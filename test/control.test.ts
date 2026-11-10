import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Engine, formatUnits, isMidMigration } from "../src/app/engine.ts";
import { EXIT, main } from "../src/app/main.ts";
import type { ChainReader, MarketFacts, MintFacts } from "../src/chain/facts.ts";
import { PROGRAMS } from "../src/chain/sdk.ts";
import { handleCommand, type ControlHooks } from "../src/control/commands.ts";
import { parseCommand, Telegram } from "../src/control/telegram.ts";
import type { PositionView } from "../src/exit/manager.ts";
import { createLogger } from "../src/log/logger.ts";
import { createRedactor } from "../src/log/redact.ts";
import { openDb } from "../src/state/db.ts";
import { assessSignal, recordSignal, type AddressSignal } from "../src/watch/signal.ts";
import { solanaRpcRoutes } from "./fake-chain.ts";
import { fakeBuilder } from "./fake-trade.ts";
import { fakeFetch, json, xApiRoutes, type Route } from "./fake-x.ts";
import { OPEN_CURVE } from "./fixtures/chain.ts";
import * as F from "./fixtures/x-posts.ts";
import { FAKE_SECRETS, loadTestConfig, REPO_ROOT, SECRET_NEEDLES, tempDir, TEST_X_ACCOUNTS_ENV } from "./helpers.ts";

const config = loadTestConfig();
const TOKEN = FAKE_SECRETS.TELEGRAM_BOT_TOKEN;
const OWNER = "777000111";

/** A fake Telegram Bot API. `updates` are handed out once, in order, then long-polls return nothing. */
function telegramApi(updates: { update_id: number; message: { chat: { id: number }; text: string } }[] = []) {
  const sent: { chat_id: string; text: string }[] = [];
  const queue = [...updates];
  const route: Route = async ({ url, body, signal }) => {
    if (url.hostname !== "api.telegram.org") return;
    const method = url.pathname.split("/").pop();
    if (!url.pathname.startsWith(`/bot${TOKEN}/`)) return json({ ok: false, description: "Unauthorized" }, 401);
    if (method === "getMe") return json({ ok: true, result: { username: "my_sniper_bot" } });
    if (method === "sendMessage") {
      sent.push(body as { chat_id: string; text: string });
      return json({ ok: true, result: {} });
    }
    if (method === "getUpdates") {
      const b = body as { offset?: number; timeout?: number };
      // offset -1 = "just show me the newest update". It isn't consumed.
      if (b.offset === -1) return json({ ok: true, result: queue.length ? [queue.at(-1)] : [] });
      // Long poll: answer as soon as there's something at or past the offset, or when aborted.
      for (;;) {
        const ready = queue.filter((u) => b.offset === undefined || u.update_id >= b.offset);
        if (ready.length) {
          queue.splice(0, queue.length);
          return json({ ok: true, result: ready });
        }
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    return json({ ok: false, description: "unknown method" }, 404);
  };
  return { route, sent, push: (u: (typeof updates)[number]) => queue.push(u) };
}

const msg = (update_id: number, text: string, chat = Number(OWNER)) => ({ update_id, message: { chat: { id: chat }, text } });
const quiet = () => createLogger({ write: () => {} });

describe("Telegram commands: parsing and authorization", () => {
  it("parses commands, with or without the bot's name", () => {
    expect(parseCommand("/status")).toEqual({ name: "status", args: [] });
    expect(parseCommand("  /SELL@my_sniper_bot 3 ")).toEqual({ name: "sell", args: ["3"] });
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });

  it("acts only on the owner's chat, ignores everyone else, and replies", async () => {
    const api = telegramApi([msg(10, "/status", 12345), msg(11, "/status"), msg(12, "not a command")]);
    const lines: string[] = [];
    const tg = new Telegram({ token: TOKEN, ownerChatId: OWNER, log: createLogger({ write: (l) => lines.push(l) }), fetch: fakeFetch([api.route]).fetch });
    const stop = new AbortController();
    const seen: string[] = [];
    const listening = tg.listen(stop.signal, (c) => (seen.push(c.name), "all good"));
    await new Promise((r) => setTimeout(r, 30));
    stop.abort();
    await listening;
    expect(seen).toEqual(["status"]);
    expect(api.sent).toEqual([{ chat_id: OWNER, text: "all good", disable_web_page_preview: true }]);
    expect(tg.stats).toMatchObject({ commands: 1, ignored: 1 });
    expect(lines.map((l) => JSON.parse(l).event)).toContain("telegram.ignored_sender");
  });

  it("drops commands that were sent while the bot was offline, and acts on ones sent after", async () => {
    const api = telegramApi([msg(50, "/sell")]); // sent before startup
    const tg = new Telegram({ token: TOKEN, ownerChatId: OWNER, log: quiet(), fetch: fakeFetch([api.route]).fetch });
    await tg.discardBacklog();
    const stop = new AbortController();
    const seen: string[] = [];
    const listening = tg.listen(stop.signal, (c) => (seen.push(c.name), "ok"));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]); // the stale /sell did not fire
    api.push(msg(51, "/status"));
    await new Promise((r) => setTimeout(r, 40));
    stop.abort();
    await listening;
    expect(seen).toEqual(["status"]);
  });

  it("never throws from send, and never leaks the token in a failure", async () => {
    const lines: string[] = [];
    const log = createLogger({ redactor: createRedactor([TOKEN]), write: (l) => lines.push(l) });
    const down = new Telegram({ token: TOKEN, ownerChatId: OWNER, log, fetch: (async (u: string) => Promise.reject(new TypeError(`fetch failed ${u}`))) as unknown as typeof fetch });
    expect(await down.send("hello")).toBe(false);
    const bad = new Telegram({ token: "wrong", ownerChatId: OWNER, log, fetch: fakeFetch([telegramApi().route]).fetch });
    expect(await bad.send("hello")).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("Telegram sendMessage: network error");
    expect(text).toContain("Telegram sendMessage: HTTP 401 Unauthorized");
    expect(text).not.toContain("telegram-secret-token");
    expect(text).not.toContain("api.telegram.org");
  });

  it("redacts secrets from outgoing messages", async () => {
    const api = telegramApi();
    const log = createLogger({ redactor: createRedactor(["rpc-secret-abc12345"]), write: () => {} });
    const tg = new Telegram({ token: TOKEN, ownerChatId: OWNER, log, fetch: fakeFetch([api.route]).fetch });
    await tg.send("error at https://rpc.example.com/?api-key=rpc-secret-abc12345");
    expect(api.sent[0]!.text).not.toContain("rpc-secret-abc12345");
  });
});

describe("command handlers", () => {
  function hooks(over: Partial<ControlHooks> = {}) {
    const state = { armed: true, sold: [] as (number | undefined)[] };
    const pos: PositionView = { id: 3, mint: F.MINT.plain, simulated: true, heldPct: 75, gainPct: 62.5, peakGainPct: 110, stepsDone: 1, costSol: 0.01, proceedsSol: 0.004, ageMinutes: 12.4 };
    const h: ControlHooks = {
      mode: "dry-run",
      startedAt: 0,
      now: () => 30 * 60_000,
      isArmed: () => state.armed,
      setArmed: (a) => (state.armed = a),
      positions: () => [pos],
      panicSell: (id) => (state.sold.push(id), id === undefined || id === 3 ? 1 : 0),
      watching: () => ["X (@adinross, @Banks)", "kick"],
      stats: () => ({}),
      ...over,
    };
    return { h, state };
  }
  const run = (text: string, h: ControlHooks) => handleCommand(parseCommand(text)!, h);

  it("/status shows mode, armed state, what's watched and each position", () => {
    const { h } = hooks();
    const s = run("/status", h);
    expect(s).toContain("Mode: dry-run (nothing real is traded)");
    expect(s).toContain("Buying: ARMED");
    expect(s).toContain("Up 30 min. Watching: X (@adinross, @Banks), kick");
    expect(s).toContain("#3 6gaH…LbLC (paper): +62.5% now, peak +110.0%, holding 75%, in 0.0100 SOL, out 0.0040 SOL, 12 min old");
    expect(run("/status", hooks({ positions: () => [] }).h)).toContain("No open positions.");
  });

  it("/sell sells everything or one position, and rejects nonsense", () => {
    const { h, state } = hooks();
    expect(run("/sell", h)).toBe("Selling 1 position now (paper sale). I'll confirm when it's done.");
    expect(run("/sell 3", h)).toContain("Selling 1 position");
    expect(run("/sell 9", h)).toBe("Position 9 isn't open.");
    expect(run("/sell abc", h)).toContain("Use /sell");
    expect(state.sold).toEqual([undefined, 3, 9]);
  });

  it("/kill turns buying off and /arm turns it back on", () => {
    const { h, state } = hooks();
    expect(run("/kill", h)).toContain("Buying is OFF");
    expect(state.armed).toBe(false);
    expect(run("/status", h)).toContain("Buying: OFF (/kill was sent)");
    expect(run("/arm", h)).toBe("Buying is ARMED again.");
    expect(state.armed).toBe(true);
  });

  it("has no command that buys", () => {
    const { h } = hooks();
    for (const c of ["/buy", "/buy abc", "/snipe", "/trade"]) expect(run(c, h)).toContain("Unknown command");
    expect(run("/help", h)).not.toMatch(/buy a|\/buy/i);
  });
});

// ---------- engine: kill switch and waiting for the pool ----------

const mintFacts: MintFacts = { address: F.MINT.plain, exists: true, owner: PROGRAMS.token2022, tokenProgram: "token-2022", isMint: true, decimals: 6, supply: 10n ** 15n, mintAuthority: null, freezeAuthority: null, extensions: [], onMintMetadata: { name: "Adin", symbol: "ADIN" } };
const open: MarketFacts = { venue: "pump_curve", detail: "open", isPumpToken: true, curveComplete: false, creator: "C", priceLamportsPerUnit: 2.8e-5, quoteReserveLamports: 30_000_000_000n, tokenReserveUnits: 10n ** 15n, multipleVsLaunch: 1, liquidityTokenAccounts: [] };
const migrating: MarketFacts = { ...open, venue: "none", curveComplete: true, detail: "pump.fun curve is complete but the PumpSwap pool doesn't exist yet (mid-migration)", priceLamportsPerUnit: undefined, quoteReserveLamports: undefined };
const pooled: MarketFacts = { ...open, venue: "pumpswap", curveComplete: true, detail: "PumpSwap pool", quoteReserveLamports: 400_000_000_000n };

function engineWith(markets: MarketFacts[], forMs = 45_000) {
  let i = 0;
  let clock = Date.parse("2026-11-19T17:00:05.000Z");
  const chain: ChainReader = {
    mintFacts: async () => mintFacts,
    marketFacts: async () => markets[Math.min(i++, markets.length - 1)]!,
    metaplexMetadata: async () => null,
    mintAgeSeconds: async () => ({ seconds: 60, exact: true }),
    top10HolderPct: async () => 5,
    tokenBalance: async () => 0n,
  };
  const db = openDb(":memory:");
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  const alerts: string[] = [];
  const notes: string[] = [];
  const engine = new Engine({
    mode: "dry-run",
    config,
    db,
    log,
    alert: (t) => alerts.push(t),
    color: false,
    chain,
    simulateRoundTrip: async () => ({ ok: true, detail: "simulated ok" }),
    notify: (t) => notes.push(t),
    migrationRetry: { everyMs: 1_500, forMs },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  const signal: AddressSignal = {
    mint: F.MINT.plain, source: "x", path: "filtered_stream", postId: "1", postUrl: "https://x.com/adinross/status/1", accountId: F.ADIN,
    account: { userId: F.ADIN, handle: "adinross", person: "adin_ross", tier: 1, isTest: false },
    postKind: "original", referencesWatchedAuthor: false, origins: [{ kind: "text" }], mintsInPost: 1, warningKeywords: [], blockedMintNote: undefined,
    postText: "ADIN live", postCreatedAt: "2026-11-19T17:00:00.000Z", receivedAt: clock,
  };
  const id = recordSignal(db, log.redactor, signal)!;
  return { engine, signal, id, alerts, notes, events: () => lines.map((l) => JSON.parse(l) as { event: string }), calls: () => i };
}

describe("engine: waiting out a pump.fun migration", () => {
  it("keeps re-checking while the coin is between curve and pool, then passes", async () => {
    const e = engineWith([migrating, migrating, migrating, pooled]);
    const v = await e.engine.handle(e.signal, assessSignal(e.signal), e.id);
    expect(v?.decision).toBe("buy");
    expect(v?.market?.venue).toBe("pumpswap");
    expect(e.engine.stats.migrationRetries).toBe(3);
    expect(e.events().filter((x) => x.event === "validation.waiting_for_pool")).toHaveLength(3);
    expect(e.alerts[0]).toContain("VALIDATOR: PASS");
  });

  it("gives up after the configured time and reports why", async () => {
    const e = engineWith([migrating], 6_000);
    const v = await e.engine.handle(e.signal, assessSignal(e.signal), e.id);
    expect(v?.decision).toBe("blocked");
    expect(e.engine.stats.migrationRetries).toBe(4); // 6 s / 1.5 s
    expect(e.alerts[0]).toContain("mid-migration");
  });

  it("doesn't retry a block that has any other cause", async () => {
    expect(isMidMigration({ decision: "blocked", market: migrating, blocks: [{ id: "route_exists", group: "market", result: "block", detail: "" }, { id: "freeze_authority_null", group: "sellability", result: "block", detail: "" }] } as never)).toBe(false);
    expect(isMidMigration({ decision: "blocked", market: { ...migrating, isPumpToken: false }, blocks: [{ id: "route_exists", group: "market", result: "block", detail: "" }] } as never)).toBe(false);
    expect(isMidMigration({ decision: "buy", market: open, blocks: [] } as never)).toBe(false);
  });

  it("sends Telegram a short summary of every verdict", async () => {
    const e = engineWith([open]);
    await e.engine.handle(e.signal, assessSignal(e.signal), e.id);
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0]).toMatch(/^GREEN: coin address from @adinross on x\n6gaH.*\nhttps:\/\/x\.com\/adinross\/status\/1\n/);
    expect(e.notes[0]).toContain("VALIDATOR: PASS");
    expect(e.notes[0]).toContain("DRY-RUN: no real transaction.");
  });

  it("formats token amounts", () => {
    expect(formatUnits(357_142_857_142n, 6)).toBe("357,142.857142");
    expect(formatUnits(5n, 6)).toBe("0.000005");
    expect(formatUnits(1_234_567n, 0)).toBe("1,234,567");
  });
});

// ---------- the whole bot with Telegram: alert out, /kill in ----------

describe("main --watch with Telegram (fake APIs)", () => {
  const users = [
    { id: F.ADIN, username: "adinross" },
    { id: "1511793806080819202", username: "AR15thed3mon" },
    { id: F.BANKS, username: "Banks" },
    { id: "1729276822485889024", username: "MarketBubble" },
    { id: F.TEST, username: "TestPoster" },
  ];

  async function run(api: ReturnType<typeof telegramApi>, activity: unknown[]) {
    const dir = tempDir();
    const envPath = join(dir, ".env");
    const env = { ...FAKE_SECRETS, TEST_X_ACCOUNTS: TEST_X_ACCOUNTS_ENV, TELEGRAM_OWNER_CHAT_ID: OWNER, SIM_PAYER_PUBKEY: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" };
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const rpcCalls: string[] = [];
    const { fetch } = fakeFetch([api.route, ...solanaRpcRoutes({ byPosition: [OPEN_CURVE, null], calls: rpcCalls }), ...xApiRoutes({ users, activity })]);
    const lines: string[] = [];
    const alerts: string[] = [];
    const code = await main({
      argv: ["--watch", "--duration", "0.6", "--data-dir", dir, "--env-file", envPath],
      env: {},
      cwd: REPO_ROOT,
      write: (l) => lines.push(l),
      alert: (t) => alerts.push(t),
      fetch,
      ocr: null,
      tradeBuilder: fakeBuilder().builder,
    });
    return { code, lines, alerts, rpcCalls, dir, events: lines.map((l) => JSON.parse(l)) };
  }

  it("announces itself, sends the alert with the paper buy, and says goodbye with a position open", async () => {
    const api = telegramApi();
    const r = await run(api, [F.testAccountPost]);
    expect(r.code).toBe(EXIT.OK);
    const texts = api.sent.map((s) => s.text);
    expect(texts[0]).toMatch(/^Sniper started in dry-run mode\. Watching 5 X accounts\. Validator on\. Buying armed\./);
    const alert = texts.find((t) => t.includes("coin address from @TestPoster"));
    expect(alert).toContain("(TEST ACCOUNT)");
    expect(alert).toContain("BUY SIMULATED: 0.0100 SOL");
    expect(texts.at(-1)).toBe("Sniper is stopping with 1 open position(s). Nothing manages them until it's started again.");
    expect(api.sent.every((s) => s.chat_id === OWNER)).toBe(true);
    expect(r.events.find((e) => e.event === "watch.started")).toMatchObject({ telegram: "on", exit_manager: "on", executor: "simulate only" });
    const all = r.lines.join("\n") + r.alerts.join("\n") + texts.join("\n");
    for (const needle of SECRET_NEEDLES) expect(all).not.toContain(needle);
    expect(r.rpcCalls.filter((m) => /send/i.test(m))).toEqual([]);
  });

  it("/kill before the post means the coin is validated but not bought", async () => {
    const api = telegramApi();
    // /kill is sent 60 ms after startup; the post arrives 250 ms in.
    setTimeout(() => api.push(msg(100, "/kill")), 60);
    const delayed = { ...F.testAccountPost };
    const dir = tempDir();
    const envPath = join(dir, ".env");
    writeFileSync(envPath, Object.entries({ ...FAKE_SECRETS, TEST_X_ACCOUNTS: TEST_X_ACCOUNTS_ENV, TELEGRAM_OWNER_CHAT_ID: OWNER, SIM_PAYER_PUBKEY: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    // Deliver the post only after the kill switch has been processed.
    const x = xApiRoutes({ users, activity: [] });
    const lateStream: Route = ({ url, signal }) => {
      if (url.pathname !== "/2/activity/stream") return;
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(ctrl) {
            await new Promise((r) => setTimeout(r, 250));
            ctrl.enqueue(enc.encode(JSON.stringify(delayed) + "\r\n"));
            signal?.addEventListener("abort", () => { try { ctrl.error(new DOMException("aborted", "AbortError")); } catch {} });
          },
        }),
        { status: 200 },
      );
    };
    const { fetch } = fakeFetch([api.route, ...solanaRpcRoutes({ byPosition: [OPEN_CURVE, null] }), lateStream, ...x]);
    const alerts: string[] = [];
    const code = await main({ argv: ["--watch", "--duration", "0.8", "--data-dir", dir, "--env-file", envPath], env: {}, cwd: REPO_ROOT, write: () => {}, alert: (t) => alerts.push(t), fetch, ocr: null, tradeBuilder: fakeBuilder().builder });
    expect(code).toBe(EXIT.OK);
    expect(api.sent.map((s) => s.text).some((t) => t.startsWith("Buying is OFF."))).toBe(true);
    const banner = alerts.find((a) => a.includes("VALIDATOR"));
    expect(banner).toContain("VALIDATOR: PASS");
    expect(banner).toContain("BUY SKIPPED: buying is off (/kill was sent)");
    const db = new DatabaseSync(join(dir, "dry-run.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT kind FROM audit_log").all() as { kind: string }[]).map((k) => k.kind)).toContain("control.armed_changed");
    db.close();
  });
});

describe("engine: shutdown and uncertain buys (review fixes)", () => {
  it("never opens a position while the bot is shutting down", async () => {
    const e = engineWith([open]);
    const alerts: string[] = [];
    const db = openDb(":memory:");
    let bought = 0;
    // An executor that would buy if asked.
    const eng = new Engine({
      mode: "dry-run", config, db, log: createLogger({ write: () => {} }), alert: (t) => alerts.push(t), color: false,
      chain: { mintFacts: async () => mintFacts, marketFacts: async () => open, metaplexMetadata: async () => null, mintAgeSeconds: async () => ({ seconds: 60, exact: true }), top10HolderPct: async () => 5, tokenBalance: async () => 0n },
      executor: { simulateRoundTrip: async () => ({ ok: true, detail: "ok" }), buy: async () => (bought++, { status: "skipped", reason: "x" }) } as never,
    });
    const id = recordSignal(db, createRedactor([]), e.signal)!;
    eng.stopping = true;
    await eng.handle(e.signal, assessSignal(e.signal), id);
    expect(bought).toBe(0);
    expect(alerts[0]).toContain("VALIDATOR: PASS");
    expect(alerts[0]).toContain("BUY SKIPPED: the bot is shutting down.");
  });

  it("stops waiting for a migrating pool as soon as shutdown starts", async () => {
    const e = engineWith([migrating]);
    e.engine.stopping = true;
    await e.engine.handle(e.signal, assessSignal(e.signal), e.id);
    expect(e.engine.stats.migrationRetries).toBe(0);
  });

  it("reports a sent-but-unconfirmed buy plainly instead of calling it failed", async () => {
    const alerts: string[] = [];
    const db = openDb(":memory:");
    const eng = new Engine({
      mode: "dry-run", config, db, log: createLogger({ write: () => {} }), alert: (t) => alerts.push(t), color: false,
      chain: { mintFacts: async () => mintFacts, marketFacts: async () => open, metaplexMetadata: async () => null, mintAgeSeconds: async () => ({ seconds: 60, exact: true }), top10HolderPct: async () => 5, tokenBalance: async () => 0n },
      executor: { simulateRoundTrip: async () => ({ ok: true, detail: "ok" }), buy: async () => ({ status: "unknown", positionId: 7, signature: "5igSomething", detail: "confirmed, but the tokens aren't visible in the wallet yet" }) } as never,
    });
    const e = engineWith([open]);
    const id = recordSignal(db, createRedactor([]), e.signal)!;
    await eng.handle(e.signal, assessSignal(e.signal), id);
    expect(alerts[0]).toContain("BUY SENT, RESULT UNKNOWN: confirmed, but the tokens aren't visible in the wallet yet");
    expect(alerts[0]).toContain("The bot keeps checking the wallet");
    expect(eng.stats.unresolved).toBe(1);
  });
});

describe("main: X is down (review fix)", () => {
  const env = { ...FAKE_SECRETS, TEST_X_ACCOUNTS: TEST_X_ACCOUNTS_ENV, TELEGRAM_OWNER_CHAT_ID: OWNER, SIM_PAYER_PUBKEY: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9" };
  function start(dir: string, api: ReturnType<typeof telegramApi>, lines: string[], alerts: string[], duration: string) {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    // X answers 503 to everything: the account check fails.
    const xDown: Route = ({ url }) => (url.hostname === "api.x.com" ? json({ title: "Service Unavailable" }, 503) : undefined);
    const { fetch } = fakeFetch([api.route, ...solanaRpcRoutes({ byPosition: [OPEN_CURVE, null] }), xDown]);
    return main({ argv: ["--watch", "--duration", duration, "--data-dir", dir, "--env-file", envPath], env: {}, cwd: REPO_ROOT, write: (l) => lines.push(l), alert: (t) => alerts.push(t), fetch, ocr: null, tradeBuilder: fakeBuilder().builder });
  }

  it("with nothing open, it exits with a config error as before", async () => {
    const lines: string[] = [];
    const code = await start(tempDir(), telegramApi(), lines, [], "5");
    expect(code).toBe(EXIT.CONFIG);
    expect(lines.map((l) => JSON.parse(l).event)).toContain("watch.accounts_invalid");
  });

  it("with a position open, it stays up, keeps managing it, and still answers /status", async () => {
    const dir = tempDir();
    // A position left open by an earlier run.
    const db = openDb(join(dir, "dry-run.sqlite"));
    db.prepare(
      "INSERT INTO positions (mint, status, created_at, updated_at, simulated, venue, token_program, tokens_bought, tokens_held, cost_lamports, entry_price, peak_price, opened_at) VALUES (?, 'open', 1, 1, 1, 'pump_curve', 'token-2022', '1000', '1000', 10000000, 10000, 10000, ?)",
    ).run(F.MINT.plain, Date.now());
    db.close();
    const api = telegramApi();
    setTimeout(() => api.push(msg(200, "/status")), 150);
    const lines: string[] = [];
    const alerts: string[] = [];
    const t0 = Date.now();
    const code = await start(dir, api, lines, alerts, "0.5");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450); // it waited for the stop instead of exiting at once
    expect(code).toBe(EXIT.CONFIG);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === "watch.x_down_positions_open")).toMatchObject({ open_positions: 1 });
    const texts = api.sent.map((s) => s.text);
    expect(texts.find((t) => t.startsWith("X can't be watched"))).toContain("Still managing 1 open position(s)");
    const status = texts.find((t) => t.startsWith("Mode: dry-run"));
    expect(status).toContain("Open positions: 1");
    expect(status).toContain("Watching: nothing (X isn't connected)");
    // The exit manager really ran while X was down.
    expect(alerts.some((a) => a.startsWith("X can't be watched"))).toBe(true);
  });
});
