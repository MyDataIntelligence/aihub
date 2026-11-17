import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AihubError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Directory that holds the bundled `skills/` and `commands/` (the repo root in a checkout, cli/pack in the npm package). */
export function packRoot(): string {
  for (const c of [join(here, "..", "..", ".."), join(here, "..", "..", "pack")]) {
    if (existsSync(join(c, "skills")) && existsSync(join(c, "commands"))) return c;
  }
  throw new AihubError("the bundled skills are missing from this installation; reinstall with 'npm i -g @ferronhooi/aihub'");
}

export function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Relative POSIX paths of all files below dir, sorted. */
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(p.slice(base.length + 1).replace(/\\/g, "/"));
  }
  return out;
}

export const readPackFile = (path: string): string => readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

/**
 * Mark a file as installed by aihub: `<!-- aihub <version> -->` in markdown (after the front matter, which must stay
 * first), `# aihub <version>` in other text files.
 */
export function stamp(rel: string, content: string, version: string): string {
  const isMd = rel.endsWith(".md");
  const mark = isMd ? `<!-- aihub ${version} -->` : `# aihub ${version}`;
  const fm = /^---\n[\s\S]*?\n---\n/.exec(content);
  if (isMd && fm) return `${fm[0]}${mark}\n${content.slice(fm[0].length)}`;
  return `${mark}\n${content}`;
}
