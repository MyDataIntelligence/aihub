import { existsSync } from "node:fs";
import { join } from "node:path";
import { clientDirs, type Client } from "./clients.js";
import { cliVersion } from "./pack.js";
import { readManifest, readNorm, skillEntries } from "./install.js";
import { sha256 } from "./pack.js";

type Op = { t: " " | "-" | "+"; s: string };

/** Line diff (longest common subsequence); fine for skill-sized files. */
export function lineDiff(a: string, b: string): Op[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const m = x.length;
  const n = y.length;
  const l: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) l[i][j] = x[i] === y[j] ? l[i + 1][j + 1] + 1 : Math.max(l[i + 1][j], l[i][j + 1]);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) out.push({ t: " ", s: x[i++] }), j++;
    else if (l[i + 1][j] >= l[i][j + 1]) out.push({ t: "-", s: x[i++] });
    else out.push({ t: "+", s: y[j++] });
  }
  while (i < m) out.push({ t: "-", s: x[i++] });
  while (j < n) out.push({ t: "+", s: y[j++] });
  return out;
}

/** The `aihub <version>` marker differs per release and is not a user edit. */
const unmark = (s: string): string => s.replace(/^(<!-- aihub \S+ -->|# aihub \S+)\n/m, "");

/** Only the changed lines with one line of context. */
export function formatDiff(a: string, b: string): string[] {
  const ops = lineDiff(a, b);
  const keep = ops.map((o, i) => o.t !== " " || (ops[i - 1] !== undefined && ops[i - 1].t !== " ") || (ops[i + 1] !== undefined && ops[i + 1].t !== " "));
  const lines: string[] = [];
  let gap = false;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap && lines.length) lines.push("  ...");
    gap = false;
    lines.push(`${o.t} ${o.s}`);
  });
  return lines;
}

export interface FileDiff {
  rel: string;
  /** edited: you changed it; behind: unchanged but the bundled pack has a newer version; missing: you deleted it */
  state: "edited" | "behind" | "missing";
  diff: string[];
}

/** Compare the installed copy of one client with the bundled pack. Only files aihub installed (manifest) are looked at. */
export function diffClient(env: NodeJS.ProcessEnv, client: Client, opts: { global: boolean; root?: string }): FileDiff[] {
  const dir = clientDirs(client, env, opts).skills;
  const man = readManifest(dir);
  const out: FileDiff[] = [];
  for (const e of skillEntries(cliVersion())) {
    const recorded = man.files[e.rel];
    if (!recorded) continue;
    const abs = join(dir, e.rel);
    if (!existsSync(abs)) {
      out.push({ rel: e.rel, state: "missing", diff: [] });
      continue;
    }
    const local = readNorm(abs);
    if (sha256(local) === sha256(e.content)) continue;
    const edited = sha256(local) !== recorded;
    out.push({ rel: e.rel, state: edited ? "edited" : "behind", diff: edited ? formatDiff(unmark(e.content), unmark(local)) : [] });
  }
  return out;
}