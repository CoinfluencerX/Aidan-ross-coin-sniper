import type { FetchFn } from "../extract/expand.ts";

/**
 * Finds which EVM chain a 0x address is a contract on. Read-only JSON-RPC (eth_getCode, eth_call).
 * Used only to make the manual-buy alert more useful. Nothing here can trade.
 */

export type EvmChain = "ethereum" | "base";

export interface ChainPresence {
  chain: EvmChain;
  /** contract = code exists at the address. none = no code (wrong chain, or a wallet). unknown = lookup failed. */
  status: "contract" | "none" | "unknown";
  symbol?: string;
}

export const EVM_CHAINS: Record<EvmChain, { label: string; uniswapChain: string; dexscreener: string; explorer: string; defaultRpc: string }> = {
  ethereum: {
    label: "Ethereum",
    uniswapChain: "mainnet",
    dexscreener: "ethereum",
    explorer: "https://etherscan.io/token/",
    defaultRpc: "https://ethereum-rpc.publicnode.com",
  },
  base: {
    label: "Base",
    uniswapChain: "base",
    dexscreener: "base",
    explorer: "https://basescan.org/token/",
    defaultRpc: "https://mainnet.base.org",
  },
};

/** Uniswap's swap page with the token already filled in. The owner still confirms the buy in their own wallet. */
export function uniswapLink(chain: EvmChain, address: string): string {
  return `https://app.uniswap.org/swap?chain=${EVM_CHAINS[chain].uniswapChain}&inputCurrency=NATIVE&outputCurrency=${address}`;
}

export function dexscreenerLink(chain: EvmChain, address: string): string {
  return `https://dexscreener.com/${EVM_CHAINS[chain].dexscreener}/${address}`;
}

export interface LocateOptions {
  rpcUrls?: Partial<Record<EvmChain, string | undefined>>;
  fetch?: FetchFn;
  timeoutMs?: number;
}

async function rpc(url: string, method: string, params: unknown[], doFetch: FetchFn, signal: AbortSignal): Promise<unknown> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/** Decodes an ABI-encoded `string` return value (or a bytes32 one, which older tokens use). */
export function decodeAbiString(hex: string): string | undefined {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0) return undefined;
  const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 32) || undefined;
  try {
    if (h.length === 64) return clean(Buffer.from(h, "hex").toString("utf8"));
    if (h.length < 128) return undefined;
    const offset = Number(BigInt("0x" + h.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + h.slice(offset, offset + 64)));
    if (!Number.isFinite(len) || len > 256) return undefined;
    return clean(Buffer.from(h.slice(offset + 64, offset + 64 + len * 2), "hex").toString("utf8"));
  } catch {
    return undefined;
  }
}

const SYMBOL_SELECTOR = "0x95d89b41"; // symbol()

async function locateOn(chain: EvmChain, address: string, url: string, doFetch: FetchFn, timeoutMs: number): Promise<ChainPresence> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const code = await rpc(url, "eth_getCode", [address, "latest"], doFetch, signal);
    if (typeof code !== "string") return { chain, status: "unknown" };
    if (code === "0x" || code === "0x0") return { chain, status: "none" };
    let symbol: string | undefined;
    try {
      const r = await rpc(url, "eth_call", [{ to: address, data: SYMBOL_SELECTOR }, "latest"], doFetch, signal);
      if (typeof r === "string") symbol = decodeAbiString(r);
    } catch {
      // not an ERC-20, or the call timed out: the contract still exists
    }
    return { chain, status: "contract", ...(symbol ? { symbol } : {}) };
  } catch {
    return { chain, status: "unknown" };
  }
}

/** Checks Ethereum and Base in parallel. Never throws: a failed lookup is reported as "unknown". */
export async function locateEvmAddress(address: string, opts: LocateOptions = {}): Promise<ChainPresence[]> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const chains = Object.keys(EVM_CHAINS) as EvmChain[];
  return Promise.all(chains.map((c) => locateOn(c, address, opts.rpcUrls?.[c] ?? EVM_CHAINS[c].defaultRpc, doFetch, timeoutMs)));
}
