import { web3 } from "../src/chain/sdk.ts";
import type { BuiltTrade, TradeBuilder } from "../src/exec/builder.ts";

/** The token account the fake builder says the user's tokens land in. */
export const ATA = web3.Keypair.generate().publicKey.toBase58();

/** A stand-in for the SDK builder: real, harmless instructions (a memo-sized SOL transfer to self). */
export function fakeBuilder(over: Partial<TradeBuilder> & { extraIxs?: number } = {}) {
  const calls: { op: string; user: string; venue: string; amount: bigint }[] = [];
  // Each built trade is a slightly different instruction, so every transaction has its own signature, as real ones do.
  let seq = 0;
  const ix = (user: string) => web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(user), toPubkey: new web3.PublicKey(user), lamports: ++seq });
  const built = (user: string, expectedOut: bigint, variant: string): BuiltTrade => ({ instructions: [ix(user)], expectedOut, variant, userTokenAccount: ATA });
  const builder: TradeBuilder = {
    buy: async (r) => (calls.push({ op: "buy", user: r.user, venue: r.venue, amount: r.lamportsIn }), built(r.user, 357_000_000_000n, "pump_curve:v3")),
    sell: async (r) => (calls.push({ op: "sell", user: r.user, venue: r.venue, amount: r.tokenAmount }), built(r.user, (r.tokenAmount * 28n) / 1_000_000n, r.venue)),
    roundTrip: async (r) => {
      calls.push({ op: "roundTrip", user: r.user, venue: r.venue, amount: r.lamportsIn });
      const many = Array.from({ length: over.extraIxs ?? 0 }, () => web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(r.user), toPubkey: web3.Keypair.generate().publicKey, lamports: 1 }));
      return { instructions: [ix(r.user), ix(r.user), ...many], buy: built(r.user, 357_000_000_000n, "pump_curve:v3") };
    },
    ...over,
  };
  return { builder, calls };
}

