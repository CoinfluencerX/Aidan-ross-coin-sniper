import { spawnSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { EXIT, main } from "../src/app/main.ts";
import { CONFIG_DIR, FAKE_SECRETS, REPO_ROOT, SECRET_NEEDLES, tempDir } from "./helpers.ts";

function envFile(dir: string, extra: Record<string, string> = {}): string {
  const path = join(dir, ".env");
  const vars = { LOG_LEVEL: "debug", ...FAKE_SECRETS, ...extra };
  writeFileSync(path, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return path;
}

async function run(argv: string[], opts: { env?: Record<string, string>; liveAvailable?: boolean } = {}) {
  const lines: string[] = [];
  const code = await main({
    argv,
    env: opts.env ?? {},
    cwd: REPO_ROOT,
    write: (l) => lines.push(l),
    ...(opts.liveAvailable !== undefined ? { liveAvailable: opts.liveAvailable } : {}),
  });
  const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  return { code, lines, events, text: lines.join("\n") };
}

describe("main: dry-run boot", () => {
  it("boots, writes state, and exits cleanly", async () => {
    const dir = tempDir();
    const { code, events } = await run(["--mode", "dry-run", "--data-dir", dir, "--env-file", envFile(dir)]);
    expect(code).toBe(EXIT.OK);
    expect(events.map((e) => e.event)).toEqual([
      "env.loaded",
      "boot.config_loaded",
      "guardrails.placeholder",
      "boot.complete",
      "boot.idle",
      "shutdown",
    ]);
    const loaded = events.find((e) => e.event === "boot.config_loaded");
    expect(loaded.accounts).toMatchObject({ people: ["adin_ross", "faze_banks"], tier1_buy_triggers: 5, blocked_mints: 1 });
    expect(loaded.configured).toMatchObject({ RPC_HTTP_URL: true, X_BEARER_TOKEN: true, WALLET_KEYPAIR_PATH: false });

    const dbPath = join(dir, "dry-run.sqlite");
    expect(existsSync(dbPath)).toBe(true);
    const db = new DatabaseSync(dbPath);
    const kinds = (db.prepare("SELECT kind FROM audit_log ORDER BY id").all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["boot", "shutdown"]);
    db.close();
  });

  it("never prints a secret, even with LOG_LEVEL=debug dumping the whole env", async () => {
    const dir = tempDir();
    const { code, text } = await run(["--data-dir", dir, "--env-file", envFile(dir)]);
    expect(code).toBe(EXIT.OK);
    expect(text).toContain("env.loaded");
    for (const needle of SECRET_NEEDLES) expect(text).not.toContain(needle);
  });

  it("works with no .env at all", async () => {
    const { code } = await run(["--data-dir", tempDir()]);
    expect(code).toBe(EXIT.OK);
  });

  it("lets real environment variables override the env file", async () => {
    const dir = tempDir();
    const { events } = await run(["--data-dir", dir, "--env-file", envFile(dir)], { env: { LOG_LEVEL: "warn" } });
    expect(events.map((e) => e.event)).toEqual(["guardrails.placeholder"]);
  });
});

describe("main: refusals", () => {
  it("refuses live from the CLI alone", async () => {
    const dir = tempDir();
    const { code, text } = await run(["--mode", "live", "--data-dir", dir, "--env-file", envFile(dir)]);
    expect(code).toBe(EXIT.MODE);
    expect(text).toContain("mode.refused");
    expect(existsSync(join(dir, "live.sqlite"))).toBe(false);
  });

  it("refuses live in M0 even with MODE=live and LIVE=1", async () => {
    const dir = tempDir();
    const { code, text } = await run(["--mode", "live", "--data-dir", dir, "--env-file", envFile(dir, { MODE: "live", LIVE: "1" })]);
    expect(code).toBe(EXIT.MODE);
    expect(text).toContain("isn't available yet");
  });

  it("once live exists, still refuses on placeholder guardrails and missing wallet/Telegram", async () => {
    const dir = tempDir();
    const { code, events } = await run(
      ["--mode", "live", "--data-dir", dir, "--env-file", envFile(dir, { MODE: "live", LIVE: "1" })],
      { liveAvailable: true },
    );
    expect(code).toBe(EXIT.MODE);
    const notReady = events.find((e) => e.event === "live.not_ready");
    expect(notReady.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("status: placeholder"),
        expect.stringContaining("take_profit_ladder is empty"),
        expect.stringContaining("WALLET_KEYPAIR_PATH"),
        expect.stringContaining("TELEGRAM_OWNER_CHAT_ID"),
      ]),
    );
    expect(existsSync(join(dir, "live.sqlite"))).toBe(false);
  });

  it("rejects an explicit env file that doesn't exist", async () => {
    const { code, text } = await run(["--env-file", join(tempDir(), "nope.env"), "--data-dir", tempDir()]);
    expect(code).toBe(EXIT.CONFIG);
    expect(text).toContain("env.missing");
  });

  it("rejects an invalid .env without printing the bad secret", async () => {
    const dir = tempDir();
    const { code, text } = await run(["--data-dir", dir, "--env-file", envFile(dir, { RPC_HTTP_URL: "not-a-url-rpc-secret-abc12345" })]);
    expect(code).toBe(EXIT.CONFIG);
    expect(text).toContain("env.invalid");
    expect(text).not.toContain("rpc-secret-abc12345");
  });

  it("rejects a broken config file with a readable message", async () => {
    const dir = tempDir();
    const configDir = join(dir, "config");
    cpSync(CONFIG_DIR, configDir, { recursive: true });
    writeFileSync(join(configDir, "validator.yaml"), "checks:\n  allowlisted_author: off\n");
    const { code, events } = await run(["--config-dir", configDir, "--data-dir", dir]);
    expect(code).toBe(EXIT.CONFIG);
    expect(events[0].event).toBe("config.invalid");
    expect(events[0].error).toContain("validator.yaml is invalid");
  });

  it.each([[["--mode", "banana"]], [["--unknown-flag"]], [["stray-positional"]]])("rejects bad usage %j", async (argv) => {
    const { code } = await run(argv);
    expect(code).toBe(EXIT.USAGE);
  });
});

describe("CLI process (what `npm start -- --mode dry-run` runs)", () => {
  it("exits 0 with clean JSON on stdout and nothing on stderr", () => {
    const dir = tempDir();
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "src/index.ts", "--mode", "dry-run", "--data-dir", dir, "--env-file", envFile(dir)],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const events = result.stdout.trim().split("\n").map((l) => JSON.parse(l).event);
    expect(events.at(-1)).toBe("shutdown");
    for (const needle of SECRET_NEEDLES) expect(result.stdout).not.toContain(needle);
  });
});
