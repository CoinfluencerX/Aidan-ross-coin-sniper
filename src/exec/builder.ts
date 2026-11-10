import BN from "bn.js";
import type { Venue } from "../chain/facts.ts";
import type { JupiterClient } from "../chain/jupiter.ts";
import { PROGRAMS, pump, pumpSwap, splToken, web3, type Web3Module } from "../chain/sdk.ts";
import type { FetchFn } from "../extract/expand.ts";

/**
 * Builds buy and sell instructions with the official pump.fun SDK (bonding curve and PumpSwap)
 * and Jupiter's API (everything else). Building is all this file does: it never signs and never sends.
 */

type Ix = Web3Module.TransactionInstruction;

export interface TradeRequest {
  mint: string;
  tokenProgram: "spl-token" | "token-2022";
  /** The wallet that trades (public key). */
  user: string;
  venue: Exclude<Venue, "none">;
  slippageBps: number;
}

export interface BuiltTrade {
  /** Instructions for pump.fun / PumpSwap. Empty for Jupiter, which returns a whole transaction. */
  instructions: Ix[];
  /** Jupiter only: a complete unsigned transaction, base64. */
  prebuiltTx?: string;
  /** Buy: token units we expect. Sell: lamports we expect. */
  expectedOut: bigint;
  /** Which SDK path built it, for the logs. */
  variant: string;
  /** The user's token account for this mint. */
  userTokenAccount: string;
}

export interface TradeBuilder {
  buy(req: TradeRequest & { lamportsIn: bigint }): Promise<BuiltTrade>;
  sell(req: TradeRequest & { tokenAmount: bigint }): Promise<BuiltTrade>;
  /**
   * One transaction's worth of instructions that buys and then sells part of what it bought.
   * Simulating it is the honeypot test: if the sell leg fails, we couldn't have exited.
   * Returns null for venues where that can't be done in one transaction (Jupiter).
   */
  roundTrip(req: TradeRequest & { lamportsIn: bigint }): Promise<{ instructions: Ix[]; buy: BuiltTrade } | null>;
}

const bn = (v: bigint) => new BN(v.toString());
const big = (v: { toString(): string }) => BigInt(v.toString());
const programKey = (p: TradeRequest["tokenProgram"]) => new web3.PublicKey(p === "token-2022" ? PROGRAMS.token2022 : PROGRAMS.splToken);

/** SPL Token CloseAccount instruction tag. */
const CLOSE_ACCOUNT = 9;
function isWsolClose(ix: Ix): boolean {
  return ix.programId.toBase58() === PROGRAMS.splToken && ix.data.length === 1 && ix.data[0] === CLOSE_ACCOUNT;
}

type SwapState = Awaited<ReturnType<InstanceType<typeof pumpSwap.OnlinePumpAmmSdk>["swapSolanaState"]>>;

/** Fields the SDK's own PumpSwap quote functions need, taken from the pool state. */
function ammQuoteArgs(st: SwapState, slippage: number) {
  return {
    slippage,
    baseReserve: st.poolBaseAmount,
    quoteReserve: st.poolQuoteAmount,
    virtualQuoteReserves: st.pool.virtualQuoteReserves,
    globalConfig: st.globalConfig,
    baseMintAccount: st.baseMintAccount,
    baseMint: st.baseMint,
    coinCreator: st.pool.coinCreator,
    creator: st.pool.creator,
    feeConfig: st.feeConfig,
    quoteMint: st.pool.quoteMint,
    isMayhemMode: st.pool.isMayhemMode,
    creatorFeeBps: st.pool.creatorFeeBps,
    quoteTransferFee: st.quoteTransferFee ?? null,
  };
}

/** Token units a PumpSwap buy of `lamportsIn` returns after fees. Falls back to plain pool math if the SDK quote throws. */
export function ammBuyQuote(st: SwapState, lamportsIn: bigint, slippage: number): bigint {
  try {
    return big(pumpSwap.buyQuoteInput({ ...ammQuoteArgs(st, slippage), quote: bn(lamportsIn) }).base);
  } catch {
    const base = big(st.poolBaseAmount);
    const quote = big(st.poolQuoteAmount) + big(st.pool.virtualQuoteReserves);
    return quote + lamportsIn > 0n ? (base * lamportsIn) / (quote + lamportsIn) : 0n;
  }
}

/** Lamports a PumpSwap sell of `tokenAmount` returns after fees. */
export function ammSellQuote(st: SwapState, tokenAmount: bigint, slippage: number): bigint {
  try {
    return big(pumpSwap.sellBaseInput({ ...ammQuoteArgs(st, slippage), base: bn(tokenAmount) }).uiQuote);
  } catch {
    const base = big(st.poolBaseAmount);
    const quote = big(st.poolQuoteAmount) + big(st.pool.virtualQuoteReserves);
    return base + tokenAmount > 0n ? (quote * tokenAmount) / (base + tokenAmount) : 0n;
  }
}

export class SdkTradeBuilder implements TradeBuilder {
  readonly #conn: Web3Module.Connection;
  readonly #pump: InstanceType<typeof pump.OnlinePumpSdk>;
  readonly #amm: InstanceType<typeof pumpSwap.OnlinePumpAmmSdk>;
  readonly #jupiter: JupiterClient | undefined;
  readonly #priorityMicroLamports: number | undefined;
  #globals: { at: number; value: Promise<{ global: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchGlobal"]>>; feeConfig: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchFeeConfig"]>> }> } | undefined;

  constructor(o: { rpcUrl: string; fetch?: FetchFn; jupiter?: JupiterClient; priorityMicroLamports?: number }) {
    this.#conn = new web3.Connection(o.rpcUrl, { commitment: "confirmed", ...(o.fetch ? { fetch: o.fetch as never } : {}) });
    this.#pump = new pump.OnlinePumpSdk(this.#conn);
    this.#amm = new pumpSwap.OnlinePumpAmmSdk(this.#conn);
    this.#jupiter = o.jupiter;
    this.#priorityMicroLamports = o.priorityMicroLamports;
  }

  /** pump.fun's global settings and fee schedule. They rarely change, so they're cached for a minute. */
  globals(now = Date.now()) {
    if (!this.#globals || now - this.#globals.at > 60_000) {
      const value = Promise.all([this.#pump.fetchGlobal(), this.#pump.fetchFeeConfig()]).then(([global, feeConfig]) => ({ global, feeConfig }));
      this.#globals = { at: now, value };
      // Don't cache a failure.
      value.catch(() => (this.#globals = undefined));
    }
    return this.#globals.value;
  }

  #ata(req: TradeRequest): string {
    return splToken.getAssociatedTokenAddressSync(new web3.PublicKey(req.mint), new web3.PublicKey(req.user), true, programKey(req.tokenProgram)).toBase58();
  }

  async buy(req: TradeRequest & { lamportsIn: bigint }): Promise<BuiltTrade> {
    const mint = new web3.PublicKey(req.mint);
    const user = new web3.PublicKey(req.user);
    const slippage = req.slippageBps / 100;
    const userTokenAccount = this.#ata(req);

    if (req.venue === "pump_curve") {
      const tokenProgram = programKey(req.tokenProgram);
      const [{ global, feeConfig }, st] = await Promise.all([this.globals(), this.#pump.fetchBuyState(mint, user, tokenProgram)]);
      return this.#curveBuyFromState(req, st, global, feeConfig);
    }

    if (req.venue === "pumpswap") {
      const st = await this.#amm.swapSolanaState(pump.canonicalPumpPoolPda(mint), user);
      const instructions = await pumpSwap.PUMP_AMM_SDK.buyQuoteInput(st, bn(req.lamportsIn), slippage);
      return { instructions, expectedOut: ammBuyQuote(st, req.lamportsIn, slippage), variant: "pumpswap", userTokenAccount };
    }

    if (!this.#jupiter) throw new Error("Jupiter isn't configured");
    const quote = await this.#jupiter.quote(PROGRAMS.wsol, req.mint, req.lamportsIn, req.slippageBps);
    const prebuiltTx = await this.#jupiter.swapTransaction(quote, req.user, this.#priorityMicroLamports !== undefined ? { priorityMicroLamports: this.#priorityMicroLamports } : {});
    return { instructions: [], prebuiltTx, expectedOut: BigInt(quote.outAmount), variant: "jupiter", userTokenAccount };
  }

  async sell(req: TradeRequest & { tokenAmount: bigint }): Promise<BuiltTrade> {
    const mint = new web3.PublicKey(req.mint);
    const user = new web3.PublicKey(req.user);
    const slippage = req.slippageBps / 100;
    const userTokenAccount = this.#ata(req);

    if (req.venue === "pump_curve") {
      const tokenProgram = programKey(req.tokenProgram);
      // fetchBuyState, not fetchSellState: the sell-state reader throws when the user has no token
      // account yet, which is always the case for a dry-run paper sell. Both return the same curve.
      const [{ global, feeConfig }, st] = await Promise.all([this.globals(), this.#pump.fetchBuyState(mint, user, tokenProgram)]);
      return this.#curveSell(req, st.bondingCurve, st.bondingCurveAccountInfo, st.quoteTokenProgram, global, feeConfig, userTokenAccount);
    }
    if (req.venue === "pumpswap") {
      const st = await this.#amm.swapSolanaState(pump.canonicalPumpPoolPda(mint), user);
      const instructions = await pumpSwap.PUMP_AMM_SDK.sellBaseInput(st, bn(req.tokenAmount), slippage);
      return { instructions, expectedOut: ammSellQuote(st, req.tokenAmount, slippage), variant: "pumpswap", userTokenAccount };
    }
    if (!this.#jupiter) throw new Error("Jupiter isn't configured");
    const quote = await this.#jupiter.quote(req.mint, PROGRAMS.wsol, req.tokenAmount, req.slippageBps);
    const prebuiltTx = await this.#jupiter.swapTransaction(quote, req.user, this.#priorityMicroLamports !== undefined ? { priorityMicroLamports: this.#priorityMicroLamports } : {});
    return { instructions: [], prebuiltTx, expectedOut: BigInt(quote.outAmount), variant: "jupiter", userTokenAccount };
  }

  async #curveSell(
    req: TradeRequest & { tokenAmount: bigint },
    bc: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchSellState"]>>["bondingCurve"],
    bondingCurveAccountInfo: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchSellState"]>>["bondingCurveAccountInfo"],
    quoteTokenProgram: Web3Module.PublicKey,
    global: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchGlobal"]>>,
    feeConfig: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchFeeConfig"]>>,
    userTokenAccount: string,
  ): Promise<BuiltTrade> {
    const mint = new web3.PublicKey(req.mint);
    const user = new web3.PublicKey(req.user);
    const tokenProgram = programKey(req.tokenProgram);
    const amount = bn(req.tokenAmount);
    const quoteAmount = pump.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount });
    const slippage = req.slippageBps / 100;
    if (!bc.isCashbackCoin) {
      const instructions = await pump.PUMP_SDK.sellV3Instructions({ bondingCurve: bc, mint, user, amount, quoteAmount, slippage, tokenProgram, quoteTokenProgram });
      return { instructions, expectedOut: big(quoteAmount), variant: "pump_curve:v3", userTokenAccount };
    }
    const instructions = await pump.PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve: bc,
      mint,
      user,
      amount,
      solAmount: quoteAmount,
      slippage,
      tokenProgram,
      mayhemMode: bc.isMayhemMode,
      cashback: bc.isCashbackCoin,
    });
    return { instructions, expectedOut: big(quoteAmount), variant: "pump_curve:legacy", userTokenAccount };
  }

  async roundTrip(req: TradeRequest & { lamportsIn: bigint }): Promise<{ instructions: Ix[]; buy: BuiltTrade } | null> {
    if (req.venue === "jupiter") return null;
    const mint = new web3.PublicKey(req.mint);
    const user = new web3.PublicKey(req.user);
    // Sell 70% of what the buy expects: always less than the buy's minimum fill, so the sell
    // can only fail for a reason that would also trap us for real. The sell's own slippage is
    // wide open (99%) because this tests whether a sell can execute, not its price.
    const part = (expected: bigint) => (expected * 70n) / 100n;

    if (req.venue === "pump_curve") {
      const tokenProgram = programKey(req.tokenProgram);
      const [{ global, feeConfig }, st] = await Promise.all([this.globals(), this.#pump.fetchBuyState(mint, user, tokenProgram)]);
      const buy = await this.#curveBuyFromState(req, st, global, feeConfig);
      const sell = await this.#curveSell({ ...req, tokenAmount: part(buy.expectedOut), slippageBps: 9_900 }, st.bondingCurve, st.bondingCurveAccountInfo, st.quoteTokenProgram, global, feeConfig, buy.userTokenAccount);
      return { instructions: [...buy.instructions, ...sell.instructions], buy };
    }

    const st = await this.#amm.swapSolanaState(pump.canonicalPumpPoolPda(mint), user);
    const buyIxs = await pumpSwap.PUMP_AMM_SDK.buyQuoteInput(st, bn(req.lamportsIn), req.slippageBps / 100);
    const expectedOut = ammBuyQuote(st, req.lamportsIn, req.slippageBps / 100);
    const sellIxs = await pumpSwap.PUMP_AMM_SDK.sellBaseInput(st, bn(part(expectedOut)), 99);
    // The buy ends by closing the temporary wrapped-SOL account. The sell needs it, so drop that
    // one close and let the sell's own closing instruction finish the job.
    const last = buyIxs.at(-1);
    const buyKept = last && isWsolClose(last) ? buyIxs.slice(0, -1) : buyIxs;
    const buy: BuiltTrade = { instructions: buyIxs, expectedOut, variant: "pumpswap", userTokenAccount: this.#ata(req) };
    return { instructions: [...buyKept, ...sellIxs], buy };
  }

  async #curveBuyFromState(
    req: TradeRequest & { lamportsIn: bigint },
    st: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchBuyState"]>>,
    global: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchGlobal"]>>,
    feeConfig: Awaited<ReturnType<InstanceType<typeof pump.OnlinePumpSdk>["fetchFeeConfig"]>>,
  ): Promise<BuiltTrade> {
    const mint = new web3.PublicKey(req.mint);
    const user = new web3.PublicKey(req.user);
    const tokenProgram = programKey(req.tokenProgram);
    const bc = st.bondingCurve;
    const quoteAmount = bn(req.lamportsIn);
    const slippage = req.slippageBps / 100;
    const userTokenAccount = this.#ata(req);
    // v3 is the current trade instruction: cheaper, and it can finish a curve and keep buying. Cashback coins need the older one.
    if (!bc.isCashbackCoin) {
      const amount = pump.getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: quoteAmount, curveBaseTokenBalance: st.curveBaseTokenBalance });
      const instructions = await pump.PUMP_SDK.buyExactQuoteInV3Instructions({ bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user, amount, quoteAmount, slippage, tokenProgram, quoteTokenProgram: st.quoteTokenProgram });
      return { instructions, expectedOut: big(amount), variant: "pump_curve:v3", userTokenAccount };
    }
    const amount = pump.getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: quoteAmount, quoteMint: bc.quoteMint });
    const instructions = await pump.PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user, amount, solAmount: quoteAmount, slippage, tokenProgram });
    return { instructions, expectedOut: big(amount), variant: "pump_curve:legacy", userTokenAccount };
  }
}
