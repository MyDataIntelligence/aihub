import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findActivePr } from "../ado.js";
import { BrowseError } from "../browse/core.js";
import { ensureBranch } from "../branches.js";
import { configHome } from "../configHome.js";
import { repoClient } from "../context.js";
import { clientForDir, fetchOrigin, resolveRepoDirs } from "../repos.js";
import { readSetFile, repoBranch } from "../setFile.js";
import { forgetScan } from "../machineScan.js";
import { openStory } from "../storyBranches.js";
import { linkBranch, storyWorktreesFileFor, updateStoryWorktrees } from "../storyWorktrees.js";
import { baseFor, startStory } from "../story-flow.js";
import { parseSections } from "../templates.js";
import { addArtifactLink, branchArtifact, getWorkItem, prArtifact, repoInfo, slugify } from "../workitems.js";
import { bumpGeneration, F, me, type Stories } from "./core.js";
import { templateOf } from "./template.js";

/**
 * Start Work, Link to Story and Create fix branch: the existing story flows (aihub story start / open, the story
 * branches links), run for the project chosen in the story browser. They need a clone of a repository of that project
 * on this PC (the bar runs the CLI in the window's first folder).
 */

function sameProject(s: Stories): void {
  let here: string;
  try {
    here = repoClient(s.b.ctx).client.remote.project;
  } catch {
    throw new BrowseError("badInput", `Start Work needs a clone of a repository of ${s.project}: open one in this window`);
  }
  if (here.toLowerCase() !== s.project.toLowerCase()) throw new BrowseError("badInput", `this window is a clone of project ${here}, the story is in ${s.project}: open a clone of ${s.project}`);
}

async function assignToMe(s: Stories, id: number): Promise<string | undefined> {
  const m = await me(s);
  if (!m.email) return undefined;
  const w = await s.c.get<{ fields: Record<string, any> }>(`wit/workitems/${id}`, { fields: F.assignedTo });
  const now = w.fields?.[F.assignedTo] as { uniqueName?: string } | undefined;
  if ((now?.uniqueName ?? "").toLowerCase() === m.email) return m.name || m.email;
  await s.c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "add", path: `/fields/${F.assignedTo}`, value: m.email }]);
  return m.name || m.email;
}

export interface StartOpts {
  id: number;
  repos?: string[];
  base?: string;
  /** reuse (default): the story's set on this PC, made when it is not there yet (a story has one set); none: only branches */
  set?: "reuse" | "none";
  assignToMe?: boolean;
  /** where the set opens: new window (default), this window, or not at all */
  open?: "new" | "this" | "none";
}

export async function storyStart(s: Stories, o: StartOpts): Promise<Record<string, unknown>> {
  sameProject(s);
  const ctx = s.b.ctx;
  const started = JSON.parse(await startStory(ctx, { id: o.id, repos: o.repos, base: o.base, noCheckout: true, json: true })) as Record<string, unknown>;
  const assignedTo = o.assignToMe === false ? undefined : await assignToMe(s, o.id);
  let set: Record<string, unknown> | undefined;
  if ((o.set ?? "reuse") !== "none") {
    const r = await openStory(ctx, { id: o.id, mode: "worktree", window: o.open ?? "none", existing: "reuse" });
    set = { folder: r.folder, ...(r.workspace ? { workspace: r.workspace } : {}), opened: r.opened, repos: r.repos };
  }
  bumpGeneration(s);
  forgetScan(s.b.env); // the new branches and set show in the lists right away
  return { ...started, ...(assignedTo ? { assignedTo } : {}), ...(set ? { set } : {}) };
}

// ---- Create fix branch (a Bug) ---------------------------------------------------------------------------------------

export function fixBranchName(s: Stories, id: number, title: string): string {
  const pattern = (s.teamCfg.branches as { bugfix?: string } | undefined)?.bugfix || "bugfix/{storyId}-{slug}";
  return pattern.replace(/\{storyId\}/g, String(id)).replace(/\{slug\}/g, slugify(title));
}

export async function storyFixBranch(s: Stories, o: { id: number; repo?: string; base?: string }): Promise<Record<string, unknown>> {
  sameProject(s);
  const ctx = s.b.ctx;
  const { root, client: main } = repoClient(ctx);
  const wi = await getWorkItem(main, o.id);
  if (!wi.title) throw new BrowseError("notFound", `work item ${o.id} not found`);
  const dir = o.repo ? resolveRepoDirs([o.repo], root, s.teamCfg, [], ctx.env)[0].dir : root;
  const client = clientForDir(ctx, dir);
  fetchOrigin(dir);
  const base = await baseFor(dir, client, s.teamCfg, o.base);
  const branch = fixBranchName(s, o.id, wi.title);
  const e = ensureBranch(dir, branch, base);
  const linked = await addArtifactLink(main, wi, branchArtifact(await repoInfo(client), branch), "Branch");
  const file = storyWorktreesFileFor(dir);
  if (file) updateStoryWorktrees(file, (d) => linkBranch(d, { storyId: o.id, branch, current: true }, (ctx.now ?? Date.now)()));
  bumpGeneration(s);
  forgetScan(s.b.env);
  return { id: o.id, repo: client.remote.repo, branch, base, created: e.created, pushed: e.pushed, linked };
}

// ---- Link to Story ---------------------------------------------------------------------------------------------------

export async function storyLink(s: Stories, o: { id: number; set?: string; repo?: string; branch?: string }): Promise<{ id: number; linked: { repo: string; branch: string; added: boolean }[]; prs: { repo: string; id: number; added: boolean }[] }> {
  const pairs: { repo: string; branch: string }[] = [];
  if (o.set) {
    const f = readSetFile(o.set);
    if (!f) throw new BrowseError("notFound", `${o.set} is not a worktree set (no set file)`);
    for (const r of f.top.repos) pairs.push({ repo: r.name, branch: repoBranch(f.top, r) });
  } else if (o.repo && o.branch) pairs.push({ repo: o.repo, branch: o.branch });
  else throw new BrowseError("badInput", "pass --set <folder>, or --repo R --branch B");
  const wi = await getWorkItem(s.c, o.id);
  const linked: { repo: string; branch: string; added: boolean }[] = [];
  const prs: { repo: string; id: number; added: boolean }[] = [];
  for (const p of pairs) {
    const rc = s.c.forRepo(p.repo);
    const info = await repoInfo(rc);
    linked.push({ ...p, added: await addArtifactLink(s.c, wi, branchArtifact(info, p.branch), "Branch") });
    const pr = await findActivePr(rc, p.branch).catch(() => undefined);
    if (pr) prs.push({ repo: p.repo, id: pr.pullRequestId, added: await addArtifactLink(s.c, wi, prArtifact(info, pr.pullRequestId), "Pull Request") });
  }
  bumpGeneration(s);
  return { id: o.id, linked, prs };
}

// ---- a draft by the agent (chat hand-off) ----------------------------------------------------------------------------

const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, "-");

export const draftFile = (s: Stories, type: string) => join(configHome(s.b.env), "stories", "proposals", `${safe(s.b.org)}-${safe(s.project)}-draft-${safe(type.toLowerCase())}.md`);

export async function storyDraftAsk(s: Stories, o: { type: string; title: string; notes?: string }): Promise<{ type: string; draftFile: string; prompt: string }> {
  const tpl = await templateOf(s, o.type);
  const file = draftFile(s, o.type);
  mkdirSync(join(configHome(s.b.env), "stories", "proposals"), { recursive: true });
  const prompt = [
    `Draft a new ${o.type} "${o.title}" for the story browser. Do not create the work item.`,
    o.notes?.trim() ? `What the user knows:\n${o.notes.trim()}` : "",
    `Write the file ${file} as markdown in the team template, one "## <heading>" per section (headings: ${tpl.headings.join(", ")}).`,
    'When the file is written, answer "Draft ready" and stop: the user checks it and creates the item in the story browser.',
  ]
    .filter(Boolean)
    .join("\n");
  return { type: o.type, draftFile: file, prompt };
}

export function storyDraft(file: string): { draftFile: string; sections: { heading: string; markdown: string }[] } {
  if (!existsSync(file)) throw new BrowseError("notFound", `no draft yet: ${file}`);
  return { draftFile: file, sections: parseSections(readFileSync(file, "utf8")).sections.map((x) => ({ heading: x.heading, markdown: x.body.trim() })) };
}
