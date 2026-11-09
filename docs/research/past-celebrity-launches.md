# Celebrity and influencer memecoin launches: how they performed after launch (2024 to Nov 2026)
Prepared 2026-11-09 by research agent. Figures marked (snippet) come from search snippets only; (calc) figures are derived.

Every figure has a bracketed source number that maps to the **Sources** list at the end.

**How to read the figures**
- **"(calc)"** means I computed the figure from cited inputs. The inputs are shown, and the arithmetic is mine.
- **"(snippet)"** means the figure appeared only in a search-engine result summary. I could not open the page itself, so treat these as lower confidence.
- **Market caps mix two bases.** Some sources report circulating-supply market cap (for example, TRUMP had 200M tokens circulating), others report fully diluted value (FDV, the full 1B supply), and outlets mix them without saying which. For tokens on Meteora with locked supply, DexScreener and Birdeye style "mcap" figures are often FDV. Conflicts are flagged where they occur.
- **"Status now"** comes from the CoinGecko markets API (snapshot about 2026-11-09 05:07–05:13 UTC) [3] and GeckoTerminal pool data (about 05:00 UTC) [18].
- **Time-of-launch proxies:** where a launch time isn't published, I used GeckoTerminal's pool-creation timestamp. For pump.fun tokens that timestamp is the Raydium migration, which can come slightly after the token was created.
- **Data gaps:** free GeckoTerminal data only goes back 180 days and free CoinGecko history only 365 days. So true 1h/24h/7d/30d price series could only be pulled for 2026 launches (LAPTOP). For older launches, checkpoints come from press reports and are often "not found."
- **Not advice:** I'm not a licensed financial advisor. Section 3 describes historical patterns, not a recommendation.

---

## 1. Summary table

| Token | Launched / promoted by | Date (UTC) | Chain · platform | Peak mcap | Time to peak | Drawdown from peak | Status now (2026-11-09) |
|---|---|---|---|---|---|---|---|
| TRUMP | Donald Trump (CIC Digital / Fight Fight Fight) | 2025-01-18 ~02:00 [1][2] | Solana · Meteora [13][4] | ~$14.7B circulating / ~$73B FDV (calc from $73.43 ATH × 200M or 1B) [3][4]; reported "$15B" [13] | ~26h (CoinGecko ATH 01-19 03:50) [3]; ~34h on CMC ($75.35) [2] | −98.4% [3] | Trading; $1.14, mcap $323M, FDV $1.14B [3] |
| MELANIA | Melania Trump (Bubblemaps links the creator to Hayden Davis's 0xcEA wallet) [17] | 2025-01-19 ~20:26–21:00 [18][13] | Solana · Meteora [18] | Conflicting: ~$2B [14] / $6.14B [13] / ~$13B FDV (calc, $13.05 ATH × 1B) [3] | ~2–2.6h (ATH 23:00 UTC) [3][18] | −99.6% [3] | Trading; $0.057, mcap $56.6M [3] |
| LIBRA | Promoted by Javier Milei; run by Kelsier / Hayden Davis | Minted 2025-02-14 21:38; Milei's post 22:01 [19] | Solana · Meteora [20] | ~$4B [19] to $4.5–4.56B [17][21] | 43 min after the post (66 min after mint) [19] | −99.9% (calc: $0.00334 vs $4.55) [3][19] | Near-dead; mcap ~$1.0M, FDV $3.3M [3][18] |
| HAWK | Haliey Welch / overHere launchpad | 2024-12-04 ~22:00 [25 (snippet)][18] | Solana · Meteora via overHere [22][24] | ~$490M [22] / ~$500M [23] | "Within hours" [23]; exact time not found | −99.8% (calc: FDV ~$0.95M vs $490M) [18][22] | Dead; FDV ~$0.95M, 24h vol ~$100 [18] |
| JENNER | Caitlyn Jenner (Sahil Arora deployed) [28] | 2024-05-26 ~20:13 [27][18] (Cointelegraph says 05-28 [29]: conflict) | Solana · pump.fun [27] | ~$42M [28] (Cointelegraph: ">$30M in 24h" [29]) | ~1–2 days (sources conflict) [28][29] | −99.8% (calc: FDV ~$77K) [18] | Dead; FDV ~$77K [18] |
| MOTHER | Iggy Azalea | 2024-05-28 ~21:00 [33][18] | Solana · Raydium pool [18] (pump.fun origin claimed in some coverage but disputed; see section) | Conflicting: $134M [29] / $148.97M [36] / ~$223M (calc) [3] / $240M [35] | ~8.5 days (CoinGecko ATH 06-06) [3] | −99.9% [3] | Near-dead; mcap $236K [3] |
| DADDY | Developer "Issathecooker"; Andrew Tate promoted (got a 40% airdrop) [39] | 2024-06-09 ~20:18 [39][18] | Solana · pump.fun → Raydium [18] | $340M [35] / ~$289M (calc, $0.2886 × 1B) [3] | ~4.3 days (ATH 06-14 03:48), ~2 days after Tate's push [3][40] | −97.9% [3] | Trading (small); mcap $3.7M [3] |
| JASON | Jason Derulo (Sahil Arora involved) | 2024-06-23 [41] | Solana · pump.fun [41][42] | ~$11M (calc from ATH ~$0.011 × 1B) [41] | First spike 5 min after his tweet; ATH within ~1 day [41] | −99.7% (calc: FDV ~$36K) [18] | Dead; FDV ~$36K [18] |
| DAVIDO | Davido | 2024-05-29 [43] | Solana · pump.fun [43] | ~$10M [44] | Same or next day; exact time not found | −99.9% (calc: FDV ~$10K) [18] | Dead; FDV ~$10K, no volume [18] |
| YZY | Kanye West / Yeezy Investments | 2025-08-20 (ATH 18:38 UTC) [3]; Cointelegraph says "Thursday" [47] (conflict) | Solana · Meteora, single-sided liquidity [18][46] | ~$3B (FDV) [45][46] | ~40 min [46] | −90.2% [3] | Trading; $0.288, mcap $86.1M, FDV $288M [3] |
| CAR | Faustin-Archange Touadéra, president of the Central African Republic | 2025-02-09 [50] | Solana; platform not found [50] | $894M [50] / ~$776M at CoinGecko ATH [3] | ~2.5h [51 (snippet)] | −99.8% [3] | Near-dead; mcap $1.89M [3] |
| LAPTOP (Base) | Hunter Biden / Phoenix Veritas | 2026-09-09 12:00 [52][54] | Base · Aerodrome + Uniswap [52] | Not meaningful: $100–144B FDV prints on ~$5K liquidity [52]; ATH $199.51 [3] | ~9 min (calc: ATH 12:09 vs 12:00 open) [3][54] | −99.98% [3] | Trading; $0.034, mcap $5.8M, FDV $29.8M [3] |
| FLOYD (Mayweather) | Sahil Arora; Mayweather's accounts promoted it [55] | 2026-10-13 (dates conflict) [55] | Solana · Fomo [55] | ~$1M [55] | Not found | −96% within 3h [55] | Not found (contract address not confirmed) |
| RKC | Posted from Roaring Kitty's X account, likely compromised [56] | 2026-05-11 [56] | Solana · pump.fun [56] | ~$11–12M [56][57] | Minutes [56] | ~−85% within the hour ($12M → $1.8M) [56]; −92% vs CoinGecko ATH [3] | Near-dead; mcap $708K [3] |
| GREED | Dave Portnoy | 2025-02-19 [59] | Not stated [59] | ~$30M [59] | ≤1h [59] | −90% and −99% both reported [59] | Not found |
| MLG (not a launch) | Existing token pumped by FaZe Banks; Adin Ross involved [61][62] | Created Apr 2024; FaZe pump Jan 2025 [61] | Solana · Raydium [18] | $164.45M [61] / ~$187M (calc, ATH 2025-02-03) [3] | 5 days after Banks bought in [61] | −99.7% [3] | Near-dead; mcap $627K [3] |
| ROSS | @RoundtableSpace (Mario Nawfal-linked), falsely claiming Adin Ross's backing [64] | 2025-03 [64] | Solana [64] | ~$7M [64] | Not found | −82.7% (one chart) and >95% in 24h (GeckoTerminal) [64] | Not found |
| SERIOUS | **Not found** (see section) | — | — | — | — | — | — |

---

## 2. Token-by-token

### TRUMP (Donald Trump, Jan 2025)
- **Launch:** Announced by posts on Trump's Truth Social and X accounts on Friday night ET [1]. CMC's first tracked price was $1.208 (daily low stamped 2025-01-18 02:01 UTC) [2]. The token is on Solana. Meteora and Jupiter handled liquidity [4][13]. 200M of 1B tokens circulated at launch; 80% went to "Creators and CIC Digital," unlocking over 3 years [1]. 44.4M TRUMP sat in single-sided pools [4].
- **Checkpoints:**
  - ~3h: "nearly $9B" [1]. That is an FDV figure: on a 200M circulating basis it would mean ~$45/token, above the day's $33.87 high (calc from [2]).
  - ~22h (Jan 18 close): $28.73, circulating mcap $5.74B [2].
  - Peak: $73.43 at 01-19 03:50 UTC [3]; CMC shows $75.35 [2]. The two sources conflict.
  - 7d: ~$29 on Jan 25 [8 (snippet)], or ~$35 implied from a −27.58% weekly move to $25.39 on Jan 31 (calc) [9].
  - Day 16: $17.74, mcap $3.56B, −75% [10].
  - Day 31: mcap ~$3.2B, about $16 (calc), about −78% [11].
- **Snipers:** Wallet 6QSc2 (Bubblemaps alleges it belongs to a trader called "Naseem") bought $1.09M in the first second, or block 0 [5][6]. The priority fee was reported as $84K [5] or a 357 SOL (~$78K) Jito tip [6]; the two reports conflict. Profit: >$100M [5] (Lookonchain: ~$108M [72 (snippet)]). The implied entry was ~$0.18/token (calc: $1.096M ÷ 5.97M) [6].
- **Overall outcome:** Chainalysis counted 58 wallets that made >$10M each (>$1.1B combined) and 764,000 wallets that lost money. Creators earned $324M in fees [7].
- **Now:** $1.14, −98.4% from ATH [3]. That is below CMC's first price ($1.21) but about 6× the block-0 sniper's entry (calc).

### MELANIA (Melania Trump, Jan 2025)
- **Launch:** Promoted in Melania's X post, which Trump reshared [13]. Meteora USDC pool created 20:26 UTC [18]; Cointelegraph puts trading at "just after 9 pm UTC" [13].
- **Peak:** $13.05 at 23:00 UTC [3], about 2–2.6h after launch. Peak mcap conflicts across sources: ~$2B [14], $6.14B [13], "$13B within four hours" [snippet, Benzinga], with the last matching FDV.
- **Checkpoints:**
  - ~36h: TRUMP and MELANIA were "down as much as 60%" over 24h on Jan 21 [12].
  - 7d: not found.
  - Day 37 (Feb 25): fell from $1.20 to a $0.90 low, mcap $513M [16], about −93% from the ATH (calc).
  - Apr 8: $0.5488, −95.4% [15].
- **Insider and sniper data:**
  - Bubblemaps found ~90% of supply in one wallet at launch [14][13], and team wallets holding 92% [15].
  - More than $30M was "quietly sold," including via single-sided liquidity [15].
  - Sniper wallet P5tb4 extracted >$2.4M, and its profits routed to 0xcEA, the wallet Bubblemaps ties to Hayden Davis [17].
  - A presale wallet holding 10% "dumped most of its allocation immediately" [17].
- **Early traders:** one turned $800K into $16.45M within 12h; another turned $560K into $11.5M [14].
- **Now:** $0.057, mcap $56.6M, −99.6% [3].

### LIBRA (Javier Milei, Feb 2025)
- **Timeline (UTC, Feb 14):**
  - Minted at 21:38.
  - Milei posted on X at 22:01, about 23 minutes after the mint [19].
  - About 20 minutes before Milei's post, one address added 1M LIBRA to a Meteora pool [20].
  - Peak $4.55 at 22:44 [19].
  - 82% of supply was unlocked at launch [17].
- **Crash:** "Nearly 90% within hours" [20]; −94% to $257M in under 11h [21].
  - Conflict: CoinGecko only began tracking after the crash, so its listed ATH is $0.75 on Feb 17 [3][20]. Decrypt repeats that $0.75 as the ATH, which conflicts with the $4.55 intraday peak.
  - 7d and 30d: not found.
- **Insiders:**
  - The creator wallet removed $87M from the liquidity pools [17]. Other figures: $107M [21], or $7.8M in Decrypt's timeline [20]. These conflict.
  - Snipers tied to 0xcEA made ~$6M [17].
- **Snipers and trader outcomes:**
  - Two wallets bought at 22:01 and sold by 22:44 for $5.4M profit [20].
  - The top sniper (Nansen) made $6.5M [19].
  - The TRUMP sniper's entity bought ~$5M and sold 40 min later for $496K profit [6].
  - Nansen: 86% of wallets with more than $1K of gains or losses lost $251M combined; the other 14% made $180M [19].
- **Now:** $0.00334, mcap ~$1.0M, −99.9% vs $4.55 (calc) [3][18].

### HAWK (Haliey Welch, Dec 2024)
- **Launch:** Trading was scheduled for 5 PM EST Dec 4 [25 (snippet)]; the pool was created 22:08 UTC [18]. The launch ran through overHere on Meteora, with "high initial fees" meant to deter snipers [22]. The trading fee was 15%, and fees passed $1M within minutes [23]. Which account first posted the contract address: not found.
- **Peak and crash:** $490M [22] or ~$500M "within hours" [23]. Fell 91% in three hours to $41.7M [22], then to ~$25M within weeks [23][24].
- **Snipers:** One wallet took 17.5% of supply seconds after deployment for 4,195 SOL ($965K). It sold ~90 minutes later for ~$1.3M profit [22]. That is total proceeds of only ~$2.3M against a paper value of ~$85M at peak (calc). **The paper peak was not exit liquidity.**
- **Insiders:**
  - 96% of supply sat in 10 connected wallets before launch [22][24].
  - A 17% presale allocation to 285 wallets was fully unlocked at launch; 155 of those wallets sold, realizing $3.3M [24].
  - 89 presale wallets sold 100% immediately [23].
- **Aftermath:** The SEC closed its investigation without findings [26].
- **Now:** FDV ~$0.95M [18].

### JENNER (Caitlyn Jenner, May 2024)
- **Launch:** Posts on @Caitlyn_Jenner said she had issued the token, and many observers suspected a hack [27]. It launched on pump.fun [27]; Sahil Arora deployed it under a deal with her [28].
  - Launch date: "late Sunday" May 26 [27], with the pool created 20:13 UTC that day [18]. Cointelegraph says May 28 [29]. The sources conflict.
- **Peak:** $42M [28]. Timing conflicts: ">$30M within 24 hours" [29] versus "peaked Tuesday" (May 28) [28].
- **Checkpoints:**
  - ~4 days: −81% from peak, and −58% in the two hours after Jenner announced an Ethereum version [28].
  - Day ~11 (Jun 6): $6.1M, −79% from ATH [29].
  - Jul 26: −75% from ATH [38].
  - End of 2024: ~$357K [31].
- **Insiders:** A cluster held ~25% of supply at launch and sold early for ~$500K [30 (snippet)].
- **Now:** FDV ~$77K [18].

### MOTHER (Iggy Azalea, May 2024)
- **Launch:** The insider "JEET" wallet received 86.9M MOTHER from the team at 21:00 UTC on May 28 [33]; the Raydium pool was created 21:04 [18]. The team handing out supply directly conflicts with claims that MOTHER was a pump.fun launch (pump.fun allows no presale; Cointelegraph notes this for IGGY [32]). The launch tweet reportedly contained the contract address [snippet, Decrypt 2024 Person of the Year].
  - A copycat, IGGY, was presold by Sahil Arora and collapsed from ~$3M to $158K [32].
- **Checkpoints:**
  - ~14h: $18.2M, rising to >$28M on May 29 [32].
  - ~4 days: $88.7M ATH at that time [34].
  - Peak: CoinGecko ATH of $0.2306 on Jun 6 [3], about 8.5 days after launch.
  - Peak mcap figures conflict: $134M on Jun 6 [29]; >$200M [37 (snippet)]; $240M ATH [35]; $148.97M on Jun 16 [36].
  - Day ~34 (Jul 1): $59.9M [36].
  - Jul 26: −78.7% from ATH [38].
- **Insiders:**
  - Insiders bought >20% directly from the team [33].
  - JEET got 12.75%; one insider sold ~10% of supply on May 29 and netted $1.4M [33].
  - "20% sniped," with $2M sold by mid-June [35].
- **Now:** mcap $236K, −99.9% [3].

### DADDY (promoted by Andrew Tate, Jun 2024)
- **Launch:** Launched Jun 9 by developer "Issathecooker" [39] on pump.fun (the contract address ends in "pump"; pool created 20:18 UTC) [18]. Tate first referenced it on X on Jun 11 and promoted it hard on Jun 12 [40]. He did not launch it himself: 40% of supply was airdropped to his wallet [39].
- **Checkpoints:**
  - Jun 12: >$275M, +450% in 24h [40].
  - Peak: $340M [35], or ~$289M from CoinGecko's ATH (calc) [3], on Jun 14 [3].
  - Liquidity was only ~$2.5M against a claimed value of $150M [39].
  - Jul 26: −73.2% from ATH [38].
- **Insiders:**
  - Insiders bought 30% before Tate's promotion and were "sitting on $45M+" [40].
  - 11 Binance-funded wallets held about 19%, worth ~$30M [40].
  - The developer made >$400K [39].
- **Now:** mcap $3.7M, −97.9% [3].

### JASON (Jason Derulo, Jun 2024)
- **Launch:** Derulo posted the contract address (6SUry…pump) on X, about 5h after the token was created on pump.fun [41]. Bubblemaps says he did not realize he was sharing a contract [42].
- **Checkpoints:**
  - Within 5 min: +1,515% to $1.85M, then back to ~$200K (calc: −89% within minutes) [41].
  - After a second tweet: $5M within 2h, then an ATH of ~$0.011; >$10M the next day [41].
  - End of 2024: −97.8% (~$783K) [31].
- **Insiders:** Clusters linked to Sahil Arora held 51% before Derulo's tweet and sold "almost everything right after" for ~$180K. Derulo sold $20K and later bought it back [42].
- **Now:** FDV ~$36K [18].

### DAVIDO (Davido, May 2024)
- **Launch:** Announced on Davido's X account; created on pump.fun May 29 [43].
- **Peak and checkpoints:** Peak ~$10M [44]. Then:
  - −93% from the high by the next morning [43];
  - $2.2M at press time on May 30 [44];
  - −66% from an ATH of $0.0033 by about one week [29].
  - These figures conflict.
- **Celebrity wallet:** Davido's wallet bought 203M tokens (20.3%) for 7 SOL at creation. It sold 121.88M for >$473K profit within 11h (Lookonchain) [43][44].
- **Now:** FDV ~$10K [18].

### YZY (Kanye West, Aug 2025)
- **Launch:** Ye's X account shared the contract address and the Yeezy Money site [46].
  - Anti-sniping: the team deployed 25 contract addresses and picked one at random as the official token [45][46].
  - Liquidity was single-sided, so the developers could sell at any time [46].
  - Meteora pool [18]; listed quickly on CMC, Bitget and Poloniex [45].
- **Peak:** ~$3B within 40 min [46]. ATH $2.95 [3]; one source gives $3.16 [snippet].
- **Checkpoints:**
  - <24h: −74% to ~$0.77 [47].
  - Day ~6: −81%, FDV $565M, mcap $73.5M [49].
  - ATL of $0.188 on Oct 10, 2025 [3].
- **Supply:** One wallet held ~70% [45]; Coinbase's Conor Grogan put insiders at ≥94% [46].
- **Snipers:**
  - Wallets Bubblemaps ties to Hayden Davis made $12M [48].
  - Nansen: 13 wallets made >$1M each, $24.5M total; only 9 of the first 99 buyers still held [47].
  - One trader made $3.4M after paying $24K in priority fees; a suspected insider first bought a decoy contract and lost $710K before recovering [46].
- **Losses:** 51,862 of 70,201 wallets (73.8%) lost $74.8M, and 11 wallets took ~30% of all profits [48].
- **Launch price comparison:** The launch price was about $0.20 (calc from "+1,400% to $3") [47], so today's $0.288 is still above it (calc) [3].

### CAR (Central African Republic president Touadéra, Feb 2025)
- **Launch:** Announced from Touadéra's official X account; supply locked via Streamflow; 25% went to "creators and company" [50].
- **Peak and crash:** $68.47M → $897.41M in about 2.5h [51 (snippet)], or a $0.89 / $894M peak [50]. CoinGecko's ATH is $0.7757 [3]. Then −96.7% to $0.029 (~$29M) in just over 24h [50].
- **Now:** mcap $1.89M [3].

### LAPTOP (Hunter Biden, Sep 2026, Base: included as the most recent major case)
- **Launch:** Biden confirmed the ticker on X on Sep 7. The contract was published on the project website before trading opened [52][53].
  - The pool opened at $0.05; the market maker supplied only ~$5K of liquidity in the first 30 seconds [52].
  - $100–144B "valuations" were thin-liquidity artifacts [52]. ATH $199.51 at 12:09 UTC [3].
- **Checkpoints** (GeckoTerminal Aerodrome LAPTOP/USDC pool, hourly closes; calc) [54]:

  | Time after open | Price | vs ATH | vs $0.05 open |
  |---|---|---|---|
  | +1h | $4.28 | −97.9% | +8,460% |
  | +24h | $0.81 | −99.6% | +1,520% |
  | +7d | $0.219 | −99.9% | +338% |
  | +30d | $0.0744 | −99.96% | +49% |
  | Now | $0.034 | −99.98% | −32% |

- **On-chain data:**
  - ~80% of traders lost money [52].
  - 60% of top holders were fresh wallets [53].
  - A project multisig sold ~42.5M of 100M tokens, and tokens moved to unidentified wallets before launch (Arkham) [52].
  - Biden says his side sold nothing [53].

### FLOYD Money Mayweather (Oct 2026, Fomo)
- Launched by Sahil Arora on the Fomo launchpad and briefly promoted by Mayweather's social accounts [55].
- Peaked at ~$1M, then fell 96% over three hours [55].
- Bubblemaps: the largest connected cluster made ~$105K and the top 100 traders ~$306K. Arora claims seven figures, which Bubblemaps disputes [55].

### RKC (Roaring Kitty-linked, May 2026)
- Two posts from Roaring Kitty's X account shared a pump.fun contract address and were deleted within an hour. The account is widely believed to have been compromised [56].
- Rose to ~$12M within minutes, then fell to $1.8M [56]. Another report gives −67% to $3.6M [58].
- The developer cashed out ~$729K ($611K in sales plus $118K in fees) [57][56] (snippets).
- Now: mcap $708K [3].

### Adin Ross / FaZe Banks / Kick and Twitch streamers
- **MLG (360noscope420blazeit):**
  - Not a launch: the token was created in April 2024 [61].
  - FaZe Banks bought 50 SOL of it in early January 2025. It was at $11M that day and reached $164.45M five days later [61]. CoinGecko ATH Feb 3, 2025 [3].
  - Banks quit as FaZe CEO after a leaked chat (Jul 28, 2025) in which he blamed Adin Ross's community for using him as "exit liquidity" [62]. Ross confirmed the chat was real but denied responsibility [snippet].
  - Now −99.7% [3].
  - ZachXBT findings on MLG: not found.
- **ROSS (Mar 2025):** @RoundtableSpace posted a contract address claiming Adin Ross backed the token and deleted it ~20 min later. It peaked at ~$7M, then fell 82.7% (one chart) and >95% in 24h (GeckoTerminal). Ross's team denied involvement [64].
- **Gainzy (pump.fun streamer token):** Fell from $4M to $12K (−99%) after he sold >73% for ~$168K; he blamed an "accidental click" [65]. The article is dated Sep 9, 2025; the event date is unclear.
- **$QUANT (Nov 2024):** A 13-year-old streamer rug-pulled his own token on a pump.fun livestream for ~$30K, after which a "revenge pump" sent it to $80M [snippets: Sportskeeda / CryptoBriefing].
- **Togi (Kick, Jun 2026):** The only source is one X post alleging a ~$100K live rug pull [66]. **Unverified.**
- **SERIOUS (FaZe, Dec 2024): not found.** Four searches turned up no such token. FaZe-promoter results were either 2021's Save the Kids (FaZe Kay, Jarvis, Nikan, Teeqo) [70] or MLG. The ticker may be confused with one of those. I did not fabricate data for it.
- **Kick/Twitch-specific launch data:** apart from the items above, not found.

### Other 2025 cases
- **GREED (Dave Portnoy, Feb 2025):** Launched from his official wallet. He bought 35.79% of supply and sold all of it ~1h later for ~$258K. The token peaked at ~$30M, then dropped 90%, or 99% to under $3M (both figures appear in the source) [59].
- **JAILSTOOL:** Community-made; Portnoy adopted it on Feb 8 [60]. ATH Feb 9, 2025; now −99.5% [3].

---

## 3. Patterns for a sniper bot

These are built only from the figures above.

### Time to peak (14 launches with a datable peak)
- **9 of 14 peaked within about 3 hours of the contract address going public:**
  - LAPTOP ~9 min;
  - YZY ~40 min;
  - LIBRA 43 min;
  - RKC "minutes";
  - GREED ≤1h;
  - MELANIA ~2–2.6h;
  - CAR ~2.5h;
  - HAWK "within hours."
  - JASON's first local top came 5 min after the tweet.
- **About 1 day:** TRUMP (~26–34h), DAVIDO (same or next day), and JASON's ATH.
- **Multi-day:** JENNER ~1–2 days, DADDY ~4 days, MOTHER ~8.5 days.
  - All three were 2024 pump.fun-era tokens, and the celebrity kept promoting after launch: Tate's burn pledge and "I'm taking over" posts [35][39], Azalea's NYSE visit [35].
- **There are two regimes:**
  - Meteora or single-sided-liquidity launches dropped by the celebrity (TRUMP, MELANIA, LIBRA, HAWK, YZY) peaked in minutes to about a day.
  - Pump.fun launches with ongoing promotion peaked over days.

### How fast the crashes came
- **≥80% fall within about 24h of the peak: 8 of 15 clear cases, plus 1 borderline:**
  - LAPTOP −97.9% in 1h;
  - HAWK −91% in 3h;
  - FLOYD −96% in 3h;
  - GREED −90%+ after ~1h;
  - LIBRA −94% in <11h;
  - CAR −96.7% in ~24h;
  - DAVIDO −93% by the next day;
  - JASON −89% within minutes of its first spike;
  - borderline: RKC, about −85% within an hour.
- **Slower decliners:** TRUMP was ~−52% to −61% by day 7 and ~−78% by day 31. MELANIA lost up to 60% in 24h and ~−93% by day 37. YZY lost 74% in 24h and 81% by day 6. MOTHER and DADDY lost ~73–79% within about 1–1.5 months.

### Share that crashed more than 80%
- **15 of 15 launches** are now >80% below their peaks; current drawdowns run from −90.2% (YZY) to −99.98% (LAPTOP).
- **13 of those 15 are now >95% below peak.** The other two are YZY (−90.2%) and RKC (−92.1%).
- The two non-launch pumps (MLG, JAILSTOOL) are also >99% down.
- The wider cohort is no better. Of 30+ celebrity tokens launched on Solana in June 2024, exactly half were down >99% within about a month, 7 more were down >90%, and 22 of 30 were under $1M in market cap [67][38].

### What separated the ones that held value longer
- **The only three still above $50M market cap** are TRUMP ($323M), YZY ($86M) and MELANIA ($57M) [3]. All three had:
  - top-tier fame;
  - Meteora pools with very large initial liquidity (TRUMP's USDC pool held $483M TVL [4]);
  - fast exchange or aggregator listings [45][1];
  - some locked or vested allocations (TRUMP 80% over 3 years [1]; YZY 10% vested [45]).
  - Even so, all three are down 90–99.6%.
- **The fastest collapses** shared one or more of:
  - supply unlocked for insiders at launch (LIBRA 82% [17]; HAWK's 17% presale fully unlocked [24]);
  - the celebrity or developer wallet selling early (DAVIDO 20.3% [43]; GREED 35.8% [59]; JASON's 51% Arora-linked clusters [42]);
  - very thin opening liquidity (LAPTOP ~$5K [52]);
  - a compromised or fake source account (RKC [56], ROSS [64]).

### Did early snipers make or lose money?
- **The documented winners all sold within minutes to hours:**
  - HAWK sniper: about 90 minutes [22];
  - LIBRA wallets: in at 22:01, out by 22:44 [20];
  - the TRUMP sniper's LIBRA trade: 40 minutes [6];
  - the Davido wallet: within 11h [43];
  - MOTHER's JEET wallet: sold on day 1 [33].
- **TRUMP's block-0 buyer is the outlier.** Entry was ~$0.18 (calc) and profit >$100M [5]. The token is still about 6× that entry today (calc).
- **Losers were the majority wherever outcomes were measured:**
  - YZY: 73.8% of wallets [48];
  - LIBRA: 86% of wallets with >$1K of gains or losses [19];
  - TRUMP: 764K wallets [7];
  - LAPTOP: ~80% of traders [52].
- **Insiders usually held the real "first block."** They bought before the public contract-address post:
  - DADDY: 30% before Tate's tweet [40];
  - JASON: 51% before Derulo's tweet [42];
  - LIBRA: minted 23 minutes before Milei's post [19];
  - MOTHER: team handed out supply at 21:00 UTC [33];
  - LAPTOP: token transfers days before launch [52].
- **Priority-fee competition at launch was heavy:** ~$78–84K on TRUMP [5][6] and $24K on YZY [46].

### What this implies for take-profit and timing rules (descriptive, not advice)
1. **Default to an exit window measured in minutes to hours.** In the Meteora / celebrity-drop regime, every peak came within 9 min to ~2.6h (TRUMP excepted, ~26h), and every one gave back ≥60% from peak within about 24h (MELANIA ~60%, YZY 74%, HAWK 91%, LIBRA 94%, CAR 96.7%, LAPTOP 99.6%). Holding past day 1 never recovered the peak for any token here.
2. **Scale out in stages in the first hour rather than waiting for one target.** Even the HAWK sniper, in "seconds after deployment," realized only ~$2.3M of a stake worth ~$85M on paper at peak (calc) [22]. DADDY carried a $150M claimed value on ~$2.5M of liquidity [39]. Set take-profit levels against pool depth and expected slippage, not displayed market cap or FDV.
3. **Treat certain on-chain events as hard exit triggers:** liquidity removal (LIBRA $87M [17]), withdrawals from single-sided liquidity (MELANIA [15], YZY [46]), and creator or celebrity wallet sells (DAVIDO, GREED, JASON).
4. **If you add a trailing-stop "runner" leg, gate it on signs of continued promotion.** Multi-day runners (JENNER, DADDY, MOTHER) needed ongoing celebrity posting. Even these were down 73–79% from peak within about 1.5 months [38].
5. **Verify the contract address before buying.** This dataset includes:
   - decoy contracts (YZY's 25 [45]);
   - a fake coin followed from Kanye's hacked Instagram ($7M peak, then −96% [49]);
   - a presold impostor (IGGY [32]);
   - a likely hacked account (RKC [56]);
   - a fake contract address claiming a celebrity's backing (ROSS [64]).
6. **Budget for fees.** HAWK charged a 15% launch fee [23], and launch priority fees reached tens of thousands of dollars [5][46]. Both eat directly into a sniper's edge.

**Biggest gap:** precise 1h/24h checkpoints for 2024–2025 launches. Filling them needs paid historical DEX data (Birdeye, Dune, or GeckoTerminal Analyst tier).

---

## 4. Sources
1. The Block, TRUMP $9B: https://www.theblock.co/post/335528/trump-posts-send-official-trump-memecoin-to-9-billion-market-cap
2. CoinMarketCap TRUMP daily history, Jan 18–21, 2025 (retrieved via https://api.coinmarketcap.com/data-api/v3/cryptocurrency/historical?id=35336&convertId=2781&timeStart=1737072000&timeEnd=1740000000&interval=1d); page: https://coinmarketcap.com/currencies/official-trump/historical-data/
3. CoinGecko markets API snapshot, 2026-11-09: https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=official-trump,melania-meme,libra-5,mother-iggy,daddy-tate,yzy,360noscope420blazeit,central-african-republic-meme,stool-prisondente,hunter-biden-s-laptop-3,red-kitten-crew
4. Cointelegraph, TRUMP launch: https://cointelegraph.com/news/official-trump-memecoin-launch-breaks-records-as-solana-sol-rallies-to-new-all-time-high
5. The Block, Bubblemaps TRUMP sniper: https://www.theblock.co/post/341664/crypto-analytics-platform-bubblemaps-claims-one-trader-turned-1-million-into-109-million-trading-trump-memecoin
6. Arkham: https://info.arkm.com/research/trump-sniper-buying-5m-libra
7. NBC News / CNBC (Chainalysis): https://www.nbcnews.com/tech/crypto/58-crypto-wallets-made-millions-trumps-meme-coin-764000-lost-money-dat-rcna205237
8. Traders Union (snippet; page returned 403): https://tradersunion.com/news/cryptocurrency-news/show/60079-official-trump-drops
9. Nairametrics: https://nairametrics.com/2025/01/31/trump-token-struggles-as-market-cap-drops-by-2-billion-in-a-week/
10. Mezha (citing CoinDesk): https://mezha.ua/en/2025/02/03/the-trump-memecoin-lost-75-of-its-maximum-value-despite-trump-s-attempts-to-promote-it
11. FXEmpire: https://www.fxempire.com/forecasts/article/trump-is-down-7-as-meme-coins-take-a-hit-amid-libras-controversy-1498599
12. FXStreet / CoinDesk: https://fxstreet.com/amp/cryptocurrencies/news/trump-melania-tokens-plunge-50-as-trump-inauguration-fails-to-buoy-bitcoin-202501211152
13. Cointelegraph, MELANIA launch: https://cointelegraph.com/news/melania-trump-memecoin-launches-notches-4-b-market-cap
14. CMC Academy: https://coinmarketcap.com/academy/article/the-trump-dump-how-the-family-branded-meme-coins-crushed-crypto-markets
15. Decrypt, MELANIA $30M: https://decrypt.co/313866/melania-solana-meme-coin-dumps-bubblemaps
16. Latin Times: https://www.latintimes.com/melania-trump-meme-coin-drops-below-1-value-month-after-launching-scammed-first-family-576770
17. Bubblemaps, LIBRA / Hayden Davis: https://blog.bubblemaps.io/how-hayden-davis-rugged-libra-for-100m-with-president-milei/
18. GeckoTerminal pool data, 2026-11-09: https://api.geckoterminal.com/api/v2/search/pools?query=HAWK&network=solana (same query pattern for each ticker). Pools:
    - HAWK: https://www.geckoterminal.com/solana/pools/ExyGVXVRvUjJryo65vYUhLACcxhwYztKqa7jXqiT2tvr
    - JENNER: https://www.geckoterminal.com/solana/pools/Crr7JdT5LXT6jCRqwQNb2epF1SNtN3Jxpv3kgdirPatX
    - JASON: https://www.geckoterminal.com/solana/pools/4XmdX5Umx7qt3uvMapdXzWPQefx2WZf4tZ69XAmNyF3X
    - DAVIDO: https://www.geckoterminal.com/solana/pools/48XCxXxuVjEefX8K1qAMD2yELYUkXihYQegtSKXf4JXG
    - LIBRA: https://www.geckoterminal.com/solana/pools/DywR4cjNLhPy1dV9tBShpCbXoAAq3LN3Wajj9Gw64co9
19. The Block, Nansen LIBRA: https://www.theblock.co/post/342266/traders-of-solana-based-libra-memecoin-lost-251-million-nansen
20. Decrypt, LIBRA explainer: https://decrypt.co/306987/what-is-libra-the-solana-meme-coin-that-sparked-a-political-scandal
21. KuCoin: https://www.kucoin.com/news/articles/from-4-56b-peak-to-94-crash-milei-s-libra-endorsement-triggers-107m-insider-exit
22. rekt.news: https://rekt.news/hawkward-exit/
23. Bubblemaps, HAWK: https://blog.bubblemaps.io/how-hailey-welchs-hawk-token-became-a-500m-disaster/
24. Bubblemaps, HAWK anatomy: https://blog.bubblemaps.io/hawk-anatomy-of-a-celebrity-rug/
25. overHere press release (snippet): https://thedefiant.io/news/press-releases/web3-launchpad-platform-overhere-launches-hawk-haliey-welchs-official-hawk-tuah-memecoin
26. Cointelegraph, Welch / FBI: https://cointelegraph.com/news/hawk-tuah-girl-haliey-welch-fbi-probed-over-hawk-memecoin
27. CoinDesk, JENNER: https://coindesk.com/markets/2024/05/27/caitlyn-jenner-meme-coin-sows-confusion-as-observers-question-its-provenance
28. Decrypt, JENNER: https://decrypt.co/233084/caitlyn-jenner-solana-meme-coin-crashes-ethereum-donald-trump
29. Cointelegraph, one week after JENNER: https://cointelegraph.com/news/celebrity-tokens-dip-one-week-after-caitlyn-jenner-crypto-debut
30. Cointelegraph, 2024 celebrity tokens (snippet): https://cointelegraph.com/news/celeb-crypto-tokens-lose-value-2024
31. Decrypt, SCENE 2024: https://decrypt.co/298703/scene-2024-story-of-the-year-celebrity-meme-coins
32. Cointelegraph, MOTHER / Arora: https://cointelegraph.com/news/iggy-azalea-memecoin-mother-sahil-arora
33. Cointelegraph, MOTHER insiders: https://cointelegraph.com/news/new-iggy-azalea-token-huge-insider-activity-analytics-firm
34. Decrypt, MOTHER $90M: https://decrypt.co/233633/iggy-azalea-solana-mad-lads-pfp-mother-nears-90-million
35. Decrypt, DADDY flips MOTHER: https://decrypt.co/235159/andrew-tate-daddy-meme-coin-iggy-azaleas-mother
36. Unchained: https://unchainedcrypto.com/mother-sheds-half-its-value-since-all-time-high-despite-iggy-azaleas-mastery-of-crypto-memes/
37. The Defiant (snippet): https://thedefiant.io/news/defi/iggy-azalea-s-mother-memecoin-hits-usd200-million-market-cap
38. Digital Money Box (citing Slorg): https://digitalmoneybox.com/news/altcoin/solanas-celebrity-tokens-down-94-mother-community-defends-the-memecoin
39. Bubblemaps, DADDY: https://blog.bubblemaps.io/unmasking-the-daddy-token/
40. Decrypt, DADDY: https://decrypt.co/235020/andrew-tate-solana-token-daddy-450-insider-buying
41. Decrypt, JASON: https://decrypt.co/236730/jason-derulo-solana-meme-coin-surges-duped-promoter
42. Bubblemaps, JASON: https://blog.bubblemaps.io/jason-derulo-and-the-jason-token-separating-fact-from-fiction/
43. Nairametrics, DAVIDO: https://nairametrics.com/2024/05/30/icymi-davidos-new-crypto-token-that-lost-93-after-launch/
44. TechPoint Africa: https://techpoint.africa/insight/is-davido-a-scam/
45. Decrypt, YZY launch: https://decrypt.co/336179/kanye-west-launches-yzy-token-solana-frenzied-debut
46. Cointelegraph, YZY $3B: https://cointelegraph.com/news/kanye-west-memecoin-pumps-3b-launch-then-falls-amid-insider-concerns
47. Cointelegraph, YZY snipers: https://cointelegraph.com/news/yzy-token-bloodbath-sees-coordinated-snipers-extract-millions-from-kanye-fans
48. The Block, YZY wallets: https://www.theblock.co/post/368557/kanye-west-yzy-11-netted-millions
49. Decrypt, YZY −81%: https://decrypt.co/336897/kanye-west-meme-coin-down-rapper-says-instagram-hacked-scam
50. The Block, CAR: https://www.theblock.co/post/339923/central-african-republic-car-memecoin-price-collapse
51. Decrypt, CAR (snippet): https://decrypt.co/305225/central-african-republic-president-meme-coin
52. BIT, LAPTOP: https://www.bit.com/knowledge-hub/laptop-memecoin
53. Cointelegraph, LAPTOP: https://cointelegraph.com/news/hunter-biden-denies-profiting-memecoin-laptop-crash
54. GeckoTerminal LAPTOP/USDC Aerodrome pool: https://www.geckoterminal.com/base/pools/0x99cf3e8bfb02c300312c53aac5d0b082e3d5975c (hourly data: https://api.geckoterminal.com/api/v2/networks/base/pools/0x99cf3e8bfb02c300312c53aac5d0b082e3d5975c/ohlcv/hour?before_timestamp=1791763200&limit=1000)
55. Decrypt, Arora / Mayweather: https://decrypt.co/380928/notorious-crypto-celeb-meme-coin-promoter-plots-second-wave-on-new-launchpad
56. KuCoin, RKC (snippet): https://www.kucoin.com/news/flash/roaring-kitty-s-x-account-suspected-of-being-hacked-rkc-market-cap-drops-from-12m-to-1-8m
57. Cointelegraph, RKC (snippet): https://cointelegraph.com/news/memecoin-dev-cashes-out-729k-gamestop-orchestrators-x-post
58. KuCoin, RKC −67% (snippet): https://www.kucoin.com/news/flash/rkc-memecoin-crashes-67-after-developer-cash-out-of-729k
59. CryptoPotato, GREED: https://cryptopotato.com/barstool-founder-launches-and-dumps-greed-meme-coin-in-just-1-hour/
60. The Block, JAILSTOOL: https://www.theblock.co/post/339658/barstool-founder-dave-portnoy-promotes-jailstool-token-in-response-to-backlash-from-memecoin-trades
61. Decrypt, MLG: https://decrypt.co/300050/call-of-duty-solana-meme-coin-mlg-skyrockets-faze-clan
62. AMBCrypto, FaZe Banks: https://ambcrypto.com/faze-clan-ceo-quits-amid-mlg-crypto-scandal-sucks-my-entire-life-gets-ruined/
64. Mitrade / BeInCrypto, ROSS: https://www.mitrade.com/insights/news/live-news/article-3-706839-20250319
65. Yahoo Finance, Gainzy: https://finance.yahoo.com/news/crypto-streamer-crashes-token-says-135554179.html
66. X post, Togi (unverified): https://x.com/miketrenches/status/2072075285961351245
67. Cointelegraph, celebrity tokens / Slorg: https://cointelegraph.com/news/celeb-tokens-solana-crash
70. PC Gamer, Save the Kids (2021): https://www.pcgamer.com/faze-clan-kicks-one-member-suspends-three-more-over-crypto-scam
72. Daily Hodl / Lookonchain (snippet): https://dailyhodl.com/2025/03/27/whale-who-netted-108000000-profit-on-trump-books-loss-on-the-memecoin-after-presidents-truth-social-post
