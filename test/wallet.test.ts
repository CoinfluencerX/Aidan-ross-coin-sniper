import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWalletFile, loadWalletSigner, WalletError } from "../src/exec/wallet.ts";
import { base58Encode } from "../src/extract/base58.ts";
import { createRedactor } from "../src/log/redact.ts";
import { REPO_ROOT, tempDir } from "./helpers.ts";

/** Every way the private key could show up in text. */
function secretForms(path: string): string[] {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  return [
    base58Encode(bytes),
    base58Encode(bytes.subarray(0, 32)),
    Buffer.from(bytes).toString("hex"),
    Buffer.from(bytes).toString("base64"),
    JSON.stringify(Array.from(bytes)),
    Array.from(bytes).join(", "),
  ];
}

describe("creating the bot wallet (throwaway keys in a temp folder)", () => {
  it("writes a 64-number key file only the owner can read, and returns the public address", () => {
    const path = join(tempDir(), "wallet.json");
    const made = createWalletFile(path, REPO_ROOT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as number[];
    expect(parsed).toHaveLength(64);
    expect(made.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // The bot can load what the script made, and gets the same address.
    expect(loadWalletSigner(path, createRedactor([]), REPO_ROOT).publicKey).toBe(made.publicKey);
    // Nothing returned carries the key.
    for (const form of secretForms(path)) expect(JSON.stringify(made)).not.toContain(form);
  });

  it("makes a different wallet every time", () => {
    const dir = tempDir();
    expect(createWalletFile(join(dir, "a.json"), REPO_ROOT).publicKey).not.toBe(createWalletFile(join(dir, "b.json"), REPO_ROOT).publicKey);
  });

  it("never overwrites an existing file", () => {
    const path = join(tempDir(), "wallet.json");
    createWalletFile(path, REPO_ROOT);
    const before = readFileSync(path, "utf8");
    expect(() => createWalletFile(path, REPO_ROOT)).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe(before);
    const other = join(tempDir(), "notes.txt");
    writeFileSync(other, "keep me");
    expect(() => createWalletFile(other, REPO_ROOT)).toThrow(WalletError);
    expect(readFileSync(other, "utf8")).toBe("keep me");
  });

  it("refuses a path inside the repo, a relative path and a missing folder", () => {
    expect(() => createWalletFile(join(REPO_ROOT, "wallets", "w.json"), REPO_ROOT)).toThrow(/inside the repo/);
    expect(() => createWalletFile(join(REPO_ROOT, "w.json"), REPO_ROOT)).toThrow(/inside the repo/);
    expect(() => createWalletFile("wallet.json", REPO_ROOT)).toThrow(/absolute/);
    expect(() => createWalletFile(join(tempDir(), "nope", "w.json"), REPO_ROOT)).toThrow(/folder/);
  });
});

describe("scripts/new-wallet.ts", () => {
  const run = (args: string[], cwd = REPO_ROOT) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "scripts/new-wallet.ts"), ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: tempDir() },
      encoding: "utf8",
    });

  it("prints the public address and the .env line, and never the key", () => {
    const path = join(tempDir(), "bot-wallet.json");
    const r = run([path]);
    expect(r.status).toBe(0);
    const address = loadWalletSigner(path, createRedactor([]), REPO_ROOT).publicKey;
    expect(r.stdout).toContain(address);
    expect(r.stdout).toContain(`WALLET_KEYPAIR_PATH=${path}`);
    for (const form of secretForms(path)) expect(r.stdout + r.stderr).not.toContain(form);
  });

  it("defaults to sniper-wallet.json in the home folder", () => {
    const home = tempDir();
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(REPO_ROOT, "scripts/new-wallet.ts")], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(statSync(join(home, "sniper-wallet.json")).mode & 0o777).toBe(0o600);
  });

  it("stops with a plain message when the file exists or the path is in the repo", () => {
    const path = join(tempDir(), "bot-wallet.json");
    expect(run([path]).status).toBe(0);
    const again = run([path]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("Not created");
    expect(again.stderr).toContain("already exists");

    const inRepo = join(REPO_ROOT, "data", "tmp-wallet-test");
    mkdirSync(inRepo, { recursive: true });
    try {
      const r = run([join(inRepo, "w.json")]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("inside the repo");
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });
});
