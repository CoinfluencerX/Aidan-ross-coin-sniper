import type { SolanaRpc } from "../chain/rpc.ts";
import type { FetchFn } from "../extract/expand.ts";

/**
 * The ONLY code in this repo that puts a transaction on chain. It is constructed only in live
 * mode (src/app/main.ts), and live mode needs --mode live, MODE=live, LIVE=1, real guardrails,
 * a wallet, Telegram, and the LIVE_TRADING_AVAILABLE switch in src/config/mode.ts.
 */

export type ConfirmStatus = "confirmed" | "failed" | "expired";

export interface Sender {
  /** Sends an already-signed transaction. Returns its signature. */
  send(signedTxBase64: string): Promise<string>;
  /** Waits until the transaction lands, fails, or its blockhash expires. */
  confirm(signature: string, timeoutMs: number): Promise<{ status: ConfirmStatus; err?: unknown }>;
}

export class LiveSender implements Sender {
  readonly #rpc: SolanaRpc;
  readonly #jitoUrl: string | undefined;
  readonly #fetch: FetchFn;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(o: { rpc: SolanaRpc; jitoUrl?: string | undefined; fetch?: FetchFn; sleep?: (ms: number) => Promise<void> }) {
    this.#rpc = o.rpc;
    this.#jitoUrl = o.jitoUrl?.replace(/\/+$/, "");
    this.#fetch = o.fetch ?? fetch;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #viaRpc(tx: string): Promise<string> {
    // skipPreflight: the validator already simulated this trade; a second simulation only adds delay.
    return this.#rpc.call<string>("sendTransaction", [tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  }

  async #viaJito(tx: string): Promise<string> {
    const res = await this.#fetch(`${this.#jitoUrl}/api/v1/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [tx, { encoding: "base64" }] }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!res.ok || !body.result) throw new Error(`Jito: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  }

  /** Fans the same signed transaction out to every path. It's one transaction, so it can only land once. */
  async send(signedTxBase64: string): Promise<string> {
    const paths = [this.#viaRpc(signedTxBase64), ...(this.#jitoUrl ? [this.#viaJito(signedTxBase64)] : [])];
    return Promise.any(paths).catch((err: AggregateError) => {
      throw new Error(`every send path failed: ${err.errors.map((e: Error) => e.message).join("; ")}`);
    });
  }

  async confirm(signature: string, timeoutMs: number): Promise<{ status: ConfirmStatus; err?: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await this.#rpc.call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature]]);
        const s = r.value[0];
        if (s?.err) return { status: "failed", err: s.err };
        if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { status: "confirmed" };
      } catch {
        // transient RPC error: keep polling
      }
      await this.#sleep(400);
    }
    return { status: "expired" };
  }
}
