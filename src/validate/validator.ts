import { priceImpactBps, type ChainReader, type MarketFacts, type MintFacts } from "../chain/facts.ts";
import type { Mode } from "../config/mode.ts";
import type { AccountsConfig, CheckId, Guardrails, ValidatorConfig } from "../config/schemas.ts";
import { isPubkey } from "../extract/base58.ts";
import type { Db } from "../state/db.ts";
import type { AddressSignal, Source } from "../watch/signal.ts";

/**
 * The validator answers three questions about a signal (docs/VALIDATOR.md):
 *   1. Is this the real token?   2. Can we sell it?   3. Is the buy within our limits?
 * It never judges whether the coin is a good investment, and it never trades.
 *
 * Fail closed: a check that can't get its data counts as failed. For a `block` check that means no buy.
 */

export type CheckGroup = "source" | "address" | "sellability" | "market";
export type CheckResult = "pass" | "warn" | "block" | "off";

/** Checks from validator.yaml, plus three that aren't configurable there. */
export type OutcomeId = CheckId | "tier1_source" | "max_entry_mcap" | "max_price_multiple";

export interface Outcome {
  id: OutcomeId;
  group: CheckGroup;
  result: CheckResult;
  detail: string;
}

export interface Verdict {
  mint: string;
  decision: "buy" | "blocked";
  outcomes: Outcome[];
  blocks: Outcome[];
  warns: Outcome[];
  mintFacts: MintFacts | null;
  market: MarketFacts | null;
  token: { name: string; symbol: string } | null;
  mcapUsd: number | undefined;
  elapsedMs: number;
}

export interface RoundTripResult {
  ok: boolean;
  detail: string;
}

export interface ValidatorDeps {
  config: ValidatorConfig;
  accounts: AccountsConfig;
  guardrails: Guardrails;
  mode: Mode;
  chain: ChainReader;
  db: Db;
  /** Simulates a buy then a sell of our size, without sending anything. Supplied by the executor. */
  simulateRoundTrip?: ((mint: string, lamportsIn: bigint, mintFacts: MintFacts, market: MarketFacts) => Promise<RoundTripResult>) | undefined;
  /** Finds a route through Jupiter for tokens that aren't on pump.fun or PumpSwap. */
  jupiterRoute?: ((mint: string, lamportsIn: bigint) => Promise<{ ok: boolean; priceImpactBps?: number; detail: string }>) | undefined;
  /** Current SOL price in USD, or undefined when unknown. */
  solUsd?: (() => number | undefined) | undefined;
  now?: () => number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Extensions that can't stop us selling. Anything not listed here is treated as dangerous. */
const HARMLESS_EXTENSIONS = new Set([
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "tokenGroup",
  "groupMemberPointer",
  "tokenGroupMember",
  "mintCloseAuthority", // can only close the mint when supply is zero
  "interestBearingConfig", // display only
  "scaledUiAmountConfig", // display only
  "transferFeeConfig", // judged by transfer_fee_max
  "confidentialTransferMint",
  "confidentialTransferFeeConfig",
]);

function isSet(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

/** Returns the reason an extension could trap our tokens, or null if it can't. */
export function dangerousExtension(e: { name: string; state: Record<string, unknown> }): string | null {
  const s = e.state;
  switch (e.name) {
    case "transferHook":
      return isSet(s.programId) ? "transfer hook program runs on every transfer" : isSet(s.authority) ? "transfer hook can be switched on by its authority" : null;
    case "permanentDelegate":
      return isSet(s.delegate) ? "permanent delegate can move or burn anyone's tokens" : null;
    case "nonTransferable":
      return "tokens can't be transferred";
    case "pausableConfig":
      return s.paused === true ? "transfers are paused" : isSet(s.authority) ? "transfers can be paused by an authority" : null;
    case "defaultAccountState":
      return s.accountState === "frozen" ? "new token accounts start frozen" : null;
    default:
      return HARMLESS_EXTENSIONS.has(e.name) ? null : `unrecognised extension "${e.name}"`;
  }
}

/** Highest transfer fee (older or newer schedule), in basis points. 0 when there's no fee extension. */
export function transferFeeBps(facts: MintFacts): number {
  const s = facts.extensions.find((e) => e.name === "transferFeeConfig")?.state as
    | { newerTransferFee?: { transferFeeBasisPoints?: number }; olderTransferFee?: { transferFeeBasisPoints?: number } }
    | undefined;
  if (!s) return 0;
  return Math.max(s.newerTransferFee?.transferFeeBasisPoints ?? 0, s.olderTransferFee?.transferFeeBasisPoints ?? 0);
}

/** The allowlist for one source, straight from accounts.yaml. Maps numeric ID -> person and tier. */
export function allowlistFor(accounts: AccountsConfig, source: Source, mode: Mode): Map<string, { person: string; tier: 1 | 2; isTest: boolean }> {
  const out = new Map<string, { person: string; tier: 1 | 2; isTest: boolean }>();
  for (const [person, p] of Object.entries(accounts.people)) {
    const list = source === "x" ? p.x : source === "kick" ? p.kick : p.twitch;
    for (const a of list) out.set(String(a.user_id), { person, tier: a.tier, isTest: false });
  }
  if (source === "x" && mode === "dry-run") {
    for (const a of accounts.test_accounts.x) out.set(a.user_id, { person: "test", tier: 1, isTest: true });
  }
  return out;
}

function nameMatches(token: { name: string; symbol: string }, postText: string, keywords: readonly string[]): boolean {
  const hay = `${token.name} ${token.symbol}`.toLowerCase();
  if (keywords.some((k) => hay.includes(k.toLowerCase()))) return true;
  const post = postText.toLowerCase();
  const words = [token.symbol, ...token.name.split(/[^\p{L}\p{N}]+/u)].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  return words.some((w) => post.includes(w));
}

/** Resolves to `fallback` if `p` hasn't settled within `ms`. Never rejects. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const fmtSol = (lamports: bigint | number) => `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export async function validate(signal: AddressSignal, lamportsIn: bigint, deps: ValidatorDeps): Promise<Verdict> {
  const started = performance.now();
  const now = (deps.now ?? Date.now)();
  const { config, accounts, guardrails } = deps;
  const outcomes: Outcome[] = [];

  /** ok: true = pass, false = failed, null = couldn't be checked (counts as failed). */
  const add = (id: CheckId, group: CheckGroup, ok: boolean | null, detail: string) => {
    const level = config.checks[id];
    const result: CheckResult = level === "off" ? "off" : ok === true ? "pass" : level;
    outcomes.push({ id, group, result, detail: ok === null ? `couldn't check: ${detail}` : detail });
  };
  const hard = (id: "tier1_source" | "max_entry_mcap" | "max_price_multiple", group: CheckGroup, ok: boolean | null, detail: string) => {
    outcomes.push({ id, group, result: ok === true ? "pass" : "block", detail: ok === null ? `couldn't check: ${detail}` : detail });
  };
  const finish = (mintFacts: MintFacts | null, market: MarketFacts | null, token: Verdict["token"], mcapUsd?: number): Verdict => {
    const blocks = outcomes.filter((o) => o.result === "block");
    return {
      mint: signal.mint,
      decision: blocks.length ? "blocked" : "buy",
      outcomes,
      blocks,
      warns: outcomes.filter((o) => o.result === "warn"),
      mintFacts,
      market,
      token,
      mcapUsd,
      elapsedMs: Math.round(performance.now() - started),
    };
  };

  // ---------- 1. Source: does the post count? (no network) ----------
  const allow = allowlistFor(accounts, signal.source, deps.mode).get(signal.accountId);
  add("allowlisted_author", "source", allow !== undefined, allow ? `${signal.source} id ${signal.accountId} is ${allow.isTest ? "the test account" : allow.person}` : `${signal.source} id ${signal.accountId} is not on the allowlist`);
  hard("tier1_source", "source", allow?.tier === 1, allow?.tier === 1 ? "tier-1 account" : "tier-2 account: confirmation only, never buys alone");
  const original = signal.postKind === "original" || signal.referencesWatchedAuthor;
  add("original_post", "source", original, original ? `${signal.postKind} post` : `${signal.postKind} of someone who isn't on the allowlist`);
  add("address_in_post", "source", signal.origins.length > 0, signal.origins.length ? `found in ${[...new Set(signal.origins.map((o) => o.kind))].join(", ")}` : "no origin recorded");
  add("single_address", "source", signal.mintsInPost === 1, signal.mintsInPost === 1 ? "one address in the post" : `post carries ${signal.mintsInPost} different addresses`);
  add("warning_post_filter", "source", signal.warningKeywords.length === 0, signal.warningKeywords.length ? `warning words: ${signal.warningKeywords.join(", ")}` : "no warning words");

  const conflict = allow ? crossAccountConflict(deps.db, signal, allow.person, now - config.params.cross_account_window_hours * 3_600_000) : undefined;
  add("cross_account_match", "source", conflict === undefined, conflict ? `${conflict.person} posted a different address (${short(conflict.mint)})` : "no conflicting address from the other person");

  const ageS = signal.postCreatedAt ? (signal.receivedAt - Date.parse(signal.postCreatedAt)) / 1000 : undefined;
  add(
    "post_age",
    "source",
    ageS === undefined ? null : ageS <= config.params.max_post_age_seconds,
    ageS === undefined ? "post has no timestamp" : `post was ${ageS.toFixed(1)} s old when it reached us (limit ${config.params.max_post_age_seconds} s)`,
  );

  // ---------- 2. Address: cheap checks first ----------
  const valid = isPubkey(signal.mint);
  add("valid_pubkey", "address", valid, valid ? "valid 32-byte address" : "not a valid Solana address");
  const blockedNote = accounts.blocked_mints.find((b) => b.mint === signal.mint)?.note;
  add("blocked_mint", "address", blockedNote === undefined, blockedNote ? `known fake: ${blockedNote}` : "not on the blocked list");

  // Already blocked by the post itself: don't spend RPC calls on it.
  if (outcomes.some((o) => o.result === "block")) return finish(null, null, null);

  // ---------- 3. Chain facts ----------
  let mintFacts: MintFacts | null = null;
  let market: MarketFacts | null = null;
  let chainError: string | undefined;
  try {
    [mintFacts, market] = await Promise.all([deps.chain.mintFacts(signal.mint), deps.chain.marketFacts(signal.mint)]);
  } catch (err) {
    chainError = (err as Error).message;
  }

  if (!mintFacts || !market) {
    const why = chainError ?? "no data";
    add("is_mint", "address", null, why);
    add("freeze_authority_null", "sellability", null, why);
    add("no_dangerous_extensions", "sellability", null, why);
    add("transfer_fee_max", "sellability", null, why);
    add("route_exists", "market", null, why);
    return finish(mintFacts, market, null);
  }

  add(
    "is_mint",
    "address",
    mintFacts.isMint,
    mintFacts.isMint
      ? `token mint (${mintFacts.tokenProgram})`
      : !mintFacts.exists
        ? "nothing exists at this address"
        : mintFacts.tokenProgram
          ? "a token account, not a mint"
          : "a wallet or program account, not a token",
  );
  if (!mintFacts.isMint) return finish(mintFacts, market, null);

  // ---------- 4. Sellability ----------
  add("freeze_authority_null", "sellability", mintFacts.freezeAuthority === null, mintFacts.freezeAuthority === null ? "no freeze authority" : `freeze authority ${short(String(mintFacts.freezeAuthority))} can freeze our tokens`);
  const dangers = mintFacts.extensions.map((e) => dangerousExtension(e)).filter((d): d is string => d !== null);
  add("no_dangerous_extensions", "sellability", dangers.length === 0, dangers.length ? dangers.join("; ") : mintFacts.extensions.length ? `extensions are harmless (${mintFacts.extensions.map((e) => e.name).join(", ")})` : "no extensions");
  const feeBps = transferFeeBps(mintFacts);
  add("transfer_fee_max", "sellability", feeBps <= config.params.transfer_fee_max_bps, `transfer fee ${(feeBps / 100).toFixed(2)}% (limit ${(config.params.transfer_fee_max_bps / 100).toFixed(2)}%)`);
  add("mint_authority_revoked", "sellability", mintFacts.mintAuthority === null, mintFacts.mintAuthority === null ? "mint authority revoked" : `mint authority ${short(String(mintFacts.mintAuthority))} can print more supply`);

  // ---------- 5. Market ----------
  let impactBps: number | undefined;
  let routeDetail = market.detail;
  let routeOk = market.venue !== "none";
  if (routeOk && market.quoteReserveLamports !== undefined) impactBps = priceImpactBps(lamportsIn, market.quoteReserveLamports);
  if (!routeOk && deps.jupiterRoute && !market.isPumpToken) {
    try {
      const j = await deps.jupiterRoute(signal.mint, lamportsIn);
      if (j.ok) {
        routeOk = true;
        market = { ...market, venue: "jupiter" };
        impactBps = j.priceImpactBps;
      }
      routeDetail = j.detail;
    } catch (err) {
      routeDetail = `${market.detail}; Jupiter lookup failed (${(err as Error).message})`;
    }
  }
  add("route_exists", "market", routeOk, routeDetail);
  const maxSlip = guardrails.buy.max_slippage_bps;
  add(
    "liquidity_depth",
    "market",
    !routeOk || impactBps === undefined ? null : impactBps <= maxSlip,
    !routeOk ? "no route" : impactBps === undefined ? "price impact unknown" : `buying ${fmtSol(lamportsIn)} moves the price ${(impactBps / 100).toFixed(2)}% (limit ${(maxSlip / 100).toFixed(2)}%)`,
  );

  const solUsd = deps.solUsd?.();
  const mcapSol = market.priceLamportsPerUnit !== undefined && mintFacts.supply !== undefined ? (market.priceLamportsPerUnit * Number(mintFacts.supply)) / LAMPORTS_PER_SOL : undefined;
  const mcapUsd = mcapSol !== undefined && solUsd !== undefined ? mcapSol * solUsd : undefined;
  const capUsd = guardrails.buy.max_entry_mcap_usd;
  if (capUsd !== null) {
    hard("max_entry_mcap", "market", mcapUsd === undefined ? null : mcapUsd <= capUsd, mcapUsd === undefined ? "market cap unknown" : `market cap $${Math.round(mcapUsd).toLocaleString("en-US")} (limit $${capUsd.toLocaleString("en-US")})`);
  }
  const capMultiple = guardrails.buy.max_price_multiple_vs_first_trade;
  if (capMultiple !== null) {
    const m = market.multipleVsLaunch;
    hard("max_price_multiple", "market", m === undefined ? null : m <= capMultiple, m === undefined ? "launch price unknown (not a pump.fun token)" : `price is ${m.toFixed(1)}x the launch price (limit ${capMultiple}x)`);
  }

  // ---------- 6. Slow lookups. Warn-only by default, so they get a time budget and never hold up the verdict. ----------
  const budget = config.params.advisory_budget_ms;
  const blockedSoFar = outcomes.some((o) => o.result === "block");
  const liveMarket = market;
  const liveMint = mintFacts;
  const [token, age, top10, sim] = await Promise.all([
    config.checks.name_matches_post === "off"
      ? null
      : mintFacts.onMintMetadata
        ? Promise.resolve(mintFacts.onMintMetadata)
        : within<{ name: string; symbol: string } | null | undefined>(deps.chain.metaplexMetadata(signal.mint), budget, undefined),
    config.checks.recent_mint === "off" ? null : within<{ seconds: number; exact: boolean } | null>(deps.chain.mintAgeSeconds(signal.mint, now), budget, null),
    config.checks.holder_concentration === "off" || mintFacts.supply === undefined
      ? null
      : within<number | null>(deps.chain.top10HolderPct(signal.mint, mintFacts.supply, market.liquidityTokenAccounts), budget, null),
    // The sell simulation is the real honeypot test. Skip it when the buy is already blocked.
    config.checks.sell_simulation === "off" || blockedSoFar || !routeOk
      ? null
      : deps.simulateRoundTrip
        ? deps.simulateRoundTrip(signal.mint, lamportsIn, liveMint, liveMarket).catch((err: Error) => ({ ok: false, detail: `simulation errored: ${err.message}` }))
        : Promise.resolve<RoundTripResult | undefined>(undefined),
  ]);

  if (sim === undefined) add("sell_simulation", "sellability", null, "no simulator available");
  else if (sim === null) {
    // Not run. That's a skip, not a failure: the buy is already blocked by something else (or the check is off).
    const why = config.checks.sell_simulation === "off" ? "off" : blockedSoFar ? "skipped: buy already blocked" : "skipped: no route";
    outcomes.push({ id: "sell_simulation", group: "sellability", result: "off", detail: why });
  }
  else add("sell_simulation", "sellability", sim.ok, sim.detail);

  const maxAgeS = config.params.recent_mint_max_age_hours * 3600;
  const fmtAge = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 86_400)} days`);
  add(
    "recent_mint",
    "address",
    age === null ? null : age.seconds > maxAgeS ? false : age.exact ? true : null,
    age === null
      ? "mint age unknown"
      : age.seconds > maxAgeS
        ? `mint is ${age.exact ? "" : "at least "}${fmtAge(age.seconds)} old (limit ${config.params.recent_mint_max_age_hours} h): probably not the new launch`
        : age.exact
          ? `mint is ${fmtAge(age.seconds)} old`
          : `very active token, at least ${fmtAge(age.seconds)} old: exact age unknown`,
  );
  add(
    "name_matches_post",
    "address",
    token === undefined || token === null ? null : nameMatches(token, signal.postText, config.params.expected_name_keywords),
    token === undefined ? "name lookup timed out" : token === null ? "token has no name metadata" : `token is "${token.name}" (${token.symbol})`,
  );
  const top10Limit = config.params.holder_top10_warn_pct;
  add("holder_concentration", "market", top10 === null ? null : top10 <= top10Limit, top10 === null ? "holder data unavailable" : `top 10 holders own ${top10.toFixed(1)}% (warn above ${top10Limit}%)`);

  return finish(mintFacts, market, token ?? null, mcapUsd);
}

/** A different mint posted by the OTHER person (tier 1) inside the window. */
function crossAccountConflict(db: Db, signal: AddressSignal, person: string, since: number): { mint: string; person: string } | undefined {
  const rows = db.prepare("SELECT mint, raw_json FROM signals WHERE mint != ? AND received_at >= ? ORDER BY id DESC LIMIT 200").all(signal.mint, since) as {
    mint: string;
    raw_json: string | null;
  }[];
  for (const r of rows) {
    try {
      const other = (JSON.parse(r.raw_json ?? "{}") as { account?: { person?: string; tier?: number; isTest?: boolean } }).account;
      if (!other?.person || other.person === person || other.tier !== 1) continue;
      if (Boolean(other.isTest) !== signal.account.isTest) continue;
      return { mint: r.mint, person: other.person };
    } catch {
      // unreadable row: ignore
    }
  }
  return undefined;
}

/** Stores one row per check for the signal, so every decision can be audited later. */
export function recordDecisions(db: Db, signalId: number, verdict: Verdict, now = Date.now()): void {
  const stmt = db.prepare("INSERT INTO decisions (signal_id, check_id, result, detail, created_at) VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const o of verdict.outcomes) stmt.run(signalId, o.id, o.result, o.detail, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Short lines for the alert banner. */
export function verdictLines(v: Verdict): string[] {
  const lines: string[] = [];
  const name = v.token ? `${v.token.name} (${v.token.symbol})` : undefined;
  if (name || v.market) {
    const mcap = v.mcapUsd !== undefined ? ` · mcap $${Math.round(v.mcapUsd).toLocaleString("en-US")}` : "";
    const multiple = v.market?.multipleVsLaunch !== undefined ? ` · ${v.market.multipleVsLaunch.toFixed(1)}x launch price` : "";
    lines.push(`TOKEN  ${name ?? "(no name)"}${v.market && v.market.venue !== "none" ? ` · ${v.market.venue}` : ""}${mcap}${multiple}`);
  }
  lines.push(v.decision === "buy" ? `VALIDATOR: PASS (${v.elapsedMs} ms, ${v.warns.length} warning${v.warns.length === 1 ? "" : "s"})` : `VALIDATOR: BLOCKED (${v.elapsedMs} ms)`);
  for (const o of v.blocks) lines.push(`  ✗ ${o.id}: ${o.detail}`);
  for (const o of v.warns) lines.push(`  ! ${o.id}: ${o.detail}`);
  return lines;
}
