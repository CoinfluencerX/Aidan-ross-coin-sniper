import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv as parseDotenv } from "node:util";
import { collectSecretValues, EnvError, parseEnv, type AppEnv } from "../config/env.ts";
import { ConfigError, loadAppConfig, type AppConfig } from "../config/load.ts";
import { isMode, ModeError, resolveMode, type Mode } from "../config/mode.ts";
import { liveReadinessProblems, PUSH_PLATFORMS, type AccountsConfig, type Platform } from "../config/schemas.ts";
import { createLogger, type Logger } from "../log/logger.ts";
import { createRedactor } from "../log/redact.ts";
import { audit } from "../state/audit.ts";
import { openDb, SCHEMA_VERSION } from "../state/db.ts";

export const EXIT = { OK: 0, CONFIG: 1, MODE: 2, USAGE: 64, FATAL: 70 } as const;

const CONNECTION_KEYS = [
  "RPC_HTTP_URL",
  "RPC_WS_URL",
  "GRPC_URL",
  "JITO_BLOCK_ENGINE_URL",
  "WALLET_KEYPAIR_PATH",
  "X_BEARER_TOKEN",
  "KICK_CLIENT_ID",
  "TWITCH_CLIENT_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_CHAT_ID",
] as const satisfies readonly (keyof AppEnv)[];

export interface MainOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  write?: (line: string) => void;
  /** Test hook only. Production always uses LIVE_TRADING_AVAILABLE. */
  liveAvailable?: boolean;
}

const USAGE = `Usage: npm start -- [--mode dry-run|live] [--config-dir config] [--data-dir data] [--env-file .env]

  --mode        dry-run (default) or live. Live also needs MODE=live and LIVE=1 in .env.
  --config-dir  folder with accounts.yaml, guardrails.yaml, validator.yaml
  --data-dir    folder for the SQLite state (one file per mode). Overrides DATA_DIR.
  --env-file    env file to load (default .env, optional). Real environment variables win.`;

export async function main(opts: MainOptions): Promise<number> {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));

  // 1. Arguments. No secrets are loaded yet, so a bare logger is fine.
  let args: ReturnType<typeof parseCli>;
  try {
    args = parseCli(opts.argv);
  } catch (err) {
    createLogger({ write }).error("usage.invalid", { error: (err as Error).message, usage: USAGE });
    return EXIT.USAGE;
  }
  if (args.help) {
    write(USAGE);
    return EXIT.OK;
  }
  if (args.mode !== undefined && !isMode(args.mode)) {
    createLogger({ write }).error("usage.invalid", { error: `--mode must be dry-run or live, got "${args.mode}"` });
    return EXIT.USAGE;
  }
  const cliMode: Mode | undefined = args.mode;

  // 2. Environment. Collect secrets from the RAW values first, so even invalid ones are redacted.
  const envFile = resolve(opts.cwd, args["env-file"] ?? ".env");
  const envFileExplicit = args["env-file"] !== undefined;
  const fileVars = existsSync(envFile) ? (parseDotenv(readFileSync(envFile, "utf8")) as Record<string, string>) : {};
  const rawEnv = { ...fileVars, ...opts.env };
  const redactor = createRedactor(collectSecretValues(rawEnv));

  if (envFileExplicit && !existsSync(envFile)) {
    createLogger({ redactor, write }).error("env.missing", { env_file: envFile });
    return EXIT.CONFIG;
  }

  let env: AppEnv;
  try {
    env = parseEnv(rawEnv);
  } catch (err) {
    createLogger({ redactor, write }).error("env.invalid", { error: (err as EnvError).message });
    return EXIT.CONFIG;
  }
  const log = createLogger({ redactor, level: env.LOG_LEVEL, write });
  // Whole env at debug level. Secret keys are redacted by name, and secret URLs by value.
  log.debug("env.loaded", { env });

  try {
    return run(log, env, cliMode, args, opts, existsSync(envFile) ? envFile : null);
  } catch (err) {
    log.error("fatal", { error: err });
    return EXIT.FATAL;
  }
}

function run(
  log: Logger,
  env: AppEnv,
  cliMode: Mode | undefined,
  args: ReturnType<typeof parseCli>,
  opts: MainOptions,
  envFile: string | null,
): number {
  // 3. Mode gate.
  let mode: Mode;
  try {
    mode = resolveMode(cliMode, env, opts.liveAvailable);
  } catch (err) {
    if (err instanceof ModeError) {
      log.error("mode.refused", { error: err.message });
      return EXIT.MODE;
    }
    throw err;
  }

  // 4. Config files.
  let config: AppConfig;
  const configDir = resolve(opts.cwd, args["config-dir"] ?? "config");
  try {
    config = loadAppConfig(configDir);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("config.invalid", { error: err.message });
      return EXIT.CONFIG;
    }
    throw err;
  }

  // 5. Live readiness. Unreachable until LIVE_TRADING_AVAILABLE flips, but enforced from day one.
  if (mode === "live") {
    const problems = [...liveReadinessProblems(config.guardrails), ...liveEnvProblems(env, config.accounts)];
    if (problems.length > 0) {
      log.error("live.not_ready", { problems });
      return EXIT.MODE;
    }
  }

  const accounts = summarizeAccounts(config.accounts);
  const levels = Object.values(config.validator.checks).reduce<Record<string, number>>((acc, level) => {
    acc[level] = (acc[level] ?? 0) + 1;
    return acc;
  }, {});

  log.info("boot.config_loaded", {
    mode,
    env_file: envFile,
    config_dir: configDir,
    accounts,
    validator_levels: levels,
    guardrails_status: config.guardrails.status,
    // Booleans only: shows what's configured without revealing anything.
    configured: Object.fromEntries(CONNECTION_KEYS.map((k) => [k, Boolean(env[k])])),
  });
  if (config.guardrails.status === "placeholder") {
    log.warn("guardrails.placeholder", { note: "guardrails.yaml still holds placeholders. Fine for dry-run, blocks live." });
  }

  // 6. State.
  const dataDir = resolve(opts.cwd, args["data-dir"] ?? env.DATA_DIR);
  const dbPath = join(dataDir, `${mode}.sqlite`);
  const db = openDb(dbPath);
  try {
    audit(db, log.redactor, "boot", { mode, schema_version: SCHEMA_VERSION, accounts });
    log.info("boot.complete", { mode, db_path: dbPath, schema_version: SCHEMA_VERSION });

    // 7. Components. Watchers arrive in M1, the validator in M2, the executor in M3.
    log.info("boot.idle", { note: "No watchers yet (M0). Exiting cleanly." });
    audit(db, log.redactor, "shutdown", { mode, reason: "m0_no_components" });
  } finally {
    db.close();
  }
  log.info("shutdown", { exit_code: EXIT.OK });
  return EXIT.OK;
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      mode: { type: "string" },
      "config-dir": { type: "string" },
      "data-dir": { type: "string" },
      "env-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

function liveEnvProblems(env: AppEnv, accounts: AccountsConfig): string[] {
  const required = ["RPC_HTTP_URL", "RPC_WS_URL", "WALLET_KEYPAIR_PATH", "X_BEARER_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID"] as const;
  const problems: string[] = required.filter((k) => !env[k]).map((k) => `${k} is not set in .env`);
  if (accounts.test_accounts.x.length > 0) problems.push("test_accounts.x must be empty in live mode");
  return problems;
}

export function summarizeAccounts(accounts: AccountsConfig) {
  const byPlatform: Partial<Record<Platform, number>> = {};
  let tier1 = 0;
  let tier2 = 0;
  for (const person of Object.values(accounts.people)) {
    for (const [platform, list] of Object.entries(person) as [Platform, { tier: 1 | 2 }[]][]) {
      if (list.length === 0) continue;
      byPlatform[platform] = (byPlatform[platform] ?? 0) + list.length;
      for (const a of list) a.tier === 1 ? tier1++ : tier2++;
    }
  }
  return {
    people: Object.keys(accounts.people),
    tier1_buy_triggers: tier1,
    tier2_confirmations: tier2,
    by_platform: byPlatform,
    push_platforms: PUSH_PLATFORMS,
    excluded:
      accounts.exclude.x_handles.length +
      accounts.exclude.kick_slugs.length +
      accounts.exclude.youtube_channel_ids.length +
      accounts.exclude.tiktok_usernames.length,
    blocked_mints: accounts.blocked_mints.length,
    test_accounts: accounts.test_accounts.x.length,
  };
}
