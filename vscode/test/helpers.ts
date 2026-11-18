import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRunner } from "../src/cli";

export const here = dirname(fileURLToPath(import.meta.url));
export const STUB = join(here, "fake-aihub.mjs");

/** A runner that runs the fake aihub with node. Extra env goes to the stub. */
export const stubRunner = (env: Record<string, string> = {}, timeoutMs = 10_000) => makeRunner({ command: process.execPath, prefixArgs: [STUB], timeoutMs, env });

export const fx = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8"));
