import { isPubkey } from "../extract/base58.ts";
import type { ParsedData, RpcAccount, SolanaRpc } from "./rpc.ts";
import { PROGRAMS, pump, pumpSwap, splToken, web3 } from "./sdk.ts";

/**
 * Read-only facts about a token, taken straight from chain accounts.
 * No judgment here: the validator decides what the facts mean.
 */

export interface MintFacts {
  address: string;
  exists: boolean;
  /** The program that owns the account. A wallet is owned by the system program, a mint by a token program. */
  owner: string | undefined;
  tokenProgram: "spl-token" | "token-2022" | undefined;
  isMint: boolean;
  decimals: number | undefined;
  supply: bigint | undefined;
  mintAuthority: string | null | undefined;
  freezeAuthority: string | null | undefined;
  /** Token-2022 extensions on the mint, by the RPC node's names (e.g. "transferHook"). */
  extensions: { name: string; state: Record<string, unknown> }[];
  /** Name and symbol stored on the mint itself (Token-2022 metadata extension). */
  onMintMetadata: { name: string; symbol: string } | undefined;
}

export function parseMintAccount(address: string, account: RpcAccount<ParsedData | [string, string]> | null): MintFacts {
  const none: MintFacts = {
    address,
    exists: false,
    owner: undefined,
    tokenProgram: undefined,
    isMint: false,
    decimals: undefined,
    supply: undefined,
    mintAuthority: undefined,
    freezeAuthority: undefined,
    extensions: [],
    onMintMetadata: undefined,
  };
  if (!account) return none;
  const tokenProgram: MintFacts["tokenProgram"] = account.owner === PROGRAMS.splToken ? "spl-token" : account.owner === PROGRAMS.token2022 ? "token-2022" : undefined;
  const base = { ...none, exists: true, owner: account.owner, tokenProgram };
  const data = account.data;
  if (!tokenProgram || Array.isArray(data) || data.parsed?.type !== "mint") return base;
  const info = data.parsed.info as {
    decimals?: number;
    supply?: string;
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    extensions?: { extension: string; state?: Record<string, unknown> }[];
  };
  const extensions = (info.extensions ?? []).map((e) => ({ name: e.extension, state: e.state ?? {} }));
  const meta = extensions.find((e) => e.name === "tokenMetadata")?.state as { name?: string; symbol?: string } | undefined;
  return {
    ...base,
    isMint: true,
    decimals: info.decimals,
    supply: info.supply !== undefined ? BigInt(info.supply) : undefined,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions,
    onMintMetadata: meta?.name !== undefined || meta?.symbol !== undefined ? { name: meta.name ?? "", symbol: meta.symbol ?? "" } : undefined,
  };
}

export type Venue = "pump_curve" | "pumpswap" | "jupiter" | "none";

export interface MarketFacts {
  venue: Venue;
  /** Why this venue, or why none. */
  detail: string;
  /** True when a pump.fun bonding curve account exists for the mint (the token was launched on pump.fun). */
  isPumpToken: boolean;
  curveComplete: boolean | undefined;
  /** Wallet that created the coin on pump.fun. */
  creator: string | undefined;
  /** Lamports of SOL per raw token unit, before our buy. */
  priceLamportsPerUnit: number | undefined;
  /** SOL side of the liquidity we trade against, in lamports (virtual reserves on the curve). */
  quoteReserveLamports: bigint | undefined;
  tokenReserveUnits: bigint | undefined;
  /** Price now divided by the pump.fun launch price. Undefined for tokens not launched on pump.fun. */
  multipleVsLaunch: number | undefined;
  /** Token accounts that hold liquidity, not an investor's bag (curve / pool vaults). Excluded from holder stats. */
  liquidityTokenAccounts: string[];
}

/** pump.fun's standard SOL launch: 30 SOL against 1,073,000,000 tokens (6 decimals) of virtual reserves. */
export const PUMP_LAUNCH_VIRTUAL_SOL = 30_000_000_000n;
const PUMP_LAUNCH_VIRTUAL_TOKENS = 1_073_000_000_000_000n;
export const PUMP_LAUNCH_PRICE = Number(PUMP_LAUNCH_VIRTUAL_SOL) / Number(PUMP_LAUNCH_VIRTUAL_TOKENS);

const NO_MARKET: MarketFacts = {
  venue: "none",
  detail: "",
  isPumpToken: false,
  curveComplete: undefined,
  creator: undefined,
  priceLamportsPerUnit: undefined,
  quoteReserveLamports: undefined,
  tokenReserveUnits: undefined,
  multipleVsLaunch: undefined,
  liquidityTokenAccounts: [],
};

function toAccountInfo(a: RpcAccount<Buffer>) {
  return { data: a.data, owner: new web3.PublicKey(a.owner), lamports: a.lamports, executable: a.executable };
}

const big = (bn: { toString(): string }) => BigInt(bn.toString());

/** Amount held by an SPL / Token-2022 token account (u64 at byte 64). */
export function tokenAccountAmount(data: Buffer): bigint | undefined {
  return data.length >= 72 ? data.readBigUInt64LE(64) : undefined;
}

/** Price impact of spending `lamportsIn` against a constant-product reserve, in basis points. */
export function priceImpactBps(lamportsIn: bigint, quoteReserveLamports: bigint): number {
  if (quoteReserveLamports <= 0n) return 10_000;
  return Math.round((Number(lamportsIn) / Number(quoteReserveLamports)) * 10_000);
}

export interface ChainReader {
  mintFacts(mint: string): Promise<MintFacts>;
  marketFacts(mint: string, tokenProgram?: MintFacts["tokenProgram"]): Promise<MarketFacts>;
  /** Name and symbol from Metaplex metadata. Null when the token has none. */
  metaplexMetadata(mint: string): Promise<{ name: string; symbol: string } | null>;
  /** Age of the mint in seconds, a lower bound ({ atLeast }) or null when it can't be told. */
  mintAgeSeconds(mint: string, nowMs: number): Promise<{ seconds: number; exact: boolean } | null>;
  /** Share of supply held by the 10 largest holders, excluding liquidity accounts. 0-100. */
  top10HolderPct(mint: string, supply: bigint, exclude: readonly string[]): Promise<number | null>;
  /** Token units `owner` holds of `mint` in their standard token account. 0 when they have none. */
  tokenBalance(owner: string, mint: string, tokenProgram?: MintFacts["tokenProgram"]): Promise<bigint>;
}

export class RpcChainReader implements ChainReader {
  readonly #rpc: SolanaRpc;
  constructor(rpc: SolanaRpc) {
    this.#rpc = rpc;
  }

  async mintFacts(mint: string): Promise<MintFacts> {
    return parseMintAccount(mint, await this.#rpc.getParsedAccount(mint));
  }

  async marketFacts(mint: string, tokenProgram?: MintFacts["tokenProgram"]): Promise<MarketFacts> {
    if (!isPubkey(mint)) return { ...NO_MARKET, detail: "not a valid address" };
    const mintKey = new web3.PublicKey(mint);
    const curveKey = pump.bondingCurvePda(mintKey);
    const poolKey = pump.canonicalPumpPoolPda(mintKey);
    const [curveAcc, poolAcc] = await this.#rpc.getAccounts([curveKey.toBase58(), poolKey.toBase58()]);

    const curve = curveAcc && curveAcc.owner === PROGRAMS.pump ? pump.PUMP_SDK.decodeBondingCurveNullable(toAccountInfo(curveAcc)) : null;
    const pool = poolAcc && poolAcc.owner === PROGRAMS.pumpAmm ? pumpSwap.PUMP_AMM_SDK.decodePoolNullable(toAccountInfo(poolAcc)) : null;
    // The curve's own token account. Derived for the mint's token program when known, else SPL Token.
    const programId = tokenProgram === "token-2022" ? new web3.PublicKey(PROGRAMS.token2022) : new web3.PublicKey(PROGRAMS.splToken);
    const curveVault = splToken.getAssociatedTokenAddressSync(mintKey, curveKey, true, programId).toBase58();
    const base = { ...NO_MARKET, isPumpToken: curve !== null, curveComplete: curve?.complete, creator: curve?.creator.toBase58() };

    if (curve && !curve.complete) {
      const quoteIsSol = curve.quoteMint.equals(web3.PublicKey.default) || curve.quoteMint.toBase58() === PROGRAMS.wsol;
      if (!quoteIsSol) {
        return { ...base, detail: `pump.fun curve is priced in another token (${curve.quoteMint.toBase58()}), not SOL`, liquidityTokenAccounts: [curveVault] };
      }
      const vq = big(curve.virtualQuoteReserves);
      const vt = big(curve.virtualTokenReserves);
      const initial = big(curve.initialVirtualQuoteReserves) > 0n ? big(curve.initialVirtualQuoteReserves) : PUMP_LAUNCH_VIRTUAL_SOL;
      return {
        ...base,
        venue: "pump_curve",
        detail: curve.isMayhemMode ? "pump.fun bonding curve, still open (mayhem mode)" : "pump.fun bonding curve, still open",
        priceLamportsPerUnit: vt > 0n ? Number(vq) / Number(vt) : undefined,
        quoteReserveLamports: vq,
        tokenReserveUnits: vt,
        multipleVsLaunch: vt > 0n ? Number(vq) / Number(vt) / (Number(initial) / Number(PUMP_LAUNCH_VIRTUAL_TOKENS)) : undefined,
        liquidityTokenAccounts: [curveVault],
      };
    }

    if (pool) {
      const quoteIsSol = pool.quoteMint.toBase58() === PROGRAMS.wsol;
      const vaults = [pool.poolBaseTokenAccount.toBase58(), pool.poolQuoteTokenAccount.toBase58()];
      if (!quoteIsSol) return { ...base, detail: "PumpSwap pool is priced in another token, not SOL", liquidityTokenAccounts: [vaults[0]!, curveVault] };
      const [baseVault, quoteVault] = await this.#rpc.getAccounts(vaults);
      const baseReserve = baseVault ? tokenAccountAmount(baseVault.data) : undefined;
      const quoteReserve = quoteVault ? tokenAccountAmount(quoteVault.data) : undefined;
      if (!baseReserve || !quoteReserve) return { ...base, detail: "PumpSwap pool exists but has no liquidity", liquidityTokenAccounts: [vaults[0]!, curveVault] };
      const quote = quoteReserve + big(pool.virtualQuoteReserves);
      const price = Number(quote) / Number(baseReserve);
      return {
        ...base,
        venue: "pumpswap",
        detail: "PumpSwap pool (graduated from pump.fun)",
        creator: base.creator ?? pool.coinCreator.toBase58(),
        priceLamportsPerUnit: price,
        quoteReserveLamports: quote,
        tokenReserveUnits: baseReserve,
        multipleVsLaunch: curve ? price / PUMP_LAUNCH_PRICE : undefined,
        liquidityTokenAccounts: [vaults[0]!, curveVault],
      };
    }

    if (curve?.complete) return { ...base, detail: "pump.fun curve is complete but the PumpSwap pool doesn't exist yet (mid-migration)", liquidityTokenAccounts: [curveVault] };
    return { ...base, detail: "no pump.fun curve or PumpSwap pool for this mint" };
  }

  async metaplexMetadata(mint: string): Promise<{ name: string; symbol: string } | null> {
    const program = new web3.PublicKey(PROGRAMS.metaplex);
    const [pda] = web3.PublicKey.findProgramAddressSync([Buffer.from("metadata"), program.toBuffer(), new web3.PublicKey(mint).toBuffer()], program);
    const [acc] = await this.#rpc.getAccounts([pda.toBase58()]);
    return acc ? parseMetaplexMetadata(acc.data) : null;
  }

  async mintAgeSeconds(mint: string, nowMs: number): Promise<{ seconds: number; exact: boolean } | null> {
    const LIMIT = 1000;
    const sigs = await this.#rpc.getSignatures(mint, LIMIT);
    const oldest = sigs.at(-1)?.blockTime;
    if (oldest === null || oldest === undefined) return null;
    // With a full page there are older transactions we didn't fetch, so this is only a lower bound.
    return { seconds: Math.max(0, Math.round(nowMs / 1000 - oldest)), exact: sigs.length < LIMIT };
  }

  async tokenBalance(owner: string, mint: string, tokenProgram?: MintFacts["tokenProgram"]): Promise<bigint> {
    const programId = new web3.PublicKey(tokenProgram === "token-2022" ? PROGRAMS.token2022 : PROGRAMS.splToken);
    const ata = splToken.getAssociatedTokenAddressSync(new web3.PublicKey(mint), new web3.PublicKey(owner), true, programId);
    const [acc] = await this.#rpc.getAccounts([ata.toBase58()]);
    return acc ? (tokenAccountAmount(acc.data) ?? 0n) : 0n;
  }

  async top10HolderPct(mint: string, supply: bigint, exclude: readonly string[]): Promise<number | null> {
    if (supply <= 0n) return null;
    const largest = await this.#rpc.getTokenLargestAccounts(mint);
    const top = largest.filter((a) => !exclude.includes(a.address)).slice(0, 10);
    const sum = top.reduce((s, a) => s + BigInt(a.amount), 0n);
    return Number((sum * 10_000n) / supply) / 100;
  }
}

/** Metaplex Metadata account: key(1) updateAuthority(32) mint(32) then length-prefixed name, symbol, uri. */
export function parseMetaplexMetadata(data: Buffer): { name: string; symbol: string } | null {
  try {
    let o = 65;
    const str = () => {
      const len = data.readUInt32LE(o);
      if (len > 256) throw new Error("bad length");
      const s = data.subarray(o + 4, o + 4 + len).toString("utf8").replace(/\0/g, "").trim();
      o += 4 + len;
      return s;
    };
    const name = str();
    const symbol = str();
    return { name, symbol };
  } catch {
    return null;
  }
}
