import type { Logger } from "../../log/logger.ts";
import { XApiError } from "./client.ts";

export interface StreamLoopOptions {
  name: string;
  /** Opens the HTTP stream. Called again on every reconnect. */
  open: (signal: AbortSignal) => Promise<Response>;
  onMessage: (msg: unknown, receivedAt: number) => void;
  signal: AbortSignal;
  log: Logger;
  /** No bytes (not even a keep-alive) for this long = dead connection. X sends keep-alives every ~20 s. */
  stallMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called once when the stream gives up for good (auth/plan errors). */
  onFatal?: (err: Error) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Reads newline-delimited JSON, skipping blank keep-alive lines. Resolves when the body ends. */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (value: unknown, receivedAt: number) => void,
  onBytes: () => void,
  onBadLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  // Cancel the read on abort (stall or shutdown), even if the body itself ignores the signal.
  const cancel = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes();
      const receivedAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          onBadLine(line);
          continue;
        }
        onLine(parsed, receivedAt);
      }
    }
    const rest = buf.trim();
    if (rest) {
      try {
        onLine(JSON.parse(rest), Date.now());
      } catch {
        onBadLine(rest);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Keeps one streaming connection alive until `signal` aborts: reconnects with
 * exponential backoff, waits longer after 429, kills stalled connections, and
 * gives up only on 401/403 (bad token or the plan doesn't include this endpoint).
 */
export async function runStreamLoop(o: StreamLoopOptions): Promise<void> {
  const stallMs = o.stallMs ?? 45_000;
  const minBackoff = o.minBackoffMs ?? 1_000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;
  const sleep = o.sleep ?? abortableSleep;
  let backoff = minBackoff;
  const log = o.log.child({ stream: o.name });

  while (!o.signal.aborted) {
    const conn = new AbortController();
    const onOuterAbort = () => conn.abort();
    o.signal.addEventListener("abort", onOuterAbort, { once: true });
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        log.warn("x.stream.stalled", { stall_ms: stallMs });
        conn.abort();
      }, stallMs);
    };
    try {
      const res = await o.open(conn.signal);
      log.info("x.stream.connected", { status: res.status });
      backoff = minBackoff;
      armStall();
      if (!res.body) throw new Error("stream response had no body");
      await readNdjson(
        res.body,
        (msg, at) => {
          const errors = (msg as { errors?: unknown[] })?.errors;
          if (errors && !(msg as { data?: unknown }).data) log.warn("x.stream.error_message", { errors });
          else o.onMessage(msg, at);
        },
        armStall,
        (line) => log.warn("x.stream.bad_line", { sample: line.slice(0, 120) }),
        conn.signal,
      );
      if (!o.signal.aborted) log.warn("x.stream.ended", { note: "server closed the stream, reconnecting" });
    } catch (err) {
      if (o.signal.aborted) break;
      if (err instanceof XApiError && err.isAuthOrPlan) {
        log.error("x.stream.fatal", { status: err.status, error: err.message });
        o.onFatal?.(err);
        break;
      }
      const rateLimited = err instanceof XApiError && err.status === 429;
      if (rateLimited) backoff = Math.max(backoff, 60_000);
      log.warn("x.stream.disconnected", { error: (err as Error).message, retry_in_ms: backoff });
    } finally {
      clearTimeout(stallTimer);
      o.signal.removeEventListener("abort", onOuterAbort);
      conn.abort();
    }
    if (o.signal.aborted) break;
    await sleep(backoff, o.signal);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}
