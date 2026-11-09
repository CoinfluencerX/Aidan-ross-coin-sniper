import type { AccountsConfig } from "../config/schemas.ts";
import type { MintCandidate, Origin } from "../extract/extract.ts";
import type { Redactor } from "../log/redact.ts";
import type { Db } from "../state/db.ts";
import type { PostKind } from "./x/normalize.ts";

/** One account the X watcher listens to, keyed by numeric ID. */
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
 * What the watcher hands to the validator (M2). It is NOT a buy decision.
 * One signal per (post, mint).
 */
export interface AddressSignal {
  mint: string;
  source: "x";
  path: XPath;
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
  postCreatedAt: string | undefined;
  receivedAt: number;
}

export type Severity = "green" | "yellow" | "red";

export interface Assessment {
  severity: Severity;
  reasons: string[];
}

/**
 * Pre-validator triage, used to colour the alert. M2's validator makes the real
 * block/warn calls from validator.yaml. This only mirrors the checks we can already do
 * from the post alone, so the dry-run alert shows what the bot would think.
 */
export function assessSignal(s: AddressSignal): Assessment {
  const red: string[] = [];
  const yellow: string[] = [];
  if (s.blockedMintNote) red.push(`blocked mint: ${s.blockedMintNote}`);
  if ((s.postKind === "reply" || s.postKind === "quote" || s.postKind === "repost") && !s.referencesWatchedAuthor) {
    red.push(`${s.postKind}, not an original post (original_post check)`);
  }
  if (s.mintsInPost > 1) red.push(`post carries ${s.mintsInPost} different addresses`);
  if (s.warningKeywords.length > 0) yellow.push(`warning words: ${s.warningKeywords.join(", ")}`);
  if (s.origins.every((o) => o.kind === "ocr")) yellow.push("found only by OCR: check every character");
  if (s.origins.some((o) => o.maybePair) && !s.origins.some((o) => !o.maybePair)) {
    yellow.push("only from a dexscreener-style link: may be a pool address, not the mint");
  }
  if (s.account.tier === 2) yellow.push("tier-2 account: confirmation only, never buys alone");
  if (red.length) return { severity: "red", reasons: [...red, ...yellow] };
  if (yellow.length) return { severity: "yellow", reasons: yellow };
  return { severity: "green", reasons: ["original post from a watched account"] };
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

/** Writes the signal once. Returns false if this (source, post, mint) was already recorded. */
export function recordSignal(db: Db, redactor: Redactor, s: AddressSignal): boolean {
  const r = db
    .prepare("INSERT OR IGNORE INTO signals (source, account_id, post_id, mint, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(s.source, s.accountId, s.postId, s.mint, s.receivedAt, JSON.stringify(redactor.redact(s)));
  return Number(r.changes) > 0;
}
