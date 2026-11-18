// A stand-in for the aihub CLI: prints a fixture per command. FAKE_AIHUB_DIR picks the fixture folder,
// FAKE_AIHUB_CALLS appends one line per call, FAKE_AIHUB_FAIL=<first word> makes that command fail,
// FAKE_AIHUB_SLEEP=<ms> delays every answer.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.FAKE_AIHUB_DIR || join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const args = process.argv.slice(2).filter((a) => a !== "--json");
if (process.env.FAKE_AIHUB_CALLS) appendFileSync(process.env.FAKE_AIHUB_CALLS, `${args.join(" ")}\n`);

const wait = Number(process.env.FAKE_AIHUB_SLEEP || 0);
if (wait) await new Promise((r) => setTimeout(r, wait));

if (args[0] === "--version") {
  console.log(process.env.FAKE_AIHUB_VERSION || "1.0.2");
  process.exit(0);
}
if (process.env.FAKE_AIHUB_FAIL === args[0]) {
  console.error("aihub: no single workspace named 'feat x' for branch feat/x; pass --workspace");
  process.exit(1);
}
const name = args[0] === "pr" ? `pr-${args[1]}` : args[0] === "fabric" ? `fabric-${args[1]}` : args[0] === "watch" ? `watch-${args[1]}` : args[0];
const file = join(dir, `${name}.json`);
if (!existsSync(file)) {
  console.error(`aihub: unknown command '${args.join(" ")}'`);
  process.exit(2);
}
process.stdout.write(readFileSync(file, "utf8"));
