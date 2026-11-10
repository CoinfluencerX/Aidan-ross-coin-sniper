# gta6-coin-sniper

A Solana sniper that buys the coin Adin Ross and FaZe Banks have talked about launching for their GTA 6 roleplay server. It buys **the moment the contract address is posted from one of their official accounts**, then sells on preset % gain rules.

> **Status:** Watcher done (M1): X is verified live; Kick and Twitch receivers are built and tested but need the server before a live test. `0x…` addresses from official posts raise a manual-buy alert and are never bought. No validator or trading yet. GTA 6 releases **Nov 19, 2026**. Target: launch-ready by **Nov 17**.

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

Live mode is locked. It needs `--mode live` **and** `MODE=live` + `LIVE=1` in `.env`, real (non-placeholder) guardrails, and a wallet and Telegram setup. Even then it stays refused until the executor ships in M3.

## The one rule

**The only buy trigger is an address posted by an official Adin Ross or FaZe Banks account, matched by numeric account ID.**

Copycat tokens with the same name and ticker show up within seconds of any celebrity launch. Fake accounts post fake addresses in replies, and Kick chat will be full of them. So the bot ignores names, tickers, replies, chat from other users and "leaked" addresses. If the address isn't in an official post, the bot doesn't buy.

## How it works

| Part | Job |
|---|---|
| **Watcher** | Watches every official account (X, Kick, Telegram, IG, TikTok, YouTube…) and pulls the address out of text, links or images. |
| **Validator** | Checks it's the real token, that we can sell it, and that the buy is within our limits. Not a buy/no-buy judgment. [Spec](docs/VALIDATOR.md) |
| **Executor** | Buys through pump.fun, PumpSwap or Jupiter, with priority fee + Jito, sent on several paths at once. One buy only. |
| **Exit manager** | Sells at take-profit % targets, with a trailing stop, stop-loss and time limit. |
| **Control** | Telegram alerts, plus `/status` `/sell` `/kill`. |

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Validator spec](docs/VALIDATOR.md)
- [Build prompt](docs/BUILD_PROMPT.md): paste it into Claude Code to start building
- [Research: past celebrity token launches](docs/research/past-celebrity-launches.md)
- [Research: official accounts + background](docs/research/accounts-and-background.md)
- [Watched accounts config](config/accounts.yaml)

## Setup checklist (what you provide)

Put every secret into `.env` yourself (copy from `.env.example`). Never paste keys into chat or commit them.

- [ ] **X developer account** with pay-per-use credits, for the Activity API `post.create` (~$0.005/event) plus Filtered Stream. Bearer token goes in `.env`.
- [ ] **Your test X account**: the handle, so it can be allowlisted for the dry run.
- [ ] **Solana RPC** with websocket + Yellowstone gRPC (Helius / Triton / QuickNode). URLs and keys go in `.env`.
- [ ] **New burner wallet**: create it yourself (`solana-keygen new -o ~/sniper-wallet.json`), store it outside this repo, and fund it only with what you're willing to lose. Path goes in `.env`.
- [ ] **Telegram bot** from @BotFather, plus your chat ID, for alerts and control.
- [ ] **Kick developer app** (optional), to watch stream titles and Adin's own chat messages.
- [ ] **Launch-day host**: your Mac or a VPS (a VPS is recommended).
- [ ] **Guardrail numbers** (SOL per buy, max slippage, max entry market cap, take-profit ladder, stops). We'll set these together during the build.

## Timeline

| Date | Milestone |
|---|---|
| Nov 9–10 | M0 scaffold, M1 extraction + X watcher |
| Nov 11–12 | M2 validator, M3 pre-warm + simulated executor |
| Nov 13–14 | M4 exit manager + Telegram |
| Nov 15–16 | M5 dry run with your test X account, then your own tiny live test |
| Nov 17 | M6 VPS deploy, runbook, pre-flight |
| Nov 19 | GTA 6 launch |

## Risk notes

- Insiders usually create the token and buy in block 0, **before** the post. We buy within seconds after the post, often from them.
- Of 15 celebrity launches studied (TRUMP, MELANIA, LIBRA, HAWK, YZY, LAPTOP…), **9 of 14 with a datable peak topped out within ~3 hours, and all 15 are now 90–99.98% below peak.** The snipers who made money sold within minutes to hours. See the [research](docs/research/past-celebrity-launches.md).
- FaZe Banks and Adin Ross have history here. Banks bought into MLG in Jan 2025, and it ran from $11M to $164M before collapsing 99.7%. Banks quit as FaZe CEO after a leaked chat about Adin's community and "exit liquidity." A fake ROSS token, falsely claiming Adin's backing, peaked at ~$7M and crashed. Expect copycats on launch day.
- **The server design breaks the platform rules.** The FiveM/Cfx.re license (updated Sept 10, 2026, signed with Rockstar and Take-Two) bans real-money cash-out (§3.1(1)) and promoting "tokens" or "meme coins" (§3.1(8)). Take-Two shut down RAGE:MP in 2026. The coin's in-game "backing" depends on a server that would be in direct violation.
- **Banks may not be involved anymore.** He and Adin publicly fell out in July 2025 over MLG, and there's no 2026 statement from Banks about the server. As of Nov 9, no server name, Discord, website or token has been announced.
- Every swap is a taxable event in the US. The audit log keeps the records.
- Only put money in the burner wallet that you're fine losing completely.
