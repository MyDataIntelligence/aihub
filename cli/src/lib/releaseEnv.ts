import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { getPr, getWorkItemTitle, type AdoClient, type PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { mapItems } from "./fabric.js";
import { tryGit } from "./gitx.js";
import { fetchOrigin } from "./repos.js";
import type { PlanItem, ReleasePlan } from "./release.js";
import { loadTeam, type TeamConfig } from "./team.js";

/**
 * `aihub release plan --from DEV --to ACC`: what would move from one environment to the next. Git (`<to-branch>..<from-branch>`) says which
 * Fabric items changed and through which PRs and stories; the Fabric deployment-pipeline stages say which items are new or deleted. Read only.
 */
export interface EnvDef {
  branch?: string;
  workspace?: string;
  /** deployment pipeline stage name or order, default the environment name */
  stage?: string;
}

export function environmentsOf(team: TeamConfig): Record<string, EnvDef> {
  const e = (team as { fabric?: { environments?: Record<string, EnvDef> } }).fabric?.environments ?? {};
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k.toUpperCase(), v ?? {}]));
}

export interface StageItem {
  name: string;
  type: string;
}

/** Items of one deployment pipeline stage (read only). */
export type StageReader = (pipeline: string, stage: string) => Promise<StageItem[]>;

export interface EnvDiffOpts {
  from?: string;
  to?: string;
  target?: string;
  also?: string[];
  name?: string;
  out?: string;
  notesOut?: string;
  json?: boolean;
}

export interface EnvItem {
  name: string;
  type: string;
  status: "new" | "changed" | "deleted";
  prs: number[];
  stories: number[];
}

export interface EnvPr {
  id: number;
  title: string;
  commit: string;
  stories: number[];
}

export interface EnvDiff {
  from: string;
  to: string;
  fromBranch: string;
  toBranch: string;
  commits: number;
  items: EnvItem[];
  prs: EnvPr[];
  /** commits on the range that no pull request explains (direct pushes) */
  direct: { commit: string; title: string }[];
  stories: { id: number; title?: string }[];
  fabric: { used: boolean; note?: string; stages?: { from: string; to: string } };
}

interface Commit {
  sha: string;
  subject: string;
  files: string[];
}

/** First-parent commits of the range, oldest first, with the files each one changed. */
export function rangeCommits(root: string, toRef: string, fromRef: string): Commit[] {
  const log = tryGit(root, ["log", "--first-parent", "--reverse", "--format=%H%x09%s", `${toRef}..${fromRef}`]);
  if (!log.ok) throw new AihubError(`git log ${toRef}..${fromRef} failed; fetch the branches first`);
  return log.out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      const files = tryGit(root, ["diff", "--name-only", `${sha}^1`, sha]).out.split("\n").filter(Boolean);
      return { sha, subject: rest.join("\t"), files };
    });
}

const MSG = /(?:Merged PR |Merge pull request !?|Merged pull request )(\d+)/i;

/** Pull request ids per commit: the Azure DevOps query by merge commit, then the "Merged PR 12" message as the fallback. */
export async function prsOf(client: AdoClient, commits: Commit[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!commits.length) return out;
  try {
    const r = await client.post<{ results?: Record<string, { pullRequestId: number }[]>[] }>(`${client.repoPath()}/pullrequestquery`, { queries: [{ items: commits.map((c) => c.sha), type: "lastMergeCommit" }] });
    for (const res of r.results ?? []) for (const [sha, prs] of Object.entries(res)) if (prs?.length) out.set(sha, prs.map((p) => p.pullRequestId));
  } catch {
    /* the message is the fallback */
  }
  for (const c of commits) {
    if (out.has(c.sha)) continue;
    const m = MSG.exec(c.subject);
    if (m) out.set(c.sha, [Number(m[1])]);
  }
  return out;
}

const keyOf = (type: string, name: string): string => `${type}:${name}`.toLowerCase();

export async function computeEnvDiff(
  ctx: Ctx,
  o: { from: string; to: string },
  deps: { stageItems?: StageReader } = {},
): Promise<{ diff: EnvDiff; plan: Pick<ReleasePlan, "items"> }> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const envs = environmentsOf(team);
  const from = o.from.toUpperCase();
  const to = o.to.toUpperCase();
  for (const e of [from, to]) {
    if (!envs[e]?.branch) throw new AihubError(`fabric.environments.${e}.branch is not set in team.yaml: say which git branch holds ${e} (for example fabric.environments.${e}.branch: ${e === "DEV" ? "develop" : "staging"})`);
  }
  if (from === to) throw new AihubError("--from and --to are the same environment");
  const fromBranch = envs[from].branch!;
  const toBranch = envs[to].branch!;
  fetchOrigin(root);
  const ref = (b: string) => (tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]).ok ? `origin/${b}` : b);
  const commits = rangeCommits(root, ref(toBranch), ref(fromBranch));

  const byCommit = await prsOf(client, commits);
  const prInfo = new Map<number, EnvPr>();
  for (const [sha, ids] of byCommit) {
    for (const id of ids) {
      if (prInfo.has(id)) continue;
      try {
        const pr = (await getPr(client, id)) as PullRequest & { workItemRefs?: { id: string }[]; lastMergeCommit?: { commitId: string } };
        prInfo.set(id, { id, title: pr.title, commit: pr.lastMergeCommit?.commitId ?? sha, stories: (pr.workItemRefs ?? []).map((w) => Number(w.id)) });
      } catch {
        prInfo.set(id, { id, title: `PR !${id}`, commit: sha, stories: [] });
      }
    }
  }
  const prs = [...prInfo.values()].sort((a, b) => commits.findIndex((c) => byCommit.get(c.sha)?.includes(a.id)) - commits.findIndex((c) => byCommit.get(c.sha)?.includes(b.id)));
  const direct = commits.filter((c) => !byCommit.has(c.sha)).map((c) => ({ commit: c.sha, title: c.subject }));

  // items changed in git, with the PRs and stories behind them
  const items = new Map<string, EnvItem>();
  for (const c of commits) {
    for (const it of mapItems(c.files)) {
      const k = keyOf(it.type, it.name);
      const cur = items.get(k) ?? { name: it.name, type: it.type, status: "changed" as const, prs: [], stories: [] };
      for (const id of byCommit.get(c.sha) ?? []) {
        if (!cur.prs.includes(id)) cur.prs.push(id);
        for (const s of prInfo.get(id)?.stories ?? []) if (!cur.stories.includes(s)) cur.stories.push(s);
      }
      items.set(k, cur);
    }
  }

  // new and deleted items from the deployment pipeline stages
  const fabric: EnvDiff["fabric"] = { used: false };
  const pipeline = (team as { fabric?: { deploymentPipeline?: string } }).fabric?.deploymentPipeline;
  if (!pipeline) fabric.note = "Fabric stage compare skipped: fabric.deploymentPipeline is not set in team.yaml (git only)";
  else {
    const stageFrom = envs[from].stage ?? from;
    const stageTo = envs[to].stage ?? to;
    try {
      const read = deps.stageItems ?? (await defaultStageReader(ctx));
      const [a, b] = [await read(pipeline, stageFrom), await read(pipeline, stageTo)];
      fabric.used = true;
      fabric.stages = { from: stageFrom, to: stageTo };
      const inTo = new Set(b.map((x) => keyOf(x.type, x.name)));
      const inFrom = new Set(a.map((x) => keyOf(x.type, x.name)));
      for (const x of a) if (!inTo.has(keyOf(x.type, x.name))) items.set(keyOf(x.type, x.name), { ...(items.get(keyOf(x.type, x.name)) ?? { name: x.name, type: x.type, prs: [], stories: [] }), status: "new" });
      for (const x of b) if (!inFrom.has(keyOf(x.type, x.name))) items.set(keyOf(x.type, x.name), { ...(items.get(keyOf(x.type, x.name)) ?? { name: x.name, type: x.type, prs: [], stories: [] }), status: "deleted" });
    } catch (e) {
      fabric.note = `Fabric stage compare skipped: ${(e as Error).message.split("\n")[0]} (git only)`;
    }
  }

  const storyIds = [...new Set([...prs.flatMap((p) => p.stories), ...[...items.values()].flatMap((i) => i.stories)])].sort((a, b) => a - b);
  const stories = await Promise.all(storyIds.map(async (id) => ({ id, title: await getWorkItemTitle(client, id) })));
  const order = ["new", "changed", "deleted"];
  const sorted = [...items.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const planItems: PlanItem[] = [
    ...prs.map((p) => ({ pr: p.id, title: p.title, commit: p.commit, ...(p.stories[0] ? { story: p.stories[0] } : {}) })),
    ...direct.map((d) => ({ commit: d.commit, title: d.title })),
  ];
  return { diff: { from, to, fromBranch, toBranch, commits: commits.length, items: sorted, prs, direct, stories, fabric }, plan: { items: planItems } };
}

async function defaultStageReader(ctx: Ctx): Promise<StageReader> {
  const { makeClient } = await import("../commands/fabric.js");
  const client = makeClient(ctx, {});
  return async (pipeline, stage) => {
    const all = await client.list<{ id: string; displayName: string }>("/deploymentPipelines");
    const p = all.find((x) => x.id.toLowerCase() === pipeline.toLowerCase() || x.displayName.toLowerCase() === pipeline.toLowerCase());
    if (!p) throw new AihubError(`deployment pipeline '${pipeline}' not found${all.length ? `; available: ${all.map((x) => x.displayName).join(", ")}` : " (none visible for this account)"}`);
    const stages = await client.list<{ id: string; order: number; displayName: string }>(`/deploymentPipelines/${p.id}/stages`);
    const st = stages.find((x) => x.id.toLowerCase() === stage.toLowerCase() || x.displayName.toLowerCase() === stage.toLowerCase() || String(x.order) === stage);
    if (!st) throw new AihubError(`stage '${stage}' not found in ${p.displayName}; stages: ${stages.map((x) => `${x.order}=${x.displayName}`).join(", ")}`);
    const items = await client.list<{ itemDisplayName?: string; displayName?: string; itemType?: string; type?: string }>(`/deploymentPipelines/${p.id}/stages/${st.id}/items`);
    return items.map((i) => ({ name: i.itemDisplayName ?? i.displayName ?? "?", type: i.itemType ?? i.type ?? "?" }));
  };
}

// ---- text ----------------------------------------------------------------------------------------------------------------

const L = {
  en: { notes: "Release notes", stories: "Stories", items: "Items", nostory: "Without a story", status: { new: "new", changed: "changed", deleted: "deleted" }, none: "nothing changed" },
  nl: { notes: "Release-notes", stories: "Stories", items: "Onderdelen", nostory: "Zonder story", status: { new: "nieuw", changed: "gewijzigd", deleted: "verwijderd" }, none: "niets gewijzigd" },
};

export function releaseNotes(d: EnvDiff, lang: string | undefined, date = new Date().toISOString().slice(0, 10)): string {
  const t = lang === "nl" ? L.nl : L.en;
  const lines = [`# ${t.notes} ${d.from} -> ${d.to} (${date})`, ""];
  if (d.stories.length) {
    lines.push(`## ${t.stories}`, "");
    for (const s of d.stories) {
      const ps = d.prs.filter((p) => p.stories.includes(s.id)).map((p) => `!${p.id}`);
      lines.push(`- AB#${s.id}${s.title ? ` ${s.title}` : ""}${ps.length ? ` (${ps.join(", ")})` : ""}`);
    }
    lines.push("");
  }
  const loose = d.prs.filter((p) => !p.stories.length);
  if (loose.length || d.direct.length) {
    lines.push(`## ${t.nostory}`, "", ...loose.map((p) => `- !${p.id} ${p.title}`), ...d.direct.map((x) => `- ${x.commit.slice(0, 8)} ${x.title}`), "");
  }
  lines.push(`## ${t.items}`, "");
  if (!d.items.length) lines.push(`- ${t.none}`);
  for (const i of d.items) {
    const refs = [...i.stories.map((s) => `AB#${s}`), ...i.prs.map((p) => `!${p}`)];
    lines.push(`- ${i.type} ${i.name}: ${t.status[i.status]}${refs.length ? ` (${refs.join(", ")})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderEnvText(d: EnvDiff, cherryTarget: string): string {
  const out = [`Release ${d.from} -> ${d.to}: git origin/${d.toBranch}..origin/${d.fromBranch}: ${d.commits} commit(s), ${d.prs.length} PR(s), ${d.stories.length} story(ies)`];
  out.push(d.fabric.used ? `Fabric stages ${d.fabric.stages!.from} -> ${d.fabric.stages!.to}: compared` : d.fabric.note ?? "Fabric stage compare skipped");
  out.push("", `Items (${d.items.length}):`);
  if (!d.items.length) out.push("  none");
  for (const i of d.items) out.push(`  ${i.status.padEnd(7)} ${i.type} ${i.name}${i.prs.length ? `  PRs ${i.prs.map((p) => `!${p}`).join(" ")}` : ""}${i.stories.length ? `  stories ${i.stories.map((s) => `AB#${s}`).join(" ")}` : ""}`);
  out.push("", `Cherry-pick list for ${cherryTarget} (merge order):`);
  if (!d.prs.length) out.push("  none");
  for (const p of d.prs) out.push(`  !${p.id} ${p.title}${p.stories.length ? ` (${p.stories.map((s) => `AB#${s}`).join(", ")})` : ""}`);
  for (const x of d.direct) out.push(`  ${x.commit.slice(0, 8)} ${x.title}  (no PR)`);
  return out.join("\n");
}

export async function releaseEnvPlan(ctx: Ctx, o: EnvDiffOpts, deps: { stageItems?: StageReader } = {}): Promise<string> {
  if (!o.from || !o.to) throw new AihubError("--from and --to go together: aihub release plan --from DEV --to ACC");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const { diff, plan } = await computeEnvDiff(ctx, { from: o.from, to: o.to }, deps);
  const target = o.target ?? diff.toBranch;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const full: ReleasePlan = {
    version: 1,
    repo: client.remote.repo,
    name: o.name ?? `release/${diff.to.toLowerCase()}-${date}`,
    targets: [target, ...(o.also ?? []).filter((t) => t !== target)],
    items: plan.items,
    ...(diff.fabric.note ? { notes: [diff.fabric.note] } : {}),
  };
  const lang = (team as { language?: string }).language;
  const notes = releaseNotes(diff, lang);
  if (o.out) writeFileSync(o.out, stringify(full), "utf8");
  if (o.notesOut) writeFileSync(o.notesOut, notes, "utf8");
  if (o.json) return JSON.stringify({ plan: full, diff, notes });
  return [renderEnvText(diff, target), "", "Release notes:", notes.trimEnd(), "", o.out ? `plan written to ${o.out}; run it with: aihub release run --plan-file ${o.out}` : "add --out plan.yaml to keep the cherry-pick plan for 'aihub release run'", ...(o.notesOut ? [`release notes written to ${o.notesOut}`] : [])].join("\n");
}
