import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { formatEvmAlert } from "../src/alert/console.ts";
import { EXIT, main } from "../src/app/main.ts";
import { decodeAbiString, locateEvmAddress, uniswapLink, type ChainPresence } from "../src/evm/locate.ts";
import { evmAddressesIn, evmFromOcrText } from "../src/extract/evm.ts";
import { extractFromPost } from "../src/extract/extract.ts";
import { createLogger } from "../src/log/logger.ts";
import { openDb } from "../src/state/db.ts";
import type { Assessment, EvmSighting } from "../src/watch/signal.ts";
import { XClient } from "../src/watch/x/client.ts";
import { fromActivityEvent } from "../src/watch/x/normalize.ts";
import { buildWatchList, XWatcher } from "../src/watch/x/watcher.ts";
import { fakeFetch, json, xApiRoutes, type Route } from "./fake-x.ts";
import * as F from "./fixtures/x-posts.ts";
import { FAKE_SECRETS, loadTestConfig, REPO_ROOT, tempDir, TEST_X_ACCOUNTS_ENV } from "./helpers.ts";

const config = loadTestConfig();
/** USDC on Base and on Ethereum: real, well-known contracts. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TX_HASH = "0x" + "ab".repeat(32);
const deps = { warningKeywords: config.validator.params.warning_keywords, expandShortLinks: false };

/** ABI encoding of the string "USDC". */
const ABI_USDC = "0x" + "20".padStart(64, "0") + "4".padStart(64, "0") + Buffer.from("USDC").toString("hex").padEnd(64, "0");

/** Fake Ethereum + Base JSON-RPC: the contract exists only on the chains listed. */
function evmRpc(contractOn: ("ethereum" | "base")[], opts: { fail?: boolean } = {}): Route {
  return ({ url, body }) => {
    const chain = url.hostname.includes("base") ? "base" : url.hostname.includes("ethereum") ? "ethereum" : undefined;
    if (!chain) return;
    if (opts.fail) return json({ error: "down" }, 503);
    const b = body as { method: string };
    const has = contractOn.includes(chain);
    if (b.method === "eth_getCode") return json({ jsonrpc: "2.0", id: 1, result: has ? "0x6080604052" : "0x" });
    if (b.method === "eth_call") return json({ jsonrpc: "2.0", id: 1, result: ABI_USDC });
  };
}

describe("0x address extraction", () => {
  it("finds a 0x address, lowercases it, and skips transaction hashes", () => {
    expect(evmAddressesIn(`CA ${USDC_BASE} tx ${TX_HASH}`)).toEqual([USDC_BASE.toLowerCase()]);
    expect(evmAddressesIn("0x1234 is too short")).toEqual([]);
  });

  it("joins an address OCR split across a line break", () => {
    const split = `${USDC_BASE.slice(0, 20)}\n${USDC_BASE.slice(20)}`;
    expect(evmFromOcrText(`contract:\n${split}\nthanks`)).toEqual([USDC_BASE.toLowerCase()]);
  });

  it("keeps 0x addresses apart from Solana mints, and ignores WETH", async () => {
    const r = await extractFromPost(
      { text: `sol ${F.MINT.plain} eth ${USDC_ETH} weth 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, urls: [], images: [] },
      deps,
    );
    expect(r.mints.map((m) => m.mint)).toEqual([F.MINT.plain]);
    expect(r.evm.map((e) => e.address)).toEqual([USDC_ETH.toLowerCase()]);
    expect(r.ignored).toContainEqual({ mint: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", reason: "WETH (Ethereum)" });
  });

  it("reads a 0x address from a link the post carries", async () => {
    const r = await extractFromPost(
      { text: "live", urls: [{ url: "https://t.co/x", expandedUrl: `https://basescan.org/token/${USDC_BASE}` }], images: [] },
      deps,
    );
    expect(r.evm).toEqual([{ address: USDC_BASE.toLowerCase(), origins: [{ kind: "url", detail: `https://basescan.org/token/${USDC_BASE}`, host: "basescan.org" }] }]);
    expect(r.mints).toEqual([]);
  });
});

describe("chain lookup", () => {
  it("reports the chain the contract is on, with its symbol", async () => {
    const { fetch } = fakeFetch([evmRpc(["base"])]);
    expect(await locateEvmAddress(USDC_BASE.toLowerCase(), { fetch })).toEqual([
      { chain: "ethereum", status: "none" },
      { chain: "base", status: "contract", symbol: "USDC" },
    ]);
  });

  it("reports unknown, never throws, when the lookup fails", async () => {
    const { fetch } = fakeFetch([evmRpc([], { fail: true })]);
    expect(await locateEvmAddress(USDC_BASE.toLowerCase(), { fetch })).toEqual([
      { chain: "ethereum", status: "unknown" },
      { chain: "base", status: "unknown" },
    ]);
  });

  it("decodes string and bytes32 symbols, and rejects junk", () => {
    expect(decodeAbiString(ABI_USDC)).toBe("USDC");
    expect(decodeAbiString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"))).toBe("MKR");
    expect(decodeAbiString("0x")).toBeUndefined();
    expect(decodeAbiString("0xzz")).toBeUndefined();
  });

  it("builds a Uniswap link for the right chain", () => {
    expect(uniswapLink("base", "0xabc")).toBe("https://app.uniswap.org/swap?chain=base&inputCurrency=NATIVE&outputCurrency=0xabc");
    expect(uniswapLink("ethereum", "0xabc")).toContain("chain=mainnet");
  });
});

function setup(chains: ChainPresence[] = [{ chain: "ethereum", status: "none" }, { chain: "base", status: "contract", symbol: "USDC" }]) {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const db = openDb(":memory:");
  const fetchFn = fakeFetch([]).fetch;
  const evm: { s: EvmSighting; a: Assessment }[] = [];
  const signals: unknown[] = [];
  const watcher = new XWatcher({
    client: new XClient({ bearerToken: FAKE_SECRETS.X_BEARER_TOKEN, fetch: fetchFn }),
    accounts: config.accounts,
    validator: config.validator,
    watchList: buildWatchList(config.accounts, "dry-run"),
    db,
    log,
    mode: "dry-run",
    fetch: fetchFn,
    onSignal: (s) => signals.push(s),
    onEvm: (s, a) => evm.push({ s, a }),
    locateEvm: async () => chains,
  });
  return { watcher, db, evm, signals };
}

const evmPost = (author: string, extra: object = {}) =>
  fromActivityEvent(F.activityEvent({ id: "1900000000000000777", author_id: author, created_at: "2026-11-19T17:00:00.000Z", text: `GTA 6 RP coin is live on Base: ${USDC_BASE}`, ...extra })).post!;

describe("0x address in an official post", () => {
  it("alerts, but never writes a signal row (so nothing downstream can buy it)", async () => {
    const { watcher, db, evm, signals } = setup();
    const out = await watcher.handlePost(evmPost(F.ADIN), "activity", Date.parse("2026-11-19T17:00:02.000Z"));
    expect(out).toEqual([]);
    expect(signals).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signals").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
    expect(evm).toHaveLength(1);
    expect(evm[0]!.s).toMatchObject({ address: USDC_BASE.toLowerCase(), accountId: F.ADIN, source: "x", postKind: "original" });
    expect(evm[0]!.a.severity).toBe("green");
    const kinds = (db.prepare("SELECT kind FROM audit_log").all() as { kind: string }[]).map((k) => k.kind);
    expect(kinds).toEqual(["x.post", "evm.address"]);
  });

  it("ignores a 0x address posted by anyone who isn't allowlisted", async () => {
    const { watcher, evm } = setup();
    await watcher.handlePost(evmPost(F.STRANGER), "filtered_stream", 0);
    expect(evm).toEqual([]);
  });

  it("is red for a reply, and yellow when no contract is found", async () => {
    const reply = setup();
    await reply.watcher.handlePost(evmPost(F.ADIN, { referenced_tweets: [{ type: "replied_to", id: "5" }] }), "activity", 0);
    expect(reply.evm[0]!.a.severity).toBe("red");

    const nowhere = setup([{ chain: "ethereum", status: "none" }, { chain: "base", status: "none" }]);
    await nowhere.watcher.handlePost(evmPost(F.ADIN), "activity", 0);
    expect(nowhere.evm[0]!.a).toMatchObject({ severity: "yellow" });
    expect(nowhere.evm[0]!.a.reasons.join(" ")).toContain("no contract at this address");
  });

  it("banner shows the Uniswap link for the chain found and says the bot doesn't buy", async () => {
    const { watcher, evm } = setup();
    await watcher.handlePost(evmPost(F.TEST), "activity", Date.parse("2026-11-19T17:00:02.000Z"));
    const text = formatEvmAlert(evm[0]!.s, evm[0]!.a, { color: false });
    expect(text).toContain("BUY BY HAND");
    expect(text).toContain(`https://app.uniswap.org/swap?chain=base&inputCurrency=NATIVE&outputCurrency=${USDC_BASE.toLowerCase()}`);
    expect(text).not.toContain("chain=mainnet"); // only the chain where the contract exists
    expect(text).toContain("BASE (USDC): contract found");
    expect(text).toContain("does NOT buy 0x addresses");
  });
});

describe("main --watch with a 0x post (fake X + fake chain RPC)", () => {
  it("prints one manual-buy alert and records no signal", async () => {
    const dir = tempDir();
    const envPath = join(dir, ".env");
    writeFileSync(envPath, Object.entries({ ...FAKE_SECRETS, TEST_X_ACCOUNTS: TEST_X_ACCOUNTS_ENV }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const post = F.activityEvent({ id: "1900000000000000888", author_id: F.TEST, created_at: new Date().toISOString(), text: `bot test ${USDC_BASE}` });
    const users = [
      { id: F.ADIN, username: "adinross" },
      { id: "1511793806080819202", username: "AR15thed3mon" },
      { id: F.BANKS, username: "Banks" },
      { id: "1729276822485889024", username: "MarketBubble" },
      { id: F.TEST, username: "TestPoster" },
    ];
    const { fetch } = fakeFetch([evmRpc(["base"]), ...xApiRoutes({ users, activity: [post] })]);
    const lines: string[] = [];
    const alerts: string[] = [];
    const code = await main({
      argv: ["--watch", "--duration", "0.4", "--data-dir", dir, "--env-file", envPath],
      env: {},
      cwd: REPO_ROOT,
      write: (l) => lines.push(l),
      alert: (t) => alerts.push(t),
      fetch,
      ocr: null,
    });
    expect(code).toBe(EXIT.OK);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("BUY BY HAND");
    expect(alerts[0]).toContain("chain=base");
    const db = new DatabaseSync(join(dir, "dry-run.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM signals").get()).toEqual({ n: 0 });
    db.close();
  });
});
