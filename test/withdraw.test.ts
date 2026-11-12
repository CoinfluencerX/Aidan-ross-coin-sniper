import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWithdraw } from "../src/app/withdraw-cli.ts";
import { SolanaRpc } from "../src/chain/rpc.ts";
import { PROGRAMS, web3 } from "../src/chain/sdk.ts";
import { createWalletFile } from "../src/exec/wallet.ts";
import { addressProblem, buildWithdrawTx, planWithdrawal, RENT_EXEMPT_MIN_LAMPORTS, TRANSFER_FEE_LAMPORTS } from "../src/exec/withdraw.ts";
import { base58Encode } from "../src/extract/base58.ts";
import { fakeFetch, json, type Route } from "./fake-x.ts";
import { FAKE_SECRETS, REPO_ROOT, SECRET_NEEDLES, tempDir } from "./helpers.ts";

const RPC_URL = FAKE_SECRETS.RPC_HTTP_URL;
const SOL = 1_000_000_000n;
const newAddress = () => web3.Keypair.generate().publicKey.toBase58();
/** An address no key can sign for (a program-derived address). */
const OFF_CURVE = web3.PublicKey.findProgramAddressSync([Buffer.from("vault")], new web3.PublicKey(PROGRAMS.pump))[0].toBase58();

interface Chain {
  balance?: bigint;
  /** The destination account as the chain sees it. null = never used. */
  destination?: { owner: string; lamports: number; executable: boolean } | null;
  /** Raw amounts of coins the wallet holds. */
  coins?: string[];
  simulateErr?: unknown;
  confirm?: "confirmed" | "failed" | "never";
}

/** A fake Solana node that records anything sent to it. */
function fakeNode(c: Chain = {}) {
  const sent: string[] = [];
  const methods: string[] = [];
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
  const route: Route = ({ url, body }) => {
    if (url.hostname !== "mainnet.helius-rpc.com") return;
    const b = body as { method: string; params: unknown[] };
    methods.push(b.method);
    switch (b.method) {
      case "getBalance":
        return ok({ value: Number(c.balance ?? 2n * SOL) });
      case "getAccountInfo":
        return ok({ value: c.destination === undefined ? { owner: PROGRAMS.system, lamports: 5_000_000, executable: false, data: ["", "base64"] } : c.destination && { ...c.destination, data: ["", "base64"] } });
      case "getTokenAccountsByOwner": {
        const first = (b.params[1] as { programId: string }).programId === PROGRAMS.splToken;
        return ok({ value: (first ? (c.coins ?? []) : []).map((amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } })) });
      }
      case "getLatestBlockhash":
        return ok({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1 } });
      case "simulateTransaction":
        return ok({ value: { err: c.simulateErr ?? null, logs: [] } });
      case "sendTransaction":
        sent.push(b.params[0] as string);
        return ok("5igFromFakeNode");
      case "getSignatureStatuses":
        return ok({ value: [c.confirm === "never" ? null : c.confirm === "failed" ? { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } : { err: null, confirmationStatus: "confirmed" }] });
      default:
        return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `fake node: ${b.method}` } });
    }
  };
  return { route, sent, methods, rpc: new SolanaRpc({ url: RPC_URL, fetch: fakeFetch([route]).fetch }) };
}

describe("withdraw: is this address a wallet?", () => {
  const from = newAddress();
  it("accepts a normal wallet address", () => expect(addressProblem(newAddress(), from)).toBeNull());
  it("refuses junk, the bot wallet itself, and addresses no key controls", () => {
    expect(addressProblem("not-an-address", from)).toMatch(/isn't a valid Solana address/);
    expect(addressProblem("0x1111111111111111111111111111111111111111", from)).toMatch(/isn't a valid Solana address/);
    expect(addressProblem(from, from)).toMatch(/own address/);
    expect(addressProblem(OFF_CURVE, from)).toMatch(/belongs to a program/);
  });
});

describe("withdraw: the plan", () => {
  const from = newAddress();
  const plan = (c: Chain, amount: bigint | "all", to = newAddress()) => planWithdrawal({ rpc: fakeNode(c).rpc, from, to, amount });

  it("sends an exact amount and shows what is left", async () => {
    const p = await plan({ balance: 2n * SOL }, SOL / 2n);
    expect(p.problems).toEqual([]);
    expect(p).toMatchObject({ lamports: SOL / 2n, feeLamports: TRANSFER_FEE_LAMPORTS, balanceBefore: 2n * SOL, balanceAfter: 2n * SOL - SOL / 2n - TRANSFER_FEE_LAMPORTS });
  });

  it("--all sends everything except the fee, leaving exactly zero", async () => {
    const p = await plan({ balance: 2n * SOL }, "all");
    expect(p.problems).toEqual([]);
    expect(p.lamports).toBe(2n * SOL - TRANSFER_FEE_LAMPORTS);
    expect(p.balanceAfter).toBe(0n);
  });

  it("refuses more than the wallet holds, zero, and an empty wallet", async () => {
    expect((await plan({ balance: SOL }, SOL)).problems.join()).toMatch(/less than the amount plus/);
    expect((await plan({ balance: SOL }, 0n)).problems.join()).toMatch(/more than zero/);
    expect((await plan({ balance: 1_000n }, "all")).problems.join()).toMatch(/doesn't hold enough SOL to cover the network fee/);
  });

  it("refuses to leave an amount too small for the network to allow", async () => {
    const p = await plan({ balance: SOL }, SOL - TRANSFER_FEE_LAMPORTS - 1_000n);
    expect(p.problems.join()).toMatch(/must keep: withdraw less, or use --all/);
  });

  it("refuses a destination that is a token account, a coin or a program", async () => {
    for (const destination of [
      { owner: PROGRAMS.splToken, lamports: 2_039_280, executable: false },
      { owner: PROGRAMS.token2022, lamports: 1_461_600, executable: false },
      { owner: "BPFLoaderUpgradeab1e11111111111111111111111", lamports: 1, executable: true },
    ]) {
      expect((await plan({ destination }, SOL)).problems.join()).toMatch(/not a wallet/);
    }
  });

  it("warns about a never-used destination, and refuses to send it dust", async () => {
    const fresh = await plan({ destination: null }, SOL);
    expect(fresh.problems).toEqual([]);
    expect(fresh.destinationIsNew).toBe(true);
    expect(fresh.warnings.join()).toMatch(/never been used before/);
    expect((await plan({ destination: null }, RENT_EXEMPT_MIN_LAMPORTS - 1n)).problems.join()).toMatch(/must receive at least/);
  });

  it("won't empty the wallet while it still holds coins, and warns when little is left for selling them", async () => {
    expect((await plan({ coins: ["0", "350000000000"] }, "all")).problems.join()).toMatch(/still holds coins/);
    const tight = await plan({ balance: SOL, coins: ["5"] }, SOL - 10_000_000n);
    expect(tight.problems).toEqual([]);
    expect(tight.warnings.join()).toMatch(/left to pay for selling them/);
    // Empty coin accounts don't count.
    expect((await plan({ coins: ["0"] }, "all")).problems).toEqual([]);
  });

  it("makes no network call at all for an address that can't be a wallet", async () => {
    const node = fakeNode();
    const p = await planWithdrawal({ rpc: node.rpc, from, to: OFF_CURVE, amount: SOL });
    expect(p.problems).toHaveLength(1);
    expect(node.methods).toEqual([]);
  });
});

describe("withdraw: the transaction", () => {
  it("is one plain SOL transfer of exactly the amount, and nothing else", () => {
    const from = newAddress();
    const to = newAddress();
    const tx = buildWithdrawTx(from, to, 123_456_789n, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const ix = tx.message.compiledInstructions[0]!;
    expect(keys[ix.programIdIndex]).toBe(PROGRAMS.system);
    expect([keys[ix.accountKeyIndexes[0]!], keys[ix.accountKeyIndexes[1]!]]).toEqual([from, to]);
    expect(Buffer.from(ix.data).readUInt32LE(0)).toBe(2);
    expect(Buffer.from(ix.data).readBigUInt64LE(4)).toBe(123_456_789n);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true); // unsigned
  });
});

describe("withdraw: the command (fake node, throwaway wallet)", () => {
  function setup(c: Chain = {}) {
    const walletPath = join(tempDir(), "bot-wallet.json");
    const wallet = createWalletFile(walletPath, REPO_ROOT);
    const node = fakeNode(c);
    const lines: string[] = [];
    const asked: string[] = [];
    const run = (argv: string[], o: { isTTY?: boolean; answer?: string; env?: Record<string, string> } = {}) =>
      runWithdraw({
        argv,
        env: { ...FAKE_SECRETS, WALLET_KEYPAIR_PATH: walletPath, ...o.env },
        repoRoot: REPO_ROOT,
        isTTY: o.isTTY ?? false,
        ask: async (q) => (asked.push(q), o.answer ?? ""),
        write: (l) => lines.push(l),
        fetch: fakeFetch([node.route]).fetch,
        sleep: async () => {},
      });
    const bytes = Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8")) as number[]);
    const secretForms = [base58Encode(bytes), base58Encode(bytes.subarray(0, 32)), Buffer.from(bytes).toString("hex"), Buffer.from(bytes).toString("base64")];
    return { wallet, node, lines, asked, run, text: () => lines.join("\n"), secretForms };
  }
  const to = newAddress();

  it("previews by default: shows both addresses and the numbers, tests the transfer, and sends nothing", async () => {
    const s = setup({ balance: 2n * SOL });
    expect(await s.run([to, "--sol", "0.5"])).toBe(0);
    const text = s.text();
    expect(text).toContain(`From         ${s.wallet.publicKey}`);
    expect(text).toContain(`To           ${to}`);
    expect(text).toContain("Amount       0.5 SOL");
    expect(text).toContain("Left after   1.499995 SOL");
    expect(text).toContain("Test run on the network: OK.");
    expect(text).toContain("PREVIEW ONLY. Nothing was sent.");
    expect(s.node.sent).toEqual([]);
    expect(s.node.methods).not.toContain("sendTransaction");
    expect(s.asked).toEqual([]);
  });

  it("never prints the private key or any other secret", async () => {
    const s = setup();
    await s.run([to, "--sol", "0.5"]);
    await s.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: to.slice(-4) });
    for (const form of [...s.secretForms, ...SECRET_NEEDLES]) expect(s.text()).not.toContain(form);
  });

  it("--send without a person at a terminal sends nothing", async () => {
    const s = setup();
    expect(await s.run([to, "--sol", "0.5", "--send"], { isTTY: false, answer: to.slice(-4) })).toBe(1);
    expect(s.text()).toContain("only works when a person runs this in a terminal");
    expect(s.node.sent).toEqual([]);
    expect(s.asked).toEqual([]);
  });

  it("--send with the wrong confirmation sends nothing", async () => {
    for (const answer of ["", "yes", "SEND", to.slice(0, 4)]) {
      const s = setup();
      expect(await s.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer })).toBe(1);
      expect(s.text()).toContain("Cancelled: nothing was sent.");
      expect(s.node.sent).toEqual([]);
    }
  });

  it("--send with the right confirmation sends exactly one transfer, signed by the bot wallet", async () => {
    const s = setup({ balance: 2n * SOL });
    expect(await s.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: ` ${to.slice(-4)} ` })).toBe(0);
    expect(s.node.sent).toHaveLength(1);
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(s.node.sent[0]!, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe(s.wallet.publicKey);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const ix = tx.message.compiledInstructions[0]!;
    expect(keys[ix.accountKeyIndexes[1]!]).toBe(to);
    expect(Buffer.from(ix.data).readBigUInt64LE(4)).toBe(SOL / 2n);
    expect(s.text()).toContain(`Sent. Transaction: ${base58Encode(tx.signatures[0]!)}`);
    expect(s.text()).toContain(`Confirmed. 0.5 SOL is now at ${to}.`);
  });

  it("stops before asking or sending when the plan has a problem or the test run fails", async () => {
    const broke = setup({ balance: SOL / 10n });
    expect(await broke.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: to.slice(-4) })).toBe(1);
    expect(broke.text()).toContain("Not possible:");
    expect(broke.text()).toContain("Nothing was sent.");
    expect(broke.asked).toEqual([]);
    expect(broke.node.sent).toEqual([]);

    const failing = setup({ simulateErr: { InstructionError: [0, "Custom"] } });
    expect(await failing.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: to.slice(-4) })).toBe(1);
    expect(failing.text()).toContain("test run of this transfer failed");
    expect(failing.asked).toEqual([]);
    expect(failing.node.sent).toEqual([]);
  });

  it("says plainly when a sent transfer was rejected or isn't confirmed, and never sends twice", async () => {
    const rejected = setup({ confirm: "failed" });
    expect(await rejected.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: to.slice(-4) })).toBe(1);
    expect(rejected.text()).toContain("The network rejected it.");
    expect(rejected.node.sent).toHaveLength(1);

    const pending = setup({ confirm: "never" });
    // Make the one-minute wait instant.
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => (t += 5_000);
    try {
      expect(await pending.run([to, "--sol", "0.5", "--send"], { isTTY: true, answer: to.slice(-4) })).toBe(2);
    } finally {
      Date.now = realNow;
    }
    expect(pending.text()).toContain("Do NOT run this again yet");
    expect(pending.node.sent).toHaveLength(1);
  });

  it("uses WITHDRAW_ADDRESS from .env when no address is given, and says so", async () => {
    const s = setup();
    expect(await s.run(["--sol", "0.25"], { env: { WITHDRAW_ADDRESS: to } })).toBe(0);
    expect(s.text()).toContain(`To           ${to}   (WITHDRAW_ADDRESS from .env)`);
  });

  it("explains what's missing instead of guessing", async () => {
    const s = setup();
    expect(await s.run(["--sol", "0.5"])).toBe(64);
    expect(s.text()).toContain("No destination");
    expect(await s.run([to])).toBe(64);
    expect(s.text()).toContain("Say how much");
    expect(await s.run([to, "--sol", "0.5", "--all"])).toBe(64);
    expect(await s.run([to, "--sol", "half"])).toBe(64);
    expect(await s.run([to, "--sol", "0.5"], { env: { WALLET_KEYPAIR_PATH: "" } })).toBe(78);
    expect(s.text()).toContain("no bot wallet to withdraw from");
    expect(s.node.sent).toEqual([]);
  });

  it("reads amounts exactly, to the last lamport", async () => {
    const s = setup({ balance: 5n * SOL });
    await s.run([to, "--sol", "1.000000001"]);
    expect(s.text()).toContain("Amount       1.000000001 SOL");
    expect(s.text()).toContain("Left after   3.999994999 SOL");
    expect(s.text()).toContain("Network fee  0.000005 SOL");
  });
});
