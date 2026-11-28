import { existsSync } from "node:fs";
import { delimiter, join, relative, sep } from "node:path";
import { spawnSync } from "../proc.js";
import { normPath, type Browse } from "./core.js";
import type { Clone } from "./read.js";

/**
 * Text search without Azure DevOps Code Search: the clones on this PC only, with ripgrep (one process for all clones; the
 * extension passes VS Code's own rg in AIHUB_RG) or else `git grep` per clone. Nothing is sent to Azure DevOps. Case-insensitive,
 * fixed text, like Code Search's words.
 */

export interface LocalHit {
  file: string;
  line: number;
  text: string;
  ranges: [number, number][];
}

/** rg from AIHUB_RG, else the first rg on PATH; no process to find it. */
export function findRg(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AIHUB_RG && existsSync(env.AIHUB_RG)) return env.AIHUB_RG;
  const names = process.platform === "win32" ? ["rg.exe"] : ["rg"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Every case-insensitive occurrence of `text` in `line` as [start, end) columns. */
export function rangesIn(line: string, text: string): [number, number][] {
  const out: [number, number][] = [];
  const l = line.toLowerCase();
  const t = text.toLowerCase();
  if (!t) return out;
  for (let i = l.indexOf(t); i >= 0; i = l.indexOf(t, i + t.length)) out.push([i, i + t.length]);
  return out;
}

/** `rg --json` lines -> hits (absolute file paths). */
export function parseRgJson(out: string, text: string): LocalHit[] {
  const hits: LocalHit[] = [];
  for (const l of out.split(/\r?\n/)) {
    if (!l.startsWith("{")) continue;
    let j: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.type !== "match" || !j.data?.path?.text || !j.data.line_number) continue;
    const t = (j.data.lines?.text ?? "").replace(/\r?\n$/, "");
    hits.push({ file: j.data.path.text, line: j.data.line_number, text: t.length > 400 ? t.slice(0, 400) : t, ranges: rangesIn(t, text) });
  }
  return hits;
}

/** `git grep -n --column` lines (`[<rev>:]path:line:col:text`) -> hits (paths relative to the clone). */
export function parseGitGrep(out: string, text: string, rev?: string): LocalHit[] {
  const hits: LocalHit[] = [];
  for (let l of out.split(/\r?\n/)) {
    if (!l) continue;
    if (rev && l.startsWith(`${rev}:`)) l = l.slice(rev.length + 1);
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const t = m[4];
    hits.push({ file: m[1], line: Number(m[2]), text: t.length > 400 ? t.slice(0, 400) : t, ranges: rangesIn(t, text) });
  }
  return hits;
}

export interface LocalTarget {
  project: string;
  repo: string;
  clone: Clone;
}

export interface LocalFile {
  project: string;
  repo: string;
  path: string;
  branch: string;
  clone: Clone;
  matches: { line: number; text: string; ranges: [number, number][] }[];
}

const globsOf = (ext: string[]) => ext.map((e) => `*.${e}`);

/**
 * Searches the clones. `branch`: a clone on another branch is searched at origin/<branch> with git grep (not its working tree);
 * a clone without that branch is named in `skipped`.
 */
export function searchClones(b: Pick<Browse, "env">, targets: LocalTarget[], o: { text: string; path?: string; ext?: string[]; branch?: string; top: number }): { files: LocalFile[]; skipped: { what: string; reason: string }[]; tool: "ripgrep" | "git grep" } {
  const skipped: { what: string; reason: string }[] = [];
  const files: LocalFile[] = [];
  const add = (t: LocalTarget, rel: string, branch: string, h: LocalHit) => {
    const path = normPath(rel.split(sep).join("/"));
    let f = files.find((x) => x.repo === t.repo && x.project === t.project && x.path === path);
    if (!f) {
      if (files.length >= o.top) return;
      f = { project: t.project, repo: t.repo, path, branch, clone: t.clone, matches: [] };
      files.push(f);
    }
    if (f.matches.length < 20) f.matches.push({ line: h.line, text: h.text, ranges: h.ranges });
  };
  const ext = (o.ext ?? []).map((e) => e.replace(/^\*?\./, "").trim()).filter(Boolean);
  const sub = o.path ? normPath(o.path).slice(1) : "";
  const onBranch = targets.filter((t) => !o.branch || t.clone.branch === o.branch);
  const elsewhere = targets.filter((t) => o.branch && t.clone.branch !== o.branch);
  const rg = findRg(b.env);
  let tool: "ripgrep" | "git grep" = rg ? "ripgrep" : "git grep";
  if (rg && onBranch.length) {
    const dirs = onBranch.map((t) => (sub ? join(t.clone.path, sub) : t.clone.path)).filter((d) => existsSync(d));
    const args = ["--json", "-i", "-F", "--max-count", "20", "--max-filesize", "5M", ...globsOf(ext).flatMap((g) => ["-g", g]), "-e", o.text, ...dirs];
    const r = spawnSync(rg, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 || r.status === 1) {
      for (const h of parseRgJson(r.stdout ?? "", o.text)) {
        const t = onBranch.find((x) => h.file.toLowerCase().startsWith(`${x.clone.path.toLowerCase()}${sep}`) || h.file.toLowerCase().startsWith(`${x.clone.path.toLowerCase()}/`));
        if (t) add(t, relative(t.clone.path, h.file), t.clone.branch, h);
      }
    } else {
      tool = "git grep"; // rg could not run: the clones are searched one by one
      elsewhere.push(...onBranch.splice(0));
    }
  } else elsewhere.push(...onBranch.splice(0));
  for (const t of elsewhere) {
    const rev = o.branch && t.clone.branch !== o.branch ? `origin/${o.branch}` : undefined;
    if (rev && spawnSync("git", ["rev-parse", "--verify", "--quiet", rev], { cwd: t.clone.path, encoding: "utf8" }).status !== 0) {
      skipped.push({ what: `${t.project}/${t.repo}`, reason: `the clone has no ${rev}` });
      continue;
    }
    const spec = [...(sub ? [sub] : []), ...ext.map((e) => `${sub ? `${sub}/` : ""}*.${e}`)];
    const pathspec = ext.length ? ext.map((e) => `:(glob)${sub ? `${sub}/` : ""}**/*.${e}`) : spec;
    const r = spawnSync("git", ["grep", "-n", "-I", "-i", "-F", "--column", "--max-count", "20", "-e", o.text, ...(rev ? [rev] : []), "--", ...pathspec], { cwd: t.clone.path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) {
      skipped.push({ what: `${t.project}/${t.repo}`, reason: `git grep failed: ${(r.stderr ?? "").split(/\r?\n/)[0]}` });
      continue;
    }
    for (const h of parseGitGrep(r.stdout ?? "", o.text, rev)) add(t, h.file, o.branch ?? t.clone.branch, h);
  }
  return { files, skipped, tool };
}
