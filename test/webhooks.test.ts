import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/load.ts";
import { createLogger } from "../src/log/logger.ts";
import { openDb } from "../src/state/db.ts";
import {
  buildKickWatchList,
  ensureKickSubscriptions,
  KICK_EVENTS,
  KickClient,
  KickWatcher,
  verifyKickSignature,
  verifyKickWatchList,
} from "../src/watch/kick.ts";
import type { AddressSignal, Assessment } from "../src/watch/signal.ts";
import {
  buildTwitchWatchList,
  ensureTwitchSubscriptions,
  TwitchClient,
  TwitchWatcher,
  verifyTwitchSignature,
  verifyTwitchWatchList,
} from "../src/watch/twitch.ts";
import { SeenIds, startWebhookServer } from "../src/watch/webhook/server.ts";
import { fakeFetch, json } from "./fake-x.ts";
import * as F from "./fixtures/x-posts.ts";
import { CONFIG_DIR } from "./helpers.ts";

const config = loadAppConfig(CONFIG_DIR);
const NOW = Date.parse("2026-11-19T17:00:05.000Z");
const TS = "2026-11-19T17:00:04Z";
const ADIN_KICK = 904404;

function pipeline() {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const db = openDb(":memory:");
  const signals: { s: AddressSignal; a: Assessment }[] = [];
  return {
    log,
    db,
    signals,
    events: () => lines.map((l) => JSON.parse(l) as { event: string }),
    deps: { accounts: config.accounts, validator: config.validator, db, log, onSignal: (s: AddressSignal, a: Assessment) => signals.push({ s, a }) },
  };
}

// ---------- Kick ----------

const kickKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kickPem = kickKeys.publicKey.export({ type: "spki", format: "pem" }) as string;
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

function kickRequest(type: string, body: object, opts: { id?: string; ts?: string; key?: typeof kickKeys.privateKey; signature?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const id = opts.id ?? "01JKICKMSG0000000000000001";
  const ts = opts.ts ?? TS;
  const signature = opts.signature ?? sign("RSA-SHA256", Buffer.from(`${id}.${ts}.${rawBody}`), opts.key ?? kickKeys.privateKey).toString("base64");
  return {
    rawBody,
    headers: { "kick-event-message-id": id, "kick-event-message-timestamp": ts, "kick-event-signature": signature, "kick-event-type": type, "kick-event-version": "1" },
  };
}

const chat = (senderId: number, content: string, extra: object = {}) => ({
  message_id: "msg-" + senderId,
  broadcaster: { user_id: ADIN_KICK, username: "AdinRoss", channel_slug: "adinross" },
  sender: { user_id: senderId, username: senderId === ADIN_KICK ? "AdinRoss" : "randomviewer" },
  content,
  created_at: "2026-11-19T17:00:03Z",
  ...extra,
});

function kickSetup(fetchPublicKey: () => Promise<string> = async () => kickPem) {
  const p = pipeline();
  const watcher = new KickWatcher({ accounts: buildKickWatchList(config.accounts), fetchPublicKey, pipeline: p.deps, log: p.log, now: () => NOW });
  return { ...p, watcher };
}

describe("Kick signature", () => {
  it("accepts Kick's signature and rejects a changed body or another key", () => {
    const r = kickRequest("chat.message.sent", chat(ADIN_KICK, "hi"));
    const sig = r.headers["kick-event-signature"];
    expect(verifyKickSignature(kickPem, "01JKICKMSG0000000000000001", TS, r.rawBody, sig)).toBe(true);
    expect(verifyKickSignature(kickPem, "01JKICKMSG0000000000000001", TS, r.rawBody + " ", sig)).toBe(false);
    expect(verifyKickSignature(otherKeys.publicKey, "01JKICKMSG0000000000000001", TS, r.rawBody, sig)).toBe(false);
    expect(verifyKickSignature("not a key", "a", "b", "c", "d")).toBe(false);
  });
});

describe("KickWatcher", () => {
  it("turns the streamer's own chat message into a signal", async () => {
    const { watcher, signals, db } = kickSetup();
    const res = await watcher.handle(kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain} go go go`)));
    expect(res.status).toBe(200);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.s).toMatchObject({ mint: F.MINT.plain, source: "kick", path: "chat.message.sent", accountId: String(ADIN_KICK), postUrl: "https://kick.com/adinross" });
    expect(signals[0]!.a.severity).toBe("green");
    expect(db.prepare("SELECT source, account_id, mint FROM signals").all()).toEqual([{ source: "kick", account_id: String(ADIN_KICK), mint: F.MINT.plain }]);
  });

  it("ignores every other chatter, whatever address they paste", async () => {
    const { watcher, signals } = kickSetup();
    const res = await watcher.handle(kickRequest("chat.message.sent", chat(555, `REAL CA ${F.MINT.pump} trust me`)));
    expect(res.status).toBe(200);
    expect(signals).toEqual([]);
    expect(watcher.stats.chatFromOthers).toBe(1);
  });

  it("refuses a forged 'streamer' message with a bad signature", async () => {
    const { watcher, signals, events } = kickSetup();
    const forged = kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`), { key: otherKeys.privateKey });
    expect((await watcher.handle(forged)).status).toBe(401);
    expect(signals).toEqual([]);
    expect(events().map((e) => e.event)).toContain("kick.signature_invalid");
  });

  it("ignores a broadcaster that isn't on the watch list", async () => {
    const { watcher, signals } = kickSetup();
    const body = { ...chat(777, `CA ${F.MINT.plain}`), broadcaster: { user_id: 777 } };
    expect((await watcher.handle(kickRequest("chat.message.sent", body))).status).toBe(200);
    expect(signals).toEqual([]);
    expect(watcher.stats.unwatched).toBe(1);
  });

  it("processes a retried message only once", async () => {
    const { watcher, signals } = kickSetup();
    const req = kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`));
    await watcher.handle(req);
    await watcher.handle(req);
    expect(signals).toHaveLength(1);
    expect(watcher.stats.duplicates).toBe(1);
  });

  it("acknowledges but doesn't act on a stale event", async () => {
    const { watcher, signals } = kickSetup();
    const old = kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`), { ts: "2026-11-19T16:00:00Z" });
    expect((await watcher.handle(old)).status).toBe(200);
    expect(signals).toEqual([]);
    expect(watcher.stats.stale).toBe(1);
  });

  it("reads a new stream title, and the title when going live", async () => {
    const { watcher, signals } = kickSetup();
    await watcher.handle(kickRequest("livestream.metadata.updated", { broadcaster: { user_id: ADIN_KICK }, metadata: { title: `GTA 6 RP | ${F.MINT.pump}` } }, { id: "t1" }));
    await watcher.handle(kickRequest("livestream.status.updated", { broadcaster: { user_id: ADIN_KICK }, is_live: true, title: `LIVE ${F.MINT.tco}` }, { id: "t2" }));
    await watcher.handle(kickRequest("livestream.status.updated", { broadcaster: { user_id: ADIN_KICK }, is_live: false, title: `ended ${F.MINT.dexPair}` }, { id: "t3" }));
    expect(signals.map((x) => [x.s.mint, x.s.path])).toEqual([
      [F.MINT.pump, "livestream.metadata.updated"],
      [F.MINT.tco, "livestream.status.updated"],
    ]);
  });

  it("marks the streamer's reply to a chatter as a reply (red)", async () => {
    const { watcher, signals } = kickSetup();
    await watcher.handle(kickRequest("chat.message.sent", chat(ADIN_KICK, `is this it? ${F.MINT.plain}`, { replies_to: { message_id: "x", sender: { user_id: 555 } } })));
    expect(signals[0]!.s.postKind).toBe("reply");
    expect(signals[0]!.a.severity).toBe("red");
  });

  it("refetches the signing key once when Kick rotates it", async () => {
    let calls = 0;
    const oldPem = otherKeys.publicKey.export({ type: "spki", format: "pem" }) as string;
    let now = NOW;
    const p = pipeline();
    const watcher = new KickWatcher({
      accounts: buildKickWatchList(config.accounts),
      fetchPublicKey: async () => (++calls === 1 ? oldPem : kickPem),
      pipeline: p.deps,
      log: p.log,
      now: () => now,
    });
    // First message: the cached key is the old one, and it was fetched moments ago, so no refetch yet.
    expect((await watcher.handle(kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`), { id: "r1" }))).status).toBe(401);
    now += 61_000;
    expect((await watcher.handle(kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`), { id: "r2", ts: new Date(now).toISOString() }))).status).toBe(200);
    expect(calls).toBe(2);
    expect(p.signals).toHaveLength(1);
  });

  it("alerts on a 0x address from the streamer without creating a signal", async () => {
    const p = pipeline();
    const evm: string[] = [];
    const watcher = new KickWatcher({
      accounts: buildKickWatchList(config.accounts),
      fetchPublicKey: async () => kickPem,
      pipeline: { ...p.deps, onEvm: (s) => evm.push(s.address) },
      log: p.log,
      now: () => NOW,
    });
    await watcher.handle(kickRequest("chat.message.sent", chat(ADIN_KICK, "base CA 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")));
    expect(evm).toEqual(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]);
    expect(p.signals).toEqual([]);
  });
});

describe("Kick setup", () => {
  const routes = (subs: object[], channelId = ADIN_KICK) =>
    fakeFetch([
      ({ url }) => (url.hostname === "id.kick.com" ? json({ access_token: "kick-app-token", expires_in: 3600 }) : undefined),
      ({ url }) => (url.pathname === "/public/v1/channels" ? json({ data: [{ broadcaster_user_id: channelId, slug: "adinross" }] }) : undefined),
      ({ url, method }) => (url.pathname === "/public/v1/events/subscriptions" ? (method === "GET" ? json({ data: subs }) : json({ data: [] })) : undefined),
    ]);
  const quiet = createLogger({ write: () => {} });

  it("verifies the slug still maps to the configured numeric ID", async () => {
    const ok = routes([]);
    await verifyKickWatchList(new KickClient({ clientId: "id", clientSecret: "sec", fetch: ok.fetch }), buildKickWatchList(config.accounts), quiet);
    const moved = routes([], 1234);
    await expect(verifyKickWatchList(new KickClient({ clientId: "id", clientSecret: "sec", fetch: moved.fetch }), buildKickWatchList(config.accounts), quiet)).rejects.toThrow(
      /kick\/adinross now resolves to id 1234/,
    );
  });

  it("subscribes only to the events that are missing, with one token request", async () => {
    const f = routes([{ id: "a", event: "chat.message.sent", broadcaster_user_id: ADIN_KICK }]);
    await ensureKickSubscriptions(new KickClient({ clientId: "id", clientSecret: "sec", fetch: f.fetch }), buildKickWatchList(config.accounts), quiet);
    const posts = f.calls.filter((c) => c.method === "POST" && c.url.includes("/events/subscriptions"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      broadcaster_user_id: ADIN_KICK,
      events: KICK_EVENTS.filter((e) => e !== "chat.message.sent").map((name) => ({ name, version: 1 })),
      method: "webhook",
    });
    expect(posts[0]!.auth).toBe("Bearer kick-app-token");
    expect(f.calls.filter((c) => c.url.includes("id.kick.com"))).toHaveLength(1);
  });
});

// ---------- Twitch ----------

const SECRET = "test-eventsub-secret-0123456789";
const ADIN_TWITCH = "59299632";

function twitchRequest(messageType: string, body: object, opts: { id?: string; ts?: string; secret?: string } = {}) {
  const rawBody = JSON.stringify(body);
  const id = opts.id ?? "tw-1";
  const ts = opts.ts ?? "2026-11-19T17:00:04.000Z";
  const signature = "sha256=" + createHmac("sha256", opts.secret ?? SECRET).update(id + ts + rawBody).digest("hex");
  return {
    rawBody,
    headers: {
      "twitch-eventsub-message-id": id,
      "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-signature": signature,
      "twitch-eventsub-message-type": messageType,
    },
  };
}

function twitchSetup(title = "") {
  const p = pipeline();
  const watcher = new TwitchWatcher({ accounts: buildTwitchWatchList(config.accounts), secret: SECRET, fetchTitle: async () => title, pipeline: p.deps, log: p.log, now: () => NOW });
  return { ...p, watcher };
}

const notification = (type: string, event: object) => ({ subscription: { type, status: "enabled" }, event });

describe("TwitchWatcher", () => {
  it("checks the HMAC signature in constant time", () => {
    const r = twitchRequest("notification", { a: 1 });
    expect(verifyTwitchSignature(SECRET, "tw-1", "2026-11-19T17:00:04.000Z", r.rawBody, r.headers["twitch-eventsub-message-signature"])).toBe(true);
    expect(verifyTwitchSignature(SECRET, "tw-1", "2026-11-19T17:00:04.000Z", r.rawBody, "sha256=00")).toBe(false);
  });

  it("echoes the verification challenge", async () => {
    const { watcher } = twitchSetup();
    expect(await watcher.handle(twitchRequest("webhook_callback_verification", { challenge: "abc123" }))).toEqual({ status: 200, body: "abc123", contentType: "text/plain" });
  });

  it("refuses a wrong signature, even for a challenge", async () => {
    const { watcher, signals } = twitchSetup();
    expect((await watcher.handle(twitchRequest("webhook_callback_verification", { challenge: "abc" }, { secret: "wrong-secret" }))).status).toBe(403);
    expect((await watcher.handle(twitchRequest("notification", notification("channel.update", { broadcaster_user_id: ADIN_TWITCH, title: F.MINT.plain }), { secret: "wrong-secret" }))).status).toBe(403);
    expect(signals).toEqual([]);
  });

  it("reads an address from a new stream title", async () => {
    const { watcher, signals } = twitchSetup();
    await watcher.handle(twitchRequest("notification", notification("channel.update", { broadcaster_user_id: ADIN_TWITCH, title: `GTA 6 RP CA ${F.MINT.plain}` })));
    expect(signals[0]!.s).toMatchObject({ mint: F.MINT.plain, source: "twitch", path: "channel.update", accountId: ADIN_TWITCH, postUrl: "https://twitch.tv/adinross" });
  });

  it("fetches the title when the stream goes live", async () => {
    const { watcher, signals } = twitchSetup(`LIVE NOW ${F.MINT.pump}`);
    await watcher.handle(twitchRequest("notification", notification("stream.online", { broadcaster_user_id: ADIN_TWITCH })));
    expect(signals.map((x) => x.s.mint)).toEqual([F.MINT.pump]);
  });

  it("ignores unwatched broadcasters, duplicates and stale messages", async () => {
    const { watcher, signals } = twitchSetup();
    const stranger = notification("channel.update", { broadcaster_user_id: "999", title: F.MINT.plain });
    await watcher.handle(twitchRequest("notification", stranger, { id: "a" }));
    const mine = twitchRequest("notification", notification("channel.update", { broadcaster_user_id: ADIN_TWITCH, title: F.MINT.plain }), { id: "b" });
    await watcher.handle(mine);
    await watcher.handle(mine);
    await watcher.handle(twitchRequest("notification", notification("channel.update", { broadcaster_user_id: ADIN_TWITCH, title: F.MINT.pump }), { id: "c", ts: "2026-11-19T15:00:00.000Z" }));
    expect(signals.map((x) => x.s.mint)).toEqual([F.MINT.plain]);
    expect(watcher.stats).toMatchObject({ unwatched: 1, duplicates: 1, stale: 1 });
  });
});

describe("Twitch setup", () => {
  const quiet = createLogger({ write: () => {} });
  const users = [
    { id: ADIN_TWITCH, login: "adinross" },
    { id: "695034438", login: "fazebanks" },
  ];
  const routes = (subs: object[], u = users) =>
    fakeFetch([
      ({ url }) => (url.hostname === "id.twitch.tv" ? json({ access_token: "tw-app-token", expires_in: 5_000_000 }) : undefined),
      ({ url }) => (url.pathname === "/helix/users" ? json({ data: u }) : undefined),
      ({ url, method }) => {
        if (url.pathname !== "/helix/eventsub/subscriptions") return;
        if (method === "GET") return json({ data: subs });
        if (method === "DELETE") return new Response(null, { status: 204 });
        return json({ data: [] }, 202);
      },
    ]);

  it("verifies logins against configured IDs", async () => {
    await verifyTwitchWatchList(new TwitchClient({ clientId: "cid", clientSecret: "s", fetch: routes([]).fetch }), buildTwitchWatchList(config.accounts), quiet);
    const moved = routes([], [{ id: "1", login: "adinross" }, users[1]!]);
    await expect(verifyTwitchWatchList(new TwitchClient({ clientId: "cid", clientSecret: "s", fetch: moved.fetch }), buildTwitchWatchList(config.accounts), quiet)).rejects.toThrow(
      /twitch\/adinross now resolves to id 1/,
    );
  });

  it("creates missing subscriptions and replaces ones on an old callback", async () => {
    const cb = "https://bot.example.com/webhooks/twitch";
    const f = routes([
      { id: "keep", type: "channel.update", status: "enabled", condition: { broadcaster_user_id: ADIN_TWITCH }, transport: { callback: cb } },
      { id: "old", type: "stream.online", status: "enabled", condition: { broadcaster_user_id: ADIN_TWITCH }, transport: { callback: "https://old.example.com/x" } },
    ]);
    await ensureTwitchSubscriptions(new TwitchClient({ clientId: "cid", clientSecret: "s", fetch: f.fetch }), buildTwitchWatchList(config.accounts), cb, SECRET, quiet);
    expect(f.calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).searchParams.get("id"))).toEqual(["old"]);
    const created = f.calls.filter((c) => c.method === "POST" && c.url.includes("eventsub")).map((c) => c.body as { type: string; condition: { broadcaster_user_id: string }; transport: { callback: string } });
    expect(created.map((c) => `${c.type}:${c.condition.broadcaster_user_id}`).sort()).toEqual([`channel.update:695034438`, `stream.online:${ADIN_TWITCH}`, `stream.online:695034438`].sort());
    expect(created.every((c) => c.transport.callback === cb)).toBe(true);
  });
});

// ---------- HTTP server ----------

describe("webhook server", () => {
  it("passes the exact raw body and headers to the route, and handles unknown paths", async () => {
    const log = createLogger({ write: () => {} });
    let got: { rawBody: string; header: string | undefined } | undefined;
    const server = await startWebhookServer({
      port: 0,
      host: "127.0.0.1",
      log,
      routes: {
        "/webhooks/kick": async (req) => {
          got = { rawBody: req.rawBody, header: req.headers["kick-event-type"] };
          return { status: 200, body: "ok" };
        },
        "/boom": async () => {
          throw new Error("handler crashed");
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const raw = '{"a": 1,  "spacing":"kept"}';
      const res = await fetch(`${base}/webhooks/kick?x=1`, { method: "POST", body: raw, headers: { "Kick-Event-Type": "chat.message.sent" } });
      expect(res.status).toBe(200);
      expect(got).toEqual({ rawBody: raw, header: "chat.message.sent" });
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/nope`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${base}/webhooks/kick`)).status).toBe(405);
      expect((await fetch(`${base}/boom`, { method: "POST", body: "{}" })).status).toBe(500);
      expect((await fetch(`${base}/webhooks/kick`, { method: "POST", body: "x".repeat(1_100_000) }).then((r) => r.status, () => 413))).toBe(413);
    } finally {
      await server.close();
    }
  });

  it("SeenIds forgets the oldest id past its limit", () => {
    const s = new SeenIds(2);
    expect([s.add("a"), s.add("a"), s.add("b"), s.add("c"), s.add("a")]).toEqual([true, false, true, true, true]);
  });
});

// ---------- main --watch with Kick enabled ----------

describe("main --watch with Kick configured (fake APIs, real local HTTP)", () => {
  it("receives a signed Kick chat message from the streamer and alerts once", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const { EXIT, main } = await import("../src/app/main.ts");
    const { xApiRoutes } = await import("./fake-x.ts");
    const { FAKE_SECRETS, REPO_ROOT, SECRET_NEEDLES, tempDir } = await import("./helpers.ts");

    const dir = tempDir();
    const envPath = join(dir, ".env");
    const env = { ...FAKE_SECRETS, KICK_CLIENT_ID: "kick-client-id", WEBHOOK_PUBLIC_URL: "https://bot.example.com" };
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const users = [
      { id: F.ADIN, username: "adinross" },
      { id: "1511793806080819202", username: "AR15thed3mon" },
      { id: F.BANKS, username: "Banks" },
      { id: "1729276822485889024", username: "MarketBubble" },
      { id: F.TEST, username: "Franklin_ETH1" },
    ];
    const { fetch: fake, calls } = fakeFetch([
      ({ url }) => (url.hostname === "id.kick.com" ? json({ access_token: "kick-app-token", expires_in: 3600 }) : undefined),
      ({ url }) => (url.pathname === "/public/v1/public-key" ? json({ data: { public_key: kickPem } }) : undefined),
      ({ url }) => (url.pathname === "/public/v1/channels" ? json({ data: [{ broadcaster_user_id: ADIN_KICK, slug: "adinross" }] }) : undefined),
      ({ url, method }) => (url.pathname === "/public/v1/events/subscriptions" ? json({ data: [] }, method === "GET" ? 200 : 201) : undefined),
      ...xApiRoutes({ users }),
    ]);
    const lines: string[] = [];
    const alerts: string[] = [];
    const done = main({
      argv: ["--watch", "--duration", "1.2", "--data-dir", dir, "--env-file", envPath],
      env: {},
      cwd: REPO_ROOT,
      write: (l) => lines.push(l),
      alert: (t) => alerts.push(t),
      fetch: fake,
      ocr: null,
      webhookPort: 0,
    });

    // Wait for the server, then deliver webhooks over real HTTP like Kick would.
    let port: number | undefined;
    for (let i = 0; i < 100 && port === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      port = lines.map((l) => JSON.parse(l)).find((e) => e.event === "webhook.listening")?.port;
    }
    expect(port).toBeTypeOf("number");
    const post = (r: ReturnType<typeof kickRequest>) => fetch(`http://127.0.0.1:${port}/webhooks/kick`, { method: "POST", body: r.rawBody, headers: r.headers });
    const ts = new Date().toISOString();
    const mine = await post(kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.plain}`), { ts, id: "live-1" }));
    const chatter = await post(kickRequest("chat.message.sent", chat(42, `CA ${F.MINT.pump}`), { ts, id: "live-2" }));
    const forged = await post(kickRequest("chat.message.sent", chat(ADIN_KICK, `CA ${F.MINT.tco}`), { ts, id: "live-3", key: otherKeys.privateKey }));
    expect([mine.status, chatter.status, forged.status]).toEqual([200, 200, 401]);

    expect(await done).toBe(EXIT.OK);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(F.MINT.plain);
    expect(alerts[0]).toContain("kick original");
    const events = lines.map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === "watch.started")).toMatchObject({ webhook_sources: ["kick"] });
    expect(events.find((e) => e.event === "kick.subscriptions")).toBeTruthy();
    expect(events.find((e) => e.event === "watch.stopped").webhook_stats.kick).toMatchObject({ posts: 1, chatFromOthers: 1, rejected: 1, signals: 1 });
    const text = lines.join("\n") + alerts.join("\n");
    for (const needle of SECRET_NEEDLES) expect(text).not.toContain(needle);
    expect(text).not.toContain("kick-app-token");
    expect(calls.some((c) => c.url.includes("/events/subscriptions") && c.method === "POST")).toBe(true);
    const db = new DatabaseSync(join(dir, "dry-run.sqlite"));
    expect(db.prepare("SELECT source, mint FROM signals").all()).toEqual([{ source: "kick", mint: F.MINT.plain }]);
    db.close();
  });
});
