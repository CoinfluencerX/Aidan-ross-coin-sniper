import { describe, expect, it } from "vitest";
import { createRedactor, isSensitiveKey, REDACTED } from "../src/log/redact.ts";

const PUBKEY = "Ce8nnx1XqLBEE6ChG44xEwcSsK6PS2uv4NX9B7bYpump"; // 44 chars
const SIGNATURE = "5" + "J".repeat(87); // 88 chars, the same shape as a base58 secret key

describe("isSensitiveKey", () => {
  it.each(["privateKey", "secret_key", "X_BEARER_TOKEN", "TELEGRAM_BOT_TOKEN", "GRPC_TOKEN", "apiKey", "api-key", "password", "seed", "seedPhrase", "mnemonic", "Authorization", "cookie", "keypair", "token", "accessToken", "KICK_CLIENT_SECRET"])(
    "%s is sensitive",
    (k) => expect(isSensitiveKey(k)).toBe(true),
  );

  it.each(["token_amount", "tokenMint", "outputToken", "mint", "signature", "wallet", "user_id", "lamports", "seeded_at_block"])(
    "%s is not sensitive (trade data must stay visible)",
    (k) => expect(isSensitiveKey(k)).toBe(false),
  );
});

describe("createRedactor", () => {
  it("redacts sensitive keys at any depth", () => {
    const r = createRedactor();
    expect(r.redact({ a: { privateKey: "abc", deeper: [{ botToken: "xyz" }] }, apiKey: 42 })).toEqual({
      a: { privateKey: REDACTED, deeper: [{ botToken: REDACTED }] },
      apiKey: REDACTED,
    });
  });

  it("keeps booleans and nulls under sensitive keys so 'is it configured?' stays readable", () => {
    const r = createRedactor();
    expect(r.redact({ X_BEARER_TOKEN: true, GRPC_TOKEN: null })).toEqual({ X_BEARER_TOKEN: true, GRPC_TOKEN: null });
  });

  it("keeps trade data visible: mints, signatures, token amounts", () => {
    const r = createRedactor();
    const trade = { mint: PUBKEY, signature: SIGNATURE, token_amount: "1000000", tokenMint: PUBKEY };
    expect(r.redact(trade)).toEqual(trade);
  });

  it("cuts registered secret values out of any string", () => {
    const r = createRedactor(["SUPERSECRETVALUE123"]);
    expect(r.redactString("calling https://rpc.example.com/SUPERSECRETVALUE123/x")).toBe(
      `calling https://rpc.example.com/${REDACTED}/x`,
    );
  });

  it("removes a longer secret whole even when it contains a shorter one", () => {
    const r = createRedactor(["abcdefgh", "abcdefgh-ijklmnop"]);
    expect(r.redactString("x abcdefgh-ijklmnop y")).toBe(`x ${REDACTED} y`);
  });

  it("ignores very short 'secrets' so it can't wipe ordinary text", () => {
    const r = createRedactor(["1", "abc"]);
    expect(r.redactString("abc 1 2 3")).toBe("abc 1 2 3");
  });

  it("supports adding a secret later (the wallet key in M3)", () => {
    const r = createRedactor();
    const fakeWalletKey = "4" + "k".repeat(87);
    expect(r.redactString(`key=${fakeWalletKey}`)).toContain(fakeWalletKey);
    r.addSecret(fakeWalletKey);
    expect(r.redactString(`loaded ${fakeWalletKey}`)).toBe(`loaded ${REDACTED}`);
  });

  it("redacts api-key style URL params and Bearer headers", () => {
    const r = createRedactor();
    expect(r.redactString("https://mainnet.helius-rpc.com/?api-key=abcd-1234&cluster=x")).toBe(
      `https://mainnet.helius-rpc.com/?api-key=${REDACTED}&cluster=x`,
    );
    expect(r.redactString("Authorization: Bearer AAAA.bbb-ccc")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("redacts 64-byte keypair arrays, typed arrays and JSON byte strings", () => {
    const r = createRedactor();
    const bytes = Array.from({ length: 64 }, (_, i) => i);
    expect(r.redact({ wallet: bytes })).toEqual({ wallet: "[REDACTED:keypair-bytes]" });
    expect(r.redact(new Uint8Array(64))).toBe("[REDACTED:keypair-bytes]");
    expect(r.redactString(`file was ${JSON.stringify(bytes)}`)).toBe("file was [REDACTED:keypair-bytes]");
  });

  it("leaves 32-byte arrays (public keys) alone", () => {
    const r = createRedactor();
    const pubkeyBytes = Array.from({ length: 32 }, () => 9);
    expect(r.redact(pubkeyBytes)).toEqual(pubkeyBytes);
  });

  it("redacts inside Error messages and stacks", () => {
    const r = createRedactor(["SUPERSECRETVALUE123"]);
    const out = r.redact(new Error("fetch failed for SUPERSECRETVALUE123")) as Record<string, string>;
    expect(out.message).toBe(`fetch failed for ${REDACTED}`);
    expect(out.stack).not.toContain("SUPERSECRETVALUE123");
  });

  it("survives circular references", () => {
    const r = createRedactor();
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(r.redact(a)).toEqual({ name: "a", self: "[Circular]" });
  });
});
