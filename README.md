# gta6-coin-sniper

A Solana sniper that buys the coin Adin Ross and FaZe Banks have talked about launching for their GTA 6 roleplay server. It buys **the moment the contract address is posted from one of their official accounts**, then sells on preset % gain rules.

> **Status (Nov 10):** all four parts are built and tested: watcher, validator, executor and exit manager, plus Telegram control. In dry-run the bot catches an official post, validates the token, simulates the buy, and manages a paper position by the sell rules. **It cannot trade real money yet**: dry-run has no sender, live mode is switched off in code, and the guardrail numbers are still placeholders. What's left is on the [launch checklist](#whats-left-before-launch). GTA 6 releases **Nov 19, 2026**. Target: launch-ready by **Nov 17**.

## Quick start

Needs Node ≥ 22.18. TypeScript runs directly, so there's no build step.

```bash
npm install
git config core.hooksPath scripts/git-hooks   # once per clone: blocks secret commits
cp .env.example .env && chmod 600 .env        # then fill it in yourself
npm run check                 # typecheck + tests
npm start -- --mode dry-run   # boots, validates config, writes data/dry-run.sqlite, exits
npm start -- --watch --duration 600   # dry-run X watcher for 10 minutes (omit --duration to run until Ctrl-C)
```

The watcher needs `X_BEARER_TOKEN` in `.env`. It reads addresses in images only when `tesseract` is installed (`brew install tesseract`); without it, images are checked by alt text alone. It never buys anything: it logs each post from a watched account and prints an alert when one carries an address.

### Secrets (this repo is public)

- Every key lives in `.env`, which is gitignored and was never committed. The wallet keypair file lives **outside** the repo.
- `scripts/git-hooks/pre-commit` refuses to commit `.env*` (except `.env.example`), keypair/wallet files, `data/`, and secret-shaped strings: X bearer tokens, Telegram bot tokens, RPC api-keys, GitHub tokens, Solana secret keys.
- GitHub secret scanning and push protection are on as a second net.
- The bot's logs redact every secret. Still, **never show `.env` on screen**. If a key ever appears in a recording, revoke and regenerate it.

Live mode is locked. It needs `--mode live` **and** `MODE=live` + `LIVE=1` in `.env`, guardrails with `status: set`, a take-profit ladder and at least one stop, a wallet, Telegram, and no test accounts. Even with all of that it stays refused while `LIVE_TRADING_AVAILABLE` in `src/config/mode.ts` is `false`, which only the owner changes.

## The one rule

**The only buy trigger is an address posted by an official Adin Ross or FaZe Banks account, matched by numeric account ID.**

Copycat tokens with the same name and ticker show up within seconds of any celebrity launch. Fake accounts post fake addresses in replies, and Kick chat will be full of them. So the bot ignores names, tickers, replies, chat from other users and "leaked" addresses. If the address isn't in an official post, the bot doesn't buy.

## How it works

| Part | Job | State |
|---|---|---|
| **Watcher** | Watches the official accounts and pulls the address out of text, links or images. X by live stream; Kick (the streamer's own chat messages and stream title) and Twitch (stream title) by signed webhooks. An address in a stream **title** is alerted but not bought by default, because mods and editors can change titles. | X verified live. Kick and Twitch tested with fakes; they need the server for a live test. |
| **Validator** | Checks it's the real token, that we can sell it (including a simulated buy-then-sell), and that the buy is within our limits. Not a buy/no-buy judgment. [Spec](docs/VALIDATOR.md) | Verified on mainnet tokens. |
| **Executor** | One buy per coin, ever. pump.fun curve, PumpSwap or Jupiter. Dry-run builds, signs and simulates; it cannot send. [Details](docs/EXECUTOR.md) | Simulated buys verified on mainnet. Live sending is written but has never been run. |
| **Exit manager** | Sells by the rules in `guardrails.yaml`: take-profit ladder, trailing stop, stop-loss, time limit, deleted post, pulled liquidity, creator selling. [Details](docs/EXIT.md) | Verified by replaying price series. |
| **Control** | Telegram alerts, plus `/status` `/sell` `/kill` `/arm`. No command can buy. | Tested with a fake Telegram. |
| **`0x…` addresses** | If an official account posts an Ethereum-style address, the bot finds the chain and alerts with a Uniswap link. It never buys these. | Chain lookup verified on Ethereum and Base. |

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Docs

- [Runbook](docs/RUNBOOK.md): set up, rehearse, go live, recover
- [Architecture](docs/ARCHITECTURE.md)
- [Validator](docs/VALIDATOR.md)
- [Executor](docs/EXECUTOR.md)
- [Exit manager and Telegram](docs/EXIT.md)
- [Build prompt](docs/BUILD_PROMPT.md)
- [Research: past celebrity token launches](docs/research/past-celebrity-launches.md)
- [Research: official accounts + background](docs/research/accounts-and-background.md)
- [Watched accounts config](config/accounts.yaml)

## Friends' alert group (optional)

One X key can only run one bot, because X allows a single stream connection per key. To share the signal, share the alert instead: set `TELEGRAM_ALERT_CHAT_IDS` to a Telegram group or channel your bot is in.

- The group gets each coin an official account posts, with the result of the bot's checks and links to buy by hand (Phantom, Jupiter, pump.fun, a chart; Uniswap for a 0x address).
- A coin the checks blocked is sent as **DO NOT BUY**, with the reason and no links.
- The alert goes out as soon as the checks finish, before the bot's own buy.
- The group can't send commands, and never sees your wallet, your buy size or your trades. Rehearsal posts from your test account are not sent to it.

## Useful commands

```bash
node scripts/preflight.ts --notify        # is everything ready? (read-only)
npm start -- --watch                      # run the bot in dry-run
node scripts/validate-mint.ts <mint> --no-sim                          # run the validator on any coin
node scripts/simulate-trade.ts <mint> --payer <public address with SOL>   # validate + simulated buy + sell quote
node scripts/telegram-chat-id.ts          # find your Telegram chat id
node scripts/new-wallet.ts                # create the bot wallet (you run this; prints the public address only)
```

## What's left before launch

Put every secret into `.env` yourself (copy from `.env.example`). Never paste keys into chat or commit them. Details for each step are in the [runbook](docs/RUNBOOK.md).

- [x] X developer account and bearer token
- [x] Test X account for dry-run (`TEST_X_ACCOUNTS` in `.env`, so it stays out of this repo)
- [x] **Solana RPC** (`RPC_HTTP_URL`, `RPC_WS_URL`). Set on Nov 10: a live coin validates and a simulated buy is signed in about 0.7 s from this Mac.
- [ ] **Guardrail numbers**: SOL per buy, max slippage, take-profit ladder, stops. The shipped file never sells.
- [x] **Telegram bot** and your chat id, for alerts and `/sell` `/kill`. Set on Nov 10: the pre-flight check sent a test message.
- [x] **Bot wallet**: `node scripts/new-wallet.ts` makes `~/sniper-wallet.json` (outside the repo) and prints only the public address. Created on Nov 10 and loads; **not funded yet**. Fund it only with what you can lose.
- [ ] **Server** with an https address, for 24/7 running and for Kick and Twitch.
- [ ] **Kick and Twitch developer apps** (free).
- [ ] **Rehearsal**: post a live pump.fun coin's address from the test account and watch the paper trade.
- [ ] **Your own small live test**, then launch day.

## Known gaps

An independent review of the safety-critical code on Nov 10 found ten issues, mostly in how a live trade's outcome was recorded. All ten are fixed and covered by tests.

- **Live sending has never been run.** It's tested only against fakes. Your small live test is its first real run.
- **No pre-warm cache.** The Jito tip is built and tested but, like all live sending, has never run for real; Jupiter-routed trades carry no tip. See [Executor](docs/EXECUTOR.md).
- **Speed:** about 0.75–0.85 s from signal to signed transaction on Solana's slow public RPC. Re-measure on your own RPC. X itself took about 4.7 s to deliver the test post.
- **Jupiter-routed coins** (not launched on pump.fun): the sell is quoted, not simulated, before buying.
- **`first_signal_fraction` below 1 just buys less.** Topping up on a second source isn't built.
- **Dependencies:** `npm audit` reports 15 advisories (8 moderate, 7 high, 0 critical) in the official Solana and pump.fun SDKs' dependency tree. None is in code this bot calls with outside input, but they're unpatched upstream.
- **Dockerfile is untested.**

## Risk notes

- Insiders usually create the token and buy in block 0, **before** the post. We buy within seconds after the post, often from them.
- Of 15 celebrity launches studied (TRUMP, MELANIA, LIBRA, HAWK, YZY, LAPTOP…), **9 of 14 with a datable peak topped out within ~3 hours, and all 15 are now 90–99.98% below peak.** The snipers who made money sold within minutes to hours. See the [research](docs/research/past-celebrity-launches.md).
- FaZe Banks and Adin Ross have history here. Banks bought into MLG in Jan 2025, and it ran from $11M to $164M before collapsing 99.7%. Banks quit as FaZe CEO after a leaked chat about Adin's community and "exit liquidity." A fake ROSS token, falsely claiming Adin's backing, peaked at ~$7M and crashed. Expect copycats on launch day.
- **The server design breaks the platform rules.** The FiveM/Cfx.re license (updated Sept 10, 2026, signed with Rockstar and Take-Two) bans real-money cash-out (§3.1(1)) and promoting "tokens" or "meme coins" (§3.1(8)). Take-Two shut down RAGE:MP in 2026. The coin's in-game "backing" depends on a server that would be in direct violation.
- **Banks may not be involved anymore.** He and Adin publicly fell out in July 2025 over MLG, and there's no 2026 statement from Banks about the server. As of Nov 9, no server name, Discord, website or token has been announced.
- Every swap is a taxable event in the US. The audit log keeps the records.
- Only put money in the burner wallet that you're fine losing completely.
