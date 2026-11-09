import { spawn } from "node:child_process";
import type { FetchFn } from "./expand.ts";

/** Turns image bytes into text. Injected so tests and hosts without tesseract can swap it. */
export type OcrEngine = (image: Uint8Array) => Promise<string>;

export class OcrUnavailableError extends Error {
  override name = "OcrUnavailableError";
}

/**
 * OCR through the local `tesseract` binary (brew install tesseract / apt install tesseract-ocr).
 * Image bytes go in on stdin, text comes out on stdout. Nothing touches disk.
 */
export function tesseractOcr(opts: { bin?: string; timeoutMs?: number } = {}): OcrEngine {
  const bin = opts.bin ?? "tesseract";
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return (image) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, ["stdin", "stdout", "--psm", "6"], { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`tesseract timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(e.code === "ENOENT" ? new OcrUnavailableError(`${bin} not found on PATH`) : e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else reject(new Error(`tesseract exited ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 200)}`));
      });
      child.stdin.on("error", () => {}); // EPIPE if tesseract dies early; the close handler reports it
      child.stdin.end(image);
    });
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Downloads an image (X media URL) and OCRs it. */
export async function ocrImageUrl(
  url: string,
  ocr: OcrEngine,
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<string> {
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4_000) });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.length} bytes`);
  return ocr(bytes);
}
