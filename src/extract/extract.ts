import { ADDRESS_CANDIDATE, isPubkey } from "./base58.ts";
import { evmAddressesIn, evmFromOcrText, IGNORED_EVM } from "./evm.ts";
import { expandUrl, type FetchFn } from "./expand.ts";
import { ocrImageUrl, type OcrEngine } from "./ocr.ts";
import { hostOf, isShortener, mintsFromUrl } from "./urls.ts";

function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Address extraction. It only ever reads the post's OWN content: its text, its own links
 * and its own attached images. Parent posts of a reply and quoted posts are never passed in,
 * so an address from someone else's post can't become a signal.
 */

/** Well-known program / system addresses that show up in posts but are never the coin. */
export const IGNORED_ADDRESSES: Record<string, string> = {
  "11111111111111111111111111111111": "system program",
  So11111111111111111111111111111111111111112: "wrapped SOL",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token program",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun program",
};

export type OriginKind = "text" | "url" | "ocr" | "alt_text";

export interface Origin {
  kind: OriginKind;
  /** The URL for url origins, the image URL for ocr/alt_text origins. */
  detail?: string;
  host?: string;
  maybePair?: boolean;
}

export interface MintCandidate {
  mint: string;
  origins: Origin[];
}

export interface PostContent {
  text: string;
  urls: { url: string; expandedUrl?: string | undefined; unwoundUrl?: string | undefined }[];
  images: { url: string; altText?: string | undefined }[];
}

/** An Ethereum-style 0x address found in the post. Alert only: the bot never buys these. */
export interface EvmCandidate {
  /** Lowercase 0x + 40 hex. */
  address: string;
  origins: Origin[];
}

export interface ExtractionResult {
  mints: MintCandidate[];
  /** Ethereum / Base style addresses. Kept apart from `mints` so they can never reach the buy path. */
  evm: EvmCandidate[];
  ignored: { mint: string; reason: string }[];
  warning: { flagged: boolean; keywords: string[] };
  ocr: { attempted: number; failed: number; errors: string[] };
  expanded: { from: string; to: string }[];
}

export interface ExtractDeps {
  warningKeywords: readonly string[];
  /** Runs OCR on attached images. Omit to skip OCR. */
  ocr?: OcrEngine | undefined;
  fetch?: FetchFn | undefined;
  /** Expand shortener links X didn't expand for us. Default true. */
  expandShortLinks?: boolean;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'”’)]+/gi;

class Collector {
  readonly mints: MintCandidate[] = [];
  readonly evm: EvmCandidate[] = [];
  readonly ignored: { mint: string; reason: string }[] = [];

  addEvm(addresses: readonly string[], origin: Origin): void {
    for (const address of addresses) {
      const reason = IGNORED_EVM[address];
      if (reason) {
        if (!this.ignored.some((i) => i.mint === address)) this.ignored.push({ mint: address, reason });
        continue;
      }
      const existing = this.evm.find((e) => e.address === address);
      if (!existing) this.evm.push({ address, origins: [origin] });
      else if (!existing.origins.some((o) => o.kind === origin.kind && o.detail === origin.detail)) existing.origins.push(origin);
    }
  }

  add(mint: string, origin: Origin): void {
    const reason = IGNORED_ADDRESSES[mint];
    if (reason) {
      if (!this.ignored.some((i) => i.mint === mint)) this.ignored.push({ mint, reason });
      return;
    }
    const existing = this.mints.find((m) => m.mint === mint);
    if (!existing) this.mints.push({ mint, origins: [origin] });
    else if (!existing.origins.some((o) => o.kind === origin.kind && o.detail === origin.detail)) existing.origins.push(origin);
  }

  addFromText(text: string, origin: Origin): void {
    for (const m of text.matchAll(ADDRESS_CANDIDATE)) if (isPubkey(m[0])) this.add(m[0], origin);
  }

  /** OCR text: also try joining neighbouring base58 fragments, since OCR often splits an address with a space or line break. */
  addFromOcrText(text: string, origin: Origin): void {
    this.addFromText(text, origin);
    for (const mint of joinedFragments(text)) this.add(mint, origin);
  }

  addFromUrl(url: string): void {
    for (const u of mintsFromUrl(url)) this.add(u.mint, { kind: "url", detail: url, host: u.host, maybePair: u.maybePair });
  }
}

const BASE58_TOKEN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Joins runs of 2–4 consecutive whitespace-separated base58 tokens and keeps the ones that are 32-byte keys. */
export function joinedFragments(text: string): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let joined = "";
    for (let j = i; j < tokens.length && j < i + 4; j++) {
      if (!BASE58_TOKEN.test(tokens[j]!)) break;
      joined += tokens[j];
      if (joined.length > 44) break;
      if (j > i && isPubkey(joined) && !out.includes(joined)) out.push(joined);
    }
  }
  return out;
}

/** Normalises curly quotes and case so "Don’t buy" matches the keyword "don't buy". */
function normalizeForKeywords(s: string): string {
  return s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, " ");
}

export function findWarningKeywords(texts: readonly string[], keywords: readonly string[]): string[] {
  const hay = normalizeForKeywords(texts.join(" \n "));
  return keywords.filter((k) => hay.includes(normalizeForKeywords(k)));
}

/** Synchronous part: plain text and any URLs written into it. */
export function extractFromText(text: string): MintCandidate[] {
  const c = new Collector();
  c.addFromText(text, { kind: "text" });
  for (const m of text.matchAll(URL_IN_TEXT)) c.addFromUrl(m[0]);
  return c.mints;
}

export async function extractFromPost(post: PostContent, deps: ExtractDeps): Promise<ExtractionResult> {
  const c = new Collector();
  const expanded: { from: string; to: string }[] = [];
  const ocrStats = { attempted: 0, failed: 0, errors: [] as string[] };
  const textsForWarning = [post.text];

  // 1. Text. A t.co link in the text never holds a mint itself, so this is safe to run first.
  c.addFromText(post.text, { kind: "text" });
  c.addEvm(evmAddressesIn(post.text), { kind: "text" });
  const textUrls = [...post.text.matchAll(URL_IN_TEXT)].map((m) => m[0]);

  // 2. Links: prefer what X already expanded; expand shorteners ourselves only if needed.
  const links = new Map<string, string>(); // short -> best known target
  for (const u of post.urls) links.set(u.url, u.unwoundUrl ?? u.expandedUrl ?? u.url);
  for (const u of textUrls) if (!links.has(u)) links.set(u, u);

  await Promise.all(
    [...links].map(async ([short, target]) => {
      let final = target;
      if (isShortener(final) && deps.expandShortLinks !== false) {
        final = await expandUrl(final, { fetch: deps.fetch });
        if (final !== target) expanded.push({ from: short, to: final });
      }
      links.set(short, final);
    }),
  );
  for (const final of links.values()) {
    c.addFromUrl(final);
    // Any link in an official post that carries a 0x address (etherscan, basescan, dexscreener, uniswap…).
    const host = hostOf(final);
    c.addEvm(evmAddressesIn(safeDecode(final)), { kind: "url", detail: final, ...(host ? { host } : {}) });
  }

  // 3. Images: alt text, then OCR.
  for (const img of post.images) {
    if (img.altText) {
      c.addFromText(img.altText, { kind: "alt_text", detail: img.url });
      c.addEvm(evmAddressesIn(img.altText), { kind: "alt_text", detail: img.url });
      textsForWarning.push(img.altText);
    }
  }
  if (deps.ocr) {
    const ocr = deps.ocr;
    const texts = await Promise.all(
      post.images.map(async (img) => {
        ocrStats.attempted++;
        try {
          return { img, text: await ocrImageUrl(img.url, ocr, { fetch: deps.fetch }) };
        } catch (err) {
          ocrStats.failed++;
          ocrStats.errors.push((err as Error).message);
          return { img, text: "" };
        }
      }),
    );
    for (const { img, text } of texts) {
      if (!text) continue;
      c.addFromOcrText(text, { kind: "ocr", detail: img.url });
      c.addEvm(evmFromOcrText(text), { kind: "ocr", detail: img.url });
      textsForWarning.push(text);
    }
  }

  const keywords = findWarningKeywords(textsForWarning, deps.warningKeywords);
  return {
    mints: c.mints,
    evm: c.evm,
    ignored: c.ignored,
    warning: { flagged: keywords.length > 0, keywords },
    ocr: ocrStats,
    expanded,
  };
}
