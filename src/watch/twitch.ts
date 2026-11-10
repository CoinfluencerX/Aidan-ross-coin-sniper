import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccountsConfig } from "../config/schemas.ts";
import type { FetchFn } from "../extract/expand.ts";
import type { Logger } from "../log/logger.ts";
import { processPost, type PipelineDeps } from "./pipeline.ts";
import type { WatchedAccount } from "./signal.ts";
import { SeenIds, type WebhookRequest, type WebhookResponse } from "./webhook/server.ts";

/**
 * Twitch watcher, on EventSub webhooks (official API, app token, no user login needed).
 *
 * Events used:
 *   channel.update  the stream title changed (the title text is in the event)
 *   stream.online   the stream went live (we then read the title from the API)
 *
 * Twitch chat isn't watched: reading it needs the streamer's or a moderator's permission.
 */

export const TWITCH_EVENTS = [
  { type: "channel.update", version: "2" },
  { type: "stream.online", version: "1" },
] as const;
const HELIX = "https://api.twitch.tv/helix";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

export class TwitchApiError extends Error {
  override name = "TwitchApiError";
  readonly status: number;
  constructor(status: number, what: string) {
    super(`Twitch API ${what} failed with HTTP ${status}`);
    this.status = status;
  }
}

export function buildTwitchWatchList(accounts: AccountsConfig): WatchedAccount[] {
  const out: WatchedAccount[] = [];
  for (const [person, p] of Object.entries(accounts.people)) {
    for (const a of p.twitch) out.push({ userId: a.user_id, handle: a.login, person, tier: a.tier, isTest: false });
  }
  return out;
}

export class TwitchClient {
  readonly #id: string;
  readonly #secret: string;
  readonly #fetch: FetchFn;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(o: { clientId: string; clientSecret: string; fetch?: FetchFn }) {
    this.#id = o.clientId;
    this.#secret = o.clientSecret;
    this.#fetch = o.fetch ?? fetch;
  }

  async token(now = Date.now()): Promise<string> {
    if (this.#token && this.#token.expiresAt > now + 60_000) return this.#token.value;
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.#id, client_secret: this.#secret }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new TwitchApiError(res.status, "token request");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new TwitchApiError(res.status, "token request (no access_token)");
    this.#token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return this.#token.value;
  }

  async #api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(HELIX + path, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, "client-id": this.#id, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new TwitchApiError(res.status, `${method} ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  async usersByLogin(logins: readonly string[]): Promise<{ id: string; login: string }[]> {
    const q = logins.map((l) => `login=${encodeURIComponent(l)}`).join("&");
    return (await this.#api<{ data?: { id: string; login: string }[] }>("GET", `/users?${q}`)).data ?? [];
  }

  async channelTitle(broadcasterId: string): Promise<string | undefined> {
    return (await this.#api<{ data?: { title?: string }[] }>("GET", `/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`)).data?.[0]?.title;
  }

  async listSubscriptions(): Promise<{ id: string; type: string; status: string; condition: { broadcaster_user_id?: string }; transport: { callback?: string } }[]> {
    type Sub = { id: string; type: string; status: string; condition: { broadcaster_user_id?: string }; transport: { callback?: string } };
    return (await this.#api<{ data?: Sub[] }>("GET", "/eventsub/subscriptions")).data ?? [];
  }

  async subscribe(type: string, version: string, broadcasterId: string, callback: string, secret: string): Promise<void> {
    await this.#api("POST", "/eventsub/subscriptions", {
      type,
      version,
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: "webhook", callback, secret },
    });
  }

  async unsubscribe(id: string): Promise<void> {
    const res = await this.#fetch(`${HELIX}/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${await this.token()}`, "client-id": this.#id },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) throw new TwitchApiError(res.status, "DELETE /eventsub/subscriptions");
  }
}

export async function verifyTwitchWatchList(client: TwitchClient, list: readonly WatchedAccount[], log: Logger): Promise<void> {
  const users = await client.usersByLogin(list.map((a) => a.handle));
  const byLogin = new Map(users.map((u) => [u.login.toLowerCase(), u]));
  const problems: string[] = [];
  for (const a of list) {
    const u = byLogin.get(a.handle.toLowerCase());
    if (!u) problems.push(`twitch/${a.handle} was not found`);
    else if (u.id !== a.userId) problems.push(`twitch/${a.handle} now resolves to id ${u.id}, config says ${a.userId}`);
  }
  if (problems.length) throw new Error(`accounts.yaml doesn't match Twitch: ${problems.join("; ")}`);
  log.info("twitch.accounts.verified", { count: list.length, logins: list.map((a) => a.handle) });
}

/**
 * Keeps one enabled subscription per (event, broadcaster) pointing at our callback.
 * Subscriptions that failed verification or point at an old callback are replaced.
 */
export async function ensureTwitchSubscriptions(client: TwitchClient, list: readonly WatchedAccount[], callback: string, secret: string, log: Logger): Promise<void> {
  const existing = await client.listSubscriptions();
  const created: string[] = [];
  for (const a of list) {
    for (const ev of TWITCH_EVENTS) {
      const mine = existing.filter((s) => s.type === ev.type && s.condition.broadcaster_user_id === a.userId);
      const good = mine.find((s) => s.transport.callback === callback && (s.status === "enabled" || s.status === "webhook_callback_verification_pending"));
      for (const s of mine) if (s !== good) await client.unsubscribe(s.id);
      if (good) continue;
      await client.subscribe(ev.type, ev.version, a.userId, callback, secret);
      created.push(`${ev.type}:${a.handle}`);
    }
  }
  log.info("twitch.subscriptions", { existing: existing.length, created });
}

/** Twitch signs id + timestamp + raw body with HMAC-SHA256 of our shared secret: "sha256=<hex>". */
export function verifyTwitchSignature(secret: string, messageId: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(messageId + timestamp + rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface TwitchBody {
  challenge?: string;
  subscription?: { type?: string; status?: string };
  event?: { broadcaster_user_id?: string; broadcaster_user_login?: string; title?: string; started_at?: string };
}

export interface TwitchWatcherOptions {
  accounts: readonly WatchedAccount[];
  secret: string;
  /** Reads the current stream title, for stream.online (which doesn't carry it). */
  fetchTitle: (broadcasterId: string) => Promise<string | undefined>;
  pipeline: PipelineDeps;
  log: Logger;
  now?: () => number;
  maxAgeMs?: number;
}

export class TwitchWatcher {
  readonly #o: TwitchWatcherOptions;
  readonly #byId: Map<string, WatchedAccount>;
  readonly #seen = new SeenIds();
  stats = { events: 0, rejected: 0, stale: 0, duplicates: 0, unwatched: 0, posts: 0, signals: 0, evm: 0, revoked: 0 };

  constructor(o: TwitchWatcherOptions) {
    this.#o = o;
    this.#byId = new Map(o.accounts.map((a) => [a.userId, a]));
  }

  async handle(req: WebhookRequest): Promise<WebhookResponse> {
    const { log } = this.#o;
    this.stats.events++;
    const id = req.headers["twitch-eventsub-message-id"];
    const ts = req.headers["twitch-eventsub-message-timestamp"];
    const sig = req.headers["twitch-eventsub-message-signature"];
    const type = req.headers["twitch-eventsub-message-type"];
    if (!id || !ts || !sig || !type) return { status: 400 };
    if (!verifyTwitchSignature(this.#o.secret, id, ts, req.rawBody, sig)) {
      this.stats.rejected++;
      log.warn("twitch.signature_invalid", { message_id: id, message_type: type });
      return { status: 403 };
    }
    let body: TwitchBody;
    try {
      body = JSON.parse(req.rawBody) as TwitchBody;
    } catch {
      return { status: 400 };
    }
    // Twitch checks we own the callback by asking us to echo a challenge.
    if (type === "webhook_callback_verification") return { status: 200, body: body.challenge ?? "", contentType: "text/plain" };
    if (type === "revocation") {
      this.stats.revoked++;
      log.warn("twitch.subscription_revoked", { type: body.subscription?.type, status: body.subscription?.status });
      return { status: 204 };
    }
    if (type !== "notification") return { status: 204 };

    const now = (this.#o.now ?? Date.now)();
    const sentAt = Date.parse(ts);
    if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > (this.#o.maxAgeMs ?? 10 * 60_000)) {
      this.stats.stale++;
      log.warn("twitch.event_stale", { message_id: id, timestamp: ts });
      return { status: 204 };
    }
    if (!this.#seen.add(id)) {
      this.stats.duplicates++;
      return { status: 204 };
    }
    const account = body.event?.broadcaster_user_id ? this.#byId.get(body.event.broadcaster_user_id) : undefined;
    if (!account) {
      this.stats.unwatched++;
      return { status: 204 };
    }

    const eventType = body.subscription?.type;
    let text: string | undefined;
    if (eventType === "channel.update") text = body.event?.title;
    else if (eventType === "stream.online") {
      try {
        text = await this.#o.fetchTitle(account.userId);
      } catch (err) {
        log.warn("twitch.title_fetch_failed", { login: account.handle, error: (err as Error).message });
      }
    } else return { status: 204 };

    this.stats.posts++;
    const result = await processPost(
      {
        source: "twitch",
        path: eventType,
        id,
        url: `https://twitch.tv/${account.handle}`,
        account,
        kind: "original",
        referencesWatchedAuthor: false,
        createdAt: ts,
        content: { text: text ?? "", urls: [], images: [] },
      },
      now,
      this.#o.pipeline,
    );
    this.stats.signals += result.newSignals;
    this.stats.evm += result.evm.length;
    return { status: 204 };
  }
}
