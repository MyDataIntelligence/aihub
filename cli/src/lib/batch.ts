import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shortBranch, type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git } from "./git.js";
import { globMatch } from "./team.js";
import { listPrs } from "./work.js";

export interface RunResult {
  code: number;
  output: string;
}
export type Runner = (argv: string[]) => Promise<RunResult>;

export interface BatchRecord {
  target: string;
  ok: boolean;
  summary: string;
}
interface Stored {
  id: string;
  run: string;
  results: BatchRecord[];
}

export const MAX_PARALLEL = 8;

/** Split a command line into tokens, honouring single and double quotes. */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (q) throw new AihubError("--run has an unclosed quote");
  if (cur || has) out.push(cur);
  return out;
}

export async function selectTargets(client: AdoClient, query: string): Promise<string[]> {
  const i = query.indexOf(":");
  const kind = i < 0 ? query : query.slice(0, i);
  const arg = i < 0 ? "" : query.slice(i + 1);
  if (kind === "prs") {
    if (arg !== "mine" && arg !== "active") throw new AihubError("query prs:<mine|active>");
    return (await listPrs(client, { mine: arg === "mine" })).map((p) => String(p.pullRequestId));
  }
  if (kind === "branches") {
    if (!arg) throw new AihubError("query branches:<glob>, e.g. branches:release/*");
    const refs = await client.list<{ name: string }>(`${client.repoPath()}/refs`, { filter: "heads/" });
    return refs.map((r) => shortBranch(r.name)).filter((b) => globMatch(arg, b));
  }
  if (kind === "ids") {
    const ids = arg.split(",").map((x) => x.trim()).filter(Boolean);
    if (!ids.length) throw new AihubError("query ids:1,2,3");
    return ids;
  }
  throw new AihubError(`unknown query '${query}'; use prs:mine, prs:active, branches:<glob> or ids:1,2,3`);
}

const oneLine = (s: string) => (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 110);

export async function runBatch(
  targets: string[],
  template: string[],
  parallel: number,
  runner: Runner,
): Promise<BatchRecord[]> {
  const results: BatchRecord[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const t = targets[i];
      const argv = template.map((x) => x.split("{target}").join(t));
      try {
        const r = await runner(argv);
        results[i] = { target: t, ok: r.code === 0, summary: oneLine(r.output) };
      } catch (e) {
        results[i] = { target: t, ok: false, summary: oneLine((e as Error).message) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, targets.length) }, worker));
  return results;
}

export interface BatchOpts {
  select?: string;
  run?: string;
  parallel?: number;
  retryFailed?: string;
  json?: boolean;
}

export async function batch(ctx: Ctx, o: BatchOpts, runner: Runner): Promise<void> {
  const { root, client } = repoClient(ctx);
  const dir = join(git(root, ["rev-parse", "--absolute-git-dir"]), "aihub", "batches");
  const parallel = o.parallel ?? 4;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new AihubError(`--parallel must be 1..${MAX_PARALLEL}`);

  let run: string;
  let targets: string[];
  let prior: BatchRecord[] = [];
  if (o.retryFailed) {
    let st: Stored;
    try {
      st = JSON.parse(readFileSync(join(dir, `${o.retryFailed}.json`), "utf8")) as Stored;
    } catch {
      throw new AihubError(`unknown batch id '${o.retryFailed}'`);
    }
    run = st.run;
    prior = st.results;
    targets = st.results.filter((r) => !r.ok).map((r) => r.target);
    if (!targets.length) {
      ctx.out(`batch ${st.id}: nothing failed, nothing to retry`);
      return;
    }
  } else {
    if (!o.select || !o.run) throw new AihubError('usage: aihub batch --select "<query>" --run "<aihub subcommand with {target}>"');
    run = o.run;
    targets = await selectTargets(client, o.select);
    if (!targets.length) {
      ctx.out(`batch: '${o.select}' selected nothing`);
      return;
    }
  }
  const template = splitCommand(run);
  if (template[0] === "aihub") template.shift();
  if (!template.length || template[0] === "batch") throw new AihubError("--run needs an aihub subcommand (not batch)");
  if (!run.includes("{target}")) throw new AihubError("--run must contain {target}");

  const fresh = await runBatch(targets, template, parallel, runner);
  const merged = o.retryFailed ? prior.map((p) => fresh.find((f) => f.target === p.target) ?? p) : fresh;
  const id = o.retryFailed ?? `b${Date.now().toString(36)}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, run, results: merged } satisfies Stored, null, 1), "utf8");

  const failed = merged.filter((r) => !r.ok);
  if (o.json) ctx.out(JSON.stringify({ id, results: merged }));
  else {
    ctx.out(`batch ${id}: ${merged.length - failed.length}/${merged.length} ok`);
    const w = Math.max(...fresh.map((r) => r.target.length));
    for (const r of fresh) ctx.out(`${r.target.padEnd(w)}  ${r.ok ? "ok    " : "FAILED"}  ${r.summary}`);
  }
  if (failed.length) throw new AihubError(`${failed.length} of ${merged.length} failed; retry with: aihub batch --retry-failed ${id}`);
}
