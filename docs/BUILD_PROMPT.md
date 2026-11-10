# Build prompt

Paste the block below into a Claude Code session opened on this repo to start the build.

---

```
GOAL: Build the Adin Ross / FaZe Banks coin sniper in this repo, following
README.md, docs/ARCHITECTURE.md and docs/VALIDATOR.md. It must be launch-ready
and tested by Nov 17, 2026, two days before GTA 6 releases on Nov 19.

OUTCOME: A TypeScript (Node 22) service that:
1. Watches every official account in config/accounts.yaml by numeric ID:
   X Activity API post.create + Filtered Stream first, then Kick webhooks,
   then Twitch EventSub, then tier-2 confirmation sources. Use official APIs
   only: no scraping, no self-bots.
2. Extracts a Solana mint from post text, links and image OCR.
3. Validates it with the VALIDATOR.md checks, using a pre-warmed cache.
4. Buys through pump.fun curve, then PumpSwap, then Jupiter, with priority
   fee + Jito tip and fan-out send. One-shot lock, so it can never double-buy.
5. Manages the exit with a take-profit ladder, trailing stop, stop-loss,
   max hold time and /sell panic command.
6. Reports every step to my Telegram and accepts /status /sell /kill.

BUILD ORDER (finish and verify each step before starting the next):
M0  [DONE 2026-11-09] Scaffold: npm + TS strict + vitest, config loader
    (yaml + .env), structured logger that redacts secrets, SQLite state.
    Verify: `npm run check` passes and `npm start -- --mode dry-run` boots
    and exits cleanly.
M1  [DONE 2026-11-09] Address extraction + X watcher. Unit-test extraction against fixtures
    (plain address, pump.fun URL, dexscreener URL, t.co link, address in an
    image, a "this is FAKE" warning post, a reply carrying a different
    address). Verify: tests pass, and the watcher logs a post from my test
    X account in dry-run.
M2  [DONE 2026-11-09] Validator against mainnet RPC (read-only). Verify with tests on real
    mints: a normal pump.fun token passes; a mint with freeze authority
    blocks; a Token-2022 mint with a transfer hook or permanent delegate
    blocks; a wallet address blocks.
M3  [EXECUTOR DONE 2026-11-09, pre-warm listener not built] Pre-warm listener (gRPC new pump.fun mints + keyword/creator match)
    and executor in SIMULATE mode only (simulateTransaction, nothing sent).
    Verify: the simulated buy and simulated sell for a live pump.fun token
    both succeed, and the time from signal to signed tx is under 100 ms.
M4  Exit manager + Telegram control. Verify: replay a recorded price series
    and assert each take-profit/stop rule fires at the right point.
M5  End-to-end dry run: I post an existing pump.fun token's address from my
    test X account, and the bot detects, validates, simulates and alerts.
    Report post-to-signed-tx latency.
M6  Launch-day ops: Dockerfile + VPS deploy steps, RUNBOOK.md (start, watch,
    kill, recover), and a pre-flight script that checks RPC, gRPC, X stream,
    Telegram and wallet balance.

HARD RULES:
- You never send a live transaction. Live mode needs MODE=live and LIVE=1,
  which I set myself, plus a funded burner wallet that I create and fund.
  I run every live test myself.
- Never ask me for, print, log or commit a private key, seed phrase or API
  key. Read keys only from paths and env vars in .env.
- The candidate list from pre-warming must never trigger a buy. Only an
  official-account post can.
- Don't add dependencies from unknown GitHub repos. Use official SDKs
  (Solana, pump.fun, Jito, Jupiter, X, Kick, Telegram), and read anything
  else before installing it.
- Keep guardrail numbers (SOL size, slippage, max entry mcap, TP ladder,
  stops) in config/guardrails.yaml with safe placeholders. I'll set the
  real values with you.

STOP AND ASK ME WHEN: an API plan or credential is missing; a platform can't be
watched in real time without breaking its terms; a check in VALIDATOR.md is
ambiguous; or a milestone's verification fails twice for the same reason.

AFTER EACH MILESTONE: commit (ask me which branch first), then report what
changed, the verification you ran with its output, and what's next.
```

---

## What to have ready before running it

See the setup checklist in the [README](../README.md#setup-checklist-what-you-provide).
