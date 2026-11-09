/** Bitcoin/Solana base58 alphabet (no 0, O, I, l). */
export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CHAR = "[1-9A-HJ-NP-Za-km-z]";

/** A run of 32–44 base58 chars that isn't part of a longer base58 run. */
export const ADDRESS_CANDIDATE = new RegExp(`(?<!${CHAR})${CHAR}{32,44}(?!${CHAR})`, "g");

const INDEX = new Map([...BASE58_ALPHABET].map((c, i) => [c, BigInt(i)]));

/** Decodes base58, or returns null on any non-alphabet character. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** True when `s` is base58 that decodes to exactly 32 bytes, the size of a Solana public key. */
export function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return base58Decode(s)?.length === 32;
}
