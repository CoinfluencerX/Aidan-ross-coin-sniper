import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { web3, type Web3Module } from "../chain/sdk.ts";
import { base58Encode } from "../extract/base58.ts";
import type { Redactor } from "../log/redact.ts";

/**
 * Signing keys. The private key never leaves this file: callers get a public key and a
 * `sign` function, nothing else. It is registered with the redactor before anything can log it.
 */

export interface Signer {
  /** Base58 public key. Safe to log. */
  publicKey: string;
  /** True for a throwaway key made in memory (dry-run timing only). It holds no funds and is never saved. */
  ephemeral: boolean;
  sign(tx: Web3Module.VersionedTransaction): void;
}

export class WalletError extends Error {
  override name = "WalletError";
}

function signerFrom(keypair: Web3Module.Keypair, ephemeral: boolean): Signer {
  return { publicKey: keypair.publicKey.toBase58(), ephemeral, sign: (tx) => tx.sign([keypair]) };
}

/** A random in-memory key. Used in dry-run when no wallet is configured, only to time the signing step. */
export function ephemeralSigner(): Signer {
  return signerFrom(web3.Keypair.generate(), true);
}

/**
 * Loads the bot wallet from the file the owner created with `solana-keygen` (a JSON array of 64 bytes).
 * Refuses a key file that sits inside the repo or that other users on the machine can read.
 * Error messages never include the file's contents.
 */
export function loadWalletSigner(path: string, redactor: Redactor, repoRoot: string): Signer {
  if (!isAbsolute(path)) throw new WalletError("WALLET_KEYPAIR_PATH must be an absolute path");
  const rel = relative(resolve(repoRoot), resolve(path));
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new WalletError("the wallet key file is inside the repo: move it outside (e.g. your home folder)");
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new WalletError("the wallet key file doesn't exist or can't be read");
  }
  if ((mode & 0o077) !== 0) throw new WalletError(`the wallet key file is readable by other users (mode ${mode.toString(8)}): run chmod 600 on it`);
  let bytes: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("shape");
    bytes = Uint8Array.from(parsed as number[]);
  } catch {
    throw new WalletError("the wallet key file isn't a solana-keygen keypair (a JSON array of 64 numbers)");
  }
  // Register every form the key could be printed in, before the Keypair exists.
  redactor.addSecret(base58Encode(bytes));
  redactor.addSecret(base58Encode(bytes.subarray(0, 32)));
  redactor.addSecret(Buffer.from(bytes).toString("hex"));
  redactor.addSecret(Buffer.from(bytes).toString("base64"));
  let keypair: Web3Module.Keypair;
  try {
    keypair = web3.Keypair.fromSecretKey(bytes);
  } catch {
    throw new WalletError("the wallet key file holds an invalid keypair");
  }
  return signerFrom(keypair, false);
}
