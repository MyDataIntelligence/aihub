#!/usr/bin/env node
// Entry point. Commands are registered in src/router.ts.
import { main } from "./router.js";

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  fetch,
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
});
process.exitCode = code;
