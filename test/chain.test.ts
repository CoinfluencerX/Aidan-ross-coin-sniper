import { describe, expect, it } from "vitest";
import { PUMP_LAUNCH_PRICE, RpcChainReader } from "../src/chain/facts.ts";
import { JupiterClient, jupiterRouteCheck, SolPrice } from "../src/chain/jupiter.ts";
import { RpcError, SolanaRpc } from "../src/chain/rpc.ts";
import { PROGRAMS, pump, pumpSwap, web3 } from "../src/chain/sdk.ts";
import { solanaRpcRoutes } from "./fake-chain.ts";
import { fakeFetch, json } from "./fake-x.ts";
import { COMPLETE_CURVE, OPEN_CURVE, PUMPSWAP_POOL } from "./fixtures/chain.ts";

const OPEN_MINT = "5qLN7781qpvhPik7txMLDXTT6qHoZdUfJmkMGAnpump";
const GRAD_MINT = "DtXzHu5uPgt9qPJ3y2L7b8UaLhWtZc78RRDBzBAspump";
const URL = "https://mainnet.helius-rpc.com/?api-key=rpc-secret-abc12345";

const reader = (routes: Parameters<typeof solanaRpcRoutes>[0]) => new RpcChainReader(new SolanaRpc({ url: URL, fetch: fakeFetch(solanaRpcRoutes(routes)).fetch }));
const tokenAccount = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return { owner: PROGRAMS.splToken, lamports: 2_039_280, executable: false, data: b.toString("hex") };
};

describe("market facts from real account bytes", () => {
  it("reads an open pump.fun curve: venue, price, reserves, creator", async () => {
    const m = await reader({ byPosition: [OPEN_CURVE, null] }).marketFacts(OPEN_MINT);
    expect(m.venue).toBe("pump_curve");
    expect(m.isPumpToken).toBe(true);
    expect(m.curveComplete).toBe(false);
    expect(m.quoteReserveLamports).toBeGreaterThan(1_000_000_000n);
    expect(m.priceLamportsPerUnit).toBeCloseTo(Number(m.quoteReserveLamports) / Number(m.tokenReserveUnits), 12);
    expect(m.multipleVsLaunch).toBeCloseTo(m.priceLamportsPerUnit! / PUMP_LAUNCH_PRICE, 6);
    expect(m.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(m.liquidityTokenAccounts).toHaveLength(1);
  });

  it("reads a graduated token from its PumpSwap pool and vault balances", async () => {
    const pool = pumpSwap.PUMP_AMM_SDK.decodePool({ data: Buffer.from(PUMPSWAP_POOL.data, "hex"), owner: new web3.PublicKey(PUMPSWAP_POOL.owner), lamports: 1, executable: false });
    expect(pool.baseMint.toBase58()).toBe(GRAD_MINT);
    const m = await reader({
      byPosition: [COMPLETE_CURVE, PUMPSWAP_POOL],
      accounts: {
        [pool.poolBaseTokenAccount.toBase58()]: tokenAccount(200_000_000_000_000n),
        [pool.poolQuoteTokenAccount.toBase58()]: tokenAccount(400_000_000_000n),
      },
    }).marketFacts(GRAD_MINT);
    expect(m.venue).toBe("pumpswap");
    expect(m.curveComplete).toBe(true);
    expect(m.tokenReserveUnits).toBe(200_000_000_000_000n);
    expect(m.quoteReserveLamports).toBeGreaterThanOrEqual(400_000_000_000n);
    expect(m.priceLamportsPerUnit).toBeCloseTo(Number(m.quoteReserveLamports) / 2e14, 12);
    expect(m.liquidityTokenAccounts).toContain(pool.poolBaseTokenAccount.toBase58());
  });

  it("reports no venue while a completed curve is still migrating", async () => {
    const m = await reader({ byPosition: [COMPLETE_CURVE, null] }).marketFacts(GRAD_MINT);
    expect(m).toMatchObject({ venue: "none", isPumpToken: true, curveComplete: true });
    expect(m.detail).toContain("mid-migration");
  });

  it("reports no venue for a token that was never on pump.fun, and for an account owned by another program", async () => {
    expect(await reader({}).marketFacts(OPEN_MINT)).toMatchObject({ venue: "none", isPumpToken: false });
    const impostor = { ...OPEN_CURVE, owner: PROGRAMS.system };
    expect(await reader({ byPosition: [impostor, null] }).marketFacts(OPEN_MINT)).toMatchObject({ venue: "none", isPumpToken: false });
  });

  it("derives the same curve address as the SDK for a mint", () => {
    expect(pump.bondingCurvePda(new web3.PublicKey(OPEN_MINT)).toBase58()).toBe("D3gDSi7xfZhSvZseRo19X6ZAYkAzzPgGKDMd8EbsqcQx");
  });
});

describe("slow lookups", () => {
  it("gives an exact age for a quiet mint and a lower bound for a busy one", async () => {
    const now = Date.parse("2026-11-19T17:00:00Z");
    const t = now / 1000;
    expect(await reader({ signatures: [{ blockTime: t - 10 }, { blockTime: t - 300 }] }).mintAgeSeconds(OPEN_MINT, now)).toEqual({ seconds: 300, exact: true });
    const busy = Array.from({ length: 1000 }, (_, i) => ({ blockTime: t - i }));
    expect(await reader({ signatures: busy }).mintAgeSeconds(OPEN_MINT, now)).toEqual({ seconds: 999, exact: false });
  });

  it("computes the top-10 holder share without the liquidity accounts", async () => {
    const largest = [
      { address: "curveVault", amount: "800" },
      { address: "a", amount: "100" },
      { address: "b", amount: "50" },
    ];
    expect(await reader({ largest }).top10HolderPct(OPEN_MINT, 1000n, ["curveVault"])).toBe(15);
  });
});

describe("RPC client", () => {
  it("never puts the RPC URL (which holds the API key) in an error", async () => {
    const down = new SolanaRpc({ url: URL, fetch: (async () => Promise.reject(new TypeError(`fetch failed: ${URL}`))) as typeof fetch });
    const err = await down.getBalance("x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as Error).message).toBe("RPC getBalance: network error");
    const http = new SolanaRpc({ url: URL, fetch: fakeFetch([() => json({}, 429)]).fetch });
    expect(((await http.getBalance("x").catch((e: Error) => e)) as Error).message).toBe("RPC getBalance: HTTP 429");
  });

  it("simulates without signature checks and has no method that sends", async () => {
    const seen: unknown[][] = [];
    const rpc = new SolanaRpc({ url: URL, fetch: fakeFetch(solanaRpcRoutes({ simulate: (p) => (seen.push(p), { err: null, logs: ["ok"] }) })).fetch });
    expect(await rpc.simulate("AAAA")).toEqual({ err: null, logs: ["ok"] });
    expect(seen[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
    expect(Object.getOwnPropertyNames(SolanaRpc.prototype).filter((n) => /send/i.test(n))).toEqual([]);
  });
});

describe("Jupiter helpers", () => {
  it("turns a quote into a route check, and a failure into 'no route'", async () => {
    const quote = { inAmount: "1", outAmount: "2", otherAmountThreshold: "1", priceImpactPct: "0.0123", slippageBps: 1500, routePlan: [{ swapInfo: { label: "Raydium" } }] };
    const ok = jupiterRouteCheck(new JupiterClient({ fetch: fakeFetch([() => json(quote)]).fetch }), 1500);
    expect(await ok("mint", 1n)).toEqual({ ok: true, priceImpactBps: 123, detail: "Jupiter route via Raydium" });
    const none = jupiterRouteCheck(new JupiterClient({ fetch: fakeFetch([() => json({ error: "x" }, 400)]).fetch }), 1500);
    expect(await none("mint", 1n)).toMatchObject({ ok: false });
  });

  it("SolPrice serves a recent price and drops a stale one", async () => {
    let calls = 0;
    const p = new SolPrice(async () => (++calls === 1 ? 150 : Promise.reject(new Error("down"))), 1000);
    expect(p.get(0)).toBeUndefined();
    await p.refresh(0);
    expect(p.get(500)).toBe(150);
    await p.refresh(600); // fails: keeps the old value
    expect(p.get(900)).toBe(150);
    expect(p.get(1500)).toBeUndefined();
  });
});
