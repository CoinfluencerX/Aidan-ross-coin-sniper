/**
 * Creates the bot's wallet. YOU run this, once:
 *
 *   node scripts/new-wallet.ts                 -> ~/sniper-wallet.json
 *   node scripts/new-wallet.ts /some/path.json -> a path you choose (outside this repo)
 *
 * It writes the key file so only your user can read it and prints the PUBLIC address.
 * It never prints the private key, never overwrites a file, and never touches the network.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletFile, WalletError } from "../src/exec/wallet.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.log("usage: node scripts/new-wallet.ts [path outside the repo]   (default: ~/sniper-wallet.json)");
  process.exit(0);
}
const expanded = arg?.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
const path = expanded ? (isAbsolute(expanded) ? expanded : resolve(expanded)) : join(homedir(), "sniper-wallet.json");

try {
  const wallet = createWalletFile(path, repoRoot);
  console.log(`
New bot wallet created.

  Public address   ${wallet.publicKey}
                   Safe to share. This is where you send SOL to fund the bot.

  Key file         ${wallet.path}
                   NEVER share it, show it on screen, or put it in the repo.

Put this line in .env:

  WALLET_KEYPAIR_PATH=${wallet.path}

This file IS the wallet. There is no seed phrase and no way to recover it:
if the file is lost, whatever it holds is lost. Keep one offline copy (a USB drive),
and only ever fund it with what you're fine losing.
`);
} catch (err) {
  if (err instanceof WalletError) {
    console.error(`Not created: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
