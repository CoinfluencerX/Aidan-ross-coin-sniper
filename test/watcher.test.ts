import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../src/app/main.ts";
import { formatAlert } from "../src/alert/console.ts";
import { loadAppConfig } from "../src/config/load.ts";
import { createLogger } from "../src/log/logger.ts";
import { openDb } from "../src/state/db.ts";
import type { AddressSignal, Assessment } from "../src/watch/signal.ts";
import { XClient } from "../src/watch/x/client.ts";
import { fromActivityEvent, fromFilteredStream } from "../src/watch/x/normalize.ts";
import { runStreamLoop } from "../src/watch/x/stream.ts";
import {
  buildWatchList,
  ensureActivitySubscriptions,
  ensureStreamRule,
  RULE_TAG,
  streamRuleValue,
  verifyWatchList,
  XWatcher,
} from "../src/watch/x/watcher.ts";
import { solanaRpcRoutes } from "./fake-chain.ts";
import { fakeBuilder } from "./fake-trade.ts";
import { fakeFetch, json, ndjsonStream, xApiRoutes } from "./fake-x.ts";
import { OPEN_CURVE } from "./fixtures/chain.ts";
import * as F from "./fixtures/x-posts.ts";
import { CONFIG_DIR, FAKE_SECRETS, REPO_ROOT, SECRET_NEEDLES, tempDir } from "./helpers.ts";

const config = loadAppConfig(CONFIG_DIR);
const ALL_USERS = [
  { id: F.ADIN, username: "adinross" },
  { id: "1511793806080819202", username: "AR15thed3mon" },
  { id: F.BANKS, username: "Banks" },
  { id: "1729276822485889024", username: "MarketBubble" },
  { id: F.TEST, username: "Franklin_ETH1" },
];

function setup(fetchFn: typeof fetch = fakeFetch([]).fetch) {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => lines.push(l) });
  const db = openDb(":memory:");
  const client = new XClient({ bearerToken: FAKE_SECRETS.X_BEARER_TOKEN, fetch: fetchFn });
  const signals: { s: AddressSignal; a: Assessment }[] = [];
  const watcher = new XWatcher({
    client,
    accounts: config.accounts,
    validator: config.validator,
    watchList: buildWatchList(config.accounts, "dry-run"),
    db,
    log,
    mode: "dry-run",
    fetch: fetchFn,
    onSignal: (s, a) => signals.push({ s, a }),
  });
  const events = () => lines.map((l) => JSON.parse(l));
  return { watcher, db, log, lines, events, signals, client };
}

const act = (m: unknown) => fromActivityEvent(m).post!;
const fs = (m: unknown) => fromFilteredStream(m)!;

describe("watch list", () => {
  it("has every X account plus the test account in dry-run, by numeric ID", () => {
    const list = buildWatchList(config.accounts, "dry-run");
    expect(list.map((a) => a.userId)).toEqual([F.ADIN, "1511793806080819202", F.BANKS, "1729276822485889024", F.TEST]);
    expect(list.find((a) => a.isTest)).toMatchObject({ handle: "Franklin_ETH1", tier: 1 });
  });

  it("never includes test accounts in live mode", () => {
    expect(buildWatchList(config.accounts, "live").some((a) => a.isTest)).toBe(false);
  });

  it("builds one from: rule over numeric IDs", () => {
    expect(streamRuleValue(buildWatchList(config.accounts, "dry-run"))).toBe(
      `from:${F.ADIN} OR from:1511793806080819202 OR from:${F.BANKS} OR from:1729276822485889024 OR from:${F.TEST}`,
    );
  });
});

describe("XWatcher.handlePost", () => {
  it("emits a green signal for a plain original post and records it", async () => {
    const { watcher, db, signals } = setup();
    const out = await watcher.handlePost(act(F.plainAddress), "activity", Date.parse("2026-11-19T17:00:01.200Z"));
    expect(out).toHaveLength(1);
    expect(signals[0]!.s).toMatchObject({ mint: F.MINT.plain, accountId: F.ADIN, postKind: "original", source: "x", path: "activity" });
    expect(signals[0]!.a.severity).toBe("green");
    const rows = db.prepare("SELECT source, account_id, post_id, mint FROM signals").all();
    expect(rows).toEqual([{ source: "x", account_id: F.ADIN, post_id: "1900000000000000001", mint: F.MINT.plain }]);
  });

  it("ignores a stranger's reply carrying an address (author not allowlisted)", async () => {
    const { watcher, signals, db, events } = setup();
    expect(await watcher.handlePost(fs(F.strangerReply), "filtered_stream", Date.now())).toEqual([]);
    expect(signals).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signals").get()).toEqual({ n: 0 });
    expect(events().map((e) => e.event)).toContain("x.post.ignored_author");
  });

  it("matches on numeric ID, not handle: a post with a watched username but another ID is ignored", async () => {
    const { watcher, signals } = setup();
    const p = act(F.plainAddress);
    p.authorId = "999";
    p.authorUsername = "adinross";
    await watcher.handlePost(p, "activity", Date.now());
    expect(signals).toEqual([]);
  });

  it("reply by a watched account: only its own address, flagged red (not original)", async () => {
    const { watcher, signals } = setup();
    await watcher.handlePost(fs(F.replyWithDifferentAddress), "filtered_stream", Date.now());
    expect(signals.map((x) => x.s.mint)).toEqual([F.MINT.replyOwn]);
    expect(signals[0]!.a.severity).toBe("red");
    expect(signals[0]!.a.reasons[0]).toContain("reply, not an original post");
  });

  it("warning post quoting a blocked mint is red with both reasons", async () => {
    const { watcher, signals } = setup();
    await watcher.handlePost(act(F.fakeWarning), "activity", Date.now());
    expect(signals[0]!.a.severity).toBe("red");
    expect(signals[0]!.a.reasons.join(" | ")).toMatch(/blocked mint.*warning words: fake, not mine, don't buy/);
  });

  it("dexscreener-only mint is yellow", async () => {
    const { watcher, signals } = setup();
    await watcher.handlePost(fs(F.dexscreenerUrl), "filtered_stream", Date.now());
    expect(signals[0]!.a.severity).toBe("yellow");
  });

  it("dedupes the same post arriving on both paths", async () => {
    const { watcher, signals, db } = setup();
    await watcher.handlePost(act(F.testAccountPost), "activity", Date.now());
    await watcher.handlePost(act(F.testAccountPost), "filtered_stream", Date.now());
    expect(signals).toHaveLength(1);
    expect(watcher.stats.duplicates).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM signals").get()).toEqual({ n: 1 });
  });

  it("logs a post with no address (the M1 'watcher sees my test post' check)", async () => {
    const { watcher, events, signals } = setup();
    await watcher.handlePost(act(F.activityEvent({ id: "1", author_id: F.TEST, text: "gm" })), "activity", Date.now());
    expect(signals).toEqual([]);
    expect(events().find((e) => e.event === "x.post")).toMatchObject({ handle: "Franklin_ETH1", test_account: true, text: "gm", mints: [] });
  });

  it("hydrates media the stream didn't include, via GET /2/tweets/:id", async () => {
    const { fetch, calls } = fakeFetch([
      ({ url }) =>
        url.pathname === "/2/tweets/1900000000000000005"
          ? json({ data: F.imageAddress.data, includes: { media: [{ media_key: "3_1900000000000000005", type: "photo", url: F.IMAGE_URL, alt_text: `CA ${F.MINT.image}` }] } })
          : undefined,
    ]);
    const { watcher, signals } = setup(fetch);
    const p = fs({ data: F.imageAddress.data }); // no includes.media
    expect(p.mediaMissing).toBe(true);
    await watcher.handlePost(p, "filtered_stream", Date.now());
    expect(calls[0]!.url).toContain("/2/tweets/1900000000000000005");
    expect(signals.map((x) => x.s.mint)).toEqual([F.MINT.image]);
  });
});

describe("account verification and setup", () => {
  const list = buildWatchList(config.accounts, "dry-run");
  const log = createLogger({ write: () => {} });

  it("passes when every handle resolves to the configured ID", async () => {
    const { fetch } = fakeFetch(xApiRoutes({ users: ALL_USERS }));
    await expect(verifyWatchList(new XClient({ bearerToken: "t".repeat(20), fetch }), list, log)).resolves.toBeUndefined();
  });

  it("refuses when a handle now maps to a different ID", async () => {
    const users = ALL_USERS.map((u) => (u.username === "Banks" ? { ...u, id: "123" } : u));
    const { fetch } = fakeFetch(xApiRoutes({ users }));
    await expect(verifyWatchList(new XClient({ bearerToken: "t".repeat(20), fetch }), list, log)).rejects.toThrow(/@Banks now resolves to id 123/);
  });

  it("refuses when a handle no longer exists", async () => {
    const { fetch } = fakeFetch(xApiRoutes({ users: ALL_USERS.filter((u) => u.username !== "Franklin_ETH1") }));
    await expect(verifyWatchList(new XClient({ bearerToken: "t".repeat(20), fetch }), list, log)).rejects.toThrow(/Franklin_ETH1 was not found/);
  });

  it("creates only missing post.create subscriptions", async () => {
    const { fetch, calls } = fakeFetch(
      xApiRoutes({ users: ALL_USERS, existingSubscriptions: [{ subscription_id: "1", event_type: "post.create", filter: { user_id: F.ADIN } }] }),
    );
    const { created } = await ensureActivitySubscriptions(new XClient({ bearerToken: "t".repeat(20), fetch }), list, log);
    expect(created).toEqual(["AR15thed3mon", "Banks", "MarketBubble", "Franklin_ETH1"]);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts[0]!.body).toEqual({ event_type: "post.create", filter: { user_id: "1511793806080819202" }, tag: `${RULE_TAG}:AR15thed3mon` });
  });

  it("in live mode, removes our subscription for the test account and leaves other apps' subscriptions alone", async () => {
    const live = buildWatchList(config.accounts, "live");
    const sub = (id: string, user: string, tag?: string) => ({ subscription_id: id, event_type: "post.create", filter: { user_id: user }, ...(tag ? { tag } : {}) });
    const { fetch, calls } = fakeFetch(
      xApiRoutes({
        users: ALL_USERS,
        existingSubscriptions: [
          ...live.map((a, i) => sub(String(i + 1), a.userId, `${RULE_TAG}:${a.handle}`)),
          sub("90", F.TEST, `${RULE_TAG}:Franklin_ETH1`),
          sub("91", "999", "some-other-tool"),
          sub("92", "998"),
        ],
      }),
    );
    const r = await ensureActivitySubscriptions(new XClient({ bearerToken: "t".repeat(20), fetch }), live, log);
    expect(r).toEqual({ created: [], removed: ["Franklin_ETH1"] });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname)).toEqual(["/2/activity/subscriptions/90"]);
  });

  it("leaves a matching stream rule alone, replaces a stale one", async () => {
    const value = streamRuleValue(list);
    const same = fakeFetch(xApiRoutes({ users: [], existingRules: [{ id: "r1", value, tag: RULE_TAG }] }));
    await ensureStreamRule(new XClient({ bearerToken: "t".repeat(20), fetch: same.fetch }), list, log);
    expect(same.calls.filter((c) => c.method === "POST")).toEqual([]);

    const stale = fakeFetch(xApiRoutes({ users: [], existingRules: [{ id: "r1", value: "from:1", tag: RULE_TAG }, { id: "other", value: "cats" }] }));
    await ensureStreamRule(new XClient({ bearerToken: "t".repeat(20), fetch: stale.fetch }), list, log);
    expect(stale.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ delete: { ids: ["r1"] } }, { add: [{ value, tag: RULE_TAG }] }]);
  });

  it("sends the bearer token only in the Authorization header", async () => {
    const { fetch, calls } = fakeFetch(xApiRoutes({ users: ALL_USERS }));
    await verifyWatchList(new XClient({ bearerToken: FAKE_SECRETS.X_BEARER_TOKEN, fetch }), list, log);
    expect(calls[0]!.auth).toBe(`Bearer ${FAKE_SECRETS.X_BEARER_TOKEN}`);
    expect(calls[0]!.url).not.toContain(FAKE_SECRETS.X_BEARER_TOKEN);
  });
});

describe("stream loop", () => {
  const noSleep = async () => {};

  it("reconnects after the server closes the stream", async () => {
    const stop = new AbortController();
    const got: unknown[] = [];
    let opens = 0;
    await runStreamLoop({
      name: "t",
      log: createLogger({ write: () => {} }),
      signal: stop.signal,
      sleep: noSleep,
      open: async (s) => {
        opens++;
        return ndjsonStream([{ data: { n: opens } }], s, { closeAfter: true });
      },
      onMessage: (m) => {
        got.push(m);
        if (got.length === 3) stop.abort();
      },
    });
    expect(opens).toBe(3);
    expect(got).toEqual([{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]);
  });

  it("gives up on 403 (plan doesn't include the endpoint) and reports it", async () => {
    let fatal: Error | undefined;
    const client = new XClient({ bearerToken: "t".repeat(20), fetch: fakeFetch([() => json({ title: "Forbidden" }, 403)]).fetch });
    await runStreamLoop({
      name: "t",
      log: createLogger({ write: () => {} }),
      signal: new AbortController().signal,
      sleep: noSleep,
      open: (s) => client.openStream("/2/activity/stream", {}, s),
      onMessage: () => {},
      onFatal: (e) => (fatal = e),
    });
    expect(fatal?.message).toContain("403");
  });

  it("kills a stalled connection and reconnects", async () => {
    const stop = new AbortController();
    let opens = 0;
    await runStreamLoop({
      name: "t",
      log: createLogger({ write: () => {} }),
      signal: stop.signal,
      sleep: noSleep,
      stallMs: 30,
      open: async (s) => {
        if (++opens === 3) stop.abort();
        return ndjsonStream([], s); // never sends anything
      },
      onMessage: () => {},
    });
    expect(opens).toBe(3);
  });
});

describe("main --watch (fake X API end to end)", () => {
  const SIM_PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  function envFile(dir: string, extra: Record<string, string> = {}) {
    const path = join(dir, ".env");
    writeFileSync(path, Object.entries({ LOG_LEVEL: "debug", ...FAKE_SECRETS, ...extra }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    return path;
  }

  async function runWatch(routes: Parameters<typeof xApiRoutes>[0], extraArgs: string[] = ["--duration", "0.4"], extraEnv: Record<string, string> = { SIM_PAYER_PUBKEY: SIM_PAYER }) {
    const dir = tempDir();
    const rpcCalls: string[] = [];
    const lines: string[] = [];
    const alerts: string[] = [];
    // The validator is on (the fake .env has an RPC URL), so give it a fake chain: a clean mint on an open pump.fun curve.
    const { fetch, calls } = fakeFetch([...solanaRpcRoutes({ byPosition: [OPEN_CURVE, null], calls: rpcCalls }), ...xApiRoutes(routes)]);
    const code = await main({
      tradeBuilder: fakeBuilder().builder,
      argv: ["--mode", "dry-run", "--watch", ...extraArgs, "--data-dir", dir, "--env-file", envFile(dir, extraEnv)],
      env: {},
      cwd: REPO_ROOT,
      write: (l) => lines.push(l),
      alert: (t) => alerts.push(t),
      fetch,
      ocr: null,
    });
    const events = lines.map((l) => JSON.parse(l));
    return { code, events, alerts, calls, rpcCalls, dir, text: lines.join("\n") + alerts.join("\n") };
  }

  it("catches the test account's post on both paths, alerts once, records it, leaks nothing", async () => {
    const r = await runWatch({ users: ALL_USERS, activity: [F.testAccountPost], filtered: [F.streamMessage(F.testAccountPost.data.payload)] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toContain(F.MINT.plain);
    expect(r.alerts[0]).toContain("@Franklin_ETH1 (TEST ACCOUNT");
    // Validated against the fake chain, then bought on paper: built, signed and simulated, never sent.
    // Yellow, not green: the fake chain has no name metadata for the token, which is a warning.
    expect(r.alerts[0]).toContain("YELLOW");
    expect(r.alerts[0]).toContain("VALIDATOR: PASS (");
    expect(r.alerts[0]).toContain("! name_matches_post");
    expect(r.alerts[0]).not.toContain("✗");
    expect(r.alerts[0]).toContain("BUY SIMULATED: 0.0100 SOL -> 357,000.000000 tokens via pump_curve:v3");
    expect(r.alerts[0]).toContain("position #1 (paper: no real transaction)");
    expect(r.alerts[0]).toContain("DRY-RUN: no real transaction was sent.");
    expect(r.rpcCalls.filter((m) => /send/i.test(m))).toEqual([]);
    expect(r.rpcCalls).toContain("simulateTransaction");
    const names = r.events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["x.accounts.verified", "x.activity.subscriptions", "x.filtered_stream.rule", "watch.started", "x.post", "signal", "validation", "watch.stopped", "shutdown"]));
    expect(r.events.find((e) => e.event === "watch.stopped").stats).toMatchObject({ posts: 1, duplicates: 1, signals: 1 });
    for (const needle of SECRET_NEEDLES) expect(r.text).not.toContain(needle);

    const db = new DatabaseSync(join(r.dir, "dry-run.sqlite"));
    expect(db.prepare("SELECT mint, account_id FROM signals").all()).toEqual([{ mint: F.MINT.plain, account_id: F.TEST }]);
    const kinds = (db.prepare("SELECT kind FROM audit_log ORDER BY id").all() as { kind: string }[]).map((k) => k.kind);
    expect(kinds).toEqual(["boot", "watch.started", "x.post", "validation", "buy.locked", "buy.done", "shutdown"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBeGreaterThan(15);
    expect(db.prepare("SELECT mint, status, simulated, venue FROM positions").all()).toEqual([{ mint: F.MINT.plain, status: "open", simulated: 1, venue: "pump_curve" }]);
    expect(db.prepare("SELECT side, status, signature FROM trades").all()).toEqual([{ side: "buy", status: "simulated", signature: null }]);
    expect(JSON.stringify(db.prepare("SELECT * FROM audit_log").all())).not.toContain(FAKE_SECRETS.X_BEARER_TOKEN);
    db.close();
  });

  it("blocks the buy, with a clear reason, when there's no wallet to simulate with", async () => {
    const r = await runWatch({ users: ALL_USERS, activity: [F.testAccountPost] }, ["--duration", "0.4"], {});
    expect(r.alerts[0]).toContain("VALIDATOR: BLOCKED");
    expect(r.alerts[0]).toContain("sell_simulation: no wallet to simulate with: set WALLET_KEYPAIR_PATH, or SIM_PAYER_PUBKEY for dry-run");
    expect(r.alerts[0]).toContain("DRY-RUN: nothing is bought.");
    const db = new DatabaseSync(join(r.dir, "dry-run.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
    db.close();
  });

  it("keeps running on the other path when one returns 403", async () => {
    const r = await runWatch({ users: ALL_USERS, activityStatus: 403, filtered: [F.streamMessage(F.testAccountPost.data.payload)] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.alerts).toHaveLength(1);
    expect(r.events.find((e) => e.event === "watch.stopped").failed_paths).toEqual(["activity"]);
  });

  it("exits FATAL when every stream is refused", async () => {
    const r = await runWatch({ users: ALL_USERS, activityStatus: 403, filteredStatus: 403 }, ["--duration", "5"]);
    expect(r.code).toBe(EXIT.FATAL);
  });

  it("refuses to start when accounts.yaml doesn't match X", async () => {
    const r = await runWatch({ users: ALL_USERS.map((u) => (u.username === "adinross" ? { ...u, id: "1" } : u)) });
    expect(r.code).toBe(EXIT.CONFIG);
    expect(r.events.find((e) => e.event === "watch.accounts_invalid").error).toContain("@adinross now resolves to id 1");
    expect(r.calls.some((c) => c.url.includes("/stream"))).toBe(false);
  });

  it("refuses --watch without an X token", async () => {
    const lines: string[] = [];
    const dir = tempDir();
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "");
    const offline: typeof fetch = async () => {
      throw new Error("must not touch the network");
    };
    const code = await main({
      argv: ["--watch", "--duration", "1", "--data-dir", dir, "--env-file", empty],
      env: {},
      cwd: REPO_ROOT,
      write: (l) => lines.push(l),
      fetch: offline,
    });
    expect(code).toBe(EXIT.CONFIG);
    expect(lines.join()).toContain("watch.no_x_token");
  });

  it("rejects --duration without --watch, or a bad number", async () => {
    for (const argv of [["--duration", "5"], ["--watch", "--duration", "-1"], ["--watch", "--duration", "abc"]]) {
      expect(await main({ argv, env: {}, cwd: REPO_ROOT, write: () => {} })).toBe(EXIT.USAGE);
    }
  });
});

describe("alert banner", () => {
  it("is colour-coded and says nothing is bought", () => {
    const s = {
      mint: F.MINT.plain,
      source: "x",
      path: "activity",
      postId: "1",
      postUrl: "https://x.com/a/status/1",
      accountId: F.TEST,
      account: { userId: F.TEST, handle: "Franklin_ETH1", person: "test", tier: 1, isTest: true },
      postKind: "original",
      referencesWatchedAuthor: false,
      origins: [{ kind: "text" }],
      mintsInPost: 1,
      warningKeywords: [],
      blockedMintNote: undefined,
      postText: "CA below",
      postCreatedAt: "2026-11-19T17:00:00.000Z",
      receivedAt: Date.parse("2026-11-19T17:00:01.500Z"),
    } satisfies AddressSignal;
    const green = formatAlert(s, { severity: "green", reasons: ["ok"] });
    expect(green).toContain("\x1b[42m"); // green background
    expect(formatAlert(s, { severity: "red", reasons: ["x"] })).toContain("\x1b[41m");
    const plain = formatAlert(s, { severity: "yellow", reasons: ["w"] }, { color: false });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("nothing is bought");
    expect(plain).toContain("post → watcher 1.50 s");
  });
});
