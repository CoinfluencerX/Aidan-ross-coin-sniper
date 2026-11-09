import { main } from "./app/main.ts";

// Ctrl-C / SIGTERM stop the watcher cleanly (streams closed, shutdown audited). A second Ctrl-C forces exit.
const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stop.signal.aborted) process.exit(130);
    stop.abort();
  });
}

process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), signal: stop.signal });
