import { createRequire } from "node:module";
import type * as PumpSdkModule from "@pump-fun/pump-sdk";
import type * as PumpSwapModule from "@pump-fun/pump-sdk/swap";
import type * as SplTokenModule from "@solana/spl-token";
import type * as Web3Module from "@solana/web3.js";

/**
 * The official pump.fun SDK and the Solana libraries it builds on.
 *
 * They are loaded through `require` on purpose: the SDK's ESM build doesn't load under plain
 * Node (one of its own dependencies imports a CommonJS module by named export), while its
 * CommonJS build works. Loading everything the same way also guarantees a single copy of
 * @solana/web3.js, so a PublicKey made here is the class the SDK expects.
 */
const require = createRequire(import.meta.url);

function load() {
  // One dependency (bigint-buffer) prints a notice when its optional native add-on isn't built.
  // We don't build it on purpose (npm install --ignore-scripts), and its pure-JS path is fine,
  // so drop that one line instead of letting it land in the middle of the bot's output.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("bigint: Failed to load bindings")) return;
    warn(...args);
  };
  try {
    return {
      web3: require("@solana/web3.js") as typeof Web3Module,
      pump: require("@pump-fun/pump-sdk") as typeof PumpSdkModule,
      pumpSwap: require("@pump-fun/pump-sdk/swap") as typeof PumpSwapModule,
      splToken: require("@solana/spl-token") as typeof SplTokenModule,
    };
  } finally {
    console.warn = warn;
  }
}

export const { web3, pump, pumpSwap, splToken } = load();

export type { PumpSdkModule, PumpSwapModule, Web3Module };

export { PROGRAMS } from "./programs.ts";
