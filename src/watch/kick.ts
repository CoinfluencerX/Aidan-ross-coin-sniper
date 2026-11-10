import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { AccountsConfig } from "../config/schemas.ts";
import type { FetchFn } from "../extract/expand.ts";
import type { Logger } from "../log/logger.ts";
import { processPost, type PipelineDeps } from "./pipeline.ts";
import type { WatchedAccount } from "./signal.ts";
import { SeenIds, type WebhookRequest, type WebhookResponse } from "./webhook/server.ts";

/**
 * Kick watcher, on Kick's official Events API (webhooks). No scraping, no chat socket.
 *
 * Events used:
 *   chat.message.sent            only messages typed by the streamer in their OWN chat count
 *   livestream.metadata.updated  the stream title changed
 *   livestream.status.updated    the stream went live (carries the title)
 *
 * Every webhook is signed by Kick (RSA + SHA-256). Unsigned or wrongly signed requests are refused.
 */

export const KICK_EVENTS = ["chat.message.sent", "livestream.metadata.updated", "livestream.status.updated"] as const;
const API = "https://api.kick.com/public/v1";
const TOKEN_URL = "https://id.kick.com/oauth/token";

export class KickApiError extends Error {
  override name = "KickApiError";
  readonly status: number;
  constructor(status: number, what: string) {
    super(`Kick API ${what} failed with HTTP ${status}`);
    this.status = status;
  }
}

export interface KickAccount extends WatchedAccount {
  slug: string;
}

export function buildKickWatchList(accounts: AccountsConfig): KickAccount[] {
  const out: KickAccount[] = [];
  for (const [person, p] of Object.entries(accounts.people)) {
    for (const a of p.kick) out.push({ userId: String(a.user_id), handle: a.slug, slug: a.slug, person, tier: a.tier, isTest: false });
  }
  return out;
}

export class KickClient {
  readonly #id: string;
  readonly #secret: string;
  readonly #fetch: FetchFn;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(o: { clientId: string; clientSecret: string; fetch?: FetchFn }) {
    this.#id = o.clientId;
    this.#secret = o.clientSecret;
    this.#fetch = o.fetch ?? fetch;
  }

  /** App access token (client credentials). Cached until shortly before it expires. */
  async token(now = Date.now()): Promise<string> {
    if (this.#token && this.#token.expiresAt > now + 60_000) return this.#token.value;
    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.#id, client_secret: this.#secret }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new KickApiError(res.status, "token request");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new KickApiError(res.status, "token request (no access_token)");
    this.#token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return this.#token.value;
  }

  async #api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new KickApiError(res.status, `${method} ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  /** Kick's webhook signing key (PEM). Public, no token needed. Kick can rotate it, so don't hardcode it. */
  async publicKeyPem(): Promise<string> {
    const res = await this.#fetch(`${API}/public-key`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new KickApiError(res.status, "public key");
    const body = (await res.json()) as { data?: { public_key?: string } };
    if (!body.data?.public_key) throw new KickApiError(res.status, "public key (empty)");
    return body.data.public_key;
  }

  async channelBySlug(slug: string): Promise<{ broadcaster_user_id: number; slug: string } | undefined> {
    const r = await this.#api<{ data?: { broadcaster_user_id: number; slug: string }[] }>("GET", `/channels?slug=${encodeURIComponent(slug)}`);
    return r.data?.find((c) => c.slug.toLowerCase() === slug.toLowerCase());
  }

  async listSubscriptions(): Promise<{ id: string; event: string; broadcaster_user_id: number }[]> {
    return (await this.#api<{ data?: { id: string; event: string; broadcaster_user_id: number }[] }>("GET", "/events/subscriptions")).data ?? [];
  }

  async subscribe(broadcasterUserId: number, events: readonly string[]): Promise<void> {
    await this.#api("POST", "/events/subscriptions", {
      broadcaster_user_id: broadcasterUserId,
      events: events.map((name) => ({ name, version: 1 })),
      method: "webhook",
    });
  }
}

/** Refuses to start if a slug now belongs to a different numeric user ID. IDs are the source of truth. */
export async function verifyKickWatchList(client: KickClient, list: readonly KickAccount[], log: Logger): Promise<void> {
  const problems: string[] = [];
  for (const a of list) {
    const ch = await client.channelBySlug(a.slug);
    if (!ch) problems.push(`kick/${a.slug} was not found`);
    else if (String(ch.broadcaster_user_id) !== a.userId) problems.push(`kick/${a.slug} now resolves to id ${ch.broadcaster_user_id}, config says ${a.userId}`);
  }
  if (problems.length) throw new Error(`accounts.yaml doesn't match Kick: ${problems.join("; ")}`);
  log.info("kick.accounts.verified", { count: list.length, slugs: list.map((a) => a.slug) });
}

/** Subscribes each watched broadcaster to the events it doesn't have yet. Safe to re-run. */
export async function ensureKickSubscriptions(client: KickClient, list: readonly KickAccount[], log: Logger): Promise<void> {
  const existing = await client.listSubscriptions();
  const created: Record<string, string[]> = {};
  for (const a of list) {
    const have = new Set(existing.filter((s) => String(s.broadcaster_user_id) === a.userId).map((s) => s.event));
    const missing = KICK_EVENTS.filter((e) => !have.has(e));
    if (missing.length === 0) continue;
    await client.subscribe(Number(a.userId), missing);
    created[a.slug] = missing;
  }
  log.info("kick.subscriptions", { existing: existing.length, created });
}

/** Kick signs `${messageId}.${timestamp}.${rawBody}` with RSA PKCS#1 v1.5 + SHA-256, base64-encoded. */
export function verifyKickSignature(key: KeyObject | string, messageId: string, timestamp: string, rawBody: string, signatureB64: string): boolean {
  try {
    const k = typeof key === "string" ? createPublicKey(key) : key;
    return verify("RSA-SHA256", Buffer.from(`${messageId}.${timestamp}.${rawBody}`), k, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

interface KickUser {
  user_id?: number;
  username?: string;
  channel_slug?: string;
}
interface KickChat {
  message_id?: string;
  broadcaster?: KickUser;
  sender?: KickUser;
  content?: string;
  created_at?: string;
  replies_to?: { sender?: KickUser } | null;
}
interface KickLive {
  broadcaster?: KickUser;
  is_live?: boolean;
  title?: string;
  started_at?: string;
  metadata?: { title?: string };
}

export interface KickWatcherOptions {
  accounts: readonly KickAccount[];
  /** Fetches Kick's current signing key. Called at first use and again if a signature fails (key rotation). */
  fetchPublicKey: () => Promise<string>;
  pipeline: PipelineDeps;
  log: Logger;
  now?: () => number;
  /** Events older than this are acknowledged but not acted on. */
  maxAgeMs?: number;
}

export class KickWatcher {
  readonly #o: KickWatcherOptions;
  readonly #byId: Map<string, KickAccount>;
  readonly #seen = new SeenIds();
  #key: KeyObject | undefined;
  #keyFetchedAt = 0;
  stats = { events: 0, chatFromOthers: 0, unwatched: 0, rejected: 0, stale: 0, duplicates: 0, posts: 0, signals: 0, evm: 0 };

  constructor(o: KickWatcherOptions) {
    this.#o = o;
    this.#byId = new Map(o.accounts.map((a) => [a.userId, a]));
  }

  async #verify(id: string, ts: string, raw: string, sig: string): Promise<boolean> {
    const now = (this.#o.now ?? Date.now)();
    if (this.#key && verifyKickSignature(this.#key, id, ts, raw, sig)) return true;
    // First use, or the key may have rotated: refetch at most once a minute.
    if (this.#key && now - this.#keyFetchedAt < 60_000) return false;
    try {
      this.#key = createPublicKey(await this.#o.fetchPublicKey());
      this.#keyFetchedAt = now;
    } catch (err) {
      this.#o.log.error("kick.public_key_failed", { error: (err as Error).message });
      return false;
    }
    return verifyKickSignature(this.#key, id, ts, raw, sig);
  }

  /** Webhook entry point. Always answers 200 for events we choose to ignore, so Kick doesn't drop the subscription. */
  async handle(req: WebhookRequest): Promise<WebhookResponse> {
    const { log } = this.#o;
    this.stats.events++;
    const id = req.headers["kick-event-message-id"];
    const ts = req.headers["kick-event-message-timestamp"];
    const sig = req.headers["kick-event-signature"];
    const type = req.headers["kick-event-type"];
    if (!id || !ts || !sig || !type) return { status: 400 };

    let body: KickChat & KickLive;
    try {
      body = JSON.parse(req.rawBody) as KickChat & KickLive;
    } catch {
      return { status: 400 };
    }

    // Cheap filter BEFORE the signature check. Dropping a message never needs trust; acting on one does.
    const broadcasterId = body.broadcaster?.user_id !== undefined ? String(body.broadcaster.user_id) : undefined;
    const account = broadcasterId ? this.#byId.get(broadcasterId) : undefined;
    if (!account) {
      this.stats.unwatched++;
      return { status: 200 };
    }
    if (type === "chat.message.sent") {
      // The one rule: only the streamer's own messages. Everyone else in chat is ignored, whatever they paste.
      if (body.sender?.user_id === undefined || String(body.sender.user_id) !== account.userId) {
        this.stats.chatFromOthers++;
        return { status: 200 };
      }
    } else if (type !== "livestream.metadata.updated" && type !== "livestream.status.updated") {
      return { status: 200 };
    }

    if (!(await this.#verify(id, ts, req.rawBody, sig))) {
      this.stats.rejected++;
      log.warn("kick.signature_invalid", { message_id: id, event_type: type });
      return { status: 401 };
    }
    const now = (this.#o.now ?? Date.now)();
    const sentAt = Date.parse(ts);
    if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > (this.#o.maxAgeMs ?? 10 * 60_000)) {
      this.stats.stale++;
      log.warn("kick.event_stale", { message_id: id, event_type: type, timestamp: ts });
      return { status: 200 };
    }
    if (!this.#seen.add(id)) {
      this.stats.duplicates++;
      return { status: 200 };
    }

    let text: string;
    let postId: string;
    let createdAt: string | undefined;
    let isReply = false;
    let repliesToWatched = false;
    if (type === "chat.message.sent") {
      text = body.content ?? "";
      postId = body.message_id ?? id;
      createdAt = body.created_at ?? ts;
      isReply = Boolean(body.replies_to);
      const parent = body.replies_to?.sender?.user_id;
      repliesToWatched = parent !== undefined && this.#byId.has(String(parent));
    } else {
      if (type === "livestream.status.updated" && body.is_live === false) return { status: 200 };
      text = (type === "livestream.metadata.updated" ? body.metadata?.title : body.title) ?? "";
      postId = id;
      createdAt = ts;
    }

    this.stats.posts++;
    const result = await processPost(
      {
        source: "kick",
        path: type,
        id: postId,
        url: `https://kick.com/${account.slug}`,
        account,
        kind: isReply ? "reply" : "original",
        referencesWatchedAuthor: repliesToWatched,
        createdAt,
        content: { text, urls: [], images: [] },
      },
      now,
      this.#o.pipeline,
    );
    this.stats.signals += result.newSignals;
    this.stats.evm += result.evm.length;
    return { status: 200 };
  }
}
