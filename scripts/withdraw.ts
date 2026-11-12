/**
 * Moves SOL out of the bot wallet to an address you choose. YOU run this; the bot never does.
 *
 *   node scripts/withdraw.ts <address> --sol 0.5          preview only, sends nothing
 *   node scripts/withdraw.ts <address> --sol 0.5 --send   sends, after you type the last 4 characters
 *   node scripts/withdraw.ts --all --send                 everything, to WITHDRAW_ADDRESS from .env
 *
 * It refuses addresses that aren't wallets, amounts the wallet can't cover, and "--all" while the
 * wallet still holds coins. It never prints the private key.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv as parseDotenv } from "node:util";
import { runWithdraw } from "../src/app/withdraw-cli.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const envPath = join(repoRoot, ".env");
const fileVars = existsSync(envPath) ? (parseDotenv(readFileSync(envPath, "utf8")) as Record<string, string>) : {};

process.exitCode = await runWithdraw({
  argv: process.argv.slice(2),
  env: { ...fileVars, ...process.env },
  repoRoot,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  write: (line) => console.log(line),
});
