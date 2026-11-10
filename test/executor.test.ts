import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainReader, MarketFacts, MintFacts } from "../src/chain/facts.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { PROGRAMS, splToken, web3 } from "../src/chain/sdk.ts";
import { base58Encode } from "../src/extract/base58.ts";
import { compileTx, Executor, simulationFailure, type BuyRequest } from "../src/exec/executor.ts";
import { LiveSender, type Sender } from "../src/exec/send.ts";
import { ephemeralSigner, loadWalletSigner, WalletError } from "../src/exec/wallet.ts";
import { createLogger } from "../src/log/logger.ts";
import { createRedactor } from "../src/log/redact.ts";
import { openDb } from "../src/state/db.ts";
import { solanaRpcRoutes, type FakeChain } from "./fake-chain.ts";
import { ATA, fakeBuilder } from "./fake-trade.ts";
import { fakeFetch, json } from "./fake-x.ts";
import * as F from "./fixtures/x-posts.ts";
import { loadTestConfig, REPO_ROOT, tempDir } from "./helpers.ts";

const config = loadTestConfig();
const URL = "https://mainnet.helius-rpc.com/?api-key=rpc-secret-abc12345";
const PAYER = web3.Keypair.generate().publicKey.toBase58();
const LAMPORTS = 10_000_000n;

const mintFacts: MintFacts = { address: F.MINT.plain, exists: true, owner: PROGRAMS.token2022, tokenProgram: "token-2022", isMint: true, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [], onMintMetadata: undefined };
const market = (over: Partial<MarketFacts> = {}): MarketFacts => ({ venue: "pump_curve", detail: "open", isPumpToken: true, curveComplete: false, creator: "Creator111", priceLamportsPerUnit: 2.8e-5, quoteReserveLamports: 30_000_000_000n, tokenReserveUnits: 10n ** 15n, multipleVsLaunch: 1, liquidityTokenAccounts: [], ...over });

function tokenAccountBase64(amount: bigint) {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString("base64");
}

function setup(o: { chain?: FakeChain; builder?: ReturnType<typeof fakeBuilder>; mode?: "dry-run" | "live"; sender?: Sender; simPayer?: string | undefined; maxOpen?: number; marketNow?: MarketFacts; now?: () => number } = {}) {
  const rpcCalls: string[] = [];
  const { fetch } = fakeFetch(solanaRpcRoutes({ calls: rpcCalls, simulate: () => ({ err: null, logs: [], unitsConsumed: 81_245, accounts: [{ owner: PROGRAMS.token2022, lamports: 1, executable: false, data: [tokenAccountBase64(357_142_857_142n), "base64"] }] }), ...o.chain }));
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const db = openDb(":memory:");
  const b = o.builder ?? fakeBuilder();
  const mode = o.mode ?? "dry-run";
  const signer = mode === "live" ? liveSigner : ephemeralSigner();
  const chain = { marketFacts: async () => o.marketNow ?? market() } as unknown as ChainReader;
  const guardrails = { ...config.guardrails, buy: { ...config.guardrails.buy, max_open_positions: o.maxOpen ?? 1 } };
  const executor = new Executor({
    mode,
    rpc: new SolanaRpc({ url: URL, fetch }),
    chain,
    builder: b.builder,
    signer,
    simPayer: mode === "live" ? signer.publicKey : "simPayer" in o ? o.simPayer : PAYER,
    guardrails,
    db,
    log,
    sender: o.sender,
    sleep: async () => {},
    ...(o.now ? { now: o.now } : {}),
  });
  return { executor, db, rpcCalls, builderCalls: b.calls, lines, events: () => lines.map((l) => JSON.parse(l)) };
}

const liveKey = web3.Keypair.generate();
const liveSigner = { publicKey: liveKey.publicKey.toBase58(), ephemeral: false, sign: (tx: InstanceType<typeof web3.VersionedTransaction>) => tx.sign([liveKey]) };
let signalSeq = 0;
function buyReq(db: ReturnType<typeof openDb>, over: Partial<BuyRequest> = {}): BuyRequest {
  const mint = over.mint ?? F.MINT.plain;
  const r = db.prepare("INSERT INTO signals (source, account_id, post_id, mint, received_at) VALUES ('x', ?, ?, ?, 1)").run(F.ADIN, `p${++signalSeq}`, mint);
  return { mint, signalId: Number(r.lastInsertRowid), source: "x", postId: "p", lamportsIn: LAMPORTS, mintFacts, market: market(), ...over };
}

describe("executor: dry-run buy", () => {
  it("locks, builds, signs and simulates, then records a paper position. Nothing is sent", async () => {
    const { executor, db, rpcCalls, builderCalls } = setup();
    const out = await executor.buy(buyReq(db));
    expect(out).toMatchObject({ status: "simulated", tokens: 357_142_857_142n, lamports: LAMPORTS, variant: "pump_curve:v3", units: 81_245, signature: undefined });
    if (out.status !== "simulated") throw new Error("unreachable");
    expect(out.signedMs).toBeLessThan(1000);
    expect(out.entryPrice).toBeCloseTo(1e7 / 357_142_857_142, 12);
    // The simulation ran as the funded payer, not the throwaway signing key.
    expect(builderCalls).toEqual([{ op: "buy", user: PAYER, venue: "pump_curve", amount: LAMPORTS }]);
    expect(rpcCalls).toEqual(["simulateTransaction"]);
    const pos = executor.position(out.positionId)!;
    expect(pos).toMatchObject({ status: "open", simulated: 1, venue: "pump_curve", token_program: "token-2022", tokens_held: "357142857142", cost_lamports: 10_000_000, source: "x", creator: "Creator111" });
    expect(db.prepare("SELECT side, status, signature, token_amount FROM trades").all()).toEqual([{ side: "buy", status: "simulated", signature: null, token_amount: "357142857142" }]);
  });

  it("never buys the same mint twice, even after a failure", async () => {
    const { executor, db, rpcCalls } = setup({ chain: { simulate: () => ({ err: { InstructionError: [2, { Custom: 6002 }] }, logs: ["Program log: AnchorError occurred. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage: Too much SOL required to buy the given amount of tokens."] }) } });
    const first = await executor.buy(buyReq(db));
    expect(first).toMatchObject({ status: "failed" });
    expect((first as { error: string }).error).toContain("TooMuchSolRequired");
    const second = await executor.buy(buyReq(db));
    expect(second).toEqual({ status: "skipped", reason: "this mint was already bought (or tried) once" });
    expect(rpcCalls.filter((c) => c === "simulateTransaction")).toHaveLength(1);
    expect(db.prepare("SELECT status FROM positions").all()).toEqual([{ status: "failed" }]);
  });

  it("refuses a second coin while one position is open", async () => {
    const { executor, db } = setup();
    expect((await executor.buy(buyReq(db))).status).toBe("simulated");
    expect(await executor.buy(buyReq(db, { mint: F.MINT.pump }))).toEqual({ status: "skipped", reason: "another position is still open" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 1 });
  });

  it("fails cleanly with no simulation wallet, and skips when there's no route", async () => {
    const none = setup({ simPayer: undefined });
    expect(await none.executor.buy(buyReq(none.db))).toMatchObject({ status: "failed", error: expect.stringContaining("no wallet to simulate with") });
    const { executor, db } = setup();
    expect(await executor.buy(buyReq(db, { market: market({ venue: "none" }) }))).toEqual({ status: "skipped", reason: "no route" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
  });
});

describe("executor: sell simulation for the validator", () => {
  it("passes when buy+sell simulate in one transaction", async () => {
    const { executor, rpcCalls } = setup();
    expect(await executor.simulateRoundTrip(F.MINT.plain, LAMPORTS, mintFacts, market())).toEqual({ ok: true, detail: "buy then sell simulated OK (pump_curve:v3, 81245 compute units)" });
    expect(rpcCalls).toEqual(["simulateTransaction"]);
  });

  it("fails with the program's own reason when the sell leg reverts", async () => {
    const { executor } = setup({ chain: { simulate: () => ({ err: { InstructionError: [1, { Custom: 17 }] }, logs: ["Program log: Instruction: Sell", "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x11"] }) } });
    const r = await executor.simulateRoundTrip(F.MINT.plain, LAMPORTS, mintFacts, market());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("custom program error: 0x11");
  });

  it("fails closed without a wallet, and when the pair doesn't fit in one transaction", async () => {
    const none = setup({ simPayer: undefined });
    expect((await none.executor.simulateRoundTrip(F.MINT.plain, LAMPORTS, mintFacts, market())).ok).toBe(false);
    const big = setup({ builder: fakeBuilder({ extraIxs: 40 }) });
    const r = await big.executor.simulateRoundTrip(F.MINT.plain, LAMPORTS, mintFacts, market());
    expect(r).toMatchObject({ ok: false, detail: expect.stringContaining("doesn't fit in one transaction") });
    expect(big.rpcCalls).toEqual([]);
  });

  it("explains an underfunded simulation wallet in plain words", () => {
    expect(simulationFailure({ err: {}, logs: ["Transfer: insufficient lamports 5, need 100"] })).toBe("the simulation wallet doesn't hold enough SOL for this buy");
    expect(simulationFailure({ err: "BlockhashNotFound", logs: null })).toBe('error "BlockhashNotFound"');
  });
});

describe("executor: dry-run sells are paper sells from a live quote", () => {
  it("sells a fraction, then the rest, and closes the position", async () => {
    const { executor, db, rpcCalls } = setup();
    const buy = await executor.buy(buyReq(db));
    if (buy.status !== "simulated") throw new Error("buy failed");
    const half = await executor.sell(buy.positionId, 178_571_428_571n, "take_profit_1");
    expect(half).toMatchObject({ status: "simulated", tokensSold: 178_571_428_571n, remaining: 178_571_428_571n });
    expect(executor.position(buy.positionId)).toMatchObject({ status: "open", tokens_held: "178571428571" });
    const rest = await executor.sell(buy.positionId, "all", "stop_loss");
    expect(rest).toMatchObject({ status: "simulated", remaining: 0n });
    const pos = executor.position(buy.positionId)!;
    expect(pos).toMatchObject({ status: "closed", close_reason: "stop_loss", tokens_held: "0" });
    expect(pos.proceeds_lamports).toBe(Number((178_571_428_571n * 28n) / 1_000_000n) * 2);
    expect(db.prepare("SELECT side, status, reason FROM trades WHERE side = 'sell'").all()).toEqual([
      { side: "sell", status: "simulated", reason: "take_profit_1" },
      { side: "sell", status: "simulated", reason: "stop_loss" },
    ]);
    expect(rpcCalls.filter((c) => /send/i.test(c))).toEqual([]);
    expect(await executor.sell(buy.positionId, "all", "again")).toEqual({ status: "failed", error: "position isn't open" });
  });

  it("sells on the venue the token is on NOW (curve at buy, PumpSwap after it graduates)", async () => {
    const { executor, db, builderCalls } = setup({ marketNow: market({ venue: "pumpswap" }) });
    const buy = await executor.buy(buyReq(db));
    if (buy.status !== "simulated") throw new Error("buy failed");
    await executor.sell(buy.positionId, "all", "max_hold");
    expect(builderCalls.at(-1)).toMatchObject({ op: "sell", venue: "pumpswap" });
  });

  it("reports a failed sell when the token is mid-migration, leaving the position open to retry", async () => {
    const { executor, db } = setup({ marketNow: market({ venue: "none", detail: "mid-migration" }) });
    const buy = await executor.buy(buyReq(db));
    if (buy.status !== "simulated") throw new Error("buy failed");
    expect(await executor.sell(buy.positionId, "all", "stop_loss")).toEqual({ status: "failed", error: "nowhere to sell right now: mid-migration" });
    expect(executor.position(buy.positionId)!.status).toBe("open");
  });
});

describe("executor: mode guards", () => {
  const base = () => {
    const { fetch } = fakeFetch([]);
    return { rpc: new SolanaRpc({ url: URL, fetch }), chain: {} as ChainReader, builder: fakeBuilder().builder, guardrails: config.guardrails, db: openDb(":memory:"), log: createLogger({ write: () => {} }) };
  };
  const sender: Sender = { send: async () => "sig", confirm: async () => ({ status: "confirmed" }) };

  it("dry-run can't be built with a sender; live can't be built without one or with a throwaway key", () => {
    expect(() => new Executor({ ...base(), mode: "dry-run", signer: ephemeralSigner(), simPayer: PAYER, sender })).toThrow("dry-run must never be given a sender");
    expect(() => new Executor({ ...base(), mode: "live", signer: liveSigner, simPayer: liveSigner.publicKey })).toThrow("live mode needs a sender");
    const eph = ephemeralSigner();
    expect(() => new Executor({ ...base(), mode: "live", signer: eph, simPayer: eph.publicKey, sender })).toThrow("needs the real wallet");
    expect(() => new Executor({ ...base(), mode: "live", signer: liveSigner, simPayer: PAYER, sender })).toThrow("simulations must run as the wallet itself");
  });
});

describe("executor: live path, against a FAKE sender (no network, no funds)", () => {
  function fakeSender(confirm: Awaited<ReturnType<Sender["confirm"]>>) {
    const sent: string[] = [];
    // Real signatures are unique per transaction, and the trades table relies on that.
    const sender: Sender = { send: async (tx) => (sent.push(tx), sent.length === 1 ? "5igFakeSignature" : `5igFakeSignature${sent.length}`), confirm: async () => confirm };
    return { sender, sent };
  }
  /** The live wallet's real token account for the test mint, as the executor derives it. */
  const WALLET_ATA = splToken.getAssociatedTokenAddressSync(new web3.PublicKey(F.MINT.plain), liveKey.publicKey, true, new web3.PublicKey(PROGRAMS.token2022)).toBase58();
  const rawAccount = (amount: bigint) => ({ owner: PROGRAMS.token2022, lamports: 1, executable: false, data: Buffer.from(tokenAccountBase64(amount), "base64").toString("hex") });
  const heldAccount = (amount: bigint): FakeChain => ({ accounts: { [WALLET_ATA]: rawAccount(amount) } });
  const SIG = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

  it("signs with the wallet, sends once, and opens the position from the wallet's real balance", async () => {
    const { sender, sent } = fakeSender({ status: "confirmed" });
    const { executor, db, builderCalls } = setup({ mode: "live", sender, chain: heldAccount(350_000_000_000n) });
    const out = await executor.buy(buyReq(db));
    expect(out).toMatchObject({ status: "confirmed", tokens: 350_000_000_000n });
    if (out.status !== "confirmed") throw new Error("unreachable");
    expect(out.signature).toMatch(SIG);
    expect(sent).toHaveLength(1);
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(sent[0]!, "base64"));
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(liveSigner.publicKey);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(builderCalls[0]).toMatchObject({ op: "buy", user: liveSigner.publicKey });
    // The signature is the transaction's own, recorded before the send.
    expect(base58Encode(tx.signatures[0]!)).toBe(out.signature);
    expect(db.prepare("SELECT status, signature FROM trades").all()).toEqual([{ status: "confirmed", signature: out.signature }]);
    expect(executor.position((out as { positionId: number }).positionId)).toMatchObject({ status: "open", simulated: 0 });
  });

  it("treats an 'expired' send as bought when the tokens did arrive", async () => {
    const { sender } = fakeSender({ status: "expired" });
    const { executor, db } = setup({ mode: "live", sender, chain: heldAccount(1_000n) });
    expect(await executor.buy(buyReq(db))).toMatchObject({ status: "confirmed", tokens: 1_000n });
  });

  it("marks the position failed when nothing arrived, and still never retries", async () => {
    const { sender, sent } = fakeSender({ status: "expired" });
    const { executor, db } = setup({ mode: "live", sender, chain: heldAccount(0n) });
    expect(await executor.buy(buyReq(db))).toMatchObject({ status: "failed", error: "buy never confirmed and no tokens arrived" });
    expect((await executor.buy(buyReq(db))).status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("caps a live sell by what the wallet really holds", async () => {
    const { sender, sent } = fakeSender({ status: "confirmed" });
    const { executor, db, builderCalls } = setup({ mode: "live", sender, chain: heldAccount(100n) });
    const buy = await executor.buy(buyReq(db));
    if (buy.status !== "confirmed") throw new Error("buy failed");
    db.prepare("UPDATE positions SET tokens_held = '999999' WHERE id = ?").run(buy.positionId); // stale record
    const out = await executor.sell(buy.positionId, "all", "panic");
    expect(out).toMatchObject({ status: "confirmed", tokensSold: 100n, remaining: 0n });
    expect(builderCalls.at(-1)).toMatchObject({ op: "sell", amount: 100n });
    expect(sent).toHaveLength(2);
  });
});

describe("LiveSender (fake endpoints)", () => {
  const rpcOk = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
  it("fans out to RPC and Jito and returns the first signature", async () => {
    const f = fakeFetch([({ url }) => (url.hostname === "jito.example.com" ? rpcOk("sigFromJito") : undefined), () => json({ jsonrpc: "2.0", id: 1, error: { message: "node is behind" } })]);
    const s = new LiveSender({ rpc: new SolanaRpc({ url: URL, fetch: f.fetch }), jitoUrl: "https://jito.example.com/", fetch: f.fetch });
    expect(await s.send("AAAA")).toBe("sigFromJito");
    expect(f.calls.map((c) => (c.body as { method: string }).method)).toEqual(["sendTransaction", "sendTransaction"]);
    expect((f.calls[0]!.body as { params: unknown[] }).params[1]).toMatchObject({ skipPreflight: true, maxRetries: 0 });
  });

  it("reports when every path fails", async () => {
    const f = fakeFetch([() => json({ jsonrpc: "2.0", id: 1, error: { message: "nope" } })]);
    const s = new LiveSender({ rpc: new SolanaRpc({ url: URL, fetch: f.fetch }) });
    await expect(s.send("AAAA")).rejects.toThrow("every send path failed: RPC sendTransaction: nope");
  });

  it("confirms, reports an on-chain failure, or times out", async () => {
    const status = (v: unknown) => new LiveSender({ rpc: new SolanaRpc({ url: URL, fetch: fakeFetch([() => rpcOk({ value: [v] })]).fetch }), sleep: async () => {} });
    expect(await status({ confirmationStatus: "confirmed", err: null }).confirm("s", 1000)).toEqual({ status: "confirmed" });
    expect(await status({ confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } }).confirm("s", 1000)).toMatchObject({ status: "failed" });
    expect(await status(null).confirm("s", 30)).toEqual({ status: "expired" });
  });
});

describe("wallet loading", () => {
  const redactor = () => createRedactor([]);
  function keyFile(mode = 0o600, content?: string) {
    const dir = tempDir("sniper-wallet-");
    const kp = web3.Keypair.generate();
    const path = join(dir, "test-wallet.json");
    writeFileSync(path, content ?? JSON.stringify([...kp.secretKey]));
    chmodSync(path, mode);
    return { path, kp };
  }

  it("loads a solana-keygen file and registers the key with the redactor before returning", () => {
    const { path, kp } = keyFile();
    const r = redactor();
    const signer = loadWalletSigner(path, r, REPO_ROOT);
    expect(signer).toMatchObject({ publicKey: kp.publicKey.toBase58(), ephemeral: false });
    expect(Object.keys(signer)).toEqual(["publicKey", "ephemeral", "sign"]); // no key material on the object
    const secret58 = base58Encode(kp.secretKey);
    expect(r.redactString(`leak ${secret58} and ${Buffer.from(kp.secretKey).toString("hex")}`)).toBe("leak [REDACTED] and [REDACTED]");
    const tx = compileTx(signer.publicKey, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", [web3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })]);
    signer.sign(tx);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });

  it("refuses a relative path, a file inside the repo, loose permissions and a malformed file", () => {
    expect(() => loadWalletSigner("wallet.json", redactor(), REPO_ROOT)).toThrow("must be an absolute path");
    const inRepo = join(REPO_ROOT, "data", "test-wallets");
    mkdirSync(inRepo, { recursive: true });
    expect(() => loadWalletSigner(join(inRepo, "w.json"), redactor(), REPO_ROOT)).toThrow("inside the repo");
    expect(() => loadWalletSigner(keyFile(0o644).path, redactor(), REPO_ROOT)).toThrow("readable by other users");
    expect(() => loadWalletSigner("/nonexistent/wallet.json", redactor(), REPO_ROOT)).toThrow("doesn't exist");
    const bad = keyFile(0o600, JSON.stringify([1, 2, 3]));
    let err: unknown;
    try {
      loadWalletSigner(bad.path, redactor(), REPO_ROOT);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletError);
    expect((err as Error).message).toBe("the wallet key file isn't a solana-keygen keypair (a JSON array of 64 numbers)");
  });
});

// ---------- fixes from the independent safety review (2026-11-10) ----------

describe("live buys: never guess whether a sent transaction landed", () => {
  const WALLET_ATA = splToken.getAssociatedTokenAddressSync(new web3.PublicKey(F.MINT.plain), liveKey.publicKey, true, new web3.PublicKey(PROGRAMS.token2022)).toBase58();
  const raw = (amount: bigint) => ({ owner: PROGRAMS.token2022, lamports: 1, executable: false, data: Buffer.from(tokenAccountBase64(amount), "base64").toString("hex") });
  const sender = (confirm: Awaited<ReturnType<Sender["confirm"]>>, sendThrows = false) => {
    const sent: string[] = [];
    const s: Sender = {
      send: async (tx) => {
        sent.push(tx);
        if (sendThrows) throw new Error("timed out");
        return "x";
      },
      confirm: async () => confirm,
    };
    return { s, sent };
  };

  it("a send that errors is still checked against the wallet: tokens there means bought", async () => {
    const { s, sent } = sender({ status: "expired" }, true);
    const { executor, db } = setup({ mode: "live", sender: s, chain: { accounts: { [WALLET_ATA]: raw(42_000n) } } });
    expect(await executor.buy(buyReq(db))).toMatchObject({ status: "confirmed", tokens: 42_000n });
    expect(sent).toHaveLength(1);
  });

  it("confirmed, but the balance isn't readable yet: stays pending, then reconcile opens it", async () => {
    const chain: FakeChain = { accounts: {} };
    const { s } = sender({ status: "confirmed" });
    const { executor, db } = setup({ mode: "live", sender: s, chain });
    const out = await executor.buy(buyReq(db));
    expect(out).toMatchObject({ status: "unknown", detail: "confirmed, but the tokens aren't visible in the wallet yet" });
    const id = (out as { positionId: number }).positionId;
    expect(executor.position(id)!.status).toBe("pending");
    // Still counted, so a second coin can't be bought while this one is unresolved.
    expect(executor.activePositionCount()).toBe(1);
    expect((await executor.buy(buyReq(db, { mint: F.MINT.pump }))).status).toBe("skipped");
    expect(await executor.reconcile()).toEqual([]); // too early to give up, nothing visible yet
    chain.accounts![WALLET_ATA] = raw(5_000n);
    const lines = await executor.reconcile();
    expect(lines).toEqual([expect.stringContaining("the buy DID land")]);
    expect(executor.position(id)).toMatchObject({ status: "open", tokens_held: "5000", cost_lamports: 10_000_000 });
    expect(db.prepare("SELECT status FROM trades WHERE side = 'buy'").all()).toEqual([{ status: "confirmed" }]);
  });

  it("reconcile gives up on a sent buy only after it can no longer land", async () => {
    let clock = 1_000_000;
    const { s } = sender({ status: "confirmed" });
    const { executor, db } = setup({ mode: "live", sender: s, chain: { accounts: {} }, now: () => clock });
    const out = await executor.buy(buyReq(db));
    const id = (out as { positionId: number }).positionId;
    clock += 60_000;
    expect(await executor.reconcile()).toEqual([]);
    expect(executor.position(id)!.status).toBe("pending");
    clock += 200_000;
    expect(await executor.reconcile()).toEqual([expect.stringContaining("the buy never landed")]);
    expect(executor.position(id)!.status).toBe("failed");
  });

  it("a row left pending by a crash before anything was sent is failed at the next reconcile", async () => {
    const { executor, db } = setup({ mode: "live", sender: sender({ status: "confirmed" }).s });
    db.prepare("INSERT INTO positions (mint, status, created_at, updated_at, simulated, token_program) VALUES (?, 'pending', 1, 1, 0, 'token-2022')").run(F.MINT.tco);
    expect(await executor.reconcile()).toEqual([expect.stringContaining("interrupted before anything was sent")]);
    expect(db.prepare("SELECT status FROM positions").all()).toEqual([{ status: "failed" }]);
    expect(executor.activePositionCount()).toBe(0);
  });

  it("dry-run: a pending paper row is failed too", async () => {
    const { executor, db } = setup();
    db.prepare("INSERT INTO positions (mint, status, created_at, updated_at, simulated) VALUES (?, 'pending', 1, 1, 1)").run(F.MINT.tco);
    expect(await executor.reconcile()).toHaveLength(1);
    expect(db.prepare("SELECT status FROM positions").all()).toEqual([{ status: "failed" }]);
  });
});

describe("buy: retrying is only allowed before anything is sent", () => {
  it("rebuilds after an RPC hiccup while building", async () => {
    let calls = 0;
    const b = fakeBuilder();
    const real = b.builder.buy;
    b.builder.buy = async (r) => {
      if (++calls === 1) throw new Error("RPC getAccountInfo: timed out after 4000 ms");
      return real(r);
    };
    const { executor, db } = setup({ builder: b });
    expect((await executor.buy(buyReq(db))).status).toBe("simulated");
    expect(calls).toBe(2);
  });

  it("gives up after three failed builds, with the row failed (never left pending)", async () => {
    const b = fakeBuilder({ buy: async () => Promise.reject(new Error("node is down")) });
    const { executor, db } = setup({ builder: b });
    expect(await executor.buy(buyReq(db))).toMatchObject({ status: "failed", error: "couldn't build the buy after 3 tries: node is down" });
    expect(db.prepare("SELECT status FROM positions").all()).toEqual([{ status: "failed" }]);
  });
});

describe("dry-run never hands a signed transaction to anyone", () => {
  it("the transaction sent for simulation has no signature, even when the real wallet is the payer", async () => {
    const seen: string[] = [];
    const kp = web3.Keypair.generate();
    const signer = { publicKey: kp.publicKey.toBase58(), ephemeral: false, sign: (tx: InstanceType<typeof web3.VersionedTransaction>) => tx.sign([kp]) };
    const { fetch } = fakeFetch(solanaRpcRoutes({ simulate: (p) => (seen.push(p[0] as string), { err: null, logs: [] }) }));
    const db = openDb(":memory:");
    const executor = new Executor({ mode: "dry-run", rpc: new SolanaRpc({ url: URL, fetch }), chain: {} as ChainReader, builder: fakeBuilder().builder, signer, simPayer: signer.publicKey, guardrails: config.guardrails, db, log: createLogger({ write: () => {} }) });
    expect((await executor.buy(buyReq(db))).status).toBe("simulated");
    expect(seen).toHaveLength(1);
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(seen[0]!, "base64"));
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(signer.publicKey);
    expect(tx.signatures.every((sig) => sig.every((b) => b === 0))).toBe(true);
  });
});

describe("live sells: an unconfirmed sale is checked against the wallet", () => {
  const WALLET_ATA = splToken.getAssociatedTokenAddressSync(new web3.PublicKey(F.MINT.plain), liveKey.publicKey, true, new web3.PublicKey(PROGRAMS.token2022)).toBase58();
  const raw = (amount: bigint) => ({ owner: PROGRAMS.token2022, lamports: 1, executable: false, data: Buffer.from(tokenAccountBase64(amount), "base64").toString("hex") });

  async function bought(chain: FakeChain) {
    const state = { confirm: { status: "confirmed" } as Awaited<ReturnType<Sender["confirm"]>>, onSend: () => {} };
    const s: Sender = { send: async () => (state.onSend(), "x"), confirm: async () => state.confirm };
    const ctx = setup({ mode: "live", sender: s, chain });
    const buy = await ctx.executor.buy(buyReq(ctx.db));
    if (buy.status !== "confirmed") throw new Error("setup buy failed");
    return { ...ctx, state, id: buy.positionId };
  }

  it("'expired' but the wallet holds that much less: it landed, so it isn't sold again", async () => {
    const chain: FakeChain = { accounts: { [WALLET_ATA]: raw(1_000n) } };
    const t = await bought(chain);
    t.state.confirm = { status: "expired" };
    t.state.onSend = () => (chain.accounts![WALLET_ATA] = raw(750n)); // the sale lands while we wait
    const out = await t.executor.sell(t.id, 250n, "take_profit", { stepsDone: 1 });
    expect(out).toMatchObject({ status: "confirmed", tokensSold: 250n, remaining: 750n });
    expect(t.executor.position(t.id)).toMatchObject({ tokens_held: "750", steps_done: 1, status: "open" });
  });

  it("'expired' and the wallet is unchanged: it didn't land, and the step isn't counted", async () => {
    const t = await bought({ accounts: { [WALLET_ATA]: raw(1_000n) } });
    t.state.confirm = { status: "expired" };
    expect(await t.executor.sell(t.id, 250n, "take_profit", { stepsDone: 1 })).toEqual({ status: "failed", error: "sell not confirmed (expired)" });
    expect(t.executor.position(t.id)).toMatchObject({ tokens_held: "1000", steps_done: 0, status: "open" });
  });

  it("one empty balance read doesn't close the position: the second read is believed", async () => {
    const chain: FakeChain = { accounts: { [WALLET_ATA]: raw(1_000n) } };
    const t = await bought(chain);
    // A node that's behind reports the account as missing once, then correctly.
    let reads = 0;
    const real = chain.accounts![WALLET_ATA]!;
    Object.defineProperty(chain.accounts!, WALLET_ATA, { get: () => (++reads === 1 ? undefined : real), configurable: true });
    const out = await t.executor.sell(t.id, "all", "stop_loss");
    expect(out).toMatchObject({ status: "confirmed", tokensSold: 1_000n });
  });

  it("two empty reads in a row do close it (you sold by hand)", async () => {
    const chain: FakeChain = { accounts: { [WALLET_ATA]: raw(1_000n) } };
    const t = await bought(chain);
    delete chain.accounts![WALLET_ATA];
    expect(await t.executor.sell(t.id, "all", "stop_loss")).toEqual({ status: "failed", error: "nothing left to sell" });
    expect(t.executor.position(t.id)!.status).toBe("closed");
  });
});
