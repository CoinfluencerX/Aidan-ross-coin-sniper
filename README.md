# Adin Ross coin sniper

A Solana sniper that buys the coin Adin Ross and FaZe Banks have talked about launching for their GTA 6 roleplay server. It buys **the moment the contract address is posted from one of their official accounts**, then sells on preset % gain rules.

> **Status:** planning. No bot code yet. GTA 6 releases **Nov 19, 2026**. Target: launch-ready by **Nov 17**.

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

- [ ] **X API access** with real-time streaming. Bearer token goes in `.env`.
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
- Past celebrity launches mostly peaked within minutes to hours, then crashed. See the [research](docs/research/past-celebrity-launches.md).
- Rockstar's terms ban crypto on roleplay servers. The coin's "backing" depends on a server Rockstar could shut down.
- Every swap is a taxable event in the US. The audit log keeps the records.
- Only put money in the burner wallet that you're fine losing completely.
