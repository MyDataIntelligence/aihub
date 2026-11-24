import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./git.js";

/** `<git common dir>/aihub`: local state that is never committed (notes, watches, event log). Shared by all worktrees. */
const knownCommon = new Map<string, string>();

/** A caller that already asked git for the common dir (aihub status) saves the extra git call. */
export function rememberCommonDir(root: string, commonDir: string): void {
  knownCommon.set(root, commonDir);
}

export function aihubDir(root: string, ...parts: string[]): string {
  const common = knownCommon.get(root) ?? git(root, ["rev-parse", "--git-common-dir"]).trim();
  return join(resolve(root, common), "aihub", ...parts);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
