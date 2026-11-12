import { parseArgs } from "node:util";
import { SolanaRpc } from "../chain/rpc.ts";
import { collectSecretValues, EnvError, parseEnv } from "../config/env.ts";
import { LiveSender } from "../exec/send.ts";
import { loadWalletSigner, WalletError } from "../exec/wallet.ts";
import { buildWithdrawTx, formatSol, planWithdrawal } from "../exec/withdraw.ts";
import { base58Encode } from "../extract/base58.ts";
import type { FetchFn } from "../extract/expand.ts";
import { createRedactor } from "../log/redact.ts";

/**
 * The withdraw command. The OWNER runs it; nothing else in the bot ever calls it.
 *
 * - Without --send it only previews: it reads the chain, simulates the transfer, and sends nothing.
 * - With --send it still needs a person at a real terminal who types the last four characters of
 *   the destination. A script, a pipe or an agent can't supply that, so it can't send by accident.
 * - The transaction is signed only after that confirmation, and is sent exactly once.
 */

export interface WithdrawCli {
  argv: string[];
  /** .env merged with the real environment. */
  env: Record<string, string | undefined>;
  repoRoot: string;
  /** True only when a person is at an interactive terminal. */
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  write: (line: string) => void;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

const USAGE = `usage: node scripts/withdraw.ts [destination address] (--sol <amount> | --all) [--send]
  Sends SOL from the bot wallet to an address you choose. Without --send it only previews.
  If no address is given, WITHDRAW_ADDRESS from .env is used.`;

export async function runWithdraw(o: WithdrawCli): Promise<number> {
  const redactor = createRedactor(collectSecretValues(o.env));
  const out = (line = "") => o.write(redactor.redactString(line));

  let args: ReturnType<typeof parse>;
  try {
    args = parse(o.argv);
  } catch (err) {
    out(`${(err as Error).message}\n${USAGE}`);
    return 64;
  }
  if (args.help) return out(USAGE), 0;

  let env;
  try {
    env = parseEnv(o.env);
  } catch (err) {
    out((err as EnvError).message);
    return 78;
  }
  const to = args.destination ?? env.WITHDRAW_ADDRESS;
  if (!to) return out(`No destination: give an address, or set WITHDRAW_ADDRESS in .env.\n${USAGE}`), 64;
  if (args.amount === undefined) return out(`Say how much: --sol <amount> or --all.\n${USAGE}`), 64;
  if (!env.RPC_HTTP_URL) return out("RPC_HTTP_URL isn't set in .env."), 78;
  if (!env.WALLET_KEYPAIR_PATH) return out("WALLET_KEYPAIR_PATH isn't set in .env, so there is no bot wallet to withdraw from."), 78;

  let signer;
  try {
    signer = loadWalletSigner(env.WALLET_KEYPAIR_PATH, redactor, o.repoRoot);
  } catch (err) {
    if (err instanceof WalletError) return out(`Can't load the bot wallet: ${err.message}`), 78;
    throw err;
  }

  const rpc = new SolanaRpc({ url: env.RPC_HTTP_URL, ...(o.fetch ? { fetch: o.fetch } : {}), timeoutMs: 15_000 });
  let plan;
  try {
    plan = await planWithdrawal({ rpc, from: signer.publicKey, to, amount: args.amount });
  } catch (err) {
    return out(`Couldn't read the chain: ${(err as Error).message}`), 1;
  }

  out("Withdraw from the bot wallet");
  out();
  out(`  From         ${plan.from}`);
  out(`               holds ${formatSol(plan.balanceBefore)} SOL`);
  out(`  To           ${plan.to}${args.destination ? "" : "   (WITHDRAW_ADDRESS from .env)"}`);
  if (plan.problems.length > 0) {
    out();
    out("Not possible:");
    for (const p of plan.problems) out(`  x ${p}`);
    out();
    out("Nothing was sent.");
    return 1;
  }
  out(`  Amount       ${formatSol(plan.lamports)} SOL`);
  out(`  Network fee  ${formatSol(plan.feeLamports)} SOL`);
  out(`  Left after   ${formatSol(plan.balanceAfter)} SOL`);
  for (const w of plan.warnings) out(`  ! ${w}`);
  out();

  // Dress rehearsal on the node: unsigned, and nothing lands on chain.
  try {
    const { blockhash } = await rpc.getLatestBlockhash();
    const sim = await rpc.simulate(Buffer.from(buildWithdrawTx(plan.from, plan.to, plan.lamports, blockhash).serialize()).toString("base64"));
    if (sim.err) return out(`The network's test run of this transfer failed (${JSON.stringify(sim.err).slice(0, 120)}). Nothing was sent.`), 1;
  } catch (err) {
    return out(`Couldn't test the transfer: ${(err as Error).message}. Nothing was sent.`), 1;
  }
  out("Test run on the network: OK.");

  if (!args.send) {
    out("PREVIEW ONLY. Nothing was sent. Run it again with --send to do it for real.");
    return 0;
  }
  if (!o.isTTY) {
    out("Not sending: --send only works when a person runs this in a terminal. Nothing was sent.");
    return 1;
  }
  const typed = (await o.ask(`This sends real money and can't be undone. Type the LAST 4 characters of the destination address to confirm: `)).trim();
  if (typed !== plan.to.slice(-4)) {
    out("That doesn't match. Cancelled: nothing was sent.");
    return 1;
  }

  // Signed only now, with a fresh blockhash, and sent once.
  const { blockhash } = await rpc.getLatestBlockhash();
  const tx = buildWithdrawTx(plan.from, plan.to, plan.lamports, blockhash);
  signer.sign(tx);
  const signature = base58Encode(tx.signatures[0]!);
  const sender = new LiveSender({ rpc, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
  try {
    await sender.send(Buffer.from(tx.serialize()).toString("base64"));
  } catch (err) {
    out(`The send failed: ${(err as Error).message}`);
    out(`It may still have gone out. Check before trying again: https://solscan.io/tx/${signature}`);
    return 2;
  }
  out(`Sent. Transaction: ${signature}`);
  const result = await sender.confirm(signature, 60_000);
  if (result.status === "confirmed") {
    out(`Confirmed. ${formatSol(plan.lamports)} SOL is now at ${plan.to}.`);
    return 0;
  }
  if (result.status === "failed") {
    out("The network rejected it. Nothing moved (the small fee may have been charged).");
    return 1;
  }
  out(`Not confirmed after a minute. Do NOT run this again yet: check https://solscan.io/tx/${signature} first.`);
  return 2;
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { sol: { type: "string" }, all: { type: "boolean" }, send: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (positionals.length > 1) throw new Error("Give one destination address at most.");
  if (values.sol !== undefined && values.all) throw new Error("Use --sol or --all, not both.");
  let amount: bigint | "all" | undefined;
  if (values.all) amount = "all";
  else if (values.sol !== undefined) {
    if (!/^\d+(\.\d{1,9})?$/.test(values.sol)) throw new Error("--sol must be a plain number like 0.5 (up to 9 decimals).");
    const [whole, frac = ""] = values.sol.split(".");
    amount = BigInt(whole!) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
  }
  return { destination: positionals[0], amount, send: values.send === true, help: values.help === true };
}
