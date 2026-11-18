import { parseArgs } from "node:util";
import { AihubError } from "./errors.js";

type Opts = Record<string, { type: "string" | "boolean" }>;

export function parseFlags(argv: string[], options: Opts): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false }).values as Record<string, string | boolean | undefined>;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
}

/** A positive integer, also accepting AB#123 and !123. */
export function posInt(v: unknown, flag: string): number {
  const n = Number(String(v ?? "").replace(/^(AB#|!)/i, ""));
  if (!Number.isInteger(n) || n <= 0) throw new AihubError(`${flag} must be a number`);
  return n;
}

export function optInt(v: unknown, flag: string): number | undefined {
  return v === undefined ? undefined : posInt(v, flag);
}

export function list(v: unknown): string[] {
  return v === undefined ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

export function intList(v: unknown, flag: string): number[] {
  return list(v).map((x) => posInt(x, flag));
}
