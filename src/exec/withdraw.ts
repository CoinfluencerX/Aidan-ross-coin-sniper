import type { SolanaRpc } from "../chain/rpc.ts";
import { PROGRAMS, web3, type Web3Module } from "../chain/sdk.ts";

/**
 * Moving SOL out of the bot wallet to an address the owner chooses. This file only works out
 * whether a withdrawal is safe and builds the transfer; it never signs or sends anything.
 * The owner runs it through scripts/withdraw.ts, which previews by default.
 */

/** Solana's fee for a transaction with one signature. */
export const TRANSFER_FEE_LAMPORTS = 5_000n;
/** The least a plain Solana account may hold. Below this (and above zero) the network rejects the transfer. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** Roughly what a sell costs in fees and tips. Used only to warn. */
const SELL_FEE_CUSHION_LAMPORTS = 20_000_000n;

export interface WithdrawPlan {
  from: string;
  to: string;
  lamports: bigint;
  feeLamports: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  destinationIsNew: boolean;
  holdsCoins: boolean;
  /** Reasons this withdrawal must not go ahead. Empty = fine. */
  problems: string[];
  /** Things the owner should look at before confirming. */
  warnings: string[];
}

/** Lamports as SOL, exact to the last lamport (no rounding: this is shown before real money moves). */
function sol(lamports: bigint): string {
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${abs / 1_000_000_000n}${frac ? `.${frac}` : ""}`;
}

/** Why an address can't receive a withdrawal, or null if it looks like a wallet address. No network call. */
export function addressProblem(to: string, from: string): string | null {
  let key: Web3Module.PublicKey;
  try {
    key = new web3.PublicKey(to);
  } catch {
    return "that isn't a valid Solana address";
  }
  if (key.toBase58() !== to) return "that isn't a valid Solana address";
  if (to === from) return "that is the bot wallet's own address";
  if (!web3.PublicKey.isOnCurve(key.toBytes())) return "that address belongs to a program, not a wallet: SOL sent there can't be recovered";
  return null;
}

async function holdsAnyCoins(rpc: SolanaRpc, owner: string): Promise<boolean> {
  for (const programId of [PROGRAMS.splToken, PROGRAMS.token2022]) {
    const r = await rpc.call<{ value: { account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[] }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (r.value.some((a) => BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? "0") > 0n)) return true;
  }
  return false;
}

/** Reads the chain and decides whether sending `amount` from `from` to `to` is safe. Read-only. */
export async function planWithdrawal(o: { rpc: SolanaRpc; from: string; to: string; amount: bigint | "all" }): Promise<WithdrawPlan> {
  const plan: WithdrawPlan = { from: o.from, to: o.to, lamports: 0n, feeLamports: TRANSFER_FEE_LAMPORTS, balanceBefore: 0n, balanceAfter: 0n, destinationIsNew: false, holdsCoins: false, problems: [], warnings: [] };
  const bad = addressProblem(o.to, o.from);
  if (bad) {
    plan.problems.push(bad);
    return plan;
  }
  const [balance, destination, holdsCoins] = await Promise.all([o.rpc.getBalance(o.from), o.rpc.getParsedAccount(o.to), holdsAnyCoins(o.rpc, o.from)]);
  plan.balanceBefore = BigInt(balance);
  plan.holdsCoins = holdsCoins;
  plan.destinationIsNew = destination === null || destination.lamports === 0;
  if (destination && (destination.executable || destination.owner !== PROGRAMS.system)) {
    plan.problems.push("that address is a program, token or coin account, not a wallet: SOL sent there can't be recovered");
  }

  plan.lamports = o.amount === "all" ? plan.balanceBefore - TRANSFER_FEE_LAMPORTS : o.amount;
  plan.balanceAfter = plan.balanceBefore - TRANSFER_FEE_LAMPORTS - plan.lamports;
  if (plan.lamports <= 0n) {
    plan.problems.push(o.amount === "all" ? "the bot wallet doesn't hold enough SOL to cover the network fee" : "the amount must be more than zero");
    return plan;
  }
  if (plan.balanceAfter < 0n) plan.problems.push(`the bot wallet holds ${sol(plan.balanceBefore)} SOL, which is less than the amount plus the ${sol(TRANSFER_FEE_LAMPORTS)} SOL fee`);
  else if (plan.balanceAfter > 0n && plan.balanceAfter < RENT_EXEMPT_MIN_LAMPORTS) {
    plan.problems.push(`that would leave ${sol(plan.balanceAfter)} SOL, below the ${sol(RENT_EXEMPT_MIN_LAMPORTS)} SOL a Solana account must keep: withdraw less, or use --all`);
  }
  if (plan.destinationIsNew && plan.lamports < RENT_EXEMPT_MIN_LAMPORTS) plan.problems.push(`an address that has never been used must receive at least ${sol(RENT_EXEMPT_MIN_LAMPORTS)} SOL`);
  if (holdsCoins && o.amount === "all") plan.problems.push("the bot wallet still holds coins, and selling them needs SOL for fees: sell first, or withdraw an amount and leave some SOL behind");
  else if (holdsCoins && plan.balanceAfter >= 0n && plan.balanceAfter < SELL_FEE_CUSHION_LAMPORTS) plan.warnings.push(`the bot wallet still holds coins, and only ${sol(plan.balanceAfter)} SOL would be left to pay for selling them`);
  if (plan.destinationIsNew) plan.warnings.push("the destination has never been used before. Check every character of it");
  return plan;
}

/** The whole withdrawal: one SOL transfer, unsigned. */
export function buildWithdrawTx(from: string, to: string, lamports: bigint, blockhash: string): Web3Module.VersionedTransaction {
  const payer = new web3.PublicKey(from);
  const ix = web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: new web3.PublicKey(to), lamports });
  return new web3.VersionedTransaction(new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
}

export const formatSol = sol;
