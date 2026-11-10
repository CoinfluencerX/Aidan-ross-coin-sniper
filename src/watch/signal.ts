import type { AccountsConfig } from "../config/schemas.ts";
import type { ChainPresence } from "../evm/locate.ts";
import type { EvmCandidate, MintCandidate, Origin } from "../extract/extract.ts";
import type { Redactor } from "../log/redact.ts";
import type { Db } from "../state/db.ts";
import type { PostKind } from "./x/normalize.ts";

/** Platforms that can deliver a post in real time. */
export type Source = "x" | "kick" | "twitch";

/** One account a watcher listens to, keyed by the platform's numeric ID. */
export interface WatchedAccount {
  userId: string;
  handle: string;
  /** "test" for test_accounts entries. */
  person: string;
  tier: 1 | 2;
  isTest: boolean;
}

export type XPath = "activity" | "filtered_stream";

/**
 * What a watcher hands to the validator. It is NOT a buy decision.
 * One signal per (post, mint).
 */
export interface AddressSignal {
  mint: string;
  source: Source;
  /** Delivery path inside the source, e.g. "filtered_stream", "chat.message.sent", "channel.update". */
  path: string;
  postId: string;
  postUrl: string;
  accountId: string;
  account: WatchedAccount;
  postKind: PostKind;
  /** Referenced posts (parent / quoted / reposted) whose author is also watched. */
  referencesWatchedAuthor: boolean;
  origins: Origin[];
  /** How many distinct mints the same post carried. More than one is ambiguous. */
  mintsInPost: number;
  warningKeywords: string[];
  blockedMintNote: string | undefined;
  postText: string;
  postCreatedAt: string | undefined;
  receivedAt: number;
}

/**
 * An Ethereum-style 0x address seen in an official post. It is never written to the `signals`
 * table and never reaches the validator or executor: the bot only alerts, the owner buys by hand.
 */
export interface EvmSighting {
  address: string;
  source: Source;
  path: string;
  postId: string;
  postUrl: string;
  accountId: string;
  account: WatchedAccount;
  postKind: PostKind;
  referencesWatchedAuthor: boolean;
  origins: Origin[];
  addressesInPost: number;
  warningKeywords: string[];
  chains: ChainPresence[];
  postCreatedAt: string | undefined;
  receivedAt: number;
}

export type Severity = "green" | "yellow" | "red";

export interface Assessment {
  severity: Severity;
  reasons: string[];
}

type Triageable = Pick<AddressSignal, "postKind" | "referencesWatchedAuthor" | "warningKeywords" | "origins" | "account">;

function commonTriage(s: Triageable, red: string[], yellow: string[]): void {
  if ((s.postKind === "reply" || s.postKind === "quote" || s.postKind === "repost") && !s.referencesWatchedAuthor) {
    red.push(`${s.postKind}, not an original post (original_post check)`);
  }
  if (s.warningKeywords.length > 0) yellow.push(`warning words: ${s.warningKeywords.join(", ")}`);
  if (s.origins.every((o) => o.kind === "ocr")) yellow.push("found only by OCR: check every character");
  if (s.account.tier === 2) yellow.push("tier-2 account: confirmation only, never buys alone");
}

function verdict(red: string[], yellow: string[], ok: string): Assessment {
  if (red.length) return { severity: "red", reasons: [...red, ...yellow] };
  if (yellow.length) return { severity: "yellow", reasons: yellow };
  return { severity: "green", reasons: [ok] };
}

/**
 * Pre-validator triage, used to colour the alert. The validator makes the real block/warn calls
 * from validator.yaml. This only mirrors the checks we can already do from the post alone.
 */
export function assessSignal(s: AddressSignal): Assessment {
  const red: string[] = [];
  const yellow: string[] = [];
  if (s.blockedMintNote) red.push(`blocked mint: ${s.blockedMintNote}`);
  commonTriage(s, red, yellow);
  if (s.mintsInPost > 1) red.push(`post carries ${s.mintsInPost} different addresses`);
  if (s.origins.some((o) => o.maybePair) && !s.origins.some((o) => !o.maybePair)) {
    yellow.push("only from a dexscreener-style link: may be a pool address, not the mint");
  }
  return verdict(red, yellow, "original post from a watched account");
}

export function assessEvm(s: EvmSighting): Assessment {
  const red: string[] = [];
  const yellow: string[] = [];
  commonTriage(s, red, yellow);
  if (s.addressesInPost > 1) yellow.push(`post carries ${s.addressesInPost} different 0x addresses`);
  const found = s.chains.filter((c) => c.status === "contract");
  if (found.length === 0) {
    yellow.push(
      s.chains.some((c) => c.status === "unknown")
        ? "couldn't confirm a token contract (chain lookup failed): check the explorer links"
        : "no contract at this address on Ethereum or Base: may be a wallet, or another chain",
    );
  }
  return verdict(red, yellow, "original post from a watched account");
}

export function blockedMintNote(accounts: AccountsConfig, mint: string): string | undefined {
  return accounts.blocked_mints.find((b) => b.mint === mint)?.note;
}

export function buildSignals(base: Omit<AddressSignal, "mint" | "origins" | "mintsInPost" | "blockedMintNote">, mints: MintCandidate[], accounts: AccountsConfig): AddressSignal[] {
  return mints.map((m) => ({
    ...base,
    mint: m.mint,
    origins: m.origins,
    mintsInPost: mints.length,
    blockedMintNote: blockedMintNote(accounts, m.mint),
  }));
}

export function buildEvmSightings(
  base: Omit<EvmSighting, "address" | "origins" | "addressesInPost" | "chains">,
  evm: EvmCandidate[],
  chainsFor: (address: string) => ChainPresence[],
): EvmSighting[] {
  return evm.map((e) => ({ ...base, address: e.address, origins: e.origins, addressesInPost: evm.length, chains: chainsFor(e.address) }));
}

/** Writes the signal once. Returns its row id, or null if this (source, post, mint) was already recorded. */
export function recordSignal(db: Db, redactor: Redactor, s: AddressSignal): number | null {
  const r = db
    .prepare("INSERT OR IGNORE INTO signals (source, account_id, post_id, mint, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(s.source, s.accountId, s.postId, s.mint, s.receivedAt, JSON.stringify(redactor.redact(s)));
  return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : null;
}
