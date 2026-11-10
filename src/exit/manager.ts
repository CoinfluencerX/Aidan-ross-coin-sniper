import type { ChainReader } from "../chain/facts.ts";
import type { Executor, PositionRow } from "../exec/executor.ts";
import type { Logger } from "../log/logger.ts";
import { audit } from "../state/audit.ts";
import type { Db } from "../state/db.ts";
import { decide, type ExitConfig, type ExitReason, type Tick } from "./rules.ts";

/**
 * Watches every open position and sells when a rule in guardrails.yaml says so.
 * The rules themselves are in rules.ts (pure). This file gathers their inputs: the price,
 * whether liquidity was pulled, whether the creator is selling, whether the source post is gone.
 *
 * A failed sell leaves the position open and is retried on the next tick.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOURCE_CHECK_EVERY_MS = 20_000;

export interface ExitManagerOptions {
  executor: Pick<Executor, "openPositions" | "position" | "sell">;
  chain: Pick<ChainReader, "marketFacts" | "tokenBalance">;
  exit: ExitConfig;
  db: Db;
  log: Logger;
  /** Human-readable event, sent to the terminal and Telegram. */
  notify: (text: string) => void;
  /** true = the post is gone, false = still there, undefined = couldn't tell. */
  isSourceDeleted?: ((source: string, postId: string) => Promise<boolean | undefined>) | undefined;
  now?: () => number;
}

export interface PositionView {
  id: number;
  mint: string;
  simulated: boolean;
  heldPct: number;
  gainPct: number | undefined;
  peakGainPct: number | undefined;
  stepsDone: number;
  costSol: number;
  proceedsSol: number;
  ageMinutes: number;
}

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export class ExitManager {
  readonly #o: ExitManagerOptions;
  readonly #panic = new Set<number>();
  readonly #liquidityPeak = new Map<number, bigint>();
  readonly #creatorBaseline = new Map<number, bigint>();
  readonly #lastSourceCheck = new Map<number, number>();
  readonly #sourceDeleted = new Set<number>();
  readonly #lastPrice = new Map<number, number>();
  readonly #failureNotified = new Set<string>();
  #ticking = false;
  stats = { ticks: 0, sells: 0, sellFailures: 0 };

  constructor(o: ExitManagerOptions) {
    this.#o = o;
  }

  /** /sell: sell everything in one position, or in all of them. Returns how many were flagged. */
  panicSell(positionId?: number): number {
    const targets = this.#o.executor.openPositions().filter((p) => positionId === undefined || p.id === positionId);
    for (const p of targets) this.#panic.add(p.id);
    return targets.length;
  }

  /** Runs until `signal` aborts, checking every `price_poll_ms`. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.#o.exit.price_poll_ms);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
  }

  /** One pass over every open position. Never throws. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    this.stats.ticks++;
    try {
      for (const pos of this.#o.executor.openPositions()) {
        try {
          await this.#check(pos);
        } catch (err) {
          this.#o.log.error("exit.check_failed", { position_id: pos.id, mint: pos.mint, error: err });
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #check(pos: PositionRow): Promise<void> {
    const { exit, log, db } = this.#o;
    const now = (this.#o.now ?? Date.now)();
    if (pos.entry_price === null || pos.tokens_held === null || pos.tokens_bought === null || pos.opened_at === null) return;
    const tick: Tick = { now, price: undefined, panic: this.#panic.has(pos.id) };

    // Price and liquidity.
    try {
      const m = await this.#o.chain.marketFacts(pos.mint, pos.token_program ?? undefined);
      if (m.venue !== "none") tick.price = m.priceLamportsPerUnit;
      // Only a pool can have its liquidity pulled. The bonding curve's can't be withdrawn.
      if (m.venue === "pumpswap" && m.quoteReserveLamports !== undefined) {
        const peak = this.#liquidityPeak.get(pos.id) ?? 0n;
        if (m.quoteReserveLamports > peak) this.#liquidityPeak.set(pos.id, m.quoteReserveLamports);
        else if (Number(m.quoteReserveLamports) < Number(peak) * (1 - exit.liquidity_removed_drop_pct / 100)) tick.liquidityRemoved = true;
      }
    } catch (err) {
      log.warn("exit.price_unavailable", { position_id: pos.id, error: (err as Error).message });
    }
    if (tick.price !== undefined) this.#lastPrice.set(pos.id, tick.price);

    // Creator wallet.
    if (exit.sell_on_creator_sell && pos.creator) {
      try {
        const bal = await this.#o.chain.tokenBalance(pos.creator, pos.mint, pos.token_program ?? undefined);
        const base = this.#creatorBaseline.get(pos.id);
        if (base === undefined) this.#creatorBaseline.set(pos.id, bal);
        else if (base > 0n && Number(bal) < Number(base) * (1 - exit.creator_sell_drop_pct / 100)) tick.creatorSold = true;
      } catch {
        // can't read it this tick: try again next time
      }
    }

    // Source post. Checked on a slower clock, and only for a while after the buy.
    if (this.#sourceDeleted.has(pos.id)) tick.sourceDeleted = true;
    else if (exit.sell_on_source_deleted && this.#o.isSourceDeleted && pos.source && pos.post_id && now - pos.opened_at <= exit.source_deleted_window_minutes * 60_000) {
      if (now - (this.#lastSourceCheck.get(pos.id) ?? 0) >= SOURCE_CHECK_EVERY_MS) {
        this.#lastSourceCheck.set(pos.id, now);
        if ((await this.#o.isSourceDeleted(pos.source, pos.post_id).catch(() => undefined)) === true) {
          this.#sourceDeleted.add(pos.id);
          tick.sourceDeleted = true;
        }
      }
    }

    const decision = decide(
      { entryPrice: pos.entry_price, peakPrice: pos.peak_price ?? pos.entry_price, stepsDone: pos.steps_done, openedAt: pos.opened_at, tokensBought: BigInt(pos.tokens_bought), tokensHeld: BigInt(pos.tokens_held) },
      tick,
      exit,
    );
    if (decision.peakPrice !== pos.peak_price) db.prepare("UPDATE positions SET peak_price = ? WHERE id = ?").run(decision.peakPrice, pos.id);
    if (decision.action.kind === "hold") return;

    const { units, all, reason, detail, stepsDone } = decision.action;
    const sharePct = (Number(units) / Number(BigInt(pos.tokens_bought))) * 100;
    log.info("exit.trigger", { position_id: pos.id, mint: pos.mint, reason, detail, token_amount: units.toString(), gain_pct: decision.gainPct });
    audit(db, log.redactor, "exit.trigger", { position_id: pos.id, mint: pos.mint, reason, detail, token_amount: units.toString() });
    const out = await this.#o.executor.sell(pos.id, all ? "all" : units, reason);
    const tag = pos.simulated ? "PAPER " : "";
    if (out.status === "failed") {
      this.stats.sellFailures++;
      const key = `${pos.id}:${reason}`;
      if (!this.#failureNotified.has(key)) {
        this.#failureNotified.add(key);
        this.#o.notify(`${tag}SELL FAILED (${reason}) on ${short(pos.mint)}: ${out.error}. Retrying every ${(exit.price_poll_ms / 1000).toFixed(1)} s.`);
      }
      return;
    }
    this.stats.sells++;
    this.#panic.delete(pos.id);
    this.#failureNotified.delete(`${pos.id}:${reason}`);
    if (stepsDone !== pos.steps_done) db.prepare("UPDATE positions SET steps_done = ? WHERE id = ?").run(stepsDone, pos.id);
    this.#o.notify(`${tag}SOLD ${sharePct.toFixed(0)}% of the ${short(pos.mint)} position for ${sol(Number(out.lamportsOut))} SOL: ${detail}.`);

    const after = this.#o.executor.position(pos.id);
    if (after?.status === "closed") {
      const cost = after.cost_lamports ?? 0;
      const pnl = after.proceeds_lamports - cost;
      this.#o.notify(
        `${tag}POSITION CLOSED ${short(pos.mint)} (${this.#closeWord(reason)}): in ${sol(cost)} SOL, out ${sol(after.proceeds_lamports)} SOL, ${pnl >= 0 ? "+" : ""}${sol(pnl)} SOL (${cost > 0 ? `${pnl >= 0 ? "+" : ""}${((pnl / cost) * 100).toFixed(1)}%` : "n/a"}), before network fees.`,
      );
      for (const m of [this.#liquidityPeak, this.#creatorBaseline, this.#lastSourceCheck, this.#lastPrice]) m.delete(pos.id);
    }
  }

  #closeWord(reason: ExitReason): string {
    return reason.replace(/_/g, " ");
  }

  /** Open positions as plain numbers, for /status. */
  status(): PositionView[] {
    const now = (this.#o.now ?? Date.now)();
    return this.#o.executor.openPositions().map((p) => {
      const price = this.#lastPrice.get(p.id);
      const entry = p.entry_price ?? 0;
      const bought = Number(p.tokens_bought ?? "0");
      return {
        id: p.id,
        mint: p.mint,
        simulated: p.simulated === 1,
        heldPct: bought > 0 ? (Number(p.tokens_held ?? "0") / bought) * 100 : 0,
        gainPct: price !== undefined && entry > 0 ? (price / entry - 1) * 100 : undefined,
        peakGainPct: p.peak_price !== null && entry > 0 ? (p.peak_price / entry - 1) * 100 : undefined,
        stepsDone: p.steps_done,
        costSol: (p.cost_lamports ?? 0) / LAMPORTS_PER_SOL,
        proceedsSol: p.proceeds_lamports / LAMPORTS_PER_SOL,
        ageMinutes: p.opened_at !== null ? (now - p.opened_at) / 60_000 : 0,
      };
    });
  }
}
