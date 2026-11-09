import { createRedactor, type Redactor } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
  readonly redactor: Redactor;
}

export interface LoggerOptions {
  level?: LogLevel;
  secrets?: readonly string[];
  redactor?: Redactor;
  /** Where JSON lines go. Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

/** One JSON object per line: {time, level, event, ...fields}, always redacted. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const redactor = opts.redactor ?? createRedactor(opts.secrets);
  const minRank = LEVEL_RANK[opts.level ?? "info"];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = opts.now ?? (() => new Date());

  const make = (bindings: Fields): Logger => {
    const emit = (level: LogLevel, event: string, fields?: Fields) => {
      if (LEVEL_RANK[level] < minRank) return;
      const body = redactor.redact({ ...bindings, ...fields }) as Fields;
      write(JSON.stringify({ time: now().toISOString(), level, event: redactor.redactString(event), ...body }));
    };
    return {
      debug: (e, f) => emit("debug", e, f),
      info: (e, f) => emit("info", e, f),
      warn: (e, f) => emit("warn", e, f),
      error: (e, f) => emit("error", e, f),
      child: (more) => make({ ...bindings, ...more }),
      redactor,
    };
  };
  return make({});
}
