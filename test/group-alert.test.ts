import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicCoinAlert, publicEvmAlert, solanaBuyLinks } from "../src/alert/public.ts";
import { Engine } from "../src/app/engine.ts";
import { EXIT, main } from "../src/app/main.ts";
import type { ChainReader, MarketFacts, MintFacts } from "../src/chain/facts.ts";
import { PROGRAMS } from "../src/chain/sdk.ts";
import { alertChatIds, parseEnv } from "../src/config/env.ts";
import { Telegram } from "../src/control/telegram.ts";
import { createLogger } from "../src/log/logger.ts";
import { createRedactor } from "../src/log/redact.ts";
import { openDb } from "../src/state/db.ts";
import type { Verdict } from "../src/validate/validator.ts";
import { assessSignal, recordSignal, type AddressSignal, type EvmSighting } from "../src/watch/signal.ts";
import { solanaRpcRoutes } from "./fake-chain.ts";
import { fakeBuilder } from "./fake-trade.ts";
import { fakeFetch, json, xApiRoutes, type Route } from "./fake-x.ts";
import { OPEN_CURVE } from "./fixtures/chain.ts";
import * as F from "./fixtures/x-posts.ts";
import { FAKE_SECRETS, loadTestConfig, REPO_ROOT, SECRET_NEEDLES, tempDir, TEST_X_ACCOUNTS_ENV } from "./helpers.ts";

const config = loadTestConfig();
const TOKEN = FAKE_SECRETS.TELEGRAM_BOT_TOKEN;
const OWNER = "777000111";
const GROUP = "-1001234567890";
const CHANNEL = "-1009876543210";
const quiet = () => createLogger({ write: () => {} });

/** A fake Telegram that records every message, and can refuse chosen chats. */
function telegramApi(refuse: string[] = [], updates: { update_id: number; message: { chat: { id: number }; text: string } }[] = []) {
  const sent: { chat_id: string; text: string }[] = [];
  const queue = [...updates];
  const route: Route = async ({ url, body, signal }) => {
    if (url.hostname !== "api.telegram.org") return;
    const method = url.pathname.split("/").pop();
    if (method === "getMe") return json({ ok: true, result: { username: "my_sniper_bot" } });
    if (method === "sendMessage") {
      const b = body as { chat_id: string; text: string };
      if (refuse.includes(String(b.chat_id))) return json({ ok: false, description: "Forbidden: bot was kicked from the group chat" }, 403);
      sent.push({ chat_id: String(b.chat_id), text: b.text });
      return json({ ok: true, result: {} });
    }
    if (method === "getUpdates") {
      const b = body as { offset?: number };
      if (b.offset === -1) return json({ ok: true, result: queue.length ? [queue.at(-1)] : [] });
      for (;;) {
        const ready = queue.filter((u) => b.offset === undefined || u.update_id >= b.offset);
        if (ready.length) return (queue.splice(0, queue.length), json({ ok: true, result: ready }));
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    return json({ ok: false, description: "unknown method" }, 404);
  };
  return { route, sent, to: (chat: string) => sent.filter((s) => s.chat_id === chat).map((s) => s.text) };
}

const mintFacts: MintFacts = { address: F.MINT.plain, exists: true, owner: PROGRAMS.token2022, tokenProgram: "token-2022", isMint: true, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [], onMintMetadata: { name: "Adin", symbol: "ADIN" } };
const open: MarketFacts = { venue: "pump_curve", detail: "open", isPumpToken: true, curveComplete: false, creator: "C", priceLamportsPerUnit: 2.8e-5, quoteReserveLamports: 30_000_000_000n, tokenReserveUnits: 10n ** 15n, multipleVsLaunch: 1, liquidityTokenAccounts: [] };
const chainWith = (facts: MintFacts): ChainReader => ({ mintFacts: async () => facts, marketFacts: async () => open, metaplexMetadata: async () => ({ name: "Adin Coin", symbol: "ADIN" }) as never, mintAgeSeconds: async () => ({ seconds: 60, exact: true }), top10HolderPct: async () => 5, tokenBalance: async () => 0n });

const signalFrom = (over: Partial<AddressSignal> = {}): AddressSignal => ({
  mint: F.MINT.plain, source: "x", path: "filtered_stream", postId: "1", postUrl: "https://x.com/adinross/status/1", accountId: F.ADIN,
  account: { userId: F.ADIN, handle: "adinross", person: "adin_ross", tier: 1, isTest: false },
  postKind: "original", referencesWatchedAuthor: false, origins: [{ kind: "text" }], mintsInPost: 1, warningKeywords: [], blockedMintNote: undefined,
  postText: "ADIN live", postCreatedAt: new Date().toISOString(), receivedAt: Date.now(),
  ...over,
});
const testSignal = () => signalFrom({ accountId: F.TEST, account: { userId: F.TEST, handle: "TestPoster", person: "test", tier: 1, isTest: true }, postUrl: "https://x.com/TestPoster/status/1" });

/** Runs one signal through a real engine and validator, with a stand-in executor that records when it's asked to buy. */
async function runEngine(signal: AddressSignal, facts: MintFacts = mintFacts) {
  const db = openDb(":memory:");
  const order: string[] = [];
  const group: string[] = [];
  const owner: string[] = [];
  const engine = new Engine({
    mode: "dry-run", config, db, log: quiet(), alert: () => {}, color: false,
    chain: chainWith(facts),
    executor: { simulateRoundTrip: async () => ({ ok: true, detail: "ok" }), buy: async () => (order.push("buy"), { status: "simulated", positionId: 4, tokens: 357_000_000_000n, lamports: 10_000_000n, variant: "pump_curve:v3", signedMs: 5 }) } as never,
    notify: (t) => owner.push(t),
    broadcast: (t) => (order.push("broadcast"), group.push(t)),
  });
  const id = recordSignal(db, createRedactor([]), signal)!;
  const verdict = await engine.handle(signal, assessSignal(signal), id);
  return { verdict: verdict!, order, group, owner };
}

describe("group alert: the text", () => {
  it("for a coin that passed: who posted it, the address, the verdict, and links to buy by hand", async () => {
    const { verdict } = await runEngine(signalFrom());
    expect(verdict.decision).toBe("buy");
    const text = publicCoinAlert(signalFrom(), verdict)!;
    expect(text).toContain("COIN ADDRESS posted by @adinross on x");
    expect(text).toContain(F.MINT.plain);
    expect(text).toContain("Post: https://x.com/adinross/status/1");
    expect(text).toContain("Bot's checks: PASSED");
    expect(text).toContain(`Jupiter: https://jup.ag/swap/SOL-${F.MINT.plain}`);
    expect(text).toContain(`pump.fun: https://pump.fun/coin/${F.MINT.plain}`);
    expect(text).toContain(`Chart: https://dexscreener.com/solana/${F.MINT.plain}`);
    expect(text).toContain("Open in Phantom: https://phantom.com/ul/browse/");
    expect(text).toContain("not advice");
    expect(text.length).toBeLessThan(4000);
  });

  it("builds a Phantom link that opens the Jupiter swap page, fully encoded", () => {
    const links = solanaBuyLinks(F.MINT.plain, false);
    expect(links.map((l) => l.label)).toEqual(["Open in Phantom", "Jupiter", "Chart"]); // no pump.fun link for a coin that isn't on pump.fun
    const phantom = new URL(links[0]!.url);
    expect(phantom.origin + phantom.pathname.slice(0, 11)).toBe("https://phantom.com/ul/browse/");
    expect(decodeURIComponent(phantom.pathname.slice(11))).toBe(`https://jup.ag/swap/SOL-${F.MINT.plain}`);
    expect(phantom.searchParams.get("ref")).toBe("https://jup.ag");
  });

  it("for a coin the checks blocked: says DO NOT BUY, gives the reason, and has no buy link at all", async () => {
    const frozen = { ...mintFacts, freezeAuthority: "Freezer1111111111111111111111111111111111111" };
    const { verdict } = await runEngine(signalFrom(), frozen);
    expect(verdict.decision).toBe("blocked");
    const text = publicCoinAlert(signalFrom(), verdict)!;
    expect(text.startsWith("DO NOT BUY.")).toBe(true);
    expect(text).toContain("BLOCKED");
    expect(text).toMatch(/\nx .*freeze/i);
    for (const host of ["jup.ag", "pump.fun", "phantom.com", "dexscreener.com"]) expect(text).not.toContain(host);
  });

  it("is never written for a test account's post", async () => {
    const { verdict } = await runEngine(signalFrom());
    expect(publicCoinAlert(testSignal(), verdict)).toBeUndefined();
  });

  it("for a 0x address: Uniswap links when it looks right, none when it looks wrong, nothing for a test account", () => {
    const sighting = (over: Partial<EvmSighting> = {}): EvmSighting => ({
      address: "0x1111111111111111111111111111111111111111", source: "x", path: "filtered_stream", postId: "9", postUrl: "https://x.com/adinross/status/9", accountId: F.ADIN,
      account: { userId: F.ADIN, handle: "adinross", person: "adin_ross", tier: 1, isTest: false },
      postKind: "original", referencesWatchedAuthor: false, origins: [{ kind: "text" }], addressesInPost: 1, warningKeywords: [],
      chains: [{ chain: "base", status: "contract", symbol: "ADIN" }, { chain: "ethereum", status: "none" }], postCreatedAt: undefined, receivedAt: 1,
      ...over,
    });
    const ok = publicEvmAlert(sighting(), { severity: "green", reasons: ["contract found on base (ADIN)"] })!;
    expect(ok).toContain("0x ADDRESS posted by @adinross on x");
    expect(ok).toContain("Uniswap, base: https://app.uniswap.org/swap?chain=base");
    expect(ok).not.toContain("chain=mainnet");
    const bad = publicEvmAlert(sighting(), { severity: "red", reasons: ["this is a reply"] })!;
    expect(bad.startsWith("CAREFUL.")).toBe(true);
    expect(bad).not.toContain("uniswap");
    expect(publicEvmAlert(sighting({ account: { userId: F.TEST, handle: "TestPoster", person: "test", tier: 1, isTest: true } }), { severity: "green", reasons: [] })).toBeUndefined();
  });
});

describe("group alert: what the engine sends, and when", () => {
  it("goes out as soon as the checks pass, before the bot's own buy", async () => {
    const r = await runEngine(signalFrom());
    expect(r.order).toEqual(["broadcast", "buy"]);
    expect(r.group).toHaveLength(1);
  });

  it("never carries the owner's trade: no size, no position, no token count", async () => {
    const r = await runEngine(signalFrom());
    // The owner's own message has all of it...
    expect(r.owner[0]).toContain("BUY SIMULATED: 0.0100 SOL");
    expect(r.owner[0]).toContain("position #4");
    // ...and the group's has none of it.
    for (const priv of ["0.0100", "SOL ->", "position #", "357,000", "BUY SIMULATED", "BOUGHT", "DRY-RUN"]) expect(r.group[0]).not.toContain(priv);
  });

  it("warns the group when the checks block a coin, and the bot doesn't buy", async () => {
    const r = await runEngine(signalFrom(), { ...mintFacts, freezeAuthority: "Freezer1111111111111111111111111111111111111" });
    expect(r.order).toEqual(["broadcast"]);
    expect(r.group[0]).toContain("DO NOT BUY.");
  });

  it("stays silent for a test account's post, though the owner still hears about it", async () => {
    const r = await runEngine(testSignal());
    expect(r.group).toEqual([]);
    expect(r.order).toEqual(["buy"]);
    expect(r.owner[0]).toContain("(TEST ACCOUNT)");
  });
});

describe("group alert: Telegram delivery", () => {
  const tg = (api: ReturnType<typeof telegramApi>, alertChatIds: string[], lines: string[] = []) =>
    new Telegram({ token: TOKEN, ownerChatId: OWNER, alertChatIds, log: createLogger({ redactor: createRedactor(["rpc-secret-abc12345"]), write: (l) => lines.push(l) }), fetch: fakeFetch([api.route]).fetch });

  it("sends to every alert chat and not to the owner; send() still goes only to the owner", async () => {
    const api = telegramApi();
    const t = tg(api, [GROUP, CHANNEL]);
    expect(await t.broadcast("coin alert")).toBe(2);
    expect(api.sent.map((s) => s.chat_id).sort()).toEqual([CHANNEL, GROUP].sort());
    await t.send("private status");
    expect(api.to(OWNER)).toEqual(["private status"]);
    expect(api.to(GROUP)).toEqual(["coin alert"]);
    expect(t.stats).toMatchObject({ broadcast: 2, broadcastFailures: 0, sent: 1 });
  });

  it("drops duplicates and the owner's own chat from the list, and does nothing with no alert chats", async () => {
    const api = telegramApi();
    const t = tg(api, [GROUP, ` ${GROUP} `, OWNER, ""]);
    expect(t.alertChatCount).toBe(1);
    expect(await t.broadcast("x")).toBe(1);
    expect(await tg(api, []).broadcast("x")).toBe(0);
    expect(api.sent).toHaveLength(1);
  });

  it("one chat failing doesn't stop the others, never throws, and never leaks the token", async () => {
    const api = telegramApi([GROUP]);
    const lines: string[] = [];
    const t = tg(api, [GROUP, CHANNEL], lines);
    expect(await t.broadcast("coin alert")).toBe(1);
    expect(api.to(CHANNEL)).toEqual(["coin alert"]);
    expect(t.stats).toMatchObject({ broadcast: 1, broadcastFailures: 1 });
    const text = lines.join("\n");
    expect(text).toContain("telegram.broadcast_failed");
    expect(text).not.toContain("telegram-secret-token");
    expect(text).not.toContain("api.telegram.org");
  });

  it("redacts secrets from what it broadcasts", async () => {
    const api = telegramApi();
    await tg(api, [GROUP]).broadcast("error at https://rpc.example.com/?api-key=rpc-secret-abc12345");
    expect(api.sent[0]!.text).not.toContain("rpc-secret-abc12345");
  });

  it("ignores commands sent from an alert chat: only the owner's chat can control the bot", async () => {
    const api = telegramApi([], [{ update_id: 5, message: { chat: { id: Number(GROUP) }, text: "/kill" } }, { update_id: 6, message: { chat: { id: Number(GROUP) }, text: "/sell" } }]);
    const t = tg(api, [GROUP]);
    const stop = new AbortController();
    const seen: string[] = [];
    const listening = t.listen(stop.signal, (c) => (seen.push(c.name), "done"));
    await new Promise((r) => setTimeout(r, 30));
    stop.abort();
    await listening;
    expect(seen).toEqual([]);
    expect(api.sent).toEqual([]);
    expect(t.stats).toMatchObject({ commands: 0, ignored: 2 });
  });
});

describe("TELEGRAM_ALERT_CHAT_IDS", () => {
  it("reads one or several chat ids", () => {
    expect(alertChatIds(parseEnv({ TELEGRAM_ALERT_CHAT_IDS: GROUP }))).toEqual([GROUP]);
    expect(alertChatIds(parseEnv({ TELEGRAM_ALERT_CHAT_IDS: `${GROUP}, ${CHANNEL},${GROUP}`, TELEGRAM_OWNER_CHAT_ID: OWNER }))).toEqual([GROUP, CHANNEL]);
    expect(alertChatIds(parseEnv({ TELEGRAM_ALERT_CHAT_IDS: `${OWNER},${GROUP}`, TELEGRAM_OWNER_CHAT_ID: OWNER }))).toEqual([GROUP]);
    expect(alertChatIds(parseEnv({}))).toEqual([]);
  });

  it("rejects anything that isn't a list of chat ids", () => {
    for (const bad of ["@mygroup", "https://t.me/mygroup", "-100 123", "abc"]) expect(() => parseEnv({ TELEGRAM_ALERT_CHAT_IDS: bad })).toThrow(/TELEGRAM_ALERT_CHAT_IDS/);
  });
});

describe("main --watch with a friends' group (fake APIs)", () => {
  const users = [
    { id: F.ADIN, username: "adinross" },
    { id: "1511793806080819202", username: "AR15thed3mon" },
    { id: F.BANKS, username: "Banks" },
    { id: "1729276822485889024", username: "MarketBubble" },
    { id: F.TEST, username: "TestPoster" },
  ];
  async function run(activity: unknown[]) {
    const api = telegramApi();
    const dir = tempDir();
    const envPath = join(dir, ".env");
    const env = { ...FAKE_SECRETS, TEST_X_ACCOUNTS: TEST_X_ACCOUNTS_ENV, TELEGRAM_OWNER_CHAT_ID: OWNER, TELEGRAM_ALERT_CHAT_IDS: GROUP, SIM_PAYER_PUBKEY: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" };
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const { fetch } = fakeFetch([api.route, ...solanaRpcRoutes({ byPosition: [OPEN_CURVE, null] }), ...xApiRoutes({ users, activity })]);
    const lines: string[] = [];
    const code = await main({ argv: ["--watch", "--duration", "0.6", "--data-dir", dir, "--env-file", envPath], env: {}, cwd: REPO_ROOT, write: (l) => lines.push(l), alert: () => {}, fetch, ocr: null, tradeBuilder: fakeBuilder().builder });
    return { code, api, lines, events: lines.map((l) => JSON.parse(l)) };
  }

  it("an official account's coin reaches the group once, with buy links and nothing private; start and stop messages stay with the owner", async () => {
    const r = await run([F.plainAddress]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.events.find((e) => e.event === "telegram.alert_chats")).toMatchObject({ count: 1 });
    const group = r.api.to(GROUP);
    expect(group).toHaveLength(1);
    expect(group[0]).toContain("posted by @adinross on x");
    expect(group[0]).toContain(F.MINT.plain);
    expect(group[0]).toMatch(/Bot's checks: PASSED|DO NOT BUY\./);
    for (const priv of ["Sniper started", "Sniper is stopping", "position #", "SOL ->", "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"]) expect(group.join("\n")).not.toContain(priv);
    expect(r.api.to(OWNER).some((t) => t.startsWith("Sniper started"))).toBe(true);
    for (const needle of SECRET_NEEDLES) expect(r.api.sent.map((s) => s.text).join("\n")).not.toContain(needle);
  });

  it("a rehearsal post from the test account never reaches the group", async () => {
    const r = await run([F.testAccountPost]);
    expect(r.api.to(GROUP)).toEqual([]);
    expect(r.api.to(OWNER).some((t) => t.includes("(TEST ACCOUNT)"))).toBe(true);
  });
});
