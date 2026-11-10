import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../../log/logger.ts";

/**
 * A tiny HTTP server for platform webhooks (Kick, Twitch). Each route gets the raw request
 * body, because signatures are computed over the exact bytes sent.
 *
 * It must sit behind HTTPS (a reverse proxy or tunnel on the server): both platforms only
 * deliver to public https URLs.
 */

export interface WebhookRequest {
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  contentType?: string;
}

export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse>;

export interface WebhookServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startWebhookServer(o: { port: number; host?: string; routes: Record<string, WebhookHandler>; log: Logger }): Promise<WebhookServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const send = (r: WebhookResponse) => {
      res.writeHead(r.status, { "content-type": r.contentType ?? "text/plain" });
      res.end(r.body ?? "");
    };
    if (req.method === "GET" && path === "/healthz") return send({ status: 200, body: "ok" });
    const handler = o.routes[path];
    if (!handler) return send({ status: 404 });
    if (req.method !== "POST") return send({ status: 405 });
    void (async () => {
      try {
        const rawBody = await readBody(req);
        if (rawBody === null) return send({ status: 413 });
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        send(await handler({ headers, rawBody }));
      } catch (err) {
        o.log.error("webhook.handler_failed", { path, error: err });
        // 500 makes the platform retry, which is what we want after a crash in our own code.
        if (!res.headersSent) send({ status: 500 });
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "0.0.0.0", () => {
      const port = (server.address() as AddressInfo).port;
      o.log.info("webhook.listening", { port, routes: Object.keys(o.routes) });
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

/** Remembers recent message IDs so a platform retry isn't processed twice. */
export class SeenIds {
  readonly #ids = new Set<string>();
  readonly #max: number;
  constructor(max = 5_000) {
    this.#max = max;
  }
  /** Returns true the first time an id is seen. */
  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.#max) this.#ids.delete(this.#ids.values().next().value!);
    return true;
  }
}
