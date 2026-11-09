import { isShortener } from "./urls.ts";

export type FetchFn = typeof fetch;

export interface ExpandOptions {
  fetch?: FetchFn;
  maxHops?: number;
  timeoutMs?: number;
}

/**
 * Follows a shortener's redirects (t.co, bit.ly, …) by reading Location headers,
 * without downloading the target page. Stops at the first URL that isn't a shortener.
 * Returns the original URL if anything fails: expansion is best effort, never fatal.
 *
 * X usually sends `expanded_url` / `unwound_url` with the post, so this only runs
 * when those are missing.
 */
export async function expandUrl(url: string, opts: ExpandOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const maxHops = opts.maxHops ?? 5;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 2_000);
  let current = url;
  try {
    for (let hop = 0; hop < maxHops && isShortener(current); hop++) {
      const res = await doFetch(current, { method: "HEAD", redirect: "manual", signal });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      current = new URL(location, current).toString();
    }
  } catch {
    // timeout / network error: keep whatever we resolved so far
  }
  return current;
}
