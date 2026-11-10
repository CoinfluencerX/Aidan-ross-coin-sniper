# Executor

The executor turns a validated signal into one buy, and the exit manager's decisions into sells. Code: `src/exec/`.

## What it can and can't do

| | Dry-run | Live |
|---|---|---|
| Builds and signs the transaction | Yes | Yes |
| Simulates it on current chain state | Yes | Yes (the validator's sell simulation) |
| Sends it | **No.** No sender object exists in dry-run. | Yes |
| Records | A paper position and `simulated` trades | Real positions, trades with signatures |

Live mode needs all of: `--mode live`, `MODE=live`, `LIVE=1`, guardrails with `status: set`, a wallet, Telegram, an empty `test_accounts` list, **and** `LIVE_TRADING_AVAILABLE = true` in `src/config/mode.ts`. That last switch is `false` in the repo. Only the owner turns it on.

`src/exec/send.ts` is the only file that can put a transaction on chain. `src/chain/rpc.ts` has no send method, and a test checks that.

## One buy per coin, ever

Before anything is built, the executor takes the one-shot lock (`positions` row, unique per mint). If the buy then fails, the mint stays locked and the bot never retries it: a "failed" send can still have landed, so a retry could buy twice. It also refuses a new coin while `max_open_positions` are open.

## Where it buys

| Venue | When | How |
|---|---|---|
| pump.fun bonding curve | Curve exists and isn't complete | Official SDK, `buy_exact_quote_in_v3` (older instruction for cashback coins) |
| PumpSwap | The token graduated | Official SDK, `buyQuoteInput` on the canonical pool |
| Jupiter | Not a pump.fun token | Jupiter swap API builds the transaction |

A curve that is complete but not yet migrated has no venue for a few seconds. The validator blocks with "mid-migration". The buy lock is not taken in that case, so a second official post can still trigger a buy once the pool exists.

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

## Not built

- **Pre-warm listener** (watching new pump.fun mints and caching candidates before the post). It would remove one RPC round trip. It never triggers a buy by design, so skipping it costs speed, not safety.
- **Jito bundles.** The live sender fans the signed transaction out to the RPC and, if `JITO_BLOCK_ENGINE_URL` is set, to Jito's transaction endpoint. No tip instruction is added yet, so `jito_tip_lamports` has no effect.

## Try it

```bash
node scripts/simulate-trade.ts <mint> --payer <public address with SOL>
```

Read-only: validates the mint, simulates the buy, quotes the sell, prints timings.
