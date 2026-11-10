import type { FetchFn } from "../extract/expand.ts";
import { PROGRAMS } from "./sdk.ts";

/**
 * Jupiter's public HTTP API: SOL price, and a swap route for tokens that aren't on pump.fun
 * or PumpSwap. Quotes are read-only. `swapTransaction` only BUILDS an unsigned transaction;
 * nothing here signs or sends.
 */

const BASE = "https://lite-api.jup.ag";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: { swapInfo: { label?: string } }[];
}

export class JupiterClient {
  readonly #fetch: FetchFn;
  readonly #base: string;
  constructor(o: { fetch?: FetchFn; baseUrl?: string } = {}) {
    this.#fetch = o.fetch ?? fetch;
    this.#base = o.baseUrl ?? BASE;
  }

  async #get<T>(path: string, timeoutMs: number): Promise<T> {
    const res = await this.#fetch(this.#base + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async solUsd(): Promise<number> {
    const r = await this.#get<Record<string, { usdPrice?: number }>>(`/price/v3?ids=${PROGRAMS.wsol}`, 5_000);
    const p = r[PROGRAMS.wsol]?.usdPrice;
    if (typeof p !== "number" || !(p > 0)) throw new Error("Jupiter returned no SOL price");
    return p;
  }

  /** Exact-in quote. Throws when Jupiter has no route. */
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupiterQuote> {
    const q = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps) });
    return this.#get<JupiterQuote>(`/swap/v1/quote?${q}`, 3_000);
  }

  /** Builds (does not sign or send) the swap transaction for a quote. Returns it base64-encoded. */
  async swapTransaction(quote: JupiterQuote, userPublicKey: string, opts: { priorityMicroLamports?: number } = {}): Promise<string> {
    const res = await this.#fetch(`${this.#base}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        ...(opts.priorityMicroLamports !== undefined ? { computeUnitPriceMicroLamports: opts.priorityMicroLamports } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Jupiter swap HTTP ${res.status}`);
    const body = (await res.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) throw new Error("Jupiter returned no transaction");
    return body.swapTransaction;
  }
}

/** Validator hook: is there a Jupiter route for our size, and how much does it move the price? */
export function jupiterRouteCheck(jupiter: JupiterClient, slippageBps: number) {
  return async (mint: string, lamportsIn: bigint): Promise<{ ok: boolean; priceImpactBps?: number; detail: string }> => {
    try {
      const q = await jupiter.quote(PROGRAMS.wsol, mint, lamportsIn, slippageBps);
      const labels = [...new Set(q.routePlan.map((r) => r.swapInfo.label).filter(Boolean))].join(" + ");
      return { ok: true, priceImpactBps: Math.round(Number(q.priceImpactPct) * 10_000), detail: `Jupiter route${labels ? ` via ${labels}` : ""}` };
    } catch (err) {
      return { ok: false, detail: `no pump.fun curve, PumpSwap pool or Jupiter route (${(err as Error).message})` };
    }
  };
}

/**
 * Keeps a recent SOL/USD price in memory so the validator never waits on it.
 * `get()` returns undefined when the price is missing or older than `maxAgeMs`.
 */
export class SolPrice {
  #value: number | undefined;
  #at = 0;
  #timer: NodeJS.Timeout | undefined;
  readonly #load: () => Promise<number>;
  readonly #maxAgeMs: number;
  constructor(load: () => Promise<number>, maxAgeMs = 10 * 60_000) {
    this.#load = load;
    this.#maxAgeMs = maxAgeMs;
  }
  async refresh(now = Date.now()): Promise<void> {
    try {
      this.#value = await this.#load();
      this.#at = now;
    } catch {
      // keep the last value until it goes stale
    }
  }
  start(everyMs = 60_000): void {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), everyMs);
    this.#timer.unref();
  }
  stop(): void {
    clearInterval(this.#timer);
  }
  get(now = Date.now()): number | undefined {
    return this.#value !== undefined && now - this.#at <= this.#maxAgeMs ? this.#value : undefined;
  }
}
