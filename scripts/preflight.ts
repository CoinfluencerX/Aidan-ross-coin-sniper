/**
 * Pre-flight check. Run it before a rehearsal and again before going live.
 *
 *   node scripts/preflight.ts                 checks for a dry-run
 *   node scripts/preflight.ts --for live      stricter: anything that would stop live mode is a FAIL
 *   node scripts/preflight.ts --notify        also sends a test message to your Telegram
 *   node scripts/preflight.ts --skip-x        skip the X account lookup (it costs about $0.05)
 *
 * Read-only. It reads keys from .env inside this process and never prints them. If
 * WALLET_KEYPAIR_PATH is set it loads that wallet to read its PUBLIC address and SOL balance.
 * It signs nothing and sends nothing. Exit code 1 if anything FAILs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv as parseDotenv } from "node:util";
import { JupiterClient } from "../src/chain/jupiter.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { parseEnv, placeholderKeys, testAccountsFromEnv, type AppEnv } from "../src/config/env.ts";
import { loadAppConfig, withTestAccounts, type AppConfig } from "../src/config/load.ts";
import { LIVE_TRADING_AVAILABLE } from "../src/config/mode.ts";
import { liveReadinessProblems } from "../src/config/schemas.ts";
import { Telegram } from "../src/control/telegram.ts";
import { createLogger } from "../src/log/logger.ts";
import { createRedactor } from "../src/log/redact.ts";
import { buildKickWatchList, KickClient, verifyKickWatchList } from "../src/watch/kick.ts";
import { buildTwitchWatchList, TwitchClient, verifyTwitchWatchList } from "../src/watch/twitch.ts";
import { XClient } from "../src/watch/x/client.ts";
import { buildWatchList, RULE_TAG, streamRuleValue, verifyWatchList } from "../src/watch/x/watcher.ts";

const { values } = parseArgs({ options: { for: { type: "string" }, notify: { type: "boolean" }, "skip-x": { type: "boolean" } } });
const target = values.for === "live" ? "live" : "dry-run";
type Status = "ok" | "warn" | "fail" | "skip";
const rows: { name: string; status: Status; detail: string }[] = [];
const add = (name: string, status: Status, detail: string) => rows.push({ name, status, detail });
/** A problem that only matters for live trading: FAIL when checking for live, WARN otherwise. */
const liveOnly = (name: string, ok: boolean, good: string, bad: string) => add(name, ok ? "ok" : target === "live" ? "fail" : "warn", ok ? good : bad);
const quiet = createLogger({ write: () => {} });
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (err) {
    add(name, "fail", (err as Error).message.slice(0, 160));
  }
};

// ---------- config and .env ----------
let config: AppConfig | undefined;
let env: AppEnv | undefined;
try {
  config = loadAppConfig("config");
  add("config files", "ok", "accounts.yaml, guardrails.yaml, validator.yaml load");
} catch (err) {
  add("config files", "fail", (err as Error).message.slice(0, 200));
}
try {
  const rawEnv = { ...(existsSync(".env") ? parseDotenv(readFileSync(".env", "utf8")) : {}), ...process.env };
  env = parseEnv(rawEnv);
  add(".env", existsSync(".env") ? "ok" : "warn", existsSync(".env") ? "loads" : "no .env file: copy .env.example to .env");
  const unfilled = placeholderKeys(rawEnv);
  if (unfilled.length > 0) add(".env markers", "warn", `still has a PASTE_..._HERE marker, so not set yet: ${unfilled.join(", ")}`);
} catch (err) {
  add(".env", "fail", (err as Error).message);
}

if (config && env) {
  config = withTestAccounts(config, testAccountsFromEnv(env));
  const g = config.guardrails;
  const problems = liveReadinessProblems(g);
  liveOnly("guardrails", problems.length === 0, `set: ${g.buy.sol_per_buy} SOL per buy, ${g.exit.take_profit_ladder.length} take-profit steps`, problems.join("; "));
  liveOnly("test accounts", config.accounts.test_accounts.x.length === 0, "none", `${config.accounts.test_accounts.x.length} test account(s) (TEST_X_ACCOUNTS in .env): fine for dry-run, must be removed for live`);
  liveOnly("live switch", LIVE_TRADING_AVAILABLE, "LIVE_TRADING_AVAILABLE is on", "LIVE_TRADING_AVAILABLE is off in src/config/mode.ts: live mode can't start (this is the safe default)");
  if (target === "live") add("MODE / LIVE in .env", env.MODE === "live" && env.LIVE === "1" ? "ok" : "fail", env.MODE === "live" && env.LIVE === "1" ? "MODE=live, LIVE=1" : "live also needs MODE=live and LIVE=1 in .env");

  // ---------- Solana ----------
  const jupiter = new JupiterClient();
  if (!env.RPC_HTTP_URL) {
    add("Solana RPC", target === "live" ? "fail" : "warn", "RPC_HTTP_URL isn't set: the validator and executor are off");
  } else {
    const rpc = new SolanaRpc({ url: env.RPC_HTTP_URL, timeoutMs: 8_000 });
    await check("Solana RPC", async () => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await rpc.getLatestBlockhash();
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const median = Math.round(times[2]!);
      add("Solana RPC", median < 150 ? "ok" : "warn", `answers in ${median} ms (median of 5)${median < 150 ? "" : ": slow. Every validator step waits on this"}`);
    });
    await check("pump.fun SDK", async () => {
      const { SdkTradeBuilder } = await import("../src/exec/builder.ts");
      const t = performance.now();
      await new SdkTradeBuilder({ rpcUrl: env.RPC_HTTP_URL!, jupiter }).globals();
      add("pump.fun SDK", "ok", `read pump.fun's settings and fee schedule through your RPC in ${Math.round(performance.now() - t)} ms`);
    });

    // ---------- wallet ----------
    const need = g.buy.sol_per_buy + 0.02;
    if (env.WALLET_KEYPAIR_PATH) {
      await check("bot wallet", async () => {
        const { loadWalletSigner } = await import("../src/exec/wallet.ts");
        const signer = loadWalletSigner(env.WALLET_KEYPAIR_PATH!, createRedactor([]), process.cwd());
        const sol = (await rpc.getBalance(signer.publicKey)) / 1e9;
        add("bot wallet", sol >= need ? "ok" : target === "live" ? "fail" : "warn", `${signer.publicKey} holds ${sol.toFixed(4)} SOL (one buy plus fees needs about ${need.toFixed(3)})`);
      });
    } else {
      add("bot wallet", target === "live" ? "fail" : "warn", "WALLET_KEYPAIR_PATH isn't set");
    }
    if (target === "dry-run") {
      if (env.SIM_PAYER_PUBKEY) {
        await check("simulation payer", async () => {
          const sol = (await rpc.getBalance(env.SIM_PAYER_PUBKEY!)) / 1e9;
          add("simulation payer", sol >= need ? "ok" : "fail", `SIM_PAYER_PUBKEY holds ${sol.toFixed(2)} SOL${sol >= need ? "" : ": too little, every simulated buy will fail"}`);
        });
      } else if (!env.WALLET_KEYPAIR_PATH) {
        add("simulation payer", "warn", "neither SIM_PAYER_PUBKEY nor a wallet is set: every buy will be blocked at the sell simulation");
      }
    }
  }
  await check("Jupiter", async () => {
    const res = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(6_000) });
    const serverDate = Date.parse(res.headers.get("date") ?? "");
    const price = await jupiter.solUsd();
    add("Jupiter", "ok", `reachable, SOL is $${price.toFixed(2)}`);
    if (Number.isFinite(serverDate)) {
      const skew = Math.abs(Date.now() - serverDate) / 1000;
      add("clock", skew < 3 ? "ok" : "warn", skew < 3 ? "this machine's clock is within 3 s of the internet's" : `this machine's clock is off by about ${skew.toFixed(0)} s: post-age numbers will be wrong`);
    }
  });

  // ---------- X ----------
  if (!env.X_BEARER_TOKEN) {
    add("X", "fail", "X_BEARER_TOKEN isn't set: nothing can be watched");
  } else if (values["skip-x"]) {
    add("X", "skip", "skipped (--skip-x)");
  } else {
    const client = new XClient({ bearerToken: env.X_BEARER_TOKEN });
    const list = buildWatchList(config.accounts, target);
    await check("X accounts", async () => {
      await verifyWatchList(client, list, quiet);
      add("X accounts", "ok", `${list.length} handles still map to the configured IDs (${list.map((a) => "@" + a.handle).join(", ")})`);
    });
    await check("X Activity API", async () => {
      const subs = (await client.listActivitySubscriptions()).filter((s) => s.event_type === "post.create");
      const have = new Set(subs.map((s) => s.filter.user_id));
      const missing = list.filter((a) => !have.has(a.userId)).map((a) => a.handle);
      const extra = subs.filter((s) => s.tag?.startsWith(`${RULE_TAG}:`) && !list.some((a) => a.userId === s.filter.user_id)).map((s) => s.tag!.slice(RULE_TAG.length + 1));
      add("X Activity API", "ok", `${subs.length} subscriptions${missing.length ? `; ${missing.length} will be created at start (${missing.join(", ")})` : ""}${extra.length ? `; ${extra.join(", ")} will be removed at start` : ""}`);
    });
    await check("X Filtered Stream", async () => {
      const ours = (await client.getStreamRules()).filter((r) => r.tag === RULE_TAG);
      const match = ours.length === 1 && ours[0]!.value === streamRuleValue(list);
      add("X Filtered Stream", "ok", match ? "rule matches the watch list" : "rule will be created or replaced at start");
    });
  }

  // ---------- Kick / Twitch ----------
  const kick = buildKickWatchList(config.accounts);
  if (env.KICK_CLIENT_ID && env.KICK_CLIENT_SECRET) {
    await check("Kick", async () => {
      await verifyKickWatchList(new KickClient({ clientId: env.KICK_CLIENT_ID!, clientSecret: env.KICK_CLIENT_SECRET! }), kick, quiet);
      add("Kick", env.WEBHOOK_PUBLIC_URL ? "ok" : "warn", `keys work, ${kick.map((a) => a.slug).join(", ")} verified${env.WEBHOOK_PUBLIC_URL ? "" : ". WEBHOOK_PUBLIC_URL isn't set: Kick can't deliver events yet"}`);
    });
  } else add("Kick", "warn", "not configured: Adin's Kick chat and stream title aren't watched");
  const twitch = buildTwitchWatchList(config.accounts);
  if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
    await check("Twitch", async () => {
      await verifyTwitchWatchList(new TwitchClient({ clientId: env.TWITCH_CLIENT_ID!, clientSecret: env.TWITCH_CLIENT_SECRET! }), twitch, quiet);
      const ready = Boolean(env.WEBHOOK_PUBLIC_URL && env.TWITCH_EVENTSUB_SECRET);
      add("Twitch", ready ? "ok" : "warn", `keys work, ${twitch.map((a) => a.handle).join(", ")} verified${ready ? "" : ". Also needs WEBHOOK_PUBLIC_URL and TWITCH_EVENTSUB_SECRET"}`);
    });
  } else add("Twitch", "warn", "not configured: stream titles on Twitch aren't watched");

  // ---------- Telegram ----------
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT_ID) {
    await check("Telegram", async () => {
      const tg = new Telegram({ token: env.TELEGRAM_BOT_TOKEN!, ownerChatId: env.TELEGRAM_OWNER_CHAT_ID!, log: quiet });
      const name = await tg.whoAmI();
      if (values.notify) {
        const sent = await tg.send("Pre-flight test message from your sniper. If you can read this, alerts work.");
        add("Telegram", sent ? "ok" : "fail", sent ? `@${name} sent you a test message` : `@${name} is valid but the message didn't send: open the bot and press Start, and check TELEGRAM_OWNER_CHAT_ID`);
      } else add("Telegram", "ok", `@${name} is valid (add --notify to send yourself a test message)`);
    });
  } else {
    add("Telegram", target === "live" ? "fail" : "warn", "not configured: alerts only reach the terminal, and there's no /sell or /kill");
  }

  // ---------- tools ----------
  const tess = spawnSync("tesseract", ["--version"], { encoding: "utf8", timeout: 3_000 });
  add("image reading", tess.status === 0 ? "ok" : "warn", tess.status === 0 ? `${tess.stdout.split("\n")[0]}` : "tesseract isn't installed: an address posted only as a screenshot would be missed");
}

// ---------- report ----------
const mark: Record<Status, string> = { ok: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
console.log(`\nPre-flight for ${target}\n`);
for (const r of rows) console.log(`${mark[r.status]}  ${r.name.padEnd(18)} ${r.detail}`);
const fails = rows.filter((r) => r.status === "fail").length;
const warns = rows.filter((r) => r.status === "warn").length;
console.log(`\n${fails === 0 ? (warns === 0 ? "All clear." : `No failures, ${warns} warning(s).`) : `${fails} failure(s), ${warns} warning(s). Not ready for ${target}.`}\n`);
process.exit(fails === 0 ? 0 : 1);
