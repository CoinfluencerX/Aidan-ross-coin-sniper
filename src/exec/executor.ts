import { tokenAccountAmount, type ChainReader, type MarketFacts, type MintFacts, type Venue } from "../chain/facts.ts";
import type { SimulationResult, SolanaRpc } from "../chain/rpc.ts";
import { PROGRAMS, splToken, web3, type Web3Module } from "../chain/sdk.ts";
import type { Mode } from "../config/mode.ts";
import type { Guardrails } from "../config/schemas.ts";
import { base58Encode } from "../extract/base58.ts";
import type { Logger } from "../log/logger.ts";
import { audit } from "../state/audit.ts";
import type { Db } from "../state/db.ts";
import { acquireBuyLock, setPositionStatus } from "../state/positions.ts";
import type { RoundTripResult } from "../validate/validator.ts";
import type { BuiltTrade, TradeBuilder, TradeRequest } from "./builder.ts";
import type { Sender } from "./send.ts";
import type { Signer } from "./wallet.ts";

/**
 * The executor turns a validated signal into a buy, and the exit manager's decisions into sells.
 *
 * Dry-run: every transaction is built and signed, then SIMULATED. Nothing is sent, because no
 * sender exists in dry-run. Buys are simulated on chain state; sells are priced from a live quote
 * (the simulation wallet doesn't hold the tokens, so a sell can't be simulated on its own).
 *
 * Live: the same path, ending in `sender.send`. The one-shot buy lock is taken BEFORE anything is
 * built, so a duplicate signal or a restart can never buy the same coin twice.
 */

type Tx = Web3Module.VersionedTransaction;
type Ix = Web3Module.TransactionInstruction;

/** Any valid blockhash works for simulation: the node replaces it. */
const PLACEHOLDER_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
const MAX_TX_BYTES = 1232;
const BUY_COMPUTE_UNITS = 400_000;
/** Tries at building the buy before anything is sent. Once a send is attempted there is never a retry. */
const PRE_SEND_ATTEMPTS = 3;
/** A blockhash is valid for roughly 60-90 s. Wait that long before calling a buy unconfirmed. */
const BUY_CONFIRM_MS = 90_000;
const SELL_CONFIRM_MS = 60_000;
/** After this long with no tokens in the wallet, a sent buy can no longer land. */
const BUY_GIVE_UP_MS = 180_000;

export interface PositionRow {
  id: number;
  mint: string;
  status: "pending" | "open" | "closing" | "closed" | "failed";
  simulated: number;
  venue: Exclude<Venue, "none"> | null;
  token_program: "spl-token" | "token-2022" | null;
  tokens_bought: string | null;
  tokens_held: string | null;
  cost_lamports: number | null;
  proceeds_lamports: number;
  entry_price: number | null;
  peak_price: number | null;
  steps_done: number;
  opened_at: number | null;
  close_reason: string | null;
  source: string | null;
  post_id: string | null;
  creator: string | null;
}

export type BuyOutcome =
  | { status: "skipped"; reason: string }
  | { status: "failed"; positionId: number; error: string }
  /** Live only: the buy was sent but we can't yet tell whether it landed. The position stays pending and reconcile() settles it. */
  | { status: "unknown"; positionId: number; signature: string; detail: string }
  | {
      status: "simulated" | "confirmed";
      positionId: number;
      tokens: bigint;
      lamports: bigint;
      entryPrice: number;
      variant: string;
      /** Milliseconds from the start of the buy to a signed transaction. */
      signedMs: number;
      totalMs: number;
      units: number | undefined;
      signature: string | undefined;
    };

export type SellOutcome =
  | { status: "failed"; error: string }
  | { status: "simulated" | "confirmed"; tokensSold: bigint; lamportsOut: bigint; remaining: bigint; variant: string; signature: string | undefined };

export interface BuyRequest {
  mint: string;
  signalId: number;
  source: string;
  postId: string;
  lamportsIn: bigint;
  mintFacts: MintFacts;
  market: MarketFacts;
}

export interface ExecutorOptions {
  mode: Mode;
  rpc: SolanaRpc;
  chain: ChainReader;
  builder: TradeBuilder;
  signer: Signer;
  /**
   * Public key used as the trader in simulations. In live mode it must be the wallet itself.
   * In dry-run it can be any funded address: nothing is signed for it and nothing is sent.
   */
  simPayer: string | undefined;
  guardrails: Guardrails;
  db: Db;
  log: Logger;
  /** Live mode only. Absent in dry-run, which is what makes sending impossible there. */
  sender?: Sender | undefined;
  /** Live mode only: a tip instruction for Jito, when a tip account is known. */
  tipInstruction?: ((payer: Web3Module.PublicKey) => Ix | undefined) | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function compileTx(payer: string, blockhash: string, instructions: Ix[]): Tx {
  const msg = new web3.TransactionMessage({ payerKey: new web3.PublicKey(payer), recentBlockhash: blockhash, instructions }).compileToV0Message();
  return new web3.VersionedTransaction(msg);
}

const toBase64 = (tx: Tx) => Buffer.from(tx.serialize()).toString("base64");

/** Serialized size in bytes, or null when the transaction is too big to serialize at all. */
export function txSize(tx: Tx): number | null {
  try {
    return tx.serialize().length;
  } catch {
    return null;
  }
}

/** The most useful line from a failed simulation, for humans. */
export function simulationFailure(sim: SimulationResult): string {
  const logs = sim.logs ?? [];
  if (logs.some((l) => /insufficient lamports|insufficient funds/i.test(l))) return "the simulation wallet doesn't hold enough SOL for this buy";
  const line = [...logs].reverse().find((l) => /AnchorError|Error Message|custom program error|failed:/i.test(l));
  const msg = line?.replace(/^Program log: /, "").slice(0, 200);
  return msg ?? `error ${JSON.stringify(sim.err).slice(0, 120)}`;
}

export class Executor {
  readonly #o: ExecutorOptions;
  /** The buy built for the validator's simulation, kept a few seconds so the real buy doesn't rebuild it. */
  readonly #prebuilt = new Map<string, { at: number; built: BuiltTrade }>();
  /** Positions a buy() call is working on right now. reconcile() must not touch them. */
  readonly #inFlight = new Set<number>();
  constructor(o: ExecutorOptions) {
    if (o.mode === "live" && !o.sender) throw new Error("live mode needs a sender");
    if (o.mode === "dry-run" && o.sender) throw new Error("dry-run must never be given a sender");
    if (o.mode === "live" && o.signer.ephemeral) throw new Error("live mode needs the real wallet, not a throwaway key");
    if (o.mode === "live" && o.simPayer !== o.signer.publicKey) throw new Error("in live mode, simulations must run as the wallet itself");
    this.#o = o;
  }

  get canSimulate(): boolean {
    return this.#o.simPayer !== undefined;
  }

  #request(mint: string, tokenProgram: MintFacts["tokenProgram"], venue: Exclude<Venue, "none">, user: string): TradeRequest {
    return { mint, tokenProgram: tokenProgram ?? "spl-token", user, venue, slippageBps: this.#o.guardrails.buy.max_slippage_bps };
  }

  #budget(): Ix[] {
    return [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: BUY_COMPUTE_UNITS }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.#o.guardrails.buy.priority_fee_micro_lamports }),
    ];
  }

  #txFor(built: BuiltTrade, payer: string, blockhash: string, withTip: boolean): Tx {
    if (built.prebuiltTx) return web3.VersionedTransaction.deserialize(Buffer.from(built.prebuiltTx, "base64"));
    const tip = withTip ? this.#o.tipInstruction?.(new web3.PublicKey(payer)) : undefined;
    return compileTx(payer, blockhash, [...this.#budget(), ...built.instructions, ...(tip ? [tip] : [])]);
  }

  /**
   * Validator hook: simulate buying our size and selling part of it straight back, in one
   * transaction. If the sell leg can't run, neither could our real exit. Nothing is sent.
   */
  simulateRoundTrip = async (mint: string, lamportsIn: bigint, mintFacts: MintFacts, market: MarketFacts): Promise<RoundTripResult> => {
    const payer = this.#o.simPayer;
    if (!payer) return { ok: false, detail: "no wallet to simulate with: set WALLET_KEYPAIR_PATH, or SIM_PAYER_PUBKEY for dry-run" };
    if (market.venue === "none") return { ok: false, detail: "no route to simulate" };
    const req = { ...this.#request(mint, mintFacts.tokenProgram, market.venue, payer), lamportsIn };
    const rt = await this.#o.builder.roundTrip(req);

    if (rt === null) {
      // Jupiter: a buy and a sell can't share one transaction here. Simulate the buy, and require a sell route.
      const buy = await this.#o.builder.buy(req);
      const sim = await this.#o.rpc.simulate(toBase64(this.#txFor(buy, payer, PLACEHOLDER_BLOCKHASH, false)));
      if (sim.err) return { ok: false, detail: `buy simulation failed: ${simulationFailure(sim)}` };
      try {
        await this.#o.builder.sell({ ...req, tokenAmount: (buy.expectedOut * 70n) / 100n });
      } catch (err) {
        return { ok: false, detail: `buy simulates, but there's no sell route: ${(err as Error).message}` };
      }
      return { ok: true, detail: "buy simulates and a sell route is quoted (Jupiter: the sell itself can't be simulated before we hold the token)" };
    }

    // No compute-budget instructions here: they aren't needed to simulate, and the pair must fit in one transaction.
    const tx = compileTx(payer, PLACEHOLDER_BLOCKHASH, rt.instructions);
    const size = txSize(tx);
    if (size === null || size > MAX_TX_BYTES) return { ok: false, detail: `buy+sell doesn't fit in one transaction (${size ?? "over the limit"} bytes), so the sell couldn't be simulated` };
    const sim = await this.#o.rpc.simulate(toBase64(tx));
    if (sim.err) return { ok: false, detail: `buy+sell simulation failed: ${simulationFailure(sim)}` };
    this.#prebuilt.set(`${mint}:${payer}:${lamportsIn}`, { at: performance.now(), built: rt.buy });
    return { ok: true, detail: `buy then sell simulated OK (${rt.buy.variant}, ${sim.unitsConsumed ?? "?"} compute units)` };
  };

  /** Buys once. Takes the one-shot lock first; returns "skipped" if this mint was ever locked before. */
  async buy(req: BuyRequest): Promise<BuyOutcome> {
    const { db, log, guardrails, mode } = this.#o;
    const now = this.#o.now ?? Date.now;
    const started = performance.now();
    if (req.market.venue === "none") return { status: "skipped", reason: "no route" };
    const venue = req.market.venue;

    const lock = acquireBuyLock(db, { mint: req.mint, maxOpenPositions: guardrails.buy.max_open_positions, signalId: req.signalId, now: now() });
    if (!lock.acquired) {
      log.info("buy.skipped", { mint: req.mint, reason: lock.reason });
      return { status: "skipped", reason: lock.reason === "mint_already_locked" ? "this mint was already bought (or tried) once" : "another position is still open" };
    }
    const positionId = lock.positionId;
    // From here until this method returns, reconcile() must leave this row alone.
    this.#inFlight.add(positionId);
    try {
      return await this.#buyLocked(req, positionId, venue, started);
    } catch (err) {
      // Anything unexpected before a send: the row must not stay "pending" forever.
      return this.#failBuy(positionId, req.mint, (err as Error).message);
    } finally {
      this.#inFlight.delete(positionId);
    }
  }

  #failBuy(positionId: number, mint: string, rawError: string): BuyOutcome {
    const { db, log } = this.#o;
    const error = log.redactor.redactString(rawError);
    setPositionStatus(db, positionId, "failed", (this.#o.now ?? Date.now)());
    db.prepare("UPDATE positions SET close_reason = ? WHERE id = ?").run(error.slice(0, 300), positionId);
    log.error("buy.failed", { position_id: positionId, mint, error });
    audit(db, log.redactor, "buy.failed", { position_id: positionId, mint, error });
    return { status: "failed", positionId, error };
  }

  async #buyLocked(req: BuyRequest, positionId: number, venue: Exclude<Venue, "none">, started: number): Promise<BuyOutcome> {
    const { db, log, mode } = this.#o;
    const now = this.#o.now ?? Date.now;
    const tokenProgram = req.mintFacts.tokenProgram ?? "spl-token";
    db.prepare("UPDATE positions SET simulated = ?, venue = ?, token_program = ?, source = ?, post_id = ?, creator = ? WHERE id = ?").run(
      mode === "dry-run" ? 1 : 0,
      venue,
      tokenProgram,
      req.source,
      req.postId,
      req.market.creator ?? null,
      positionId,
    );
    audit(db, log.redactor, "buy.locked", { position_id: positionId, mint: req.mint, venue, lamports: req.lamportsIn.toString(), mode });
    if (mode === "dry-run" && !this.#o.simPayer) return this.#failBuy(positionId, req.mint, "no wallet to simulate with: set WALLET_KEYPAIR_PATH, or SIM_PAYER_PUBKEY for dry-run");

    // In live mode the trader is the wallet. In dry-run it's the simulation payer, so the simulation reflects a funded account.
    const user = mode === "live" ? this.#o.signer.publicKey : (this.#o.simPayer ?? this.#o.signer.publicKey);
    const key = `${req.mint}:${user}:${req.lamportsIn}`;

    // Build and sign. Nothing has been sent yet, so a failure here (an RPC hiccup) is safe to retry a couple of times.
    let built: BuiltTrade | undefined;
    let tx: Tx | undefined;
    let lastError = "";
    for (let attempt = 1; attempt <= PRE_SEND_ATTEMPTS && !tx; attempt++) {
      try {
        const cached = this.#prebuilt.get(key);
        this.#prebuilt.delete(key);
        // Reuse the instructions the validator just simulated if they're under 3 seconds old; otherwise build fresh.
        built =
          cached && performance.now() - cached.at < 3_000
            ? cached.built
            : await this.#o.builder.buy({ ...this.#request(req.mint, tokenProgram, venue, user), lamportsIn: req.lamportsIn });
        const blockhash = mode === "live" ? (await this.#o.rpc.getLatestBlockhash()).blockhash : PLACEHOLDER_BLOCKHASH;
        const candidate = this.#txFor(built, user, blockhash, mode === "live");
        const size = txSize(candidate);
        if (size === null || size > MAX_TX_BYTES) return this.#failBuy(positionId, req.mint, `transaction too large (${size ?? "over the limit"} bytes)`);
        tx = candidate;
      } catch (err) {
        lastError = (err as Error).message;
        log.warn("buy.build_retry", { position_id: positionId, mint: req.mint, attempt, error: lastError });
        if (attempt < PRE_SEND_ATTEMPTS) await this.#sleep(250);
      }
    }
    if (!tx || !built) return this.#failBuy(positionId, req.mint, `couldn't build the buy after ${PRE_SEND_ATTEMPTS} tries: ${lastError}`);

    if (mode === "dry-run") {
      // Sign a COPY, only to time the signing step. The transaction that goes to the RPC for
      // simulation is never signed, so nothing that leaves this process could be broadcast.
      this.#signCopy(tx, built, user);
      const signedMs = Math.round(performance.now() - started);
      const sim = await this.#o.rpc.simulate(toBase64(tx), { accounts: [built.userTokenAccount] });
      if (sim.err) return this.#failBuy(positionId, req.mint, `buy simulation failed: ${simulationFailure(sim)}`);
      const post = sim.accounts?.[0];
      const received = post ? tokenAccountAmount(Buffer.from(post.data[0], "base64")) : undefined;
      const tokens = received && received > 0n ? received : built.expectedOut;
      return this.#opened(positionId, req.mint, req.lamportsIn, tokens, built.variant, "simulated", signedMs, started, sim.unitsConsumed, undefined);
    }

    // ---- live ----
    this.#o.signer.sign(tx);
    const signedMs = Math.round(performance.now() - started);
    const signature = base58Encode(tx.signatures[0]!);
    // Written BEFORE sending, so a crash right after the send still leaves a record to reconcile from.
    db.prepare("INSERT INTO trades (position_id, side, signature, lamports, token_amount, status, created_at) VALUES (?, 'buy', ?, ?, ?, 'sent', ?)").run(
      positionId,
      signature,
      Number(req.lamportsIn),
      built.expectedOut.toString(),
      now(),
    );
    const sender = this.#o.sender!;
    try {
      await sender.send(toBase64(tx));
      log.info("buy.sent", { position_id: positionId, mint: req.mint, signature, signed_ms: signedMs });
    } catch (err) {
      // A send that errors can still have landed (a timeout after the node accepted it). Never retry; go and look.
      log.warn("buy.send_error", { position_id: positionId, mint: req.mint, signature, error: (err as Error).message });
    }
    const conf = await sender.confirm(signature, BUY_CONFIRM_MS);
    const held = await this.#settledBalance(this.#tokenAccount(req.mint, user, tokenProgram));
    if (held !== undefined && held > 0n) {
      db.prepare("UPDATE trades SET status = 'confirmed' WHERE signature = ?").run(signature);
      return this.#opened(positionId, req.mint, req.lamportsIn, held, built.variant, "confirmed", signedMs, started, undefined, signature);
    }
    if (conf.status === "failed") {
      db.prepare("UPDATE trades SET status = 'failed' WHERE signature = ?").run(signature);
      return this.#failBuy(positionId, req.mint, `buy transaction failed on chain: ${JSON.stringify(conf.err).slice(0, 120)}`);
    }
    if (conf.status === "expired" && held === 0n) {
      db.prepare("UPDATE trades SET status = 'failed' WHERE signature = ?").run(signature);
      return this.#failBuy(positionId, req.mint, "buy never confirmed and no tokens arrived");
    }
    // Confirmed but the balance isn't visible yet, or the balance couldn't be read. Don't guess:
    // leave it pending. reconcile() keeps checking and opens or fails it.
    const detail = conf.status === "confirmed" ? "confirmed, but the tokens aren't visible in the wallet yet" : "not confirmed, and the wallet balance couldn't be read";
    log.warn("buy.unresolved", { position_id: positionId, mint: req.mint, signature, detail });
    audit(db, log.redactor, "buy.unresolved", { position_id: positionId, mint: req.mint, signature, detail });
    return { status: "unknown", positionId, signature, detail };
  }

  /** Signs a copy of `tx` to measure the signing step. The copy is discarded. */
  #signCopy(tx: Tx, built: BuiltTrade, user: string): void {
    try {
      if (user === this.#o.signer.publicKey) this.#o.signer.sign(web3.VersionedTransaction.deserialize(tx.serialize()));
      else this.#o.signer.sign(compileTx(this.#o.signer.publicKey, PLACEHOLDER_BLOCKHASH, built.instructions.length ? [...this.#budget(), ...built.instructions] : this.#budget()));
    } catch {
      // timing only: never let it affect the trade
    }
  }

  #sleep(ms: number): Promise<void> {
    return this.#o.sleep ? this.#o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** The wallet's standard token account for a mint, derived locally (no network). */
  #tokenAccount(mint: string, owner: string, tokenProgram: string | null): string {
    const programId = new web3.PublicKey(tokenProgram === "token-2022" ? PROGRAMS.token2022 : PROGRAMS.splToken);
    return splToken.getAssociatedTokenAddressSync(new web3.PublicKey(mint), new web3.PublicKey(owner), true, programId).toBase58();
  }

  /** One balance read. undefined = the read failed. A missing account reads as 0. */
  async #walletBalance(tokenAccount: string): Promise<bigint | undefined> {
    try {
      const [acc] = await this.#o.rpc.getAccounts([tokenAccount]);
      return acc ? (tokenAccountAmount(acc.data) ?? 0n) : 0n;
    } catch {
      return undefined;
    }
  }

  /**
   * A balance we're willing to act on. A zero is only believed after a second read agrees:
   * a node that's a moment behind reports a brand-new token account as missing.
   */
  async #settledBalance(tokenAccount: string): Promise<bigint | undefined> {
    const first = await this.#walletBalance(tokenAccount);
    if (first === undefined || first > 0n) return first;
    await this.#sleep(700);
    return this.#walletBalance(tokenAccount);
  }

  #opened(positionId: number, mint: string, lamportsIn: bigint, tokens: bigint, variant: string, status: "simulated" | "confirmed", signedMs: number, started: number, units: number | undefined, signature: string | undefined): BuyOutcome & { status: "simulated" | "confirmed" } {
    const { db, log } = this.#o;
    const now = (this.#o.now ?? Date.now)();
    const entryPrice = Number(lamportsIn) / Number(tokens);
    db.prepare(
      "UPDATE positions SET status = 'open', tokens_bought = ?, tokens_held = ?, cost_lamports = ?, entry_price = ?, peak_price = ?, opened_at = ?, updated_at = ? WHERE id = ?",
    ).run(tokens.toString(), tokens.toString(), Number(lamportsIn), entryPrice, entryPrice, now, now, positionId);
    if (status === "simulated") {
      db.prepare("INSERT INTO trades (position_id, side, signature, lamports, token_amount, status, created_at) VALUES (?, 'buy', NULL, ?, ?, 'simulated', ?)").run(positionId, Number(lamportsIn), tokens.toString(), now);
    }
    const totalMs = Math.round(performance.now() - started);
    log.info("buy.done", { position_id: positionId, mint, status, variant, lamports: lamportsIn.toString(), token_amount: tokens.toString(), entry_price: entryPrice, signed_ms: signedMs, total_ms: totalMs, units, signature });
    audit(db, log.redactor, "buy.done", { position_id: positionId, mint, status, variant, lamports: lamportsIn.toString(), token_amount: tokens.toString(), signature });
    return { status, positionId, tokens, lamports: lamportsIn, entryPrice, variant, signedMs, totalMs, units, signature };
  }

  /**
   * Settles positions left in "pending": a buy whose outcome wasn't known when buy() returned,
   * or one interrupted by a crash or restart. Called at startup and on every exit-manager tick.
   * Returns one line per position it settled, for the owner.
   */
  async reconcile(): Promise<string[]> {
    const { db, mode } = this.#o;
    const now = (this.#o.now ?? Date.now)();
    const out: string[] = [];
    const pending = (db.prepare("SELECT * FROM positions WHERE status = 'pending' ORDER BY id").all() as unknown as PositionRow[]).filter((p) => !this.#inFlight.has(p.id));
    for (const pos of pending) {
      const short = `${pos.mint.slice(0, 4)}…${pos.mint.slice(-4)}`;
      const age = now - Number((db.prepare("SELECT created_at FROM positions WHERE id = ?").get(pos.id) as { created_at: number }).created_at);
      const trade = db.prepare("SELECT signature, lamports FROM trades WHERE position_id = ? AND side = 'buy' AND signature IS NOT NULL ORDER BY id DESC LIMIT 1").get(pos.id) as { signature: string; lamports: number } | undefined;
      // Nothing was ever sent for it (paper position, or interrupted before the send): it can't have bought anything.
      if (pos.simulated === 1 || mode === "dry-run" || !trade) {
        this.#failBuy(pos.id, pos.mint, "interrupted before the buy was sent");
        out.push(`Position #${pos.id} (${short}) was interrupted before anything was sent. Marked failed; this coin stays locked.`);
        continue;
      }
      const held = await this.#settledBalance(this.#tokenAccount(pos.mint, this.#o.signer.publicKey, pos.token_program));
      if (held !== undefined && held > 0n) {
        db.prepare("UPDATE trades SET status = 'confirmed' WHERE signature = ?").run(trade.signature);
        this.#opened(pos.id, pos.mint, BigInt(trade.lamports), held, pos.venue ?? "unknown", "confirmed", 0, performance.now(), undefined, trade.signature);
        out.push(`Position #${pos.id} (${short}): the buy DID land. Tokens found in the wallet; the position is now open and managed.`);
      } else if (held === 0n && age > BUY_GIVE_UP_MS) {
        // Well past the blockhash lifetime with nothing in the wallet: it can't land any more.
        db.prepare("UPDATE trades SET status = 'failed' WHERE signature = ?").run(trade.signature);
        this.#failBuy(pos.id, pos.mint, "buy never landed: no tokens in the wallet after the transaction expired");
        out.push(`Position #${pos.id} (${short}): the buy never landed. Marked failed; this coin stays locked.`);
      }
      // Otherwise: still too early, or the balance can't be read. Try again next time.
    }
    return out;
  }

  position(id: number): PositionRow | undefined {
    return this.#o.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined;
  }

  /** Positions that hold, or may hold, real or paper tokens: open, closing, or a buy still being settled. */
  activePositionCount(): number {
    return (this.#o.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE status IN ('pending', 'open', 'closing')").get() as { n: number }).n;
  }

  openPositions(): PositionRow[] {
    return this.#o.db.prepare("SELECT * FROM positions WHERE status IN ('open', 'closing') ORDER BY id").all() as unknown as PositionRow[];
  }

  /**
   * Sells an exact number of token units, or "all" that the position still holds. Safe to call
   * again after a failure: in live mode the amount is capped by the wallet's real balance each time.
   * `stepsDone` is written in the same statement as the new balance, so a crash can't leave a
   * take-profit step sold but not counted.
   */
  async sell(positionId: number, units: bigint | "all", reason: string, opts: { stepsDone?: number } = {}): Promise<SellOutcome> {
    const { db, log, mode } = this.#o;
    const now = this.#o.now ?? Date.now;
    const pos = this.position(positionId);
    if (!pos || (pos.status !== "open" && pos.status !== "closing")) return { status: "failed", error: "position isn't open" };
    let held = BigInt(pos.tokens_held ?? "0");
    const tokenProgram = pos.token_program ?? "spl-token";

    try {
      const market = await this.#o.chain.marketFacts(pos.mint, tokenProgram);
      // A token bought through Jupiter has no pump.fun venue; keep selling it the same way.
      const venue: Venue = market.venue !== "none" ? market.venue : pos.venue === "jupiter" ? "jupiter" : "none";
      if (venue === "none") return { status: "failed", error: `nowhere to sell right now: ${market.detail}` };
      const user = mode === "live" ? this.#o.signer.publicKey : (this.#o.simPayer ?? this.#o.signer.publicKey);
      const base = this.#request(pos.mint, tokenProgram, venue, user);
      const account = this.#tokenAccount(pos.mint, user, tokenProgram);

      if (mode === "live") {
        // The wallet is the truth. A read that fails doesn't stop a sale; a believed zero closes the position.
        const real = await this.#settledBalance(account);
        if (real !== undefined) held = real;
      }
      if (held <= 0n) {
        this.#close(positionId, reason, 0n, now());
        return { status: "failed", error: "nothing left to sell" };
      }
      const amount = units === "all" || units >= held ? held : units;
      if (amount <= 0n) return { status: "failed", error: "nothing to sell" };
      const built = await this.#o.builder.sell({ ...base, tokenAmount: amount });

      let signature: string | undefined;
      if (mode === "live") {
        const blockhash = (await this.#o.rpc.getLatestBlockhash()).blockhash;
        const tx = this.#txFor(built, user, blockhash, true);
        this.#o.signer.sign(tx);
        signature = base58Encode(tx.signatures[0]!);
        db.prepare("INSERT INTO trades (position_id, side, signature, lamports, token_amount, status, created_at, reason) VALUES (?, 'sell', ?, ?, ?, 'sent', ?, ?)").run(positionId, signature, Number(built.expectedOut), amount.toString(), now(), reason);
        const sender = this.#o.sender!;
        try {
          await sender.send(toBase64(tx));
        } catch (err) {
          log.warn("sell.send_error", { position_id: positionId, mint: pos.mint, signature, error: (err as Error).message });
        }
        const conf = await sender.confirm(signature, SELL_CONFIRM_MS);
        let landed = conf.status === "confirmed";
        if (!landed && conf.status !== "failed") {
          // Not confirmed in time. If the wallet now holds that much less, it did land: don't sell it again.
          const after = await this.#walletBalance(account);
          landed = after !== undefined && after <= held - amount;
        }
        if (!landed) {
          db.prepare("UPDATE trades SET status = 'failed' WHERE signature = ?").run(signature);
          return { status: "failed", error: conf.status === "failed" ? `sell failed on chain: ${JSON.stringify(conf.err).slice(0, 120)}` : `sell not confirmed (${conf.status})` };
        }
        db.prepare("UPDATE trades SET status = 'confirmed' WHERE signature = ?").run(signature);
      } else {
        db.prepare("INSERT INTO trades (position_id, side, signature, lamports, token_amount, status, created_at, reason) VALUES (?, 'sell', NULL, ?, ?, 'simulated', ?, ?)").run(positionId, Number(built.expectedOut), amount.toString(), now(), reason);
      }

      const remaining = held - amount;
      db.prepare("UPDATE positions SET tokens_held = ?, proceeds_lamports = proceeds_lamports + ?, steps_done = COALESCE(?, steps_done), updated_at = ? WHERE id = ?").run(
        remaining.toString(),
        Number(built.expectedOut),
        opts.stepsDone ?? null,
        now(),
        positionId,
      );
      if (remaining <= 0n) this.#close(positionId, reason, remaining, now());
      const status = mode === "live" ? "confirmed" : "simulated";
      log.info("sell.done", { position_id: positionId, mint: pos.mint, status, reason, variant: built.variant, token_amount: amount.toString(), lamports: built.expectedOut.toString(), remaining: remaining.toString(), signature });
      audit(db, log.redactor, "sell.done", { position_id: positionId, mint: pos.mint, status, reason, token_amount: amount.toString(), lamports: built.expectedOut.toString(), signature });
      return { status, tokensSold: amount, lamportsOut: built.expectedOut, remaining, variant: built.variant, signature };
    } catch (err) {
      const error = log.redactor.redactString((err as Error).message);
      log.error("sell.failed", { position_id: positionId, mint: pos.mint, reason, error });
      return { status: "failed", error };
    }
  }

  #close(positionId: number, reason: string, remaining: bigint, now: number): void {
    this.#o.db.prepare("UPDATE positions SET status = 'closed', close_reason = ?, tokens_held = ?, updated_at = ? WHERE id = ?").run(reason, remaining.toString(), now, positionId);
  }
}
