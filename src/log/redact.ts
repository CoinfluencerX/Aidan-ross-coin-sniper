/**
 * Redaction for logs and the audit log. Three layers:
 *
 * 1. By key: fields whose name says "secret" (privateKey, botToken, apiKey, …).
 *    Trade fields like `token_amount` or `tokenMint` are NOT secrets and stay visible.
 * 2. By value: every registered secret (env secrets, and the wallet key once M3 loads it)
 *    is cut out of any string it appears in.
 * 3. By shape: api-key style URL params, "Bearer …" headers, and 64-byte arrays (keypair bytes).
 *
 * There's deliberately no generic "88-char base58 = secret key" pattern. Transaction
 * signatures are also 64 bytes / 88 chars, and we need them in the logs. The real
 * wallet key is registered by value with `addSecret` instead.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PARTS =
  /(secret|password|passwd|passphrase|privatekey|secretkey|seedphrase|mnemonic|apikey|bearer|authorization|cookie|keypair)/;
const SENSITIVE_TOKEN_KEY = /(^|access|auth|bot|grpc|refresh|session|api|id)token$/;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return k === "seed" || SENSITIVE_KEY_PARTS.test(k) || SENSITIVE_TOKEN_KEY.test(k);
}

const URL_SECRET_PARAM = /([?&](?:api[-_]?key|apikey|access[-_]?token|token|key|secret|auth)=)[^&\s#"']+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/%]+=*/gi;
const BYTE_ARRAY_64 = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

const MIN_SECRET_LENGTH = 8;

function isKeypairBytes(v: unknown): boolean {
  if (v instanceof Uint8Array) return v.length === 64;
  return Array.isArray(v) && v.length === 64 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

export interface Redactor {
  addSecret(value: string): void;
  redactString(s: string): string;
  redact(value: unknown): unknown;
}

export function createRedactor(initialSecrets: readonly string[] = []): Redactor {
  let secrets: string[] = [];

  const addSecret = (value: string) => {
    const v = value.trim();
    if (v.length < MIN_SECRET_LENGTH || secrets.includes(v)) return;
    // Longest first, so a secret that contains another is removed whole.
    secrets = [...secrets, v].sort((a, b) => b.length - a.length);
  };
  initialSecrets.forEach(addSecret);

  const redactString = (s: string): string => {
    let out = s;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out
      .replace(URL_SECRET_PARAM, `$1${REDACTED}`)
      .replace(BEARER, `Bearer ${REDACTED}`)
      .replace(BYTE_ARRAY_64, "[REDACTED:keypair-bytes]");
  };

  const walk = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return redactString(value);
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value.toISOString();
    if (isKeypairBytes(value)) return "[REDACTED:keypair-bytes]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        ...(value.stack ? { stack: redactString(value.stack) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, seen));

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keepAsIs = v === null || v === undefined || typeof v === "boolean";
      out[k] = isSensitiveKey(k) && !keepAsIs ? REDACTED : walk(v, seen);
    }
    return out;
  };

  return { addSecret, redactString, redact: (value) => walk(value, new WeakSet()) };
}
