import { web3, type Web3Module } from "../chain/sdk.ts";

/**
 * Jito tips. A tip is a plain SOL transfer to one of Jito's tip accounts, placed in the same
 * transaction as the trade. Validators running Jito's software order transactions by tip, so a
 * tipped buy is more likely to land early when the network is jammed.
 *
 * Because the tip rides inside the trade's own transaction, it is only paid if the trade lands.
 * It is paid whichever path lands the transaction, including the plain RPC path.
 */

/**
 * Jito's mainnet tip accounts. Source: docs.jito.wtf (low latency transaction send) and the block
 * engine's own getTipAccounts call, which returned this same list on 2026-11-10. Jito's docs say
 * the list does not change. Never load these from an address lookup table.
 */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

/** Jito ignores tips below this. */
export const JITO_MIN_TIP_LAMPORTS = 1_000;

export type TipInstruction = (payer: Web3Module.PublicKey) => Web3Module.TransactionInstruction;

/**
 * Returns a function that makes the tip instruction, or undefined when the amount is too small to
 * count (so "0" in guardrails.yaml means no tip). The account is picked at random per transaction,
 * as Jito recommends, to spread load.
 */
export function jitoTipInstruction(lamports: number, pick: () => number = Math.random): TipInstruction | undefined {
  if (!Number.isSafeInteger(lamports) || lamports < JITO_MIN_TIP_LAMPORTS) return undefined;
  return (payer) => {
    const index = Math.min(JITO_TIP_ACCOUNTS.length - 1, Math.max(0, Math.floor(pick() * JITO_TIP_ACCOUNTS.length)));
    return web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: new web3.PublicKey(JITO_TIP_ACCOUNTS[index]!), lamports });
  };
}
