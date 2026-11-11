# Executor

The executor turns a validated signal into one buy, and the exit manager's decisions into sells. Code: `src/exec/`.

## What it can and can't do

| | Dry-run | Live |
|---|---|---|
| Builds and signs the transaction | Yes | Yes |
| Simulates it on current chain state | Yes | Yes (the validator's sell simulation) |
| Sends it | **No.** No sender object exists in dry-run, and the transaction handed to the RPC for simulation is never signed. | Yes |
| Records | A paper position and `simulated` trades | Real positions, trades with signatures |

Live mode needs all of: `--mode live`, `MODE=live`, `LIVE=1`, guardrails with `status: set`, a wallet, Telegram, no test accounts, **and** `LIVE_TRADING_AVAILABLE = true` in `src/config/mode.ts`. That last switch is `false` in the repo. Only the owner turns it on.

`src/exec/send.ts` is the only file that can put a transaction on chain. `src/chain/rpc.ts` has no send method, and a test checks that.

## One buy per coin, ever

Before anything is built, the executor takes the one-shot lock (`positions` row, unique per mint). It also refuses a new coin while `max_open_positions` are open, pending ones included.

- **Before anything is sent**, a failure (an RPC hiccup while building) is retried up to 3 times. That's safe: nothing has left the machine.
- **Once a send is attempted, there is never a retry**, even if the send call itself errors. A send that "failed" can still have landed.
- **The bot never guesses whether a sent buy landed.** The transaction's signature is written to the database before sending. Then it waits up to 90 s for confirmation and reads the wallet:
  - tokens in the wallet → the position opens, whatever the confirmation said;
  - the chain reports the transaction failed → marked failed;
  - it expired and two balance reads agree the wallet is empty → marked failed;
  - anything else (confirmed but not visible yet, or the balance can't be read) → the position stays **pending** and you get `BUY SENT, RESULT UNKNOWN`. The bot re-checks the wallet every second and tells you when it settles. It only gives up after 3 minutes with an empty wallet.
- **After a crash or restart**, pending rows are settled the same way before anything else happens.
- A mint that ends up failed stays locked for good.

## Where it buys

| Venue | When | How |
|---|---|---|
| pump.fun bonding curve | Curve exists and isn't complete | Official SDK, `buy_exact_quote_in_v3` (older instruction for cashback coins) |
| PumpSwap | The token graduated | Official SDK, `buyQuoteInput` on the canonical pool |
| Jupiter | Not a pump.fun token | Jupiter swap API builds the transaction |

**How much SOL a buy can spend:** on the bonding curve, at most `sol_per_buy`, fees included. On PumpSwap, the SDK's "spend this much SOL" buy allows up to `max_slippage_bps` **more** than `sol_per_buy` if the price moves while the transaction is in flight. Size the wallet for that.

A curve that is complete but not yet migrated has no venue for a few seconds. The engine waits for the pool: it re-checks every 1.5 s for up to 45 s, then gives up with "mid-migration". The buy lock is only taken once the validator passes.

Sells re-check the venue each time, so a coin bought on the curve is sold on PumpSwap after it graduates.

## The sell simulation (the honeypot test)

Before buying, the executor simulates **one transaction that buys our size and sells 70% of it straight back**. If the sell leg can't run, the validator blocks the buy. Nothing is signed or sent for this.

Limits to know about:
- **Jupiter tokens:** a buy and a sell can't share one transaction there. The buy is simulated and a sell route must be quoted, but the sell itself isn't simulated. The freeze-authority and Token-2022 extension checks still apply.
- **Who the simulation runs as:** it needs an address that holds SOL. In live mode that's the wallet. In dry-run, set `SIM_PAYER_PUBKEY` to any public address with SOL until your own wallet is funded. No key is involved: signature checks are off in simulation.

## Dry-run sells are paper sells

In dry-run the simulated buyer doesn't hold the tokens, so a sell can't be simulated by itself. Dry-run sells are priced from a live quote (the SDK's own math on current reserves) and recorded as `simulated`.

## Speed

Measured 2026-11-09 through Solana's **public** RPC endpoint, which is slow:

| Step | Time |
|---|---|
| Validator, including the buy+sell simulation | 730–850 ms |
| Build and sign the buy (reuses the instructions just simulated) | 8–11 ms |
| Signal to signed transaction | 740–860 ms |

Almost all of it is network round trips to the RPC node. A paid RPC close to the server should cut this several times over; measure again once `RPC_HTTP_URL` is set. The original target of under 100 ms from signal to signed transaction is **not met** and won't be without the pre-warm cache below. For scale: X took about 4.7 s to deliver the test post.

## Jito tip

When `JITO_BLOCK_ENGINE_URL` is set and `jito_tip_lamports` in `config/guardrails.yaml` is at least 1,000, every buy and sell built from pump.fun or PumpSwap instructions ends with a SOL transfer of that amount to one of Jito's eight tip accounts (picked at random). The signed transaction then goes to both your RPC and Jito.

- The tip is part of the trade's own transaction, so it is only paid if the trade lands. It is paid whichever path lands it.
- Dry-run adds the same instruction to the simulated buy, so paper buys are the same size and cost as live ones.
- It is **not** added to Jupiter's prebuilt transactions or to the validator's buy-and-sell-back test.
- No Jito address, or a tip of 0, means no tip. A tip larger than `sol_per_buy` is refused as a typo.
- Measured on real coins on Nov 10: the largest tipped transaction (a PumpSwap buy) is 1,130 bytes of the 1,232 allowed.
- Jito allows about one request a second per address without an API key. That is enough for one buy and a ladder of sells.

The tip amount is the owner's number, like every other guardrail. Tipped sending has never run for real.

## Not built

- **Pre-warm listener** (watching new pump.fun mints and caching candidates before the post). It would remove one RPC round trip. It never triggers a buy by design, so skipping it costs speed, not safety.
- **Jito bundles.** The bot sends one tipped transaction, not a bundle (see below).

## Try it

```bash
node scripts/simulate-trade.ts <mint> --payer <public address with SOL>
```

Read-only: validates the mint, simulates the buy, quotes the sell, prints timings.
