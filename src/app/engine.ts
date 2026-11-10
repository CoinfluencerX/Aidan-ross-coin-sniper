import { formatAlert } from "../alert/console.ts";
import type { ChainReader } from "../chain/facts.ts";
import type { AppConfig } from "../config/load.ts";
import type { Mode } from "../config/mode.ts";
import type { Executor } from "../exec/executor.ts";
import type { Logger } from "../log/logger.ts";
import { audit } from "../state/audit.ts";
import type { Db } from "../state/db.ts";
import { recordDecisions, validate, verdictLines, type ValidatorDeps, type Verdict } from "../validate/validator.ts";
import type { AddressSignal, Assessment } from "../watch/signal.ts";

/**
 * What happens after a watcher finds an address in an official post:
 *   signal -> validator -> (executor, added in M3) -> alert.
 *
 * The engine is the only place a buy can start, and it only ever starts from a signal that a
 * watcher recorded from an allowlisted account.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface EngineOptions {
  mode: Mode;
  config: AppConfig;
  db: Db;
  log: Logger;
  alert: (text: string) => void;
  color: boolean;
  /** Reads the chain for the validator. Without it (no RPC_HTTP_URL) signals are alerted but not validated. */
  chain?: ChainReader | undefined;
  simulateRoundTrip?: ValidatorDeps["simulateRoundTrip"];
  jupiterRoute?: ValidatorDeps["jupiterRoute"];
  solUsd?: ValidatorDeps["solUsd"];
  /** Buys (simulated in dry-run) when the validator passes. Without it, the engine only validates and alerts. */
  executor?: Executor | undefined;
  /** Told about every position the executor opens, so the exit manager can start watching it. */
  onPositionOpened?: ((positionId: number) => void) | undefined;
  now?: () => number;
}

/** Lamports for the first buy: the configured size times the first-signal fraction (the hacked-account guard). */
export function firstBuyLamports(config: AppConfig): bigint {
  return BigInt(Math.round(config.guardrails.buy.sol_per_buy * config.guardrails.confirmation.first_signal_fraction * LAMPORTS_PER_SOL));
}

/** Raw token units as a decimal number with thousands separators, e.g. 357142857142 at 6 decimals -> "357,142.857142". */
export function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimals > 0 ? `${whole}.${s.slice(s.length - decimals)}` : whole;
}

export class Engine {
  readonly #o: EngineOptions;
  readonly #pending = new Set<Promise<void>>();
  stats = { signals: 0, validated: 0, passed: 0, blocked: 0, bought: 0, skipped: 0, failed: 0, errors: 0 };

  constructor(o: EngineOptions) {
    this.#o = o;
  }

  /** Watcher callback. Returns at once: validation runs in the background and `drain()` waits for it. */
  onSignal = (s: AddressSignal, a: Assessment, signalId: number): void => {
    this.stats.signals++;
    const p: Promise<void> = this.handle(s, a, signalId).then(
      () => undefined,
      (err) => {
        this.stats.errors++;
        this.#o.log.error("engine.failed", { mint: s.mint, post_id: s.postId, error: err });
      },
    );
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  };

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
  }

  async handle(s: AddressSignal, a: Assessment, signalId: number): Promise<Verdict | undefined> {
    const { log, db, config, mode } = this.#o;
    const now = this.#o.now ?? Date.now;
    if (!this.#o.chain) {
      this.#o.alert(formatAlert(s, a, { color: this.#o.color, mode, now: now(), footer: `${mode.toUpperCase()}: nothing is bought. Validator is off: RPC_HTTP_URL isn't set.` }));
      return undefined;
    }

    const verdict = await validate(s, firstBuyLamports(config), {
      config: config.validator,
      accounts: config.accounts,
      guardrails: config.guardrails,
      mode,
      chain: this.#o.chain,
      db,
      simulateRoundTrip: this.#o.executor?.simulateRoundTrip ?? this.#o.simulateRoundTrip,
      jupiterRoute: this.#o.jupiterRoute,
      solUsd: this.#o.solUsd,
      now,
    });
    this.stats.validated++;
    verdict.decision === "buy" ? this.stats.passed++ : this.stats.blocked++;
    recordDecisions(db, signalId, verdict, now());
    log.info("validation", {
      mint: s.mint,
      post_id: s.postId,
      decision: verdict.decision,
      elapsed_ms: verdict.elapsedMs,
      venue: verdict.market?.venue ?? null,
      token: verdict.token,
      blocks: verdict.blocks.map((o) => ({ id: o.id, detail: o.detail })),
      warns: verdict.warns.map((o) => ({ id: o.id, detail: o.detail })),
    });
    audit(db, log.redactor, "validation", { signal_id: signalId, mint: s.mint, decision: verdict.decision, outcomes: verdict.outcomes, elapsed_ms: verdict.elapsedMs });

    const extra = verdictLines(verdict);
    let executed = false;
    if (verdict.decision === "buy" && this.#o.executor && verdict.mintFacts && verdict.market) {
      const lamportsIn = firstBuyLamports(config);
      const out = await this.#o.executor.buy({ mint: s.mint, signalId, source: s.source, postId: s.postId, lamportsIn, mintFacts: verdict.mintFacts, market: verdict.market });
      executed = true;
      const decimals = verdict.mintFacts.decimals ?? 6;
      if (out.status === "skipped") {
        this.stats.skipped++;
        extra.push(`BUY SKIPPED: ${out.reason}`);
      } else if (out.status === "failed") {
        this.stats.failed++;
        extra.push(`BUY FAILED: ${out.error}`, "  This mint is now locked: the bot will not try it again.");
      } else {
        this.stats.bought++;
        // Skip it if the post's timestamp is ahead of our clock (clock skew): a negative delay means nothing.
        const postLag = s.postCreatedAt ? s.receivedAt - Date.parse(s.postCreatedAt) : undefined;
        const postToSigned = postLag !== undefined && postLag >= 0 ? postLag + verdict.elapsedMs + out.signedMs : undefined;
        extra.push(
          `${out.status === "simulated" ? "BUY SIMULATED" : "BOUGHT"}: ${(Number(out.lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${formatUnits(out.tokens, decimals)} tokens via ${out.variant}`,
          `  validate ${verdict.elapsedMs} ms + build/sign ${out.signedMs} ms${postToSigned !== undefined ? ` · post -> signed tx ${(postToSigned / 1000).toFixed(2)} s` : ""}`,
          `  position #${out.positionId}${out.status === "simulated" ? " (paper: no real transaction)" : ` · ${out.signature}`}`,
        );
        log.info("latency", {
          mint: s.mint,
          post_to_watcher_ms: postLag ?? null,
          validate_ms: verdict.elapsedMs,
          build_sign_ms: out.signedMs,
          signal_to_signed_ms: verdict.elapsedMs + out.signedMs,
          post_to_signed_ms: postToSigned ?? null,
        });
        this.#o.onPositionOpened?.(out.positionId);
      }
    }

    const severity = verdict.decision === "blocked" ? "red" : verdict.warns.length ? "yellow" : "green";
    this.#o.alert(
      formatAlert(s, { severity, reasons: [] }, {
        color: this.#o.color,
        mode,
        now: now(),
        extra,
        footer: mode === "live" ? "LIVE MODE." : executed ? "DRY-RUN: no real transaction was sent." : "DRY-RUN: nothing is bought.",
      }),
    );
    return verdict;
  }
}
