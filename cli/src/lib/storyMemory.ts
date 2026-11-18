import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { repoRoot } from "./git.js";
import { hasWorkToCommit, tryGit, unpushedCount } from "./gitx.js";
import { crossStatus, type RepoStatus } from "./crossRepoOps.js";
import { readJournal, type JournalEntry } from "./journal.js";
import { resolveRepoDirs } from "./repos.js";
import { findSet } from "./setInfo.js";
import { loadTeam } from "./team.js";
import { getWorkItem } from "./workitems.js";
import { basename } from "node:path";

interface RepoJournal {
  repo: string;
  dir: string;
  entries: JournalEntry[];
}

/** Every local checkout that can hold journal lines for a story: this one, the set, the repositories of team.yaml next to it. */
function checkouts(ctx: Ctx): { name: string; dir: string }[] {
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const out = new Map<string, { name: string; dir: string }>();
  const add = (name: string, dir: string) => out.set(dir.replace(/\\/g, "/").toLowerCase(), { name, dir });
  add(basename(root), root);
  const set = findSet(ctx.cwd);
  for (const r of set?.repos ?? []) add(r.name, r.path);
  const names = (team.repositories ?? []).map((r) => r.name).filter((n): n is string => !!n);
  try {
    for (const d of resolveRepoDirs(names, root, team)) add(d.name, d.dir);
  } catch {
    /* repositories that are not checked out are simply not listed */
  }
  return [...out.values()];
}

const mentions = (e: JournalEntry, story: number): boolean => new RegExp(`(feature/|story/|--id |--story |AB#|story-?|\\bid )${story}\\b|/${story}[-_]`).test(`${e.command} ${e.result}`);

function storyJournals(ctx: Ctx, story: number): RepoJournal[] {
  return checkouts(ctx)
    .map((c) => ({ repo: c.name, dir: c.dir, entries: readJournal(c.dir).filter((e) => mentions(e, story)) }))
    .filter((j) => j.entries.length);
}

export interface Recall {
  story: { id: number; title: string; state: string };
  prs: RepoStatus[];
  journal: { repo: string; entry: JournalEntry }[];
  open: string[];
  warnings: string[];
}

export async function recallStory(ctx: Ctx, o: { id: number; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const warnings: string[] = [];
  const wi = await getWorkItem(client, o.id);
  if (!wi.title) throw new AihubError(`work item ${o.id} not found`);
  let prs: RepoStatus[] = [];
  try {
    prs = await crossStatus(ctx, { story: o.id });
  } catch (e) {
    warnings.push((e as Error).message);
  }
  const journals = storyJournals(ctx, o.id);
  const journal = journals.flatMap((j) => j.entries.map((entry) => ({ repo: j.repo, entry }))).sort((a, b) => a.entry.at.localeCompare(b.entry.at));

  const open: string[] = [];
  for (const p of prs) {
    if (p.prStatus === "active" || p.prStatus === "draft") {
      const red = p.pipelines.filter((x) => !/succeeded|partiallySucceeded/.test(x.state) && !/inProgress|notStarted|running/.test(x.state));
      if (red.length) open.push(`${p.repo} PR !${p.pr}: pipeline ${red.map((x) => `${x.name} ${x.state}`).join(", ")}`);
      else if (!p.pipelines.length) open.push(`${p.repo} PR !${p.pr}: no pipeline run seen`);
    }
  }
  for (const c of checkouts(ctx)) {
    const branch = tryGit(c.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out || undefined;
    if (!branch || !new RegExp(`[/_-]${o.id}(?=[-_/]|$)`).test(branch)) continue;
    if (hasWorkToCommit(c.dir)) open.push(`${c.name} (${branch}): uncommitted changes`);
    const n = unpushedCount(c.dir);
    if (n) open.push(`${c.name} (${branch}): ${n} unpushed commit(s)`);
  }
  for (const j of journals) {
    const last = j.entries[j.entries.length - 1];
    if (last.status === "failed") open.push(`${j.repo}: the last step failed: ${last.command} -> ${last.result}`);
  }

  const data: Recall = { story: { id: o.id, title: wi.title, state: wi.state ?? "?" }, prs, journal, open, warnings };
  if (o.json) return JSON.stringify(data);
  const L: string[] = [`Story ${o.id} [${data.story.state}] ${data.story.title}`];
  if (prs.length) {
    L.push("Repositories and PRs:");
    for (const p of prs) L.push(`  ${p.repo}: ${p.branch} -> ${p.target}  PR !${p.pr} ${p.prStatus}  ${p.pipelines.length ? p.pipelines.map((x) => `${x.name} ${x.state}`).join(", ") : "no pipeline run"}  ${p.url}`);
  } else L.push(`No linked pull requests${warnings.length ? ` (${warnings[0]})` : ""}.`);
  if (journal.length) {
    L.push("Journal (latest 10):");
    for (const j of journal.slice(-10)) L.push(`  ${j.entry.at.slice(0, 16).replace("T", " ")} ${j.repo}: ${j.entry.command.replace(/^aihub /, "")} -> ${j.entry.status === "ok" ? "" : "FAILED "}${j.entry.result}`);
  } else L.push("Journal: nothing on this machine (the story was worked on elsewhere, or before the journal existed).");
  L.push(open.length ? `Open ends:\n${open.map((x) => `  - ${x}`).join("\n")}` : "Open ends: none seen.");
  return L.join("\n");
}

export async function searchStories(ctx: Ctx, o: { text: string; json?: boolean }): Promise<string> {
  const words = o.text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) throw new AihubError('aihub story search "<words>" needs at least one word');
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const type = team.workItems?.storyType ?? "User Story";
  const esc = (s: string) => s.replace(/'/g, "''");
  const q = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${esc(type)}' AND ${words.map((w) => `[System.Title] CONTAINS '${esc(w)}'`).join(" AND ")} ORDER BY [System.ChangedDate] DESC`,
  });
  const ids = (q.workItems ?? []).slice(0, 15).map((w) => w.id);
  const items: { id: number; state: string; title: string }[] = [];
  if (ids.length) {
    const r = await client.get<{ value?: { id: number; fields: Record<string, string> }[] }>("wit/workitems", { ids: ids.join(","), fields: "System.Id,System.Title,System.State" });
    for (const w of r.value ?? []) items.push({ id: w.id, state: w.fields["System.State"], title: w.fields["System.Title"] });
  }
  const lower = words.map((w) => w.toLowerCase());
  const hits: { repo: string; entry: JournalEntry }[] = [];
  for (const c of checkouts(ctx)) for (const entry of readJournal(c.dir)) if (lower.every((w) => `${entry.command} ${entry.result}`.toLowerCase().includes(w))) hits.push({ repo: c.name, entry });
  if (o.json) return JSON.stringify({ words, stories: items, journal: hits.slice(-10) });
  const L = [items.length ? `Stories with "${words.join(" ")}" in the title (${items.length}):` : `No story title contains "${words.join(" ")}".`];
  for (const i of items) L.push(`  ${i.id} [${i.state}] ${i.title}`);
  if (hits.length) {
    L.push("Journal lines on this machine:");
    for (const h of hits.slice(-10)) L.push(`  ${h.entry.at.slice(0, 16).replace("T", " ")} ${h.repo}: ${h.entry.command.replace(/^aihub /, "")} -> ${h.entry.result}`);
  }
  if (items.length) L.push("Details of one: aihub story recall --id <id>");
  return L.join("\n");
}
