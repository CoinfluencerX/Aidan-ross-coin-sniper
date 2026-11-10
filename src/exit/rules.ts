import type { Guardrails } from "../config/schemas.ts";

/**
 * The sell rules, as one pure function: position + current tick + config -> what to do.
 * No I/O, no clock, no randomness, so a recorded price series replays to the same decisions.
 *
 * Every number comes from config/guardrails.yaml. Nothing here picks a threshold.
 */

export type ExitConfig = Guardrails["exit"];

export interface PositionState {
  /** Lamports per raw token unit paid at entry. */
  entryPrice: number;
  /** Highest price seen since entry. */
  peakPrice: number;
  /** Take-profit steps already sold. */
  stepsDone: number;
  openedAt: number;
  tokensBought: bigint;
  tokensHeld: bigint;
}

export interface Tick {
  now: number;
  /** Current price, or undefined when it couldn't be read this tick. */
  price: number | undefined;
  sourceDeleted?: boolean;
  liquidityRemoved?: boolean;
  creatorSold?: boolean;
  /** The owner sent /sell. */
  panic?: boolean;
}

export type ExitReason = "panic" | "source_deleted" | "liquidity_removed" | "creator_sold" | "stop_loss" | "trailing_stop" | "max_hold" | "take_profit";

export type ExitAction =
  | { kind: "hold" }
  | {
      kind: "sell";
      /** Exact token units to sell. Never more than is held. */
      units: bigint;
      /** True when this sells everything that's left. */
      all: boolean;
      reason: ExitReason;
      detail: string;
      /** Ladder steps completed after this sale. */
      stepsDone: number;
    };

export interface Decision {
  action: ExitAction;
  /** Updated peak, to store even on "hold". */
  peakPrice: number;
  /** Gain vs entry in percent, when the price is known. */
  gainPct: number | undefined;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
/** Thresholds are compared with this much slack, so a price sitting exactly on one isn't missed to floating-point rounding. */
const EPS = 1e-9;

export function decide(pos: PositionState, tick: Tick, cfg: ExitConfig): Decision {
  const price = tick.price;
  const peakPrice = price !== undefined ? Math.max(pos.peakPrice, price) : pos.peakPrice;
  const gainPct = price !== undefined && pos.entryPrice > 0 ? (price / pos.entryPrice - 1) * 100 : undefined;
  const all = (reason: ExitReason, detail: string): Decision => ({ action: { kind: "sell", units: pos.tokensHeld, all: true, reason, detail, stepsDone: pos.stepsDone }, peakPrice, gainPct });
  if (pos.tokensHeld <= 0n) return { action: { kind: "hold" }, peakPrice, gainPct };

  // 1. Emergencies first. These don't need a price.
  if (tick.panic) return all("panic", "you sent /sell");
  if (cfg.sell_on_source_deleted && tick.sourceDeleted) return all("source_deleted", "the post that triggered the buy was deleted");
  if (cfg.sell_on_liquidity_removed && tick.liquidityRemoved) return all("liquidity_removed", "liquidity was pulled from the pool");
  if (cfg.sell_on_creator_sell && tick.creatorSold) return all("creator_sold", "the coin's creator wallet is selling");

  // 2. Stops.
  if (gainPct !== undefined && price !== undefined) {
    if (cfg.stop_loss_pct !== null && gainPct <= -cfg.stop_loss_pct + EPS) return all("stop_loss", `price is ${pct(gainPct)} vs entry (stop-loss at -${cfg.stop_loss_pct}%)`);
    if (cfg.trailing_stop_pct !== null && peakPrice > 0) {
      const fromPeak = (price / peakPrice - 1) * 100;
      if (fromPeak <= -cfg.trailing_stop_pct + EPS) return all("trailing_stop", `price is ${pct(fromPeak)} from its peak (trailing stop at -${cfg.trailing_stop_pct}%), ${pct(gainPct)} vs entry`);
    }
  }
  if (cfg.max_hold_minutes !== null && tick.now - pos.openedAt >= cfg.max_hold_minutes * 60_000) {
    return all("max_hold", `held for ${cfg.max_hold_minutes} minutes${gainPct !== undefined ? `, ${pct(gainPct)} vs entry` : ""}`);
  }

  // 3. Take-profit ladder. Each step sells a share of the ORIGINAL position. If the price jumps
  //    past several steps between two ticks, they're sold together.
  if (gainPct !== undefined) {
    let stepsDone = pos.stepsDone;
    let sellPctOfOriginal = 0;
    while (stepsDone < cfg.take_profit_ladder.length && gainPct >= cfg.take_profit_ladder[stepsDone]!.gain_pct - EPS) {
      sellPctOfOriginal += cfg.take_profit_ladder[stepsDone]!.sell_pct;
      stepsDone++;
    }
    if (stepsDone > pos.stepsDone) {
      const wanted = (pos.tokensBought * BigInt(Math.round(sellPctOfOriginal * 100))) / 10_000n;
      const units = wanted >= pos.tokensHeld ? pos.tokensHeld : wanted;
      const steps = stepsDone - pos.stepsDone === 1 ? `step ${stepsDone}` : `steps ${pos.stepsDone + 1}-${stepsDone}`;
      return {
        action: { kind: "sell", units, all: units === pos.tokensHeld, reason: "take_profit", detail: `take-profit ${steps}: ${pct(gainPct)} vs entry, selling ${sellPctOfOriginal}% of the position`, stepsDone },
        peakPrice,
        gainPct,
      };
    }
  }
  return { action: { kind: "hold" }, peakPrice, gainPct };
}
