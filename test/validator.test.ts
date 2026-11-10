import { describe, expect, it } from "vitest";
import { parseMetaplexMetadata, parseMintAccount, priceImpactBps, tokenAccountAmount, type ChainReader, type MarketFacts, type MintFacts } from "../src/chain/facts.ts";
import { PROGRAMS } from "../src/chain/sdk.ts";
import { loadAppConfig } from "../src/config/load.ts";
import type { Guardrails, ValidatorConfig } from "../src/config/schemas.ts";
import { createRedactor } from "../src/log/redact.ts";
import { openDb } from "../src/state/db.ts";
import { allowlistFor, dangerousExtension, recordDecisions, transferFeeBps, validate, verdictLines, type ValidatorDeps } from "../src/validate/validator.ts";
import { recordSignal, type AddressSignal } from "../src/watch/signal.ts";
import * as F from "./fixtures/x-posts.ts";
import { CONFIG_DIR } from "./helpers.ts";

const config = loadAppConfig(CONFIG_DIR);
const NOW = Date.parse("2026-11-19T17:00:05.000Z");
const LAMPORTS = 10_000_000n; // 0.01 SOL

const goodMint = (over: Partial<MintFacts> = {}): MintFacts => ({
  address: F.MINT.plain,
  exists: true,
  owner: PROGRAMS.splToken,
  tokenProgram: "spl-token",
  isMint: true,
  decimals: 6,
  supply: 1_000_000_000_000_000n,
  mintAuthority: null,
  freezeAuthority: null,
  extensions: [],
  onMintMetadata: undefined,
  ...over,
});

const curveMarket = (over: Partial<MarketFacts> = {}): MarketFacts => ({
  venue: "pump_curve",
  detail: "pump.fun bonding curve, still open",
  isPumpToken: true,
  curveComplete: false,
  creator: "Creator1111111111111111111111111111111111111",
  priceLamportsPerUnit: 30e9 / 1.073e15,
  quoteReserveLamports: 30_000_000_000n,
  tokenReserveUnits: 1_073_000_000_000_000n,
  multipleVsLaunch: 1,
  liquidityTokenAccounts: ["vault"],
  ...over,
});

function chain(over: Partial<ChainReader> & { mint?: MintFacts; market?: MarketFacts } = {}): ChainReader {
  return {
    mintFacts: async () => over.mint ?? goodMint(),
    marketFacts: async () => over.market ?? curveMarket(),
    metaplexMetadata: async () => ({ name: "Adin Ross RP", symbol: "ADIN" }),
    mintAgeSeconds: async () => ({ seconds: 120, exact: true }),
    top10HolderPct: async () => 12.5,
    tokenBalance: async () => 0n,
    ...over,
  };
}

const signal = (over: Partial<AddressSignal> = {}): AddressSignal => ({
  mint: F.MINT.plain,
  source: "x",
  path: "filtered_stream",
  postId: "1900000000000000001",
  postUrl: "https://x.com/adinross/status/1900000000000000001",
  accountId: F.ADIN,
  account: { userId: F.ADIN, handle: "adinross", person: "adin_ross", tier: 1, isTest: false },
  postKind: "original",
  referencesWatchedAuthor: false,
  origins: [{ kind: "text" }],
  mintsInPost: 1,
  warningKeywords: [],
  blockedMintNote: undefined,
  postText: "GTA 6 RP coin is live",
  postCreatedAt: "2026-11-19T17:00:00.000Z",
  receivedAt: NOW,
  ...over,
});

function deps(over: Partial<ValidatorDeps> = {}): ValidatorDeps {
  return {
    config: config.validator,
    accounts: config.accounts,
    guardrails: config.guardrails,
    mode: "dry-run",
    chain: chain(),
    db: openDb(":memory:"),
    simulateRoundTrip: async () => ({ ok: true, detail: "buy and sell both simulate" }),
    solUsd: () => 150,
    now: () => NOW,
    ...over,
  };
}

const withChecks = (checks: Partial<ValidatorConfig["checks"]>): ValidatorConfig => ({ ...config.validator, checks: { ...config.validator.checks, ...checks } });
const withBuy = (buy: Partial<Guardrails["buy"]>): Guardrails => ({ ...config.guardrails, buy: { ...config.guardrails.buy, ...buy } });
const result = (v: Awaited<ReturnType<typeof validate>>, id: string) => v.outcomes.find((o) => o.id === id)?.result;

describe("validator: a normal pump.fun launch", () => {
  it("passes every check and says buy", async () => {
    const v = await validate(signal(), LAMPORTS, deps());
    expect(v.decision).toBe("buy");
    expect(v.blocks).toEqual([]);
    expect(v.warns).toEqual([]);
    expect(v.outcomes.map((o) => o.id).sort()).toEqual(
      [...Object.keys(config.validator.checks), "tier1_source"].sort(),
    );
    expect(v.token).toEqual({ name: "Adin Ross RP", symbol: "ADIN" });
    expect(v.mcapUsd).toBeCloseTo(((30e9 / 1.073e15) * 1e15 / 1e9) * 150, 0);
  });

  it("writes one decision row per check", async () => {
    const d = deps();
    const s = signal();
    const id = recordSignal(d.db, createRedactor([]), s)!;
    const v = await validate(s, LAMPORTS, d);
    recordDecisions(d.db, id, v, NOW);
    const rows = d.db.prepare("SELECT check_id, result FROM decisions WHERE signal_id = ?").all(id) as { check_id: string; result: string }[];
    expect(rows).toHaveLength(v.outcomes.length);
    expect(rows.every((r) => r.result === "pass")).toBe(true);
  });
});

describe("validator: the one rule (source checks)", () => {
  it("blocks an author who isn't on the allowlist, without touching the chain", async () => {
    let chainCalls = 0;
    const v = await validate(signal({ accountId: F.STRANGER }), LAMPORTS, deps({ chain: chain({ mintFacts: async () => (chainCalls++, goodMint()) }) }));
    expect(v.decision).toBe("blocked");
    expect(result(v, "allowlisted_author")).toBe("block");
    expect(chainCalls).toBe(0);
  });

  it("trusts accounts.yaml, not the signal, for who is tier 1", async () => {
    // AR15thed3mon is tier 2 in config. A signal claiming tier 1 for that ID is still confirmation-only.
    const v = await validate(signal({ accountId: "1511793806080819202", account: { userId: "1511793806080819202", handle: "AR15thed3mon", person: "adin_ross", tier: 1, isTest: false } }), LAMPORTS, deps());
    expect(result(v, "tier1_source")).toBe("block");
    expect(v.decision).toBe("blocked");
  });

  it("allows the test account in dry-run only", () => {
    expect(allowlistFor(config.accounts, "x", "dry-run").get(F.TEST)).toMatchObject({ isTest: true, tier: 1 });
    expect(allowlistFor(config.accounts, "x", "live").has(F.TEST)).toBe(false);
    expect(allowlistFor(config.accounts, "kick", "live").get("904404")).toMatchObject({ person: "adin_ross", tier: 1 });
  });

  it("blocks a reply to a stranger, allows a reply to the other watched person", async () => {
    expect((await validate(signal({ postKind: "reply" }), LAMPORTS, deps())).blocks.map((b) => b.id)).toContain("original_post");
    expect((await validate(signal({ postKind: "reply", referencesWatchedAuthor: true }), LAMPORTS, deps())).decision).toBe("buy");
  });

  it("blocks a post carrying two different addresses", async () => {
    expect(result(await validate(signal({ mintsInPost: 2 }), LAMPORTS, deps()), "single_address")).toBe("block");
  });

  it("warns (but still buys) on a warning-word post and on a late post", async () => {
    const v = await validate(signal({ warningKeywords: ["fake"], postCreatedAt: "2026-11-19T16:00:00.000Z" }), LAMPORTS, deps());
    expect(v.decision).toBe("buy");
    expect(v.warns.map((w) => w.id).sort()).toEqual(["post_age", "warning_post_filter"]);
  });

  it("blocks when Adin and Banks posted different addresses", async () => {
    const d = deps();
    const banks = signal({ mint: F.MINT.pump, accountId: F.BANKS, account: { userId: F.BANKS, handle: "Banks", person: "faze_banks", tier: 1, isTest: false }, postId: "2" });
    recordSignal(d.db, createRedactor([]), banks);
    const v = await validate(signal(), LAMPORTS, d);
    expect(result(v, "cross_account_match")).toBe("block");
    expect(v.blocks[0]!.detail).toContain("faze_banks posted a different address");
  });

  it("doesn't count the same person's second address, a tier-2 account, or the test account as a conflict", async () => {
    const d = deps();
    const r = createRedactor([]);
    recordSignal(d.db, r, signal({ mint: F.MINT.pump, postId: "2" })); // same person
    recordSignal(d.db, r, signal({ mint: F.MINT.tco, postId: "3", accountId: "1729276822485889024", account: { userId: "1729276822485889024", handle: "MarketBubble", person: "faze_banks", tier: 2, isTest: false } }));
    recordSignal(d.db, r, signal({ mint: F.MINT.dexPair, postId: "4", accountId: F.TEST, account: { userId: F.TEST, handle: "Franklin_ETH1", person: "test", tier: 1, isTest: true } }));
    expect(result(await validate(signal(), LAMPORTS, d), "cross_account_match")).toBe("pass");
  });

  it("blocks a known fake mint", async () => {
    const v = await validate(signal({ mint: F.MINT.blocked }), LAMPORTS, deps());
    expect(result(v, "blocked_mint")).toBe("block");
  });
});

describe("validator: is it a token we can sell?", () => {
  it("blocks a wallet address", async () => {
    const wallet = goodMint({ isMint: false, owner: PROGRAMS.system, tokenProgram: undefined });
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: wallet }) }));
    expect(v.decision).toBe("blocked");
    expect(v.blocks.map((b) => [b.id, b.detail])).toEqual([["is_mint", "a wallet or program account, not a token"]]);
  });

  it("blocks an address where nothing exists", async () => {
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: goodMint({ exists: false, isMint: false, owner: undefined, tokenProgram: undefined }) }) }));
    expect(v.blocks[0]).toMatchObject({ id: "is_mint", detail: "nothing exists at this address" });
  });

  it("blocks a mint with a freeze authority", async () => {
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: goodMint({ freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar" }) }) }));
    expect(v.blocks.map((b) => b.id)).toContain("freeze_authority_null");
  });

  it("blocks Token-2022 honeypot extensions and allows harmless ones", () => {
    const ext = (name: string, state: Record<string, unknown> = {}) => dangerousExtension({ name, state });
    expect(ext("transferHook", { programId: "Hook111", authority: null })).toMatch(/transfer hook/);
    expect(ext("transferHook", { programId: null, authority: "Auth111" })).toMatch(/switched on/);
    expect(ext("transferHook", { programId: null, authority: null })).toBeNull();
    expect(ext("permanentDelegate", { delegate: "Del111" })).toMatch(/permanent delegate/);
    expect(ext("permanentDelegate", { delegate: null })).toBeNull();
    expect(ext("nonTransferable")).toMatch(/can't be transferred/);
    expect(ext("pausableConfig", { authority: "A", paused: false })).toMatch(/can be paused/);
    expect(ext("defaultAccountState", { accountState: "frozen" })).toMatch(/frozen/);
    expect(ext("tokenMetadata", { name: "x" })).toBeNull();
    expect(ext("metadataPointer")).toBeNull();
    expect(ext("someFutureExtension")).toMatch(/unrecognised/);
  });

  it("blocks a mint with a permanent delegate end to end", async () => {
    const m = goodMint({ tokenProgram: "token-2022", owner: PROGRAMS.token2022, extensions: [{ name: "permanentDelegate", state: { delegate: "Del111" } }] });
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: m }) }));
    expect(v.blocks.map((b) => b.id)).toContain("no_dangerous_extensions");
  });

  it("blocks a transfer fee above the limit, allows one at the limit", async () => {
    const fee = (bps: number) => goodMint({ extensions: [{ name: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: bps }, olderTransferFee: { transferFeeBasisPoints: 0 } } }] });
    expect(transferFeeBps(fee(9900))).toBe(9900);
    expect(result(await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: fee(9900) }) })), "transfer_fee_max")).toBe("block");
    expect(result(await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: fee(100) }) })), "transfer_fee_max")).toBe("pass");
  });

  it("blocks when the sell simulation fails, errors, or isn't available", async () => {
    const failed = await validate(signal(), LAMPORTS, deps({ simulateRoundTrip: async () => ({ ok: false, detail: "sell reverted: custom program error 0x1771" }) }));
    expect(failed.blocks).toEqual([{ id: "sell_simulation", group: "sellability", result: "block", detail: "sell reverted: custom program error 0x1771" }]);
    const threw = await validate(signal(), LAMPORTS, deps({ simulateRoundTrip: async () => Promise.reject(new Error("rpc down")) }));
    expect(threw.blocks[0]!.detail).toBe("simulation errored: rpc down");
    const missing = await validate(signal(), LAMPORTS, deps({ simulateRoundTrip: undefined }));
    expect(missing.blocks[0]).toMatchObject({ id: "sell_simulation", detail: "couldn't check: no simulator available" });
  });

  it("only warns when the mint authority is still set", async () => {
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mint: goodMint({ mintAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar" }) }) }));
    expect(v.decision).toBe("buy");
    expect(v.warns.map((w) => w.id)).toEqual(["mint_authority_revoked"]);
  });

  it("fails closed when the chain can't be read", async () => {
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ mintFacts: async () => Promise.reject(new Error("RPC getAccountInfo: timed out after 4000 ms")) }) }));
    expect(v.decision).toBe("blocked");
    expect(v.blocks.map((b) => b.id)).toEqual(expect.arrayContaining(["is_mint", "freeze_authority_null", "route_exists"]));
    expect(v.blocks[0]!.detail).toContain("couldn't check");
  });
});

describe("validator: market limits", () => {
  it("blocks when there's nowhere to buy", async () => {
    const none = curveMarket({ venue: "none", detail: "pump.fun curve is complete but the PumpSwap pool doesn't exist yet (mid-migration)", quoteReserveLamports: undefined, priceLamportsPerUnit: undefined });
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ market: none }) }));
    expect(v.blocks.map((b) => b.id)).toEqual(expect.arrayContaining(["route_exists", "liquidity_depth"]));
  });

  it("falls back to a Jupiter route for a token that was never on pump.fun", async () => {
    const none = curveMarket({ venue: "none", isPumpToken: false, detail: "no pump.fun curve or PumpSwap pool for this mint", quoteReserveLamports: undefined, priceLamportsPerUnit: undefined, multipleVsLaunch: undefined });
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ market: none }), jupiterRoute: async () => ({ ok: true, priceImpactBps: 40, detail: "Jupiter route via Raydium" }) }));
    expect(v.decision).toBe("buy");
    expect(v.market?.venue).toBe("jupiter");
  });

  it("blocks when our size would move the price past max slippage", async () => {
    // 0.01 SOL against 0.05 SOL of reserves = 20% impact, over the 15% placeholder.
    const thin = curveMarket({ quoteReserveLamports: 50_000_000n });
    expect(priceImpactBps(LAMPORTS, 50_000_000n)).toBe(2000);
    const v = await validate(signal(), LAMPORTS, deps({ chain: chain({ market: thin }) }));
    expect(result(v, "liquidity_depth")).toBe("block");
  });

  it("enforces max entry market cap only when the owner sets one", async () => {
    const off = await validate(signal(), LAMPORTS, deps());
    expect(off.outcomes.some((o) => o.id === "max_entry_mcap")).toBe(false);
    const over = await validate(signal(), LAMPORTS, deps({ guardrails: withBuy({ max_entry_mcap_usd: 1000 }) }));
    expect(over.blocks.map((b) => b.id)).toEqual(["max_entry_mcap"]);
    const under = await validate(signal(), LAMPORTS, deps({ guardrails: withBuy({ max_entry_mcap_usd: 10_000_000 }) }));
    expect(under.decision).toBe("buy");
    const unknown = await validate(signal(), LAMPORTS, deps({ guardrails: withBuy({ max_entry_mcap_usd: 10_000_000 }), solUsd: () => undefined }));
    expect(unknown.blocks[0]).toMatchObject({ id: "max_entry_mcap", detail: "couldn't check: market cap unknown" });
  });

  it("enforces a price multiple vs launch when set", async () => {
    const pumped = curveMarket({ multipleVsLaunch: 8.2 });
    const g = withBuy({ max_price_multiple_vs_first_trade: 5 });
    expect((await validate(signal(), LAMPORTS, deps({ guardrails: g, chain: chain({ market: pumped }) }))).blocks.map((b) => b.id)).toEqual(["max_price_multiple"]);
    expect((await validate(signal(), LAMPORTS, deps({ guardrails: g }))).decision).toBe("buy");
  });
});

describe("validator: slow warn-only lookups", () => {
  it("warns on an old mint, a name that doesn't match, and concentrated holders", async () => {
    const c = chain({
      metaplexMetadata: async () => ({ name: "Totally Unrelated", symbol: "XYZ" }),
      mintAgeSeconds: async () => ({ seconds: 40 * 86_400, exact: false }),
      top10HolderPct: async () => 81.2,
    });
    const v = await validate(signal(), LAMPORTS, deps({ chain: c }));
    expect(v.decision).toBe("buy");
    expect(v.warns.map((w) => w.id).sort()).toEqual(["holder_concentration", "name_matches_post", "recent_mint"]);
  });

  it("matches the name against the post text too", async () => {
    const c = chain({ metaplexMetadata: async () => ({ name: "Los Santos Dollars", symbol: "LSD" }) });
    const v = await validate(signal({ postText: "Los Santos dollars are live" }), LAMPORTS, deps({ chain: c }));
    expect(result(v, "name_matches_post")).toBe("pass");
  });

  it("never waits longer than the budget for them", async () => {
    const slow = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 2_000));
    const c = chain({ metaplexMetadata: () => slow(null), mintAgeSeconds: () => slow(null), top10HolderPct: () => slow(null) });
    const t = Date.now();
    const v = await validate(signal(), LAMPORTS, deps({ chain: c, config: { ...config.validator, params: { ...config.validator.params, advisory_budget_ms: 50 } } }));
    expect(Date.now() - t).toBeLessThan(600);
    expect(v.decision).toBe("buy");
    expect(v.warns.map((w) => w.id).sort()).toEqual(["holder_concentration", "name_matches_post", "recent_mint"]);
  });

  it("respects checks turned off in config", async () => {
    const v = await validate(signal(), LAMPORTS, deps({ config: withChecks({ sell_simulation: "off", recent_mint: "off" }), simulateRoundTrip: undefined }));
    expect(v.decision).toBe("buy");
    expect(result(v, "sell_simulation")).toBe("off");
    expect(result(v, "recent_mint")).toBe("off");
  });
});

describe("chain parsing", () => {
  it("parses a jsonParsed SPL mint and a Token-2022 mint with extensions", () => {
    const spl = parseMintAccount("m", {
      owner: PROGRAMS.splToken,
      lamports: 1,
      executable: false,
      data: { program: "spl-token", space: 82, parsed: { type: "mint", info: { decimals: 6, supply: "1000", mintAuthority: null, freezeAuthority: "F1" } } },
    });
    expect(spl).toMatchObject({ isMint: true, tokenProgram: "spl-token", supply: 1000n, mintAuthority: null, freezeAuthority: "F1" });
    const t22 = parseMintAccount("m", {
      owner: PROGRAMS.token2022,
      lamports: 1,
      executable: false,
      data: {
        program: "spl-token-2022",
        space: 300,
        parsed: { type: "mint", info: { decimals: 6, supply: "5", mintAuthority: null, freezeAuthority: null, extensions: [{ extension: "tokenMetadata", state: { name: "PayPal USD", symbol: "PYUSD" } }, { extension: "permanentDelegate", state: { delegate: "D" } }] } },
      },
    });
    expect(t22.onMintMetadata).toEqual({ name: "PayPal USD", symbol: "PYUSD" });
    expect(t22.extensions.map((e) => e.name)).toEqual(["tokenMetadata", "permanentDelegate"]);
  });

  it("tells a wallet, a token account and a missing account apart from a mint", () => {
    expect(parseMintAccount("m", null)).toMatchObject({ exists: false, isMint: false });
    expect(parseMintAccount("m", { owner: PROGRAMS.system, lamports: 5, executable: false, data: ["", "base64"] })).toMatchObject({ exists: true, isMint: false, tokenProgram: undefined });
    const tokenAcct = parseMintAccount("m", { owner: PROGRAMS.splToken, lamports: 5, executable: false, data: { program: "spl-token", space: 165, parsed: { type: "account", info: {} } } });
    expect(tokenAcct).toMatchObject({ exists: true, isMint: false, tokenProgram: "spl-token" });
  });

  it("reads a token account balance and Metaplex name/symbol", () => {
    const acct = Buffer.alloc(165);
    acct.writeBigUInt64LE(123_456_789n, 64);
    expect(tokenAccountAmount(acct)).toBe(123_456_789n);
    expect(tokenAccountAmount(Buffer.alloc(10))).toBeUndefined();

    const meta = Buffer.alloc(200);
    let o = 65;
    for (const [s, len] of [["Bonk", 32], ["BONK", 10]] as const) {
      meta.writeUInt32LE(len, o);
      meta.write(s, o + 4, "utf8");
      o += 4 + len;
    }
    expect(parseMetaplexMetadata(meta)).toEqual({ name: "Bonk", symbol: "BONK" });
    expect(parseMetaplexMetadata(Buffer.alloc(10))).toBeNull();
  });
});

describe("verdict summary lines", () => {
  it("lists blocks and warnings for the alert", async () => {
    const v = await validate(signal({ warningKeywords: ["scam"] }), LAMPORTS, deps({ chain: chain({ mint: goodMint({ freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar" }) }) }));
    const text = verdictLines(v).join("\n");
    expect(text).toContain("VALIDATOR: BLOCKED");
    expect(text).toContain("✗ freeze_authority_null");
    expect(text).toContain("! warning_post_filter: warning words: scam");
    expect(text).toContain("Adin Ross RP (ADIN) · pump_curve");
  });
});

describe("validator: stream titles (review fix)", () => {
  const kick = (path: string) =>
    signal({ source: "kick", path, accountId: "904404", account: { userId: "904404", handle: "adinross", person: "adin_ross", tier: 1, isTest: false }, postUrl: "https://kick.com/adinross" });

  it("blocks an address that came from a stream title, since editors and mods can change titles", async () => {
    for (const path of ["livestream.metadata.updated", "livestream.status.updated"]) {
      const v = await validate(kick(path), LAMPORTS, deps());
      expect(v.decision).toBe("blocked");
      expect(v.blocks.map((b) => b.id)).toEqual(["title_source"]);
    }
    const twitch = signal({ source: "twitch", path: "channel.update", accountId: "59299632", account: { userId: "59299632", handle: "adinross", person: "adin_ross", tier: 1, isTest: false } });
    expect((await validate(twitch, LAMPORTS, deps())).blocks.map((b) => b.id)).toEqual(["title_source"]);
  });

  it("still buys from the streamer's own Kick chat message, and from X", async () => {
    expect((await validate(kick("chat.message.sent"), LAMPORTS, deps())).decision).toBe("buy");
    expect(result(await validate(signal(), LAMPORTS, deps()), "title_source")).toBe("pass");
  });

  it("the owner can relax it to a warning in validator.yaml", async () => {
    const v = await validate(kick("livestream.metadata.updated"), LAMPORTS, deps({ config: withChecks({ title_source: "warn" }) }));
    expect(v.decision).toBe("buy");
    expect(v.warns.map((w) => w.id)).toEqual(["title_source"]);
  });
});
