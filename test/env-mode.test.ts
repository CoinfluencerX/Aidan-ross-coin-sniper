import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv as parseDotenv } from "node:util";
import { describe, expect, it } from "vitest";
import { collectSecretValues, EnvError, parseEnv, placeholderKeys } from "../src/config/env.ts";
import { ModeError, resolveMode } from "../src/config/mode.ts";
import { FAKE_SECRETS, REPO_ROOT } from "./helpers.ts";

describe("parseEnv", () => {
  it("defaults to dry-run with nothing set", () => {
    expect(parseEnv({})).toMatchObject({ MODE: "dry-run", LIVE: "0", DATA_DIR: "data", LOG_LEVEL: "info" });
  });

  it("accepts .env.example as shipped (empty values count as unset)", () => {
    const example = parseDotenv(readFileSync(join(REPO_ROOT, ".env.example"), "utf8")) as Record<string, string>;
    expect(parseEnv(example)).toMatchObject({ MODE: "dry-run", LIVE: "0" });
  });

  it("treats a line that still has its PASTE_..._HERE marker as not set, and says which", () => {
    const example = parseDotenv(readFileSync(join(REPO_ROOT, ".env.example"), "utf8")) as Record<string, string>;
    const env = parseEnv(example);
    expect(env.RPC_HTTP_URL).toBeUndefined();
    expect(env.RPC_WS_URL).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(placeholderKeys(example)).toEqual(["RPC_HTTP_URL", "RPC_WS_URL", "TELEGRAM_BOT_TOKEN"]);
    expect(collectSecretValues(example)).toEqual([]);
  });

  it("uses the line once the marker is replaced with a key", () => {
    const filled = { RPC_HTTP_URL: "https://mainnet.helius-rpc.com/?api-key=abc-123", RPC_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=abc-123" };
    expect(parseEnv(filled)).toMatchObject(filled);
    expect(placeholderKeys(filled)).toEqual([]);
    expect(collectSecretValues(filled)).toHaveLength(2);
  });

  it("ignores unrelated environment variables", () => {
    expect(() => parseEnv({ PATH: "/usr/bin", HOME: "/x" })).not.toThrow();
  });

  it("rejects bad values without echoing them", () => {
    let err: unknown;
    try {
      parseEnv({ RPC_HTTP_URL: "not a url rpc-secret-abc12345", MODE: "yolo" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvError);
    expect((err as Error).message).toMatch(/RPC_HTTP_URL/);
    expect((err as Error).message).toMatch(/MODE/);
    expect((err as Error).message).not.toContain("rpc-secret-abc12345");
  });

  it("collects secret values, but not public client IDs", () => {
    const secrets = collectSecretValues({ ...FAKE_SECRETS, KICK_CLIENT_ID: "public-client-id" });
    expect(secrets).toEqual(expect.arrayContaining(Object.values(FAKE_SECRETS)));
    expect(secrets).not.toContain("public-client-id");
  });
});

describe("resolveMode", () => {
  const off = { MODE: "dry-run", LIVE: "0" } as const;
  const on = { MODE: "live", LIVE: "1" } as const;

  it("is dry-run unless live is asked for", () => {
    expect(resolveMode(undefined, on)).toBe("dry-run");
    expect(resolveMode("dry-run", on)).toBe("dry-run");
  });

  it("refuses live from the CLI alone", () => {
    expect(() => resolveMode("live", off)).toThrow(ModeError);
    expect(() => resolveMode("live", { MODE: "live", LIVE: "0" })).toThrow(/LIVE=1/);
    expect(() => resolveMode("live", { MODE: "dry-run", LIVE: "1" })).toThrow(/MODE=live/);
  });

  it("refuses live while live trading isn't available yet (M0)", () => {
    expect(() => resolveMode("live", on)).toThrow(/isn't available yet/);
  });

  it("allows live only when all three switches agree and it's available", () => {
    expect(resolveMode("live", on, true)).toBe("live");
  });
});
