import { PROGRAMS } from "../src/chain/sdk.ts";
import { json, type Route } from "./fake-x.ts";
import type { RawAccount } from "./fixtures/chain.ts";

/**
 * A fake Solana JSON-RPC endpoint for tests. Answers the read-only calls the validator makes.
 * `host` is matched against the request URL, so it only answers calls meant for the RPC.
 */
export interface FakeChain {
  host?: string;
  /** jsonParsed `info` for the mint. null = no account at that address. Default: a clean SPL mint. */
  mintInfo?: Record<string, unknown> | null;
  mintOwner?: string;
  /** Raw accounts by address, for getMultipleAccounts. Anything not listed is null. */
  accounts?: Record<string, RawAccount>;
  /** Used when `accounts` has no entry: answer by position instead (e.g. [curve, pool]). */
  byPosition?: (RawAccount | null)[];
  signatures?: { blockTime: number }[];
  largest?: { address: string; amount: string }[];
  simulate?: (params: unknown[]) => unknown;
  solUsd?: number;
  calls?: string[];
}

export const CLEAN_MINT_INFO = { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null, isInitialized: true };

export function solanaRpcRoutes(c: FakeChain = {}): Route[] {
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
  return [
    ({ url }) => (url.hostname === "lite-api.jup.ag" && url.pathname.startsWith("/price") ? json({ [PROGRAMS.wsol]: { usdPrice: c.solUsd ?? 100 } }) : undefined),
    ({ url }) => (url.hostname === "lite-api.jup.ag" ? json({ error: "No route" }, 400) : undefined),
    ({ url, body }) => {
      if (url.hostname !== (c.host ?? "mainnet.helius-rpc.com")) return;
      const b = body as { method: string; params: unknown[] };
      c.calls?.push(b.method);
      switch (b.method) {
        case "getAccountInfo": {
          if (c.mintInfo === null) return ok({ value: null });
          const owner = c.mintOwner ?? PROGRAMS.splToken;
          const isToken = owner === PROGRAMS.splToken || owner === PROGRAMS.token2022;
          return ok({
            value: {
              owner,
              lamports: 1_461_600,
              executable: false,
              data: isToken ? { program: "spl-token", space: 82, parsed: { type: "mint", info: c.mintInfo ?? CLEAN_MINT_INFO } } : ["", "base64"],
            },
          });
        }
        case "getMultipleAccounts": {
          const addresses = b.params[0] as string[];
          const usePosition = c.byPosition && addresses.length === c.byPosition.length && !addresses.some((a) => c.accounts?.[a]);
          return ok({
            value: addresses.map((a, i) => {
              const acc = c.accounts?.[a] ?? (usePosition ? c.byPosition![i] : null);
              return acc ? { owner: acc.owner, lamports: acc.lamports, executable: acc.executable, data: [Buffer.from(acc.data, "hex").toString("base64"), "base64"] } : null;
            }),
          });
        }
        case "getSignaturesForAddress":
          return ok((c.signatures ?? [{ blockTime: Math.floor(Date.now() / 1000) - 90 }]).map((s, i) => ({ signature: "sig" + i, err: null, ...s })));
        case "getTokenLargestAccounts":
          return ok({ value: c.largest ?? [{ address: "holder1", amount: "50000000000000" }] });
        case "getLatestBlockhash":
          return ok({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 } });
        case "getBalance":
          return ok({ value: 5_000_000_000 });
        case "simulateTransaction":
          return ok({ value: c.simulate ? c.simulate(b.params) : { err: null, logs: [], unitsConsumed: 1 } });
        default:
          return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `fake rpc: ${b.method} not implemented` } });
      }
    },
  ];
}
