#!/usr/bin/env node
// Entry point. Commands are registered in src/router.ts.
import { flushPerf, perfRecord, startPerf, timedFetch } from "./lib/perf.js";
import { main } from "./router.js";

const argv = process.argv.slice(2);
startPerf(process.env, argv);
const t0 = performance.now();
const code = await main(argv, {
  cwd: process.cwd(),
  env: process.env,
  fetch: timedFetch(fetch),
  out: (l) => process.stdout.write(l + "\n"),
  err: (l) => process.stderr.write(l + "\n"),
});
// startupMs: node start plus loading the modules, before the command ran
perfRecord("cli.run", { ms: Math.round(performance.now() - t0), startupMs: Math.round(t0), code });
flushPerf();
process.exitCode = code;
