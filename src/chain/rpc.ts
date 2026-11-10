import type { FetchFn } from "../extract/expand.ts";

/**
 * A small Solana JSON-RPC client over fetch. Read-only methods plus simulateTransaction.
 * It has NO method that sends a transaction: sending lives in the executor and only in live mode.
 */

export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`RPC ${method}: ${message}`);
    this.code = code;
  }
}

export interface RpcAccount<D = unknown> {
  owner: string;
  lamports: number;
  data: D;
  executable: boolean;
}

export interface ParsedData {
  program: string;
  parsed: { type: string; info: Record<string, unknown> };
  space: number;
}

export interface SimulationResult {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
  accounts?: (RpcAccount<[string, string]> | null)[] | null;
}

export class SolanaRpc {
  readonly #url: string;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  #id = 0;

  constructor(o: { url: string; fetch?: FetchFn; timeoutMs?: number }) {
    this.#url = o.url;
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 4_000;
  }

  async call<T>(method: string, params: unknown[], timeoutMs = this.#timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Never include the URL: providers put the API key in it.
      throw new RpcError(method, (err as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "network error");
    }
    if (!res.ok) throw new RpcError(method, `HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new RpcError(method, body.error.message ?? "error", body.error.code);
    return body.result as T;
  }

  /** jsonParsed account. `data` is ParsedData when the node can parse it, otherwise [base64, "base64"]. */
  async getParsedAccount(address: string): Promise<RpcAccount<ParsedData | [string, string]> | null> {
    const r = await this.call<{ value: RpcAccount<ParsedData | [string, string]> | null }>("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return r.value;
  }

  /** Raw accounts, in the order asked. Missing accounts are null. */
  async getAccounts(addresses: readonly string[]): Promise<(RpcAccount<Buffer> | null)[]> {
    if (addresses.length === 0) return [];
    const r = await this.call<{ value: (RpcAccount<[string, string]> | null)[] }>("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
    return r.value.map((a) => (a ? { ...a, data: Buffer.from(a.data[0], "base64") } : null));
  }

  async getSignatures(address: string, limit: number): Promise<{ signature: string; blockTime: number | null; err: unknown }[]> {
    return this.call("getSignaturesForAddress", [address, { limit, commitment: "confirmed" }]);
  }

  async getTokenLargestAccounts(mint: string): Promise<{ address: string; amount: string }[]> {
    return (await this.call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }])).value;
  }

  async getBalance(address: string): Promise<number> {
    return (await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return (await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  }

  /**
   * Runs a transaction against current chain state WITHOUT sending it. Nothing lands on chain
   * and no signature is needed (sigVerify off, blockhash replaced by the node).
   */
  async simulate(txBase64: string, opts: { accounts?: readonly string[] } = {}): Promise<SimulationResult> {
    const r = await this.call<{ value: SimulationResult }>(
      "simulateTransaction",
      [
        txBase64,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          ...(opts.accounts?.length ? { accounts: { encoding: "base64", addresses: opts.accounts } } : {}),
        },
      ],
      8_000,
    );
    return r.value;
  }
}
