import type { AddressSignal, Assessment, Severity } from "../watch/signal.ts";

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

/**
 * A big boxed banner for one signal. Dry-run never buys: the footer says so.
 * `color: false` gives plain text (for files / tests).
 */
export function formatAlert(s: AddressSignal, a: Assessment, opts: { color?: boolean; mode?: string; now?: number } = {}): string {
  const color = opts.color ?? true;
  const st = STYLE[a.severity];
  const c = (code: string, text: string) => (color ? code + text + RESET : text);
  const bar = c(st.fg, "█".repeat(WIDTH));
  const row = (text: string) => c(st.fg, "█ ") + pad(text) + c(st.fg, " █");
  const latency = s.postCreatedAt ? Math.max(0, (opts.now ?? s.receivedAt) - Date.parse(s.postCreatedAt)) : undefined;
  const who = `@${s.account.handle} (${s.account.isTest ? "TEST ACCOUNT" : s.account.person}, tier ${s.account.tier}, id ${s.accountId})`;

  const lines = [
    "",
    bar,
    row(c(st.bg + BOLD, ` ${a.severity.toUpperCase()} `) + "  " + c(BOLD, st.title)),
    row(""),
    row("MINT   " + c(BOLD, s.mint)),
    row("FROM   " + who),
    row(`POST   ${s.postKind} · ${s.postUrl}`),
    row(`FOUND  ${[...new Set(s.origins.map((o) => (o.host ? `${o.kind}:${o.host}` : o.kind)))].join(", ")}  via ${s.path}`),
    ...(latency !== undefined ? [row(`LAG    post → watcher ${(latency / 1000).toFixed(2)} s (X timestamps are whole seconds)`)] : []),
    row(""),
    ...a.reasons.map((r) => row((a.severity === "green" ? "✓ " : "! ") + r)),
    row(""),
    row(c(BOLD, `${(opts.mode ?? "dry-run").toUpperCase()}: nothing is bought. Validator (M2) and executor (M3) not wired yet.`)),
    bar,
    "",
  ];
  return lines.join("\n");
}
