import type { FetchFn } from "../../extract/expand.ts";
import type { XIncludes, XTweet } from "./normalize.ts";

export const X_API_BASE = "https://api.x.com";

/** Fields asked for on every post, so both stream paths and lookups return the same shape. */
export const POST_QUERY: Record<string, string> = {
  "tweet.fields": "author_id,created_at,conversation_id,entities,attachments,referenced_tweets,in_reply_to_user_id,note_tweet",
  expansions: "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id",
  "media.fields": "type,url,preview_image_url,alt_text",
  "user.fields": "username",
};

export class XApiError extends Error {
  override name = "XApiError";
  readonly status: number;
  readonly path: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`X API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
  /** 401/403: credential or plan problem. Retrying won't help. */
  get isAuthOrPlan(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
  protected?: boolean;
}

export interface ActivitySubscription {
  subscription_id: string;
  event_type: string;
  filter: { user_id?: string };
  tag?: string;
}

export interface StreamRule {
  id: string;
  value: string;
  tag?: string;
}

/**
 * Thin client over the official X API v2 REST routes (no SDK needed for these).
 * Auth is the app-only bearer token. It goes in the Authorization header only, which
 * the logger redacts, and is never part of a URL or an error message.
 */
export class XClient {
  readonly #bearer: string;
  readonly #fetch: FetchFn;
  readonly base: string;

  constructor(opts: { bearerToken: string; fetch?: FetchFn; base?: string }) {
    this.#bearer = opts.bearerToken;
    this.#fetch = opts.fetch ?? fetch;
    this.base = opts.base ?? X_API_BASE;
  }

  url(path: string, query: Record<string, string> = {}): string {
    const u = new URL(path, this.base);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.#fetch(this.url(path, opts.query), {
      method,
      headers: {
        authorization: `Bearer ${this.#bearer}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new XApiError(res.status, path, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Opens a long-lived streaming GET. The caller owns the body. */
  async openStream(path: string, query: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const res = await this.#fetch(this.url(path, query), {
      method: "GET",
      headers: { authorization: `Bearer ${this.#bearer}` },
      signal,
    });
    if (!res.ok) throw new XApiError(res.status, path, await res.text().catch(() => ""));
    return res;
  }

  async lookupUsers(usernames: readonly string[]): Promise<{ users: XUser[]; errors: { value?: string; detail?: string }[] }> {
    if (usernames.length === 0) return { users: [], errors: [] };
    const r = await this.request<{ data?: XUser[]; errors?: { value?: string; detail?: string }[] }>("GET", "/2/users/by", {
      query: { usernames: usernames.join(","), "user.fields": "protected" },
    });
    return { users: r.data ?? [], errors: r.errors ?? [] };
  }

  async getPost(id: string): Promise<{ data?: XTweet; includes?: XIncludes }> {
    return this.request("GET", `/2/tweets/${encodeURIComponent(id)}`, { query: POST_QUERY });
  }

  async listActivitySubscriptions(): Promise<ActivitySubscription[]> {
    const out: ActivitySubscription[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ data?: ActivitySubscription[]; meta?: { next_token?: string } }>("GET", "/2/activity/subscriptions", {
        query: { max_results: "100", ...(token ? { pagination_token: token } : {}) },
      });
      out.push(...(r.data ?? []));
      token = r.meta?.next_token;
      if (!token) break;
    }
    return out;
  }

  async createActivitySubscription(userId: string, tag: string): Promise<ActivitySubscription | undefined> {
    const r = await this.request<{ data?: ActivitySubscription[] | ActivitySubscription }>("POST", "/2/activity/subscriptions", {
      body: { event_type: "post.create", filter: { user_id: userId }, tag },
    });
    return Array.isArray(r.data) ? r.data[0] : r.data;
  }

  async getStreamRules(): Promise<StreamRule[]> {
    const r = await this.request<{ data?: StreamRule[] }>("GET", "/2/tweets/search/stream/rules");
    return r.data ?? [];
  }

  async addStreamRule(value: string, tag: string): Promise<void> {
    await this.request("POST", "/2/tweets/search/stream/rules", { body: { add: [{ value, tag }] } });
  }

  async deleteStreamRules(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request("POST", "/2/tweets/search/stream/rules", { body: { delete: { ids } } });
  }
}
