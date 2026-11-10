/**
 * Ethereum-style (EVM) addresses: "0x" + 40 hex characters. The same address format is used on
 * Ethereum, Base and every other EVM chain, so the address alone doesn't say which chain it's on.
 *
 * The bot NEVER buys these. It only alerts, so the owner can buy by hand. See src/watch/pipeline.ts.
 */

/** 0x + exactly 40 hex chars. Longer hex runs (transaction hashes are 64) don't match. */
export const EVM_ADDRESS = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** Addresses that show up in posts and links but are never the coin. Lowercase. */
export const IGNORED_EVM: Record<string, string> = {
  "0x0000000000000000000000000000000000000000": "zero address",
  "0x000000000000000000000000000000000000dead": "burn address",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": "native ETH placeholder",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH (Ethereum)",
  "0x4200000000000000000000000000000000000006": "WETH (Base)",
};

/** Every distinct EVM address in `text`, lowercased, in order of first appearance. */
export function evmAddressesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EVM_ADDRESS)) {
    const a = m[0].toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** OCR often breaks a long address with a space or newline. Joins "0x…" with the hex fragments that follow it. */
export function evmFromOcrText(text: string): string[] {
  const out = evmAddressesIn(text);
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!/^0x[0-9a-fA-F]*$/.test(tokens[i]!)) continue;
    let joined = tokens[i]!;
    for (let j = i + 1; j < tokens.length && j < i + 4 && joined.length < 42; j++) {
      if (!/^[0-9a-fA-F]+$/.test(tokens[j]!)) break;
      joined += tokens[j];
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(joined) && !out.includes(joined.toLowerCase())) out.push(joined.toLowerCase());
  }
  return out;
}
