# Validator spec

The validator doesn't decide whether the coin is a good investment. That decision is already made: if an official account posts an address, we buy. Its job is to answer three questions in under ~100 ms, using data cached before the post lands:

1. **Is this the real token?** (not a copycat, a wallet address, or a typo)
2. **Will we be able to sell it?** (no freeze or honeypot mechanics)
3. **Is the buy still within our limits?** (price, size, liquidity)

Anything that fails a **BLOCK** check stops the buy and sends a Telegram alert. **WARN** checks log the issue and alert us, but the buy goes through. Every check can be set to `block`, `warn` or `off` in `config/validator.yaml`.

## Checks

### 1. Source checks (does the post count?)

| Check | Default | Why |
|---|---|---|
| Author matches an allowlisted **numeric account ID** (not handle or display name) | BLOCK | Handles can be renamed. Impersonators copy display names. |
| Post is original, or a repost/quote of another allowlisted account | BLOCK | Replies and quote-tweets from strangers carry fake addresses. |
| Address appears in the post itself (text, link, or OCR of an attached image) | BLOCK | Never take an address from replies or comments. |
| If both Adin and Banks post, the addresses match | BLOCK on mismatch | Two different addresses means something is wrong. Halt and alert. |
| Post isn't a "don't buy X, it's fake" warning | WARN | Celebs often post fake addresses to warn people. A keyword filter flags "fake", "not mine" and "scam". |
| **Hacked-account guard**: optionally buy part of the size on the first official post, and the rest only when a second source confirms the same address (the other person, or another platform) | Setting for the guardrails session | Official accounts do get hacked. Roaring Kitty's X posted a pump.fun address (RKC, −85% within the hour). Kanye's Instagram promoted a fake coin (−96%). See [research](research/past-celebrity-launches.md). |
| **Deleted post**: if the source post disappears within N minutes, the exit manager sells | Exit trigger | Hacked or fake posts get deleted fast: RKC within an hour, ROSS in ~20 min. |

**Decoy contracts:** for YZY, Kanye's team deployed 25 contracts and made one of them official, to beat snipers who guess the address. Our bot never guesses, so decoys don't fool it. It's one more reason the pre-warm list must never trigger a buy.

### 2. Address checks (is it a token?)

| Check | Default | Why |
|---|---|---|
| Valid base58 32-byte public key | BLOCK | Typos, truncated addresses. |
| Account is a **mint**, owned by SPL Token or Token-2022 | BLOCK | Celebs sometimes post wallet addresses. |
| Mint isn't on the `blocked_mints` list in `config/accounts.yaml` | BLOCK (core) | Known fakes, like the "Official Adin Ross Coin" already on pump.fun. |
| Mint was created recently (configurable, e.g. < 24h) | WARN | An old token is probably not the new launch. |
| Token name or symbol relates to the post text | WARN | Catches the wrong address being pasted. |

### 3. Sellability checks (can we exit?)

| Check | Default | Why |
|---|---|---|
| **Freeze authority is null** | BLOCK | With freeze authority, the issuer can freeze our tokens so we can never sell. pump.fun tokens always have this null. |
| No dangerous Token-2022 extensions: transfer hook, permanent delegate, non-transferable, pausable | BLOCK | These are the main honeypot mechanics on Solana. |
| Transfer fee ≤ configured max (e.g. 1%) | BLOCK | A 99% transfer fee is a honeypot. |
| **Sell simulation passes**: `simulateTransaction` of a sell for the size we'd buy | BLOCK | The most direct honeypot test. Costs nothing, sends nothing. |
| Mint authority revoked | WARN | If not revoked, the issuer can print more supply. pump.fun revokes it. A custom launch might not. |

### 4. Market checks (within our limits?)

| Check | Default | Why |
|---|---|---|
| A route exists: pump.fun bonding curve (not complete), PumpSwap pool, or Jupiter route | BLOCK | Nowhere to buy. |
| Liquidity can absorb our size within max slippage | BLOCK | Stops us from moving the price against ourselves. |
| Market cap at entry ≤ `max_entry_mcap` | Set later in guardrails | Stops us buying the top after a 50x. |
| Price is ≤ X× the token's first trade price | Set later in guardrails | Same idea, relative to launch. |
| Top-10 holder %, first-block bundle %, dev wallet % | WARN | Shows how much insiders hold and could dump. Shown in the alert. Feeds the exit manager. |

## What about tokenomics?

Classic tokenomics (vesting schedules, team allocations, unlocks) matters for whether a coin holds value over weeks. It doesn't matter in the first 30 seconds, and it's too slow to read in the hot path. On pump.fun, every token has the same fixed supply (1B) and curve, so there's nothing to analyze.

If the coin launches **outside** pump.fun (a custom launch like TRUMP's, where 80% of supply sat with insiders under unlock schedules), the bot logs the supply breakdown, top wallets and authorities to the alert. The exit manager can sell faster when insiders hold most of the supply. That's a post-buy input, not a blocker.

## Pre-warming (how we stay fast)

The validator does most of its work **before** the post:

- An on-chain listener (Yellowstone gRPC or websocket) watches new pump.fun and launchpad mints. It flags candidates whose name or symbol matches keywords (`adin`, `ross`, `gta`, `banks`, `faze`, …) or whose creator is a known wallet.
- For each candidate, we cache the mint, authorities, extensions, bonding-curve and pool accounts, and an **unsigned buy-transaction template**.
- When the official post arrives, address extraction → cache lookup → sign → send. The candidate list never triggers a buy by itself. **Only an official post can.**
