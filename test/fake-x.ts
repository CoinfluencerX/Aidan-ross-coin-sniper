import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.ts";

export interface FakeCall {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

export type Route = (req: { method: string; url: URL; body: unknown; signal: AbortSignal | undefined }) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A streaming response that sends each message as an NDJSON line (with keep-alive
 * blank lines between), then stays open until the request is aborted, like the real X streams.
 */
export function ndjsonStream(messages: unknown[], signal: AbortSignal | undefined, opts: { closeAfter?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const m of messages) {
        ctrl.enqueue(enc.encode("\r\n"));
        ctrl.enqueue(enc.encode(JSON.stringify(m) + "\r\n"));
        await new Promise((r) => setTimeout(r, 5));
      }
      if (opts.closeAfter) return ctrl.close();
      if (signal?.aborted) return ctrl.error(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", () => {
        try {
          ctrl.error(new DOMException("aborted", "AbortError"));
        } catch {}
      });
    },
  });
  return new Response(body, { status: 200 });
}

export const FIXTURE_PNG = readFileSync(join(REPO_ROOT, "test/fixtures/images/ca-screenshot.png"));

/** Routes fetch calls to handlers in order; records every call. Unrouted calls get 404. */
export function fakeFetch(routes: Route[]) {
  const calls: FakeCall[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.toString(), auth: headers.get("authorization"), body });
    for (const r of routes) {
      const res = await r({ method, url, body, signal: init.signal ?? undefined });
      if (res) return res;
    }
    return json({ title: "Not Found" }, 404);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** The standard happy-path X API: users resolve, setup succeeds, streams deliver the given messages. */
export function xApiRoutes(opts: {
  users: { id: string; username: string }[];
  activity?: unknown[];
  filtered?: unknown[];
  activityStatus?: number;
  filteredStatus?: number;
  existingSubscriptions?: { subscription_id: string; event_type: string; filter: { user_id: string } }[];
  existingRules?: { id: string; value: string; tag?: string }[];
}): Route[] {
  return [
    ({ method, url }) => {
      if (method === "GET" && url.pathname === "/2/users/by") {
        const wanted = (url.searchParams.get("usernames") ?? "").split(",").map((h) => h.toLowerCase());
        return json({ data: opts.users.filter((u) => wanted.includes(u.username.toLowerCase())) });
      }
    },
    ({ method, url, body }) => {
      if (url.pathname !== "/2/activity/subscriptions") return;
      if (method === "GET") return json({ data: opts.existingSubscriptions ?? [], meta: {} });
      if (method === "POST") return json({ data: [{ subscription_id: "s-" + (body as { filter: { user_id: string } }).filter.user_id, ...(body as object) }] }, 201);
    },
    ({ method, url }) => {
      if (url.pathname !== "/2/tweets/search/stream/rules") return;
      if (method === "GET") return json({ data: opts.existingRules ?? [] });
      return json({ meta: { summary: { created: 1 } } });
    },
    ({ url, signal }) => {
      if (url.pathname === "/2/activity/stream") {
        if (opts.activityStatus && opts.activityStatus !== 200) return json({ title: "Forbidden" }, opts.activityStatus);
        return ndjsonStream(opts.activity ?? [], signal);
      }
      if (url.pathname === "/2/tweets/search/stream") {
        if (opts.filteredStatus && opts.filteredStatus !== 200) return json({ title: "Forbidden" }, opts.filteredStatus);
        return ndjsonStream(opts.filtered ?? [], signal);
      }
    },
    ({ url }) => (url.hostname === "pbs.twimg.com" ? new Response(FIXTURE_PNG, { status: 200 }) : undefined),
  ];
}
