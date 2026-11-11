import { uniswapLink } from "../evm/locate.ts";
import type { Verdict } from "../validate/validator.ts";
import type { AddressSignal, Assessment, EvmSighting } from "../watch/signal.ts";

/**
 * The alert that goes to the friends' Telegram group (TELEGRAM_ALERT_CHAT_IDS).
 *
 * It is a broadcast of what an official account posted and what the bot's checks said. It never
 * carries anything about the owner: no wallet, no buy size, no position, no profit. People in the
 * group buy by hand; nothing here can make any bot buy.
 */

const DISCLAIMER = "Automatic alert, not advice. The checks can miss things. Only use money you can lose.";
const MAX_REASONS = 4;

/** Links for buying a Solana coin by hand. The Phantom link opens Jupiter inside Phantom's own browser. */
export function solanaBuyLinks(mint: string, isPumpToken: boolean): { label: string; url: string }[] {
  const jupiter = `https://jup.ag/swap/SOL-${mint}`;
  return [
    { label: "Open in Phantom", url: `https://phantom.com/ul/browse/${encodeURIComponent(jupiter)}?ref=${encodeURIComponent("https://jup.ag")}` },
    { label: "Jupiter", url: jupiter },
    ...(isPumpToken ? [{ label: "pump.fun", url: `https://pump.fun/coin/${mint}` }] : []),
    { label: "Chart", url: `https://dexscreener.com/solana/${mint}` },
  ];
}

/**
 * Group alert for a Solana coin address. Returns undefined for a test account's post, which is a
 * rehearsal and must not reach other people.
 *
 * A coin that passed gets buy links. A coin the checks blocked gets none, and says so first.
 */
export function publicCoinAlert(s: AddressSignal, v: Verdict): string | undefined {
  if (s.account.isTest) return undefined;
  const who = `@${s.account.handle} on ${s.source}`;
  const token = v.token ? `${v.token.name} (${v.token.symbol})` : undefined;
  if (v.decision === "blocked") {
    return [
      `DO NOT BUY. ${who} posted an address, but the bot's checks BLOCKED it.`,
      s.mint,
      ...(token ? [`Token: ${token}`] : []),
      `Post: ${s.postUrl}`,
      ...v.blocks.slice(0, MAX_REASONS).map((o) => `x ${o.detail}`),
      "",
      DISCLAIMER,
    ].join("\n");
  }
  return [
    `COIN ADDRESS posted by ${who}`,
    s.mint,
    ...(token ? [`Token: ${token}`] : []),
    `Post: ${s.postUrl}`,
    "",
    `Bot's checks: PASSED${v.warns.length ? ` with ${v.warns.length} warning${v.warns.length === 1 ? "" : "s"}` : ""}`,
    ...v.warns.slice(0, MAX_REASONS).map((o) => `! ${o.detail}`),
    "",
    "Buy by hand:",
    ...solanaBuyLinks(s.mint, v.market?.isPumpToken === true).map((l) => `${l.label}: ${l.url}`),
    "",
    DISCLAIMER,
  ].join("\n");
}

/** Group alert for a 0x (Ethereum or Base) address. Undefined for a test account's post. */
export function publicEvmAlert(s: EvmSighting, a: Assessment): string | undefined {
  if (s.account.isTest) return undefined;
  const who = `@${s.account.handle} on ${s.source}`;
  const found = s.chains.filter((c) => c.status === "contract");
  if (a.severity === "red") {
    return [`CAREFUL. ${who} posted a 0x address, but it looks wrong:`, s.address, `Post: ${s.postUrl}`, ...a.reasons.slice(0, MAX_REASONS).map((r) => `x ${r}`), "", DISCLAIMER].join("\n");
  }
  const chains = found.length ? found.map((c) => c.chain) : (["ethereum", "base"] as const);
  return [
    `0x ADDRESS posted by ${who} (Ethereum or Base, not Solana)`,
    s.address,
    `Post: ${s.postUrl}`,
    ...a.reasons.slice(0, MAX_REASONS).map((r) => `${a.severity === "green" ? "ok" : "!"} ${r}`),
    "",
    "Buy by hand (needs MetaMask or another Ethereum wallet):",
    ...chains.map((c) => `Uniswap, ${c}${found.length ? "" : " (not confirmed)"}: ${uniswapLink(c, s.address)}`),
    "",
    DISCLAIMER,
  ].join("\n");
}
