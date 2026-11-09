import { main } from "./app/main.ts";

process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() });
