# Architecture

```
 ┌──────────── WATCHER ────────────┐     ┌──── VALIDATOR ────┐     ┌──── EXECUTOR ────┐     ┌── EXIT MANAGER ──┐
 │ X (Adin, Banks)        realtime │     │ source checks     │     │ build buy ix     │     │ live price feed  │
 │ Kick (title, chat)     realtime │──▶  │ address checks    │──▶  │ sign (burner)    │──▶  │ take-profit %    │
 │ Telegram channels      realtime │     │ sellability       │     │ send: Jito +     │     │ trailing stop    │
 │ IG / TikTok / YT       polling  │     │ market limits     │     │  Sender + RPC    │     │ max hold time    │
 │ OCR on images, link expansion   │     │ (uses pre-warm    │     │ confirm + record │     │ panic sell       │
 └─────────────────────────────────┘     │  cache)           │     └──────────────────┘     └──────────────────┘
                 ▲                       └───────────────────┘              │                        │
 ┌──────── PRE-WARM ────────┐                                               ▼                        ▼
 │ gRPC: new pump.fun mints │                                     ┌────────── CONTROL ──────────┐
 │ keyword / creator match  │                                     │ Telegram alerts + commands  │
 │ cache accounts + tx tmpl │                                     │ /status /sell /kill         │
 └──────────────────────────┘                                     │ SQLite state + audit log    │
                                                                  └─────────────────────────────┘
```

## Components

### Watcher
- **Sources**: every official account for Adin Ross and FaZe Banks (see `config/accounts.yaml`), tracked by **numeric platform ID**.
- **Tier 1, can trigger a buy:**
  - **X Activity API** `post.create`, filtered by user ID. X says delivery is sub-second, and it costs ~$0.005 per event (pay-per-use since Feb 2026). Filtered Stream (`from:` rule, ~4–5 s P99) runs as a redundant path.
  - **Kick official webhooks** on Adin's user ID 904404: his own chat messages (`chat.message.sent` where sender = broadcaster) and stream title changes. Free.
  - **Twitch EventSub** title and go-live events for both accounts. Free.
- **Tier 2, confirmation only:** YouTube (WebSub), Instagram and Threads (Graph API polling), and Adin's Discord (a followed announcement channel). These are minutes slower, and TikTok and Snapchat have no usable API. **No scraping and no self-bots.** Both break the platforms' terms and get accounts banned.
- **Neither of them has an official Telegram.** Any "Adin Ross Telegram" is fake.
- **Extraction**: Solana base58 regex, plus mint parsing from pump.fun / dexscreener / birdeye / solscan / jup.ag URLs, plus t.co and shortener expansion, plus OCR on attached images (celebs often post a screenshot).
- Dedupes across sources and emits one `AddressSignal {mint, source, postId, receivedAt}`.

### Validator
See [VALIDATOR.md](VALIDATOR.md).

### Executor
- Picks the venue from the cached state: pump.fun bonding curve (official pump SDK) → PumpSwap pool → Jupiter fallback.
- Compute-budget priority fee + Jito tip, both set in config.
- **Fan-out send**: the same signed transaction goes to the Jito block engine, Helius Sender and a standard RPC in parallel. They share one signature, so it can't double-buy.
- **One-shot lock**: the position is written to SQLite *before* sending, so a restart or duplicate signal can't buy twice.
- Confirms through websocket/gRPC and records the fill price and amount.

### Exit manager
- Price from bonding-curve or pool account updates (push, not polling).
- Take-profit ladder: sell a set % of the position at each % gain target.
- Trailing stop, hard stop-loss and max hold time. Note: in a crash, the stop fills *much* worse than the trigger because of slippage.
- Sells get a higher priority fee and tip than buys.
- **On-chain exit triggers**, from the research. Each one sells right away:
  - liquidity removed from the pool (LIBRA's creator pulled $87M);
  - single-sided liquidity withdrawn (MELANIA, YZY);
  - the creator, dev or celebrity wallet sells (DAVIDO, GREED, JASON);
  - the source post is deleted.
- **Take-profit is sized against pool depth, not displayed market cap.** The HAWK sniper's position was worth ~$85M on paper at peak, but they realized ~$2.3M. The pool wasn't deep enough to exit at the displayed price.

### Control and ops
- Telegram bot: alert on every signal, check result, transaction and fill. Commands: `/status`, `/sell <pct>`, `/kill`.
- Modes: `dry-run` (detect + validate + simulate only), `live` (needs `LIVE=1` **and** a funded burner, both set by the owner).
- Audit log of every signal and decision, used for the post-mortem and taxes.

## Latency budget (target)

| Step | Target |
|---|---|
| Post → our watcher (X stream) | ~1–3 s (set by X, mostly outside our control) |
| Extraction + validation (cached) | < 100 ms |
| Sign + fan-out send | < 50 ms |
| Land on-chain (Jito tip) | ~0.4–1 s |
| **Post → bought** | **~2–5 s** |

Insiders who create the token buy in block 0, before the post exists. We can't beat them, and the system isn't designed to. It's designed to be among the first buyers **after the post**, while copycat-token bots are still confused.

## Infrastructure
- **Language**: TypeScript on Node 22 (best Solana SDK support: `@solana/web3.js`, the official pump.fun SDKs, Jito clients).
- **RPC**: paid provider with websocket **and** Yellowstone gRPC (Helius / Triton / QuickNode).
- **Host on launch day**: a VPS in the same region as the RPC and a Jito block engine (e.g. NY or Frankfurt). A home Mac adds latency and can sleep or drop Wi-Fi.
- **Secrets**: `.env` + keypair file outside the repo. Never in git, logs or chat.
