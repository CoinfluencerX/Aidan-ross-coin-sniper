import { ADDRESS_CANDIDATE, isPubkey } from "./base58.ts";

export interface UrlMint {
  mint: string;
  host: string;
  /**
   * dexscreener /solana/<addr> URLs usually carry the PAIR (pool) address, not the mint.
   * The validator's is_mint check (M2) rejects pairs, and can resolve the pool's base mint.
   */
  maybePair: boolean;
}

/** Hosts whose URLs put a token address in the path. Matching is on the registrable host. */
const TOKEN_HOSTS: Record<string, { maybePair?: boolean }> = {
  "pump.fun": {},
  "dexscreener.com": { maybePair: true },
  "birdeye.so": {},
  "solscan.io": {},
  "jup.ag": {},
  "gmgn.ai": {},
  "photon-sol.tinyastro.io": { maybePair: true },
  "bullx.io": {},
  "axiom.trade": { maybePair: true },
  "rugcheck.xyz": {},
  "letsbonk.fun": {},
  "bonk.fun": {},
  "believe.app": {},
  "moonshot.money": {},
};

/** Hosts that only redirect somewhere else. Their path never holds a mint. */
export const SHORTENER_HOSTS = new Set([
  "t.co",
  "bit.ly",
  "tinyurl.com",
  "linktr.ee",
  "rebrand.ly",
  "ow.ly",
  "buff.ly",
  "is.gd",
  "cutt.ly",
  "shorturl.at",
  "dub.sh",
  "lnkd.in",
]);

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function knownHost(host: string): string | null {
  for (const h of Object.keys(TOKEN_HOSTS)) {
    if (host === h || host.endsWith("." + h)) return h;
  }
  return null;
}

export function isShortener(url: string): boolean {
  const host = hostOf(url);
  return host !== null && SHORTENER_HOSTS.has(host);
}

/**
 * Pulls 32-byte base58 addresses out of a token-site URL's path and query
 * (e.g. pump.fun/coin/<mint>, jup.ag/swap/SOL-<mint>, birdeye.so/token/<mint>?chain=solana).
 * Returns [] for hosts we don't recognise: an address on a random site isn't a token link.
 */
export function mintsFromUrl(url: string): UrlMint[] {
  const host = hostOf(url);
  if (!host) return [];
  const known = knownHost(host);
  if (!known) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  // A stray "%" in a link makes decodeURIComponent throw. Fall back to the raw text rather than lose the post.
  let haystack = parsed.pathname + " " + parsed.search;
  try {
    haystack = decodeURIComponent(haystack);
  } catch {
    // keep the undecoded text
  }
  const out: UrlMint[] = [];
  for (const m of haystack.matchAll(ADDRESS_CANDIDATE)) {
    if (isPubkey(m[0]) && !out.some((o) => o.mint === m[0])) {
      out.push({ mint: m[0], host: known, maybePair: TOKEN_HOSTS[known]!.maybePair ?? false });
    }
  }
  return out;
}
