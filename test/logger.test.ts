import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log/logger.ts";

function capture(level?: "debug" | "info" | "warn" | "error", secrets: string[] = []) {
  const lines: string[] = [];
  const log = createLogger({
    write: (l) => lines.push(l),
    now: () => new Date("2026-11-19T00:00:00.000Z"),
    secrets,
    ...(level ? { level } : {}),
  });
  return { log, lines, json: () => lines.map((l) => JSON.parse(l)) };
}

describe("createLogger", () => {
  it("writes one JSON object per line with time, level and event", () => {
    const { log, json } = capture();
    log.info("signal.received", { mint: "abc", n: 1 });
    expect(json()).toEqual([
      { time: "2026-11-19T00:00:00.000Z", level: "info", event: "signal.received", mint: "abc", n: 1 },
    ]);
  });

  it("drops lines below the configured level", () => {
    const { log, json } = capture("warn");
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
    expect(json().map((l) => l.event)).toEqual(["c", "d"]);
  });

  it("merges child bindings into every line", () => {
    const { log, json } = capture();
    log.child({ component: "watcher", source: "x" }).info("connected");
    expect(json()[0]).toMatchObject({ component: "watcher", source: "x", event: "connected" });
  });

  it("redacts secrets in fields, bindings and the event name", () => {
    const { log, lines } = capture("info", ["SUPERSECRETVALUE123"]);
    log.child({ url: "https://x/SUPERSECRETVALUE123" }).error("failed SUPERSECRETVALUE123", { botToken: "t-1" });
    expect(lines.join("\n")).not.toContain("SUPERSECRETVALUE123");
    expect(lines.join("\n")).not.toContain("t-1");
  });
});
