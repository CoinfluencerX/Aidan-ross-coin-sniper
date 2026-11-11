# Runbook

How to set up, rehearse, run and recover the bot. Commands assume you're in the repo folder.

## The safety model in one paragraph

The bot starts in **dry-run** unless three things all say live: `--mode live` on the command line, `MODE=live` and `LIVE=1` in `.env`. Live also needs real guardrails, a wallet, Telegram, no test accounts, and the code switch `LIVE_TRADING_AVAILABLE` in `src/config/mode.ts`, which is `false` in the repo. In dry-run there is no object that can send a transaction. **Stopping the bot never sells**, and **no Telegram command can buy**.

## 1. One-time setup

On your Mac or on the server (Ubuntu shown):

```bash
sudo apt-get install -y tesseract-ocr
```

Install Node 22.18 or newer, then:

```bash
npm ci --ignore-scripts
```

```bash
git config core.hooksPath scripts/git-hooks
```

```bash
cp .env.example .env && chmod 600 .env
```

Fill `.env` in yourself. What each key unlocks:

| Key | Needed for | Where it comes from |
|---|---|---|
| `X_BEARER_TOKEN` | Watching X (already set) | X developer portal |
| `TEST_X_ACCOUNTS` | Rehearsals in dry-run | Your own X account as `handle:user_id`. Get the number with `node scripts/x-lookup-user.ts yourhandle` |
| `RPC_HTTP_URL`, `RPC_WS_URL` | Validator, executor, exit manager | Your Solana RPC provider. The lines ship ready for Helius: paste your key over `PASTE_HELIUS_KEY_HERE` on both |
| `JITO_BLOCK_ENGINE_URL` | Faster landing: trades also go to Jito, with the tip from `guardrails.yaml` | Ships set to Jito's global address; pick the region nearest your server from docs.jito.wtf |
| `SIM_PAYER_PUBKEY` | Dry-run buys before your wallet is funded | Any public address that holds SOL |
| `WALLET_KEYPAIR_PATH` | Live trading, and realistic dry-runs | `node scripts/new-wallet.ts` (makes `~/sniper-wallet.json`, readable only by you, and prints the line to paste). `solana-keygen` files work too. Keep it outside the repo; there is no seed phrase, so keep one offline copy |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | Phone alerts, `/sell`, `/kill` | @BotFather, then `node scripts/telegram-chat-id.ts` |
| `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | Adin's Kick chat and title | kick.com → Settings → Developer |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_EVENTSUB_SECRET` | Twitch stream titles | dev.twitch.tv/console; the last one is any random string you make up |
| `WEBHOOK_PUBLIC_URL`, `WEBHOOK_PORT` | Kick and Twitch (server only) | Your server's https address |

**Kick and Twitch only work on the server**, because they deliver to a public https address. Put a reverse proxy in front of the bot. With Caddy, the whole config is:

```
bot.yourdomain.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then set `WEBHOOK_PUBLIC_URL=https://bot.yourdomain.com`, and in the Kick developer app set the webhook URL to `https://bot.yourdomain.com/webhooks/kick` and switch webhooks on. Twitch is registered by the bot itself at start.

## 2. Before every start

```bash
node scripts/preflight.ts --notify
```

It checks config, RPC speed, the pump.fun SDK against your RPC, X accounts and subscriptions, Kick, Twitch, Telegram (and sends you a test message), the wallet balance, and the clock. Fix every FAIL. Read every WARN.

## 3. Start in dry-run

```bash
npm start -- --watch
```

Stop with Ctrl-C (once: it shuts down cleanly; twice forces it). For a fixed run add `--duration 600`.

Healthy start-up, in order: `executor.ready` with `"can_send": false`, `x.accounts.verified`, `watch.started` showing `validator: on`, `executor: simulate only`, `exit_manager: on`, then two `x.stream.connected` lines. Those last two show up about 20 seconds after `watch.started`.

To keep it running on the server, use a systemd unit (`/etc/systemd/system/sniper.service`):

```
[Unit]
Description=gta6-coin-sniper
After=network-online.target

[Service]
WorkingDirectory=/home/sniper/gta6-coin-sniper
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.ts --watch
Restart=always
RestartSec=2
User=sniper

[Install]
WantedBy=multi-user.target
```

`Restart=always` is safe: the buy lock is in the database, so a restart can't buy a coin twice. On start the bot first settles any buy that was in flight when it stopped (by reading the wallet), then picks open positions back up. If X can't be reached while a position is open, it stays running to manage that position instead of exiting. A Dockerfile is in the repo too, but it has **not been built or run yet**.

## 4. Rehearse

1. Start the bot in dry-run.
2. From your test X account, post the address of a real pump.fun coin that's trading right now.
3. Within a few seconds you should get one alert: who posted, the validator's verdict, and `BUY SIMULATED` with the time from post to signed transaction.
4. Send `/status` in Telegram to see the paper position. Send `/sell` to close it on paper.

To check any coin without posting:

```bash
node scripts/simulate-trade.ts <mint> --payer <public address with SOL>
```

Set test guardrails first if you want to see the sell rules fire. With the shipped placeholders the bot never sells.

## 5. Going live (you do every step)

Do these in order, and only after the guardrails session:

1. `config/guardrails.yaml`: real numbers, a take-profit ladder, at least one stop, `status: set`.
2. `.env`: empty `TEST_X_ACCOUNTS`.
3. Fund the bot wallet. Set `WALLET_KEYPAIR_PATH` in `.env`. Remove `SIM_PAYER_PUBKEY`.
4. `src/config/mode.ts`: set `LIVE_TRADING_AVAILABLE = true`.
5. `.env`: `MODE=live` and `LIVE=1`.
6. `node scripts/preflight.ts --for live --notify` must show no FAIL.
7. Start with `npm start -- --mode live --watch`. Check `executor.ready` says `"can_send": true` and shows **your** wallet address.

**Your first live run should be a small test, not launch day.** Test accounts are refused in live mode on purpose, so to test live: set a tiny `sol_per_buy`, temporarily add your own X account to `accounts.yaml` as an `x` entry with `tier: 1` under a throwaway person name, post a real coin's address, watch the buy and the sells, then remove the entry again. Don't commit that edit: `accounts.yaml` is public. This is the first time the sending code runs for real.

Starting in live mode also removes the bot's X subscription for the test account, so its posts stop being delivered and billed.

## 6. While it's running

| You see | It means |
|---|---|
| Green alert, `VALIDATOR: PASS`, `BOUGHT` | It bought. The exit manager is now watching the position |
| Red alert, `VALIDATOR: BLOCKED` | It did not buy. The lines marked ✗ say why |
| `BUY SENT, RESULT UNKNOWN` | Live only. The buy went out but the bot can't yet tell if it landed. It keeps checking the wallet and will message you. Look at the wallet yourself too |
| `X can't be watched … Still managing N open position(s)` | X is down or the token stopped working. Nothing new will be bought, but the sell rules and `/sell` still run. Fix X and restart |
| `BUY FAILED … This mint is now locked` | The buy didn't go through and the bot will **not** retry that coin. Buy by hand if you still want it |
| `BUY SKIPPED: another position is still open` | `max_open_positions` is reached |
| `ETHEREUM-STYLE ADDRESS: BUY BY HAND` | A `0x…` address was posted. The bot doesn't buy these. Use the Uniswap link |
| `SELL FAILED … Retrying` | A sale didn't go through. It retries every price check. Consider `/sell`, or sell by hand |

Telegram: `/status`, `/sell`, `/sell 3`, `/kill` (stop buying), `/arm`, `/help`.

## 7. Stopping

- **Stop buying, keep managing positions:** `/kill`.
- **Sell everything:** `/sell`.
- **Stop the program:** Ctrl-C, or `sudo systemctl stop sniper`. This does **not** sell. If a position is open the bot says so. Start it again to resume managing it.

## 8. Recovering

- **It crashed or the server rebooted:** start it again. Open positions resume. The same coin can't be bought twice.
- **A position shows `failed`:** the buy errored before sending, failed on chain, or expired with an empty wallet. That coin is locked for good.
- **A position shows `pending`:** a buy was sent and its result isn't known yet. The bot keeps reading the wallet and opens or fails it. Check the wallet on Solscan yourself.
- **You sold by hand:** the bot will try to sell, find nothing, and close the position.
- **See what the bot knows** (read-only):

```bash
sqlite3 data/live.sqlite "SELECT id, mint, status, simulated, tokens_held, cost_lamports, proceeds_lamports, close_reason FROM positions"
```

```bash
sqlite3 data/live.sqlite "SELECT at, kind FROM audit_log ORDER BY id DESC LIMIT 30"
```

Use `data/dry-run.sqlite` for dry-run. Each mode has its own database, so a dry-run rehearsal never locks a coin for live.

- **A key appeared on screen or in a recording:** revoke and regenerate it at the provider, then update `.env`. For the wallet, move the funds to a new wallet.
