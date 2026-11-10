# Exit manager and Telegram

## When the bot sells

Code: `src/exit/rules.ts` (the rules, one pure function) and `src/exit/manager.ts` (reads prices and calls the executor). Every number comes from `config/guardrails.yaml`. **The shipped file has no ladder and no stops, so the bot would never sell.** Live mode refuses to start in that state.

Checked every `price_poll_ms`, in this order. The first rule that fires wins.

| # | Rule | Sells | Setting |
|---|---|---|---|
| 1 | You sent `/sell` | Everything | — |
| 2 | The post that triggered the buy was deleted | Everything | `sell_on_source_deleted`, checked every 20 s for `source_deleted_window_minutes` (X posts only) |
| 3 | Liquidity pulled from the pool | Everything | `sell_on_liquidity_removed`, `liquidity_removed_drop_pct` (PumpSwap only: a bonding curve's liquidity can't be pulled) |
| 4 | The coin's creator wallet is selling | Everything | `sell_on_creator_sell`, `creator_sell_drop_pct` |
| 5 | Stop-loss: price this far below entry | Everything | `stop_loss_pct` |
| 6 | Trailing stop: price this far below its peak | Everything | `trailing_stop_pct` |
| 7 | Held too long | Everything | `max_hold_minutes` |
| 8 | Take-profit ladder | Each step's share of the **original** position | `take_profit_ladder` |

Things to know when choosing numbers:
- **The trailing stop is active from the moment of the buy.** The peak starts at the entry price, so a 30% trailing stop also acts as a 30% stop-loss until the price rises.
- **A ladder that adds up to less than 100% leaves the rest riding** until a stop or `max_hold_minutes` sells it.
- **If the price jumps past two steps between checks, both are sold together.**
- **Rules 5, 6 and 8 need a price.** While the price can't be read (for example mid-migration), only rules 1–4 and 7 can fire. A coin bought through Jupiter is priced from a Jupiter sell quote for what you hold.
- **Each ladder step is recorded together with the sale**, and in live mode an unconfirmed sale is checked against the wallet before it's called failed, so a step can't be sold twice.
- **One empty balance reading never closes a position.** The wallet has to read empty twice in a row.
- **A failed sell is retried on every check** and you're told once. In live mode each attempt is capped by what the wallet really holds.
- Sells use `buy.max_slippage_bps` as their slippage limit.

Verified by replaying price series in `test/exit.test.ts`: each ladder step fires once at the first tick that reaches it, and each stop fires at its threshold and not one tick earlier.

## Not built

- Sizing a take-profit sale by pool depth. Each step sells its full share at once.
- Watching for single-sided liquidity withdrawal as its own signal. A drop in the pool's SOL side (rule 3) covers the common case.
- Deleted-post checks for Kick and Twitch.

## Telegram

Your own bot, talking only to your chat. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` in `.env`; `node scripts/telegram-chat-id.ts` prints your chat id.

| Command | What it does |
|---|---|
| `/status` | Mode, whether buying is armed, what's watched, each open position |
| `/sell` | Sell everything now. `/sell 3` sells only position 3 |
| `/kill` | Stop buying. Open positions are still managed and sold by the rules |
| `/arm` | Allow buying again |
| `/help` | The list |

- **No command can buy.** Only a post from an official account can.
- Commands from any other chat are ignored and logged.
- Commands sent while the bot was off are discarded when it starts, so an old `/sell` can't fire on restart.
- You get a message for: startup, every address caught (with the validator's verdict and the buy result), every `0x…` address (with a Uniswap link), every sale, every failed sale, each closed position with its result, and shutdown.
- **Stopping the bot does not sell.** If it stops with a position open, it says so, and nothing manages that position until it's started again. On restart the exit manager picks open positions back up from the database.
