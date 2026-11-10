import { spawnSync } from "node:child_process";
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
import { openDb, SCHEMA_VERSION, type Db } from "../state/db.ts";
import { formatEvmAlert } from "../alert/console.ts";
import { JupiterClient, jupiterRouteCheck, SolPrice } from "../chain/jupiter.ts";
import { SolanaRpc } from "../chain/rpc.ts";
import type { ChainReader } from "../chain/facts.ts";
import type { TradeBuilder } from "../exec/builder.ts";
import type { Executor } from "../exec/executor.ts";
import type { Sender } from "../exec/send.ts";
import { Engine } from "./engine.ts";
import { locateEvmAddress } from "../evm/locate.ts";
import type { FetchFn } from "../extract/expand.ts";
import { tesseractOcr, type OcrEngine } from "../extract/ocr.ts";
import type { PipelineDeps } from "../watch/pipeline.ts";
import type { XPath } from "../watch/signal.ts";
import { startWebhookWatchers } from "./webhooks.ts";
import { XApiError, XClient } from "../watch/x/client.ts";
import {
  buildWatchList,
  ensureActivitySubscriptions,
  ensureStreamRule,
  verifyWatchList,
  WatchConfigError,
  XWatcher,
} from "../watch/x/watcher.ts";

export const EXIT = { OK: 0, CONFIG: 1, MODE: 2, USAGE: 64, FATAL: 70 } as const;

const CONNECTION_KEYS = [
  "RPC_HTTP_URL",
  "RPC_WS_URL",
  "GRPC_URL",
  "JITO_BLOCK_ENGINE_URL",
  "WALLET_KEYPAIR_PATH",
  "SIM_PAYER_PUBKEY",
  "X_BEARER_TOKEN",
  "KICK_CLIENT_ID",
  "TWITCH_CLIENT_ID",
  "WEBHOOK_PUBLIC_URL",
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
  /** Network for the watcher (X API, link expansion, image download). Defaults to global fetch. */
  fetch?: FetchFn;
  /** OCR engine. Defaults to the local tesseract binary when it's installed. Pass null to disable. */
  ocr?: OcrEngine | null;
  /** Where the human-readable alert banners go. Defaults to stderr, so stdout stays JSON lines. */
  alert?: (text: string) => void;
  /** Stops the watcher (Ctrl-C). */
  signal?: AbortSignal;
  /** Test hook: replaces the SDK-backed trade builder. */
  tradeBuilder?: TradeBuilder;
  /** Test hook: port for the Kick/Twitch webhook server (0 = any free port, bound to localhost). */
  webhookPort?: number;
}

const USAGE = `Usage: npm start -- [--mode dry-run|live] [--watch [--duration <seconds>]] [--config-dir config] [--data-dir data] [--env-file .env]

  --mode        dry-run (default) or live. Live also needs MODE=live and LIVE=1 in .env.
  --config-dir  folder with accounts.yaml, guardrails.yaml, validator.yaml
  --data-dir    folder for the SQLite state (one file per mode). Overrides DATA_DIR.
  --env-file    env file to load (default .env, optional). Real environment variables win.
  --watch       start the X watcher (Activity API + Filtered Stream). Needs X_BEARER_TOKEN.
  --duration    with --watch: stop after this many seconds (default: run until Ctrl-C).`;

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
  let durationMs: number | undefined;
  if (args.duration !== undefined) {
    const n = Number(args.duration);
    if (!args.watch || !Number.isFinite(n) || n <= 0) {
      createLogger({ write }).error("usage.invalid", { error: "--duration needs --watch and a positive number of seconds" });
      return EXIT.USAGE;
    }
    durationMs = n * 1000;
  }

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
    return await run(log, env, cliMode, args, opts, existsSync(envFile) ? envFile : null, durationMs);
  } catch (err) {
    log.error("fatal", { error: err });
    return EXIT.FATAL;
  }
}

async function run(
  log: Logger,
  env: AppEnv,
  cliMode: Mode | undefined,
  args: ReturnType<typeof parseCli>,
  opts: MainOptions,
  envFile: string | null,
  durationMs: number | undefined,
): Promise<number> {
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

    // 7. Components. The validator arrives in M2, the executor in M3.
    if (!args.watch) {
      log.info("boot.idle", { note: "No --watch given. Exiting cleanly." });
      audit(db, log.redactor, "shutdown", { mode, reason: "no_watch" });
      log.info("shutdown", { exit_code: EXIT.OK });
      return EXIT.OK;
    }
    const code = await watch(log, env, mode, config, db, opts, durationMs);
    log.info("shutdown", { exit_code: code });
    return code;
  } finally {
    db.close();
  }
}

function defaultOcr(log: Logger): OcrEngine | undefined {
  const probe = spawnSync("tesseract", ["--version"], { encoding: "utf8", timeout: 3_000 });
  if (probe.status === 0) {
    log.info("ocr.ready", { engine: "tesseract", version: probe.stdout.split("\n")[0] });
    return tesseractOcr();
  }
  log.warn("ocr.unavailable", { note: "tesseract not on PATH: images are checked by alt text only" });
  return undefined;
}

async function watch(
  log: Logger,
  env: AppEnv,
  mode: Mode,
  config: AppConfig,
  db: Db,
  opts: MainOptions,
  durationMs: number | undefined,
): Promise<number> {
  if (!env.X_BEARER_TOKEN) {
    log.error("watch.no_x_token", { note: "--watch needs X_BEARER_TOKEN in .env" });
    audit(db, log.redactor, "shutdown", { mode, reason: "no_x_token" });
    return EXIT.CONFIG;
  }
  const client = new XClient({ bearerToken: env.X_BEARER_TOKEN, ...(opts.fetch ? { fetch: opts.fetch } : {}) });

  let watchList;
  try {
    watchList = buildWatchList(config.accounts, mode);
    await verifyWatchList(client, watchList, log);
  } catch (err) {
    const known = err instanceof WatchConfigError || err instanceof XApiError;
    log.error("watch.accounts_invalid", { error: (err as Error).message });
    audit(db, log.redactor, "shutdown", { mode, reason: "accounts_invalid" });
    if (known) return EXIT.CONFIG;
    throw err;
  }

  // Set up each path. A path whose endpoint the plan doesn't include is dropped, not fatal,
  // as long as one path remains.
  const paths: XPath[] = [];
  const setups: [XPath, () => Promise<unknown>][] = [
    ["activity", () => ensureActivitySubscriptions(client, watchList, log)],
    ["filtered_stream", () => ensureStreamRule(client, watchList, log)],
  ];
  for (const [path, setup] of setups) {
    try {
      await setup();
      paths.push(path);
    } catch (err) {
      log.warn("watch.path_unavailable", { path, error: (err as Error).message });
    }
  }
  if (paths.length === 0) {
    log.error("watch.no_paths", { note: "Neither the Activity API nor Filtered Stream could be set up. Check the X plan and token." });
    audit(db, log.redactor, "shutdown", { mode, reason: "no_paths" });
    return EXIT.CONFIG;
  }

  const ocr = opts.ocr === null ? undefined : (opts.ocr ?? defaultOcr(log));
  const alert = opts.alert ?? ((text: string) => process.stderr.write(text + "\n"));
  const color = opts.alert ? false : Boolean(process.stderr.isTTY) || process.env.FORCE_COLOR !== undefined;
  // Validator: needs an RPC endpoint. Without one, signals are still caught and alerted, just not validated.
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  const jupiter = new JupiterClient(fetchOpt);
  const solPrice = new SolPrice(() => jupiter.solUsd());
  let chain: ChainReader | undefined;
  let executor: Executor | undefined;
  if (env.RPC_HTTP_URL) {
    // Loaded only when needed: the Solana and pump.fun SDKs take a few hundred ms to load.
    const { RpcChainReader } = await import("../chain/facts.ts");
    const { Executor: ExecutorClass } = await import("../exec/executor.ts");
    const rpc = new SolanaRpc({ url: env.RPC_HTTP_URL, ...fetchOpt });
    chain = new RpcChainReader(rpc);
    try {
      const built = await buildExecutor({ env, mode, config, db, log, rpc, chain, jupiter, opts, ExecutorClass });
      executor = built.executor;
      log.info("executor.ready", built.info);
    } catch (err) {
      // A wallet problem must stop the bot loudly, not fall back to something else.
      log.error("executor.unavailable", { error: (err as Error).message });
      audit(db, log.redactor, "shutdown", { mode, reason: "executor_unavailable" });
      return EXIT.CONFIG;
    }
  }
  if (chain) solPrice.start();
  else log.warn("validator.off", { note: "RPC_HTTP_URL isn't set: addresses are caught and alerted, but not validated" });
  const engine = new Engine({
    mode,
    config,
    db,
    log,
    alert,
    color,
    chain,
    executor,
    jupiterRoute: jupiterRouteCheck(jupiter, config.guardrails.buy.max_slippage_bps),
    solUsd: () => solPrice.get(),
  });

  // Every source (X, Kick, Twitch) feeds the same pipeline, so the rules can't differ between them.
  const pipeline: PipelineDeps = {
    accounts: config.accounts,
    validator: config.validator,
    db,
    log,
    ocr,
    fetch: opts.fetch,
    onSignal: engine.onSignal,
    // 0x addresses: find the chain, then alert. Never bought.
    locateEvm: (address) =>
      locateEvmAddress(address, { rpcUrls: { ethereum: env.ETH_RPC_URL, base: env.BASE_RPC_URL }, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
    onEvm: (s, a) => alert(formatEvmAlert(s, a, { color, mode, now: Date.now() })),
  };
  const watcher = new XWatcher({
    client,
    accounts: config.accounts,
    validator: config.validator,
    watchList,
    db,
    log,
    mode,
    ocr,
    fetch: opts.fetch,
    paths,
    onSignal: pipeline.onSignal,
    locateEvm: pipeline.locateEvm,
    onEvm: pipeline.onEvm,
  });
  const webhooks = await startWebhookWatchers({
    env,
    accounts: config.accounts,
    pipeline,
    log,
    fetch: opts.fetch,
    ...(opts.webhookPort !== undefined ? { port: opts.webhookPort, host: "127.0.0.1" } : {}),
  });

  const stops = [opts.signal, durationMs !== undefined ? AbortSignal.timeout(durationMs) : undefined].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  const stop = stops.length ? AbortSignal.any(stops) : new AbortController().signal;
  log.info("watch.started", {
    mode,
    paths,
    validator: chain ? "on" : "off (no RPC_HTTP_URL)",
    webhook_sources: webhooks?.sources ?? [],
    webhook_port: webhooks?.port ?? null,
    duration_s: durationMs !== undefined ? durationMs / 1000 : null,
    ocr: Boolean(ocr),
    accounts: watchList.map((a) => ({ handle: a.handle, user_id: a.userId, tier: a.tier, test: a.isTest })),
  });
  audit(db, log.redactor, "watch.started", { mode, paths, accounts: watchList });

  const { failedPaths } = await watcher.run(stop);
  const everyPathFailed = failedPaths.length === paths.length && !stop.aborted;
  await webhooks?.close();
  await engine.drain();
  solPrice.stop();
  log.info("watch.stopped", { stats: watcher.stats, engine: engine.stats, failed_paths: failedPaths, ...(webhooks ? { webhook_stats: webhooks.stats() } : {}) });
  audit(db, log.redactor, "shutdown", { mode, reason: everyPathFailed ? "all_paths_failed" : "stopped", stats: watcher.stats });
  return everyPathFailed ? EXIT.FATAL : EXIT.OK;
}

/**
 * Builds the executor. Dry-run gets NO sender, so it cannot put anything on chain.
 * The wallet file is only read when the owner has put its path in .env themselves.
 */
async function buildExecutor(a: {
  env: AppEnv;
  mode: Mode;
  config: AppConfig;
  db: Db;
  log: Logger;
  rpc: SolanaRpc;
  chain: ChainReader;
  jupiter: JupiterClient;
  opts: MainOptions;
  ExecutorClass: typeof Executor;
}): Promise<{ executor: Executor; info: Record<string, unknown> }> {
  const { env, mode, config, opts } = a;
  const { ephemeralSigner, loadWalletSigner } = await import("../exec/wallet.ts");
  const signer = env.WALLET_KEYPAIR_PATH ? loadWalletSigner(env.WALLET_KEYPAIR_PATH, a.log.redactor, opts.cwd) : ephemeralSigner();
  // Who the simulations run as. Live: always the wallet. Dry-run: SIM_PAYER_PUBKEY if given, else the wallet if there is one.
  const simPayer = mode === "live" ? signer.publicKey : (env.SIM_PAYER_PUBKEY ?? (signer.ephemeral ? undefined : signer.publicKey));
  let builder = opts.tradeBuilder;
  if (!builder) {
    const { SdkTradeBuilder } = await import("../exec/builder.ts");
    builder = new SdkTradeBuilder({
      rpcUrl: env.RPC_HTTP_URL!,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      jupiter: a.jupiter,
      priorityMicroLamports: config.guardrails.buy.priority_fee_micro_lamports,
    });
  }
  let sender: Sender | undefined;
  if (mode === "live") {
    const { LiveSender } = await import("../exec/send.ts");
    sender = new LiveSender({ rpc: a.rpc, jitoUrl: env.JITO_BLOCK_ENGINE_URL, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }
  const executor = new a.ExecutorClass({ mode, rpc: a.rpc, chain: a.chain, builder, signer, simPayer, guardrails: config.guardrails, db: a.db, log: a.log, sender });
  return {
    executor,
    info: {
      mode,
      can_send: sender !== undefined,
      wallet: signer.ephemeral ? "none (throwaway key, timing only)" : signer.publicKey,
      simulates_as: simPayer ?? "nobody: set WALLET_KEYPAIR_PATH or SIM_PAYER_PUBKEY, or every buy fails its simulation",
    },
  };
}

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      mode: { type: "string" },
      "config-dir": { type: "string" },
      "data-dir": { type: "string" },
      "env-file": { type: "string" },
      watch: { type: "boolean" },
      duration: { type: "string" },
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
