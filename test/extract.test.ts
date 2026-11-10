import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, isPubkey } from "../src/extract/base58.ts";
import { expandUrl } from "../src/extract/expand.ts";
import { extractFromPost, extractFromText, findWarningKeywords, IGNORED_ADDRESSES, joinedFragments, type ExtractDeps } from "../src/extract/extract.ts";
import { tesseractOcr } from "../src/extract/ocr.ts";
import { mintsFromUrl } from "../src/extract/urls.ts";
import { fromActivityEvent, fromFilteredStream, type XPost } from "../src/watch/x/normalize.ts";
import { fakeFetch, FIXTURE_PNG, json } from "./fake-x.ts";
import * as F from "./fixtures/x-posts.ts";
import { repoConfigObject } from "./helpers.ts";

const KEYWORDS: string[] = repoConfigObject("validator.yaml").params.warning_keywords;
const HAS_TESSERACT = spawnSync("tesseract", ["--version"]).status === 0;

const post = (msg: unknown): XPost => {
  const p = (msg as { data: { event_type?: string } }).data.event_type ? fromActivityEvent(msg).post : fromFilteredStream(msg);
  if (!p) throw new Error("fixture didn't normalise");
  return p;
};

/** No network unless a test opts in: any fetch fails loudly. */
const offline: typeof fetch = async (u) => {
  throw new Error(`unexpected network call: ${String(u)}`);
};
const deps = (extra: Partial<ExtractDeps> = {}): ExtractDeps => ({ warningKeywords: KEYWORDS, fetch: offline, ...extra });

describe("base58", () => {
  it("round-trips random 32-byte keys, including leading zero bytes", () => {
    for (let i = 0; i < 200; i++) {
      const bytes = randomBytes(32);
      if (i % 10 === 0) bytes[0] = 0;
      const s = base58Encode(bytes);
      expect(base58Decode(s)).toEqual(Uint8Array.from(bytes));
      expect(isPubkey(s)).toBe(true);
    }
  });

  it("rejects non-base58 characters, wrong lengths and 64-byte strings", () => {
    expect(isPubkey("0gaHBt2GVzj81inCZJJkNGSLjjphxM3VkJT5bFLRLbLC")).toBe(false); // 0 isn't base58
    expect(isPubkey(F.MINT.plain.slice(0, 30))).toBe(false); // badly truncated
    // NB: a 44-char key cut to 43 chars can still decode to 32 bytes, so base58 alone can't
    // catch a one-char truncation. M2's on-chain is_mint check does.
    expect(isPubkey(base58Encode(randomBytes(64)))).toBe(false); // tx signature shape
    expect(isPubkey("1".repeat(31))).toBe(false);
  });

  it("the ignore list holds real 32-byte addresses", () => {
    for (const a of Object.keys(IGNORED_ADDRESSES)) expect(isPubkey(a), a).toBe(true);
  });
});

describe("mintsFromUrl", () => {
  const m = F.MINT.pump;
  it.each([
    [`https://pump.fun/coin/${m}`, "pump.fun"],
    [`https://www.pump.fun/${m}`, "pump.fun"],
    [`https://birdeye.so/token/${m}?chain=solana`, "birdeye.so"],
    [`https://solscan.io/token/${m}`, "solscan.io"],
    [`https://jup.ag/swap/SOL-${m}`, "jup.ag"],
    [`https://jup.ag/tokens/${m}`, "jup.ag"],
    [`https://gmgn.ai/sol/token/${m}`, "gmgn.ai"],
  ])("%s", (url, host) => {
    expect(mintsFromUrl(url)).toEqual([{ mint: m, host, maybePair: false }]);
  });

  it("flags dexscreener links as possibly a pair address", () => {
    expect(mintsFromUrl(`https://dexscreener.com/solana/${m}`)).toEqual([{ mint: m, host: "dexscreener.com", maybePair: true }]);
  });

  it("ignores addresses on hosts that aren't token sites", () => {
    expect(mintsFromUrl(`https://evil.example/pump.fun/coin/${m}`)).toEqual([]);
    expect(mintsFromUrl(`https://pump.fun.evil.example/coin/${m}`)).toEqual([]);
    expect(mintsFromUrl("not a url")).toEqual([]);
  });
});

describe("extraction fixtures (BUILD_PROMPT M1)", () => {
  it("1. plain address in text", async () => {
    const r = await extractFromPost(post(F.plainAddress).content, deps());
    expect(r.mints).toEqual([{ mint: F.MINT.plain, origins: [{ kind: "text" }] }]);
    expect(r.warning.flagged).toBe(false);
  });

  it("2. pump.fun URL (X-expanded t.co)", async () => {
    const r = await extractFromPost(post(F.pumpFunUrl).content, deps());
    expect(r.mints).toEqual([
      { mint: F.MINT.pump, origins: [{ kind: "url", host: "pump.fun", maybePair: false, detail: `https://pump.fun/coin/${F.MINT.pump}` }] },
    ]);
    expect(r.expanded).toEqual([]); // used X's expanded_url, no network
  });

  it("3. dexscreener URL, flagged maybePair", async () => {
    const r = await extractFromPost(post(F.dexscreenerUrl).content, deps());
    expect(r.mints.map((m) => m.mint)).toEqual([F.MINT.dexPair]);
    expect(r.mints[0]!.origins[0]).toMatchObject({ host: "dexscreener.com", maybePair: true });
  });

  it("4. bare t.co link expanded through two redirects", async () => {
    const { fetch, calls } = fakeFetch([
      ({ url, method }) => {
        const to = F.TCO_REDIRECTS[url.toString()];
        if (method === "HEAD" && to) return new Response(null, { status: 301, headers: { location: to } });
      },
    ]);
    const r = await extractFromPost(post(F.tcoLink).content, deps({ fetch }));
    expect(r.mints.map((m) => m.mint)).toEqual([F.MINT.tco]);
    expect(r.mints[0]!.origins[0]).toMatchObject({ kind: "url", host: "jup.ag" });
    expect(r.expanded).toEqual([{ from: "https://t.co/ShOrT0001", to: `https://jup.ag/swap/SOL-${F.MINT.tco}` }]);
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "HEAD"]); // never downloads the page
  });

  it.skipIf(!HAS_TESSERACT)("5. address only in an attached image (real tesseract OCR)", async () => {
    const { fetch } = fakeFetch([({ url }) => (url.toString() === F.IMAGE_URL ? new Response(FIXTURE_PNG) : undefined)]);
    const r = await extractFromPost(post(F.imageAddress).content, deps({ fetch, ocr: tesseractOcr() }));
    expect(r.ocr).toEqual({ attempted: 1, failed: 0, errors: [] });
    expect(r.mints).toEqual([{ mint: F.MINT.image, origins: [{ kind: "ocr", detail: F.IMAGE_URL }] }]);
  });

  it("5b. image alt text is read without OCR", async () => {
    const p = post(F.imageAddress);
    p.content.images[0]!.altText = `CA ${F.MINT.image}`;
    const r = await extractFromPost(p.content, deps());
    expect(r.mints).toEqual([{ mint: F.MINT.image, origins: [{ kind: "alt_text", detail: F.IMAGE_URL }] }]);
  });

  it('6. "this is FAKE" warning post is flagged (curly apostrophe too)', async () => {
    const r = await extractFromPost(post(F.fakeWarning).content, deps());
    expect(r.mints.map((m) => m.mint)).toEqual([F.MINT.blocked]);
    expect(r.warning).toEqual({ flagged: true, keywords: ["fake", "not mine", "don't buy"] });
  });

  it("7. reply: only the reply's own address, never the parent's", async () => {
    const p = post(F.replyWithDifferentAddress);
    expect(p.kind).toBe("reply");
    expect(p.referenced).toEqual([{ type: "replied_to", id: "1900000000000000000", authorId: F.STRANGER }]);
    const r = await extractFromPost(p.content, deps());
    expect(r.mints.map((m) => m.mint)).toEqual([F.MINT.replyOwn]);
    expect(JSON.stringify(r)).not.toContain(F.MINT.replyParent);
  });

  it("quote post: the quoted post's address is never extracted", async () => {
    const p = post(F.quoteOfStranger);
    expect(p.kind).toBe("quote");
    const r = await extractFromPost(p.content, deps());
    expect(r.mints).toEqual([]);
  });
});

describe("extraction details", () => {
  it("dedupes one mint seen in text and a link, keeping both origins", async () => {
    const r = await extractFromPost(
      { text: `CA ${F.MINT.pump}`, urls: [{ url: "https://t.co/x", expandedUrl: `https://pump.fun/coin/${F.MINT.pump}` }], images: [] },
      deps(),
    );
    expect(r.mints).toHaveLength(1);
    expect(r.mints[0]!.origins.map((o) => o.kind)).toEqual(["text", "url"]);
  });

  it("keeps several different mints in order, and skips program addresses", () => {
    const mints = extractFromText(`${F.MINT.plain} then ${F.MINT.pump} paid with So11111111111111111111111111111111111111112`);
    expect(mints.map((m) => m.mint)).toEqual([F.MINT.plain, F.MINT.pump]);
  });

  it("doesn't take a substring of a longer base58 run", () => {
    expect(extractFromText(F.MINT.plain + "abc")).toEqual([]);
  });

  it("reads mints from URLs typed into the text", () => {
    expect(extractFromText(`https://pump.fun/coin/${F.MINT.pump}`).map((m) => m.mint)).toEqual([F.MINT.pump]);
  });

  it("joins OCR fragments split by a space or line break", () => {
    const m = F.MINT.image;
    expect(joinedFragments(`CA: ${m.slice(0, 16)} ${m.slice(16)}`)).toEqual([m]);
    expect(joinedFragments(`${m.slice(0, 20)}\n${m.slice(20, 30)} ${m.slice(30)}`)).toEqual([m]);
    expect(joinedFragments("only buy from this address")).toEqual([]);
  });

  it("OCR failure is recorded, not thrown", async () => {
    const { fetch } = fakeFetch([() => json({}, 500)]);
    const r = await extractFromPost(post(F.imageAddress).content, deps({ fetch, ocr: async () => "x" }));
    expect(r.ocr.failed).toBe(1);
    expect(r.ocr.errors[0]).toContain("HTTP 500");
    expect(r.mints).toEqual([]);
  });

  it("warning keywords are case-insensitive", () => {
    expect(findWarningKeywords(["SCAM ALERT", "I was HACKED"], KEYWORDS)).toEqual(["scam", "hacked"]);
    expect(findWarningKeywords(["gm, coin is live"], KEYWORDS)).toEqual([]);
  });
});

describe("expandUrl", () => {
  it("returns the input when the shortener errors or times out", async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    expect(await expandUrl("https://t.co/abc", { fetch: hang, timeoutMs: 50 })).toBe("https://t.co/abc");
  });

  it("doesn't touch non-shortener URLs", async () => {
    expect(await expandUrl("https://example.com/a", { fetch: offline })).toBe("https://example.com/a");
  });

  it("stops after maxHops on a redirect loop", async () => {
    const loop: typeof fetch = async () => new Response(null, { status: 301, headers: { location: "https://t.co/loop" } });
    expect(await expandUrl("https://t.co/loop", { fetch: loop, maxHops: 3 })).toBe("https://t.co/loop");
  });
});

describe("links with a stray % (review fix)", () => {
  it("doesn't throw on a token link that isn't valid percent-encoding", () => {
    const mint = "En8Ltt7MV1nhqTnUFecEzo5Fxbqy8XspwvCHmx6yeHJy";
    expect(() => mintsFromUrl(`https://pump.fun/coin/${mint}?ref=100%`)).not.toThrow();
    expect(mintsFromUrl(`https://pump.fun/coin/${mint}?ref=100%`).map((m) => m.mint)).toEqual([mint]);
  });
});
