import { describe, expect, it } from "vitest";
import type { ChainReader, MarketFacts, MintFacts } from "../src/chain/facts.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { PROGRAMS, web3 } from "../src/chain/sdk.ts";
import { Executor } from "../src/exec/executor.ts";
import { ephemeralSigner } from "../src/exec/wallet.ts";
import { ExitManager } from "../src/exit/manager.ts";
import { decide, type ExitConfig, type PositionState, type Tick } from "../src/exit/rules.ts";
import { createLogger } from "../src/log/logger.ts";
import { openDb } from "../src/state/db.ts";
import { solanaRpcRoutes } from "./fake-chain.ts";
import { fakeBuilder } from "./fake-trade.ts";
import { fakeFetch } from "./fake-x.ts";
import * as F from "./fixtures/x-posts.ts";
import { loadTestConfig } from "./helpers.ts";

const config = loadTestConfig();
const T0 = Date.parse("2026-11-19T17:00:10.000Z");
const MIN = 60_000;

/** Test values only. The real numbers are the owner's to set in guardrails.yaml. */
const cfg = (over: Partial<ExitConfig> = {}): ExitConfig => ({
  ...config.guardrails.exit,
  take_profit_ladder: [
    { gain_pct: 50, sell_pct: 25 },
    { gain_pct: 100, sell_pct: 25 },
    { gain_pct: 300, sell_pct: 25 },
  ],
  trailing_stop_pct: 30,
  stop_loss_pct: 40,
  max_hold_minutes: 60,
  ...over,
});

const BOUGHT = 1_000_000n;
const fresh = (): PositionState => ({ entryPrice: 1, peakPrice: 1, stepsDone: 0, openedAt: T0, tokensBought: BOUGHT, tokensHeld: BOUGHT });

/** Replays a price series (one tick per second) and applies each sale, like the manager does. */
function replay(prices: (number | undefined)[], c: ExitConfig, flags: (i: number) => Partial<Tick> = () => ({}), stepMs = 1000) {
  let pos = fresh();
  const events: { tick: number; price: number | undefined; reason: string; soldPctOfOriginal: number }[] = [];
  prices.forEach((price, i) => {
    const d = decide(pos, { now: T0 + (i + 1) * stepMs, price, ...flags(i) }, c);
    pos = { ...pos, peakPrice: d.peakPrice };
    if (d.action.kind === "sell") {
      const sold = d.action.units;
      events.push({ tick: i, price, reason: d.action.reason, soldPctOfOriginal: Math.round((Number(sold) / Number(BOUGHT)) * 100) });
      pos = { ...pos, tokensHeld: pos.tokensHeld - sold, stepsDone: d.action.stepsDone };
    }
  });
  return { events, pos };
}

describe("exit rules: replaying a price series", () => {
  it("fires each take-profit step once, at the tick the price first reaches it", () => {
    const { events, pos } = replay([1.1, 1.3, 1.49, 1.5, 1.7, 1.6, 2.0, 2.4, 3.9, 4.0, 4.1], cfg({ trailing_stop_pct: null }));
    expect(events).toEqual([
      { tick: 3, price: 1.5, reason: "take_profit", soldPctOfOriginal: 25 },
      { tick: 6, price: 2.0, reason: "take_profit", soldPctOfOriginal: 25 },
      { tick: 9, price: 4.0, reason: "take_profit", soldPctOfOriginal: 25 },
    ]);
    // The ladder adds up to 75%, so a quarter of the position is still riding.
    expect(pos.tokensHeld).toBe(250_000n);
    expect(pos.stepsDone).toBe(3);
  });

  it("sells two steps together when the price jumps past both between ticks", () => {
    const { events, pos } = replay([1.2, 2.5], cfg({ trailing_stop_pct: null }));
    expect(events).toEqual([{ tick: 1, price: 2.5, reason: "take_profit", soldPctOfOriginal: 50 }]);
    expect(pos.stepsDone).toBe(2);
  });

  it("trailing stop sells the rest when the price falls 30% from its peak", () => {
    // Peak 3.0. 30% below is 2.1: 2.11 holds, 2.1 sells.
    const { events, pos } = replay([1.5, 2.0, 3.0, 2.6, 2.11, 2.1, 5.0], cfg());
    expect(events).toEqual([
      { tick: 0, price: 1.5, reason: "take_profit", soldPctOfOriginal: 25 },
      { tick: 1, price: 2.0, reason: "take_profit", soldPctOfOriginal: 25 },
      { tick: 5, price: 2.1, reason: "trailing_stop", soldPctOfOriginal: 50 },
    ]);
    expect(pos.tokensHeld).toBe(0n);
  });

  it("stop-loss sells everything at -40%, not at -39%", () => {
    const { events } = replay([0.9, 0.75, 0.61, 0.6, 0.2], cfg({ trailing_stop_pct: null }));
    expect(events).toEqual([{ tick: 3, price: 0.6, reason: "stop_loss", soldPctOfOriginal: 100 }]);
  });

  it("stop-loss is checked before the trailing stop when both would fire", () => {
    const { events } = replay([0.5], cfg());
    expect(events[0]!.reason).toBe("stop_loss");
  });

  it("max hold sells everything once the time is up, even with no price", () => {
    const prices = Array.from({ length: 61 }, () => 1.1);
    prices[60] = undefined as unknown as number;
    const { events } = replay(prices, cfg({ trailing_stop_pct: null }), undefined, MIN);
    expect(events).toEqual([{ tick: 59, price: 1.1, reason: "max_hold", soldPctOfOriginal: 100 }]);
  });

  it("holds through ticks where the price can't be read", () => {
    const { events } = replay([undefined, undefined, 1.5], cfg({ trailing_stop_pct: null }));
    expect(events).toEqual([{ tick: 2, price: 1.5, reason: "take_profit", soldPctOfOriginal: 25 }]);
  });

  it("does nothing at all with no ladder and no stops (which is why live mode refuses that config)", () => {
    const none = cfg({ take_profit_ladder: [], trailing_stop_pct: null, stop_loss_pct: null, max_hold_minutes: null });
    expect(replay([0.01, 50, 0.001], none).events).toEqual([]);
  });

  it("uses the placeholder guardrails as shipped without selling", () => {
    expect(replay([2, 10, 0.1], config.guardrails.exit).events).toEqual([]);
  });
});

describe("exit rules: emergencies", () => {
  const at = (flags: Partial<Tick>, c = cfg(), pos = fresh()) => decide(pos, { now: T0 + 1000, price: 1.2, ...flags }, c).action;

  it("panic beats everything, then deleted post, pulled liquidity, creator selling", () => {
    expect(at({ panic: true, sourceDeleted: true, liquidityRemoved: true })).toMatchObject({ kind: "sell", all: true, units: BOUGHT, reason: "panic" });
    expect(at({ sourceDeleted: true, liquidityRemoved: true, creatorSold: true })).toMatchObject({ reason: "source_deleted" });
    expect(at({ liquidityRemoved: true, creatorSold: true })).toMatchObject({ reason: "liquidity_removed" });
    expect(at({ creatorSold: true })).toMatchObject({ reason: "creator_sold" });
  });

  it("emergencies don't need a price", () => {
    expect(decide(fresh(), { now: T0, price: undefined, sourceDeleted: true }, cfg()).action).toMatchObject({ kind: "sell", reason: "source_deleted" });
  });

  it("each emergency can be switched off in guardrails; /sell can't", () => {
    const off = cfg({ sell_on_source_deleted: false, sell_on_liquidity_removed: false, sell_on_creator_sell: false });
    expect(at({ sourceDeleted: true, liquidityRemoved: true, creatorSold: true }, off)).toEqual({ kind: "hold" });
    expect(at({ panic: true }, off)).toMatchObject({ reason: "panic" });
  });

  it("holds an empty position", () => {
    expect(at({ panic: true }, cfg(), { ...fresh(), tokensHeld: 0n })).toEqual({ kind: "hold" });
  });
});

// ---------- manager: the rules driven by live readings, selling through the real executor ----------

const mintFacts: MintFacts = { address: F.MINT.plain, exists: true, owner: PROGRAMS.token2022, tokenProgram: "token-2022", isMint: true, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [], onMintMetadata: undefined };
const market = (over: Partial<MarketFacts> = {}): MarketFacts => ({ venue: "pump_curve", detail: "open", isPumpToken: true, curveComplete: false, creator: "Creator111", priceLamportsPerUnit: 1, quoteReserveLamports: 30_000_000_000n, tokenReserveUnits: 10n ** 15n, multipleVsLaunch: 1, liquidityTokenAccounts: [], ...over });

async function managed(exit: ExitConfig, o: { isSourceDeleted?: (s: string, id: string) => Promise<boolean | undefined> } = {}) {
  const state = { market: market(), creatorBalance: 5_000n, now: T0 };
  const chain = { marketFacts: async () => state.market, tokenBalance: async () => state.creatorBalance } as unknown as ChainReader;
  const rpcCalls: string[] = [];
  const { fetch } = fakeFetch(solanaRpcRoutes({ calls: rpcCalls }));
  const db = openDb(":memory:");
  const log = createLogger({ write: () => {} });
  const executor = new Executor({ mode: "dry-run", rpc: new SolanaRpc({ url: "https://mainnet.helius-rpc.com/?api-key=x", fetch }), chain, builder: fakeBuilder().builder, signer: ephemeralSigner(), simPayer: web3.Keypair.generate().publicKey.toBase58(), guardrails: config.guardrails, db, log, now: () => state.now });
  const sid = Number(db.prepare("INSERT INTO signals (source, account_id, post_id, mint, received_at) VALUES ('x', ?, 'post-1', ?, 1)").run(F.ADIN, F.MINT.plain).lastInsertRowid);
  const buy = await executor.buy({ mint: F.MINT.plain, signalId: sid, source: "x", postId: "post-1", lamportsIn: 10_000_000n, mintFacts, market: market() });
  if (buy.status !== "simulated") throw new Error("setup buy failed");
  // Entry price from the fake fill; express later prices as multiples of it.
  const entry = buy.entryPrice;
  const notes: string[] = [];
  const manager = new ExitManager({ executor, chain, exit, db, log, notify: (t) => notes.push(t), isSourceDeleted: o.isSourceDeleted, now: () => state.now });
  const at = async (multiple: number, afterMs = 1000, extra: Partial<MarketFacts> = {}) => {
    state.now += afterMs;
    state.market = market({ priceLamportsPerUnit: entry * multiple, ...extra });
    await manager.tick();
  };
  const sells = () => db.prepare("SELECT reason, status FROM trades WHERE side = 'sell' ORDER BY id").all() as { reason: string; status: string }[];
  return { manager, executor, state, notes, at, sells, id: buy.positionId, rpcCalls, db };
}

describe("exit manager (dry-run, paper sells)", () => {
  it("walks the ladder, then closes on the trailing stop, and reports the result", async () => {
    const m = await managed(cfg());
    await m.at(1.2);
    await m.at(1.6);
    await m.at(2.2);
    await m.at(3.0);
    await m.at(2.0);
    expect(m.sells()).toEqual([
      { reason: "take_profit", status: "simulated" },
      { reason: "take_profit", status: "simulated" },
      { reason: "trailing_stop", status: "simulated" },
    ]);
    const pos = m.executor.position(m.id)!;
    expect(pos).toMatchObject({ status: "closed", close_reason: "trailing_stop", steps_done: 2, tokens_held: "0" });
    expect(pos.peak_price).toBeCloseTo(pos.entry_price! * 3, 10);
    expect(m.notes.filter((n) => n.startsWith("PAPER SOLD"))).toHaveLength(3);
    expect(m.notes.at(-1)).toMatch(/^PAPER POSITION CLOSED .* \(trailing stop\): in 0\.0100 SOL, out /);
    expect(m.rpcCalls.filter((c) => /send/i.test(c))).toEqual([]);
    // Closed positions are left alone.
    await m.at(0.01);
    expect(m.sells()).toHaveLength(3);
  });

  it("sells everything when pool liquidity is pulled", async () => {
    const m = await managed(cfg());
    await m.at(1.1, 1000, { venue: "pumpswap", quoteReserveLamports: 400_000_000_000n });
    await m.at(1.1, 1000, { venue: "pumpswap", quoteReserveLamports: 210_000_000_000n }); // -47.5%: still above the 50% line
    expect(m.sells()).toEqual([]);
    await m.at(1.1, 1000, { venue: "pumpswap", quoteReserveLamports: 190_000_000_000n }); // -52.5%
    expect(m.sells()).toEqual([{ reason: "liquidity_removed", status: "simulated" }]);
  });

  it("sells everything when the creator's balance drops past the limit", async () => {
    const m = await managed(cfg());
    await m.at(1.1); // baseline 5,000
    m.state.creatorBalance = 4_600n; // -8%
    await m.at(1.1);
    expect(m.sells()).toEqual([]);
    m.state.creatorBalance = 4_000n; // -20%
    await m.at(1.1);
    expect(m.sells()).toEqual([{ reason: "creator_sold", status: "simulated" }]);
  });

  it("sells when the source post is deleted, checking at most every 20 s and only inside the window", async () => {
    const asked: string[] = [];
    let deleted: boolean | undefined = false;
    const m = await managed(cfg({ source_deleted_window_minutes: 2 }), { isSourceDeleted: async (s, id) => (asked.push(`${s}:${id}`), deleted) });
    await m.at(1.1);
    await m.at(1.1, 5_000);
    expect(asked).toEqual(["x:post-1"]); // second tick was inside the 20 s gap
    deleted = undefined; // lookup failed: not treated as deleted
    await m.at(1.1, 20_000);
    expect(m.sells()).toEqual([]);
    deleted = true;
    await m.at(1.1, 20_000);
    expect(m.sells()).toEqual([{ reason: "source_deleted", status: "simulated" }]);

    const late = await managed(cfg({ source_deleted_window_minutes: 2 }), { isSourceDeleted: async () => true });
    await late.at(1.1, 3 * MIN); // window is over: no check, no sale
    expect(late.sells()).toEqual([]);
  });

  it("/sell sells everything on the next tick", async () => {
    const m = await managed(cfg());
    expect(m.manager.panicSell()).toBe(1);
    await m.at(1.1);
    expect(m.sells()).toEqual([{ reason: "panic", status: "simulated" }]);
    expect(m.manager.panicSell()).toBe(0);
  });

  it("retries a failed sell on the next tick and only notifies once", async () => {
    const m = await managed(cfg());
    await m.at(0.5, 1000, { venue: "none", detail: "mid-migration" }); // stop-loss can't see a price: holds
    m.manager.panicSell();
    await m.at(0.5, 1000, { venue: "none", detail: "mid-migration" });
    await m.at(0.5, 1000, { venue: "none", detail: "mid-migration" });
    expect(m.sells()).toEqual([]);
    expect(m.notes).toEqual(["PAPER SELL FAILED (panic) on 6gaH…LbLC: nowhere to sell right now: mid-migration. Retrying every 1.0 s."]);
    await m.at(0.5);
    expect(m.sells()).toEqual([{ reason: "panic", status: "simulated" }]);
    expect(m.manager.stats).toMatchObject({ sells: 1, sellFailures: 2 });
  });

  it("reports open positions for /status", async () => {
    const m = await managed(cfg());
    await m.at(1.6, 5 * MIN);
    const [view] = m.manager.status();
    expect(view).toMatchObject({ id: m.id, mint: F.MINT.plain, simulated: true, stepsDone: 1, costSol: 0.01 });
    expect(view!.heldPct).toBeCloseTo(75, 1);
    expect(view!.gainPct).toBeCloseTo(60, 6);
    expect(view!.ageMinutes).toBeCloseTo(5, 1);
  });
});

describe("exit manager: review fixes", () => {
  it("prices a Jupiter-bought coin from a sell quote, so its stop-loss can fire", async () => {
    const m = await managed(cfg());
    // Pretend the position was bought through Jupiter: no pump.fun market exists for it.
    m.db.prepare("UPDATE positions SET venue = 'jupiter' WHERE id = ?").run(m.id);
    const entry = m.executor.position(m.id)!.entry_price!;
    const asked: bigint[] = [];
    let multiple = 1;
    const chain = { marketFacts: async () => market({ venue: "none", priceLamportsPerUnit: undefined, detail: "not a pump.fun token" }), tokenBalance: async () => 0n } as unknown as ChainReader;
    const notes: string[] = [];
    const jm = new ExitManager({ executor: m.executor, chain, exit: cfg(), db: m.db, log: createLogger({ write: () => {} }), notify: (t) => notes.push(t), quotePrice: async (_mint, units) => (asked.push(units), entry * multiple), now: () => m.state.now });
    await jm.tick();
    expect(asked).toHaveLength(1);
    expect(jm.status()[0]!.gainPct).toBeCloseTo(0, 6);
    multiple = 0.5; // -50%: past the 40% stop-loss
    await jm.tick();
    expect(m.sells()).toEqual([{ reason: "stop_loss", status: "simulated" }]);
  });

  it("without a quote source, a Jupiter position has no price and only non-price rules can sell it", async () => {
    const m = await managed(cfg({ max_hold_minutes: null }));
    m.db.prepare("UPDATE positions SET venue = 'jupiter' WHERE id = ?").run(m.id);
    await m.at(0.01, 1000, { venue: "none", priceLamportsPerUnit: undefined });
    expect(m.sells()).toEqual([]);
  });

  it("tells the owner when a pending buy is settled", async () => {
    const notes: string[] = [];
    const executor = { openPositions: () => [], position: () => undefined, sell: async () => ({ status: "failed" as const, error: "" }), reconcile: async () => ["Position #4 (abcd…wxyz): the buy DID land. Tokens found in the wallet; the position is now open and managed."] };
    const jm = new ExitManager({ executor, chain: {} as ChainReader, exit: cfg(), db: openDb(":memory:"), log: createLogger({ write: () => {} }), notify: (t) => notes.push(t) });
    await jm.tick();
    expect(notes).toEqual([expect.stringContaining("the buy DID land")]);
  });
});
