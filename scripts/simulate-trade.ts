/**
 * Dry-run rehearsal for one mint on mainnet: validate it, simulate a buy, then quote a sell.
 *
 *   node scripts/simulate-trade.ts <mint> --payer <public address with SOL> [--sol 0.01]
 *
 * Read-only. The executor is built in dry-run mode, which has no sender, so nothing can reach
 * the chain. The payer is only a PUBLIC address used inside the simulation; no key is involved.
 * Uses RPC_HTTP_URL from .env, or Solana's public endpoint (slow, rate-limited) without one.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { formatUnits } from "../src/app/engine.ts";
import { RpcChainReader } from "../src/chain/facts.ts";
import { JupiterClient, jupiterRouteCheck } from "../src/chain/jupiter.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { loadAppConfig, withTestAccounts } from "../src/config/load.ts";
import { SdkTradeBuilder } from "../src/exec/builder.ts";
import { Executor } from "../src/exec/executor.ts";
import { ephemeralSigner } from "../src/exec/wallet.ts";
import { createLogger } from "../src/log/logger.ts";
import { openDb } from "../src/state/db.ts";
import { validate } from "../src/validate/validator.ts";
import type { AddressSignal } from "../src/watch/signal.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { payer: { type: "string" }, sol: { type: "string" } } });
const mint = positionals[0];
const env = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const payer = values.payer ?? (env.SIM_PAYER_PUBKEY ?? "").trim();
if (!mint || !payer) {
  console.error("usage: node scripts/simulate-trade.ts <mint> --payer <public address with SOL> [--sol 0.01]");
  process.exit(64);
}
const url = (env.RPC_HTTP_URL ?? "").trim() || "https://api.mainnet-beta.solana.com";
// A stand-in author for the pretend post. No real account is involved.
const config = withTestAccounts(loadAppConfig("config"), [{ handle: "stand_in_test", user_id: "1" }]);
const sol = Number(values.sol ?? config.guardrails.buy.sol_per_buy);
const lamportsIn = BigInt(Math.round(sol * 1e9));
const test = config.accounts.test_accounts.x.at(-1)!;
const db = openDb(":memory:");
const log = createLogger({ level: "error", write: (l) => console.error(l) });
const rpc = new SolanaRpc({ url, timeoutMs: 15_000 });
const chain = new RpcChainReader(rpc);
const jupiter = new JupiterClient();
const guardrails = { ...config.guardrails, buy: { ...config.guardrails.buy, sol_per_buy: sol } };
const executor = new Executor({
  mode: "dry-run",
  rpc,
  chain,
  builder: new SdkTradeBuilder({ rpcUrl: url, jupiter, priorityMicroLamports: guardrails.buy.priority_fee_micro_lamports }),
  signer: ephemeralSigner(),
  simPayer: payer,
  guardrails,
  db,
  log,
});

const now = Date.now();
const signal: AddressSignal = {
  mint,
  source: "x",
  path: "manual",
  postId: `manual-${now}`,
  postUrl: "(manual rehearsal)",
  accountId: test.user_id,
  account: { userId: test.user_id, handle: test.handle, person: "test", tier: 1, isTest: true },
  postKind: "original",
  referencesWatchedAuthor: false,
  origins: [{ kind: "text" }],
  mintsInPost: 1,
  warningKeywords: [],
  blockedMintNote: undefined,
  postText: "",
  postCreatedAt: new Date(now).toISOString(),
  receivedAt: now,
};
const signalId = Number(db.prepare("INSERT INTO signals (source, account_id, post_id, mint, received_at) VALUES ('x', ?, ?, ?, ?)").run(test.user_id, signal.postId, mint, now).lastInsertRowid);

console.log(`\nmint   ${mint}\nsize   ${sol} SOL   simulated as ${payer}\nrpc    ${url.includes("mainnet-beta") ? "public endpoint" : "RPC_HTTP_URL from .env"}`);
const t0 = performance.now();
const verdict = await validate(signal, lamportsIn, {
  config: { ...config.validator, params: { ...config.validator.params, advisory_budget_ms: 3_000 } },
  accounts: config.accounts,
  guardrails,
  mode: "dry-run",
  chain,
  db,
  simulateRoundTrip: executor.simulateRoundTrip,
  jupiterRoute: jupiterRouteCheck(jupiter, guardrails.buy.max_slippage_bps),
});
const validateMs = Math.round(performance.now() - t0);
console.log(`\ntoken  ${verdict.token ? `${verdict.token.name} (${verdict.token.symbol})` : "(unknown)"} · ${verdict.market?.venue ?? "?"}: ${verdict.market?.detail ?? ""}`);
for (const o of verdict.outcomes.filter((x) => x.result !== "pass")) console.log(`  ${o.result === "block" ? "✗" : o.result === "warn" ? "!" : "-"} ${o.id}: ${o.detail}`);
console.log(`  sell_simulation: ${verdict.outcomes.find((o) => o.id === "sell_simulation")?.detail}`);
console.log(`VALIDATOR ${verdict.decision === "buy" ? "PASS" : "BLOCKED"} in ${validateMs} ms`);
if (verdict.decision !== "buy" || !verdict.mintFacts || !verdict.market) process.exit(verdict.decision === "buy" ? 0 : 2);

const buy = await executor.buy({ mint, signalId, source: "x", postId: signal.postId, lamportsIn, mintFacts: verdict.mintFacts, market: verdict.market });
if (buy.status !== "simulated") {
  console.log(`BUY ${buy.status.toUpperCase()}: ${"error" in buy ? buy.error : "reason" in buy ? buy.reason : ""}`);
  process.exit(3);
}
const decimals = verdict.mintFacts.decimals ?? 6;
console.log(`BUY SIMULATED: ${sol} SOL -> ${formatUnits(buy.tokens, decimals)} tokens via ${buy.variant} (${buy.units ?? "?"} compute units)`);
console.log(`  build + sign ${buy.signedMs} ms · signal -> signed tx ${validateMs + buy.signedMs} ms · with simulation ${validateMs + buy.totalMs} ms`);

const sell = await executor.sell(buy.positionId, "all", "rehearsal");
if (sell.status === "failed") console.log(`SELL QUOTE FAILED: ${sell.error}`);
else console.log(`SELL QUOTED (paper): ${formatUnits(sell.tokensSold, decimals)} tokens -> ${(Number(sell.lamportsOut) / 1e9).toFixed(6)} SOL via ${sell.variant}  (round trip keeps ${((Number(sell.lamportsOut) / Number(lamportsIn)) * 100).toFixed(1)}% after fees and price impact)`);
console.log(`\nNothing was sent. Rows written to an in-memory database only.\n`);
