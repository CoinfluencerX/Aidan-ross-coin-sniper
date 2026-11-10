/**
 * Runs the validator against a real mint on mainnet, read-only, and prints every check.
 *
 *   node scripts/validate-mint.ts <mint> [--sol 0.01] [--no-sim]
 *
 * Uses RPC_HTTP_URL from .env. Without one it falls back to Solana's public endpoint, which is
 * slow and rate-limited but fine for a manual check. Nothing is bought, signed or sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";
import { RpcChainReader } from "../src/chain/facts.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { loadAppConfig, withTestAccounts } from "../src/config/load.ts";
import { openDb } from "../src/state/db.ts";
import { validate } from "../src/validate/validator.ts";
import type { AddressSignal } from "../src/watch/signal.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { sol: { type: "string" }, "no-sim": { type: "boolean" }, json: { type: "boolean" } } });
const mint = positionals[0];
if (!mint) {
  console.error("usage: node scripts/validate-mint.ts <mint> [--sol 0.01] [--no-sim]");
  process.exit(64);
}
const env = existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {};
const url = (env.RPC_HTTP_URL ?? "").trim() || "https://api.mainnet-beta.solana.com";
const usingPublic = !(env.RPC_HTTP_URL ?? "").trim();
// A stand-in author for the pretend post. No real account is involved.
const config = withTestAccounts(loadAppConfig("config"), [{ handle: "stand_in_test", user_id: "1" }]);
const sol = Number(values.sol ?? config.guardrails.buy.sol_per_buy);
const test = config.accounts.test_accounts.x.at(-1)!;

// A stand-in signal, as if the dry-run test account had just posted this address.
const now = Date.now();
const signal: AddressSignal = {
  mint,
  source: "x",
  path: "manual",
  postId: `manual-${now}`,
  postUrl: "(manual check)",
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

// The public endpoint is slow, so give the warn-only lookups more time here than the bot does.
const validator = { ...config.validator, checks: { ...config.validator.checks, ...(values["no-sim"] ? { sell_simulation: "off" as const } : {}) }, params: { ...config.validator.params, advisory_budget_ms: 6_000 } };
const rpc = new SolanaRpc({ url, timeoutMs: 10_000 });
const v = await validate(signal, BigInt(Math.round(sol * 1e9)), {
  config: validator,
  accounts: config.accounts,
  guardrails: config.guardrails,
  mode: "dry-run",
  chain: new RpcChainReader(rpc),
  db: openDb(":memory:"),
});

if (values.json) {
  console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
} else {
  const mark = { pass: "✓", warn: "!", block: "✗", off: "-" } as const;
  console.log(`\nmint     ${mint}`);
  console.log(`rpc      ${usingPublic ? "public endpoint (no RPC_HTTP_URL in .env)" : "RPC_HTTP_URL from .env"}`);
  console.log(`size     ${sol} SOL`);
  console.log(`token    ${v.token ? `${v.token.name} (${v.token.symbol})` : "(unknown)"} · ${v.mintFacts?.tokenProgram ?? "not a token"}`);
  console.log(`market   ${v.market ? `${v.market.venue}: ${v.market.detail}` : "(not read)"}`);
  for (const group of ["source", "address", "sellability", "market"] as const) {
    console.log(`\n${group}`);
    for (const o of v.outcomes.filter((x) => x.group === group)) console.log(`  ${mark[o.result]} ${o.id.padEnd(24)} ${o.detail}`);
  }
  console.log(`\nVERDICT  ${v.decision === "buy" ? "PASS" : "BLOCKED"} in ${v.elapsedMs} ms${v.blocks.length ? ` · blocked by ${v.blocks.map((b) => b.id).join(", ")}` : ""}${v.warns.length ? ` · ${v.warns.length} warning(s)` : ""}\n`);
}
