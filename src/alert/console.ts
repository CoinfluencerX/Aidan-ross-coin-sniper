import { dexscreenerLink, EVM_CHAINS, uniswapLink } from "../evm/locate.ts";
import type { AddressSignal, Assessment, EvmSighting, Severity } from "../watch/signal.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const STYLE: Record<Severity, { bg: string; fg: string; title: string }> = {
  green: { bg: "\x1b[42m\x1b[30m", fg: "\x1b[32m", title: "COIN ADDRESS DETECTED" },
  yellow: { bg: "\x1b[43m\x1b[30m", fg: "\x1b[33m", title: "COIN ADDRESS DETECTED: CHECK WARNINGS" },
  red: { bg: "\x1b[41m\x1b[97m", fg: "\x1b[31m", title: "COIN ADDRESS DETECTED: WOULD BE BLOCKED" },
};

const WIDTH = 78;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s: string) => s + " ".repeat(Math.max(0, WIDTH - 4 - stripAnsi(s).length));

export interface AlertOptions {
  color?: boolean;
  mode?: string;
  now?: number;
  /** Extra lines under the reasons, e.g. the validator's verdict. */
  extra?: readonly string[];
  /** Replaces the default last line. */
  footer?: string;
}

function box(severity: Severity, color: boolean, rows: (c: (code: string, text: string) => string) => string[]): string {
  const st = STYLE[severity];
  const c = (code: string, text: string) => (color ? code + text + RESET : text);
  const bar = c(st.fg, "█".repeat(WIDTH));
  const row = (text: string) => c(st.fg, "█ ") + pad(text) + c(st.fg, " █");
  return ["", bar, ...rows(c).map(row), bar, ""].join("\n");
}

type Common = Pick<AddressSignal, "account" | "accountId" | "postKind" | "postUrl" | "origins" | "path" | "source" | "postCreatedAt" | "receivedAt">;

function commonRows(s: Common, now: number | undefined): string[] {
  const latency = s.postCreatedAt ? Math.max(0, (now ?? s.receivedAt) - Date.parse(s.postCreatedAt)) : undefined;
  const who = `@${s.account.handle} (${s.account.isTest ? "TEST ACCOUNT" : s.account.person}, tier ${s.account.tier}, id ${s.accountId})`;
  return [
    "FROM   " + who,
    `POST   ${s.source} ${s.postKind} · ${s.postUrl}`,
    `FOUND  ${[...new Set(s.origins.map((o) => (o.host ? `${o.kind}:${o.host}` : o.kind)))].join(", ")}  via ${s.path}`,
    ...(latency !== undefined ? [`LAG    post → watcher ${(latency / 1000).toFixed(2)} s${s.source === "x" ? " (X timestamps are whole seconds)" : ""}`] : []),
  ];
}

/**
 * A big boxed banner for one Solana signal. `color: false` gives plain text (for files / tests).
 */
export function formatAlert(s: AddressSignal, a: Assessment, opts: AlertOptions = {}): string {
  const st = STYLE[a.severity];
  return box(a.severity, opts.color ?? true, (c) => [
    c(st.bg + BOLD, ` ${a.severity.toUpperCase()} `) + "  " + c(BOLD, st.title),
    "",
    "MINT   " + c(BOLD, s.mint),
    ...commonRows(s, opts.now),
    "",
    ...a.reasons.map((r) => (a.severity === "green" ? "✓ " : "! ") + r),
    ...(opts.extra?.length ? ["", ...opts.extra] : []),
    "",
    c(BOLD, opts.footer ?? `${(opts.mode ?? "dry-run").toUpperCase()}: nothing is bought.`),
  ]);
}

/**
 * Banner for an Ethereum-style address. The bot never buys these: the links open Uniswap with the
 * token filled in, and the owner confirms in their own wallet.
 */
export function formatEvmAlert(s: EvmSighting, a: Assessment, opts: AlertOptions = {}): string {
  const st = STYLE[a.severity];
  const found = s.chains.filter((ch) => ch.status === "contract");
  // Show the chains where the contract exists. If none was confirmed, show both so the owner can check.
  const show = found.length ? found : (Object.keys(EVM_CHAINS) as (keyof typeof EVM_CHAINS)[]).map((chain) => ({ chain, status: "unknown" as const }));
  const chainRows = show.flatMap((ch) => [
    `${EVM_CHAINS[ch.chain].label.toUpperCase()}${"symbol" in ch && ch.symbol ? ` (${ch.symbol})` : ""}${found.length ? ": contract found" : ": not confirmed"}`,
    `  buy    ${uniswapLink(ch.chain, s.address)}`,
    `  chart  ${dexscreenerLink(ch.chain, s.address)}`,
  ]);
  return box(a.severity, opts.color ?? true, (c) => [
    c(st.bg + BOLD, ` ${a.severity.toUpperCase()} `) + "  " + c(BOLD, "ETHEREUM-STYLE ADDRESS: BUY BY HAND"),
    "",
    "TOKEN  " + c(BOLD, s.address),
    ...commonRows(s, opts.now),
    "",
    ...chainRows,
    "",
    ...a.reasons.map((r) => (a.severity === "green" ? "✓ " : "! ") + r),
    "",
    c(BOLD, "The bot does NOT buy 0x addresses. Check the token, then confirm in your wallet."),
  ]);
}
