import { parseArgs } from "node:util";
import { AihubError } from "./errors.js";

type Opts = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

export function parse<T extends Opts>(argv: string[], options: T, positionals = false) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: positionals });
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
}

export function num(v: unknown, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/^AB#/i, ""));
  if (!Number.isInteger(n) || n <= 0) throw new AihubError(`${flag} must be a number`);
  return n;
}
