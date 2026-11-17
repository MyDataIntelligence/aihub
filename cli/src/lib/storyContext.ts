import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPr, shortBranch, type AdoClient } from "./ado.js";
import { findStoryBranchNames } from "./branches.js";
import { repoClient, type Ctx } from "./context.js";
import { fieldsToSections, getStory, loadStoryTemplate } from "./story.js";
import { clientForDir, resolveRepoDirs, type RepoDir } from "./repos.js";
import { tryGit } from "./gitx.js";
import { headingsMatch, parseSections } from "./templates.js";
import { loadTeam } from "./team.js";
import { getWorkItem } from "./workitems.js";

export const CONTEXT_FILES = 15;
const MAX_FILES_SCANNED = 20_000;
const MAX_BYTES = 150_000;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|vendor|\.git|\.venv|__pycache__|coverage|target|bin|obj)\//;
const SKIP_FILE = /\.(png|jpe?g|gif|ico|svg|pdf|zip|gz|jar|dll|exe|woff2?|ttf|lock|min\.js|map|snap)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

const STOP = new Set(
  (
    "that this with from have will should would could when then than into your their about which there these those been being also only some such more most other " +
    "must need needs want wants user users story able allow allows make makes made using used shall each every after before over under between while where what " +
    "een het dat dit van voor met niet zijn wordt worden kunnen moet moeten willen zodat omdat als dan ook naar over door bij uit gebruiker gebruikers functie nieuwe nieuw alle deze die wat waar welke"
  ).split(/\s+/),
);

export interface RankedFile {
  repo: string;
  path: string;
  score: number;
  reason: string;
}

export interface StoryContext {
  story: { id: number; type: string; state: string; title: string; url: string };
  acceptanceCriteria: string;
  prs: { id: number; title: string; status: string }[];
  branches: string[];
  keywords: string[];
  files: RankedFile[];
}

const sub = (w: string) => w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);

/** Keywords of the story: words of the title weigh 3x; identifiers are also split (camelCase, snake_case). */
export function keywordsOf(title: string, rest: string, max = 12): string[] {
  const weight = new Map<string, number>();
  const add = (text: string, w: number) => {
    for (const raw of text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
      for (const part of sub(raw)) {
        const k = part.toLowerCase();
        if (k.length < 4 || STOP.has(k) || /^\d+$/.test(k)) continue;
        weight.set(k, (weight.get(k) ?? 0) + w);
      }
    }
  };
  add(title, 3);
  add(rest, 1);
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([k]) => k);
}

const tokensOfPath = (p: string) => sub(p).map((t) => t.toLowerCase());
const kwMatchesToken = (kw: string, tok: string) => tok === kw || (tok.length >= 4 && (tok.startsWith(kw) || kw.startsWith(tok)));

export interface FileInput {
  path: string;
  /** Lowercased file text, or undefined when it is not read. */
  text?: string;
  touchedBy: string[];
}

export function scoreFile(f: FileInput, keywords: string[]): { score: number; reason: string } {
  const toks = tokensOfPath(f.path);
  const pathHits = keywords.filter((k) => toks.some((t) => kwMatchesToken(k, t)));
  const contentHits = f.text ? keywords.filter((k) => !pathHits.includes(k) && f.text!.includes(k)) : [];
  const score = 5 * pathHits.length + 2 * contentHits.length + (f.touchedBy.length ? 8 : 0);
  const reason = [
    f.touchedBy.length ? `touched by ${f.touchedBy.join(", ")}` : "",
    pathHits.length ? `path matches ${pathHits.join(", ")}` : "",
    contentHits.length ? `mentions ${contentHits.slice(0, 5).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { score, reason };
}

async function prFiles(client: AdoClient, id: number): Promise<{ title: string; status: string; files: string[] } | undefined> {
  try {
    const pr = await getPr(client, id);
    const its = await client.list<{ id: number }>(`${client.repoPath()}/pullrequests/${id}/iterations`);
    const last = its.sort((a, b) => b.id - a.id)[0];
    const files: string[] = [];
    if (last) {
      const r = await client.get<{ changeEntries?: { item?: { path?: string; isFolder?: boolean } }[] }>(`${client.repoPath()}/pullrequests/${id}/iterations/${last.id}/changes`);
      for (const e of r.changeEntries ?? []) if (e.item?.path && !e.item.isFolder) files.push(e.item.path.replace(/^\//, ""));
    }
    return { title: pr.title, status: pr.status, files };
  } catch {
    return undefined; // the PR belongs to another repository
  }
}

function listFiles(dir: string): string[] {
  const out = tryGit(dir, ["ls-files", "-z"]).out.split("\0").filter(Boolean);
  return out.filter((p) => !SKIP_DIR.test(p) && !SKIP_FILE.test(p)).slice(0, MAX_FILES_SCANNED);
}

function readText(dir: string, rel: string, budget: { left: number }): string | undefined {
  try {
    const p = join(dir, rel);
    const size = statSync(p).size;
    if (size > MAX_BYTES) return undefined;
    budget.left -= size;
    const buf = readFileSync(p);
    if (buf.includes(0)) return undefined;
    return buf.toString("utf8").toLowerCase();
  } catch {
    return undefined;
  }
}

export async function storyContext(ctx: Ctx, o: { id: number; repos?: string[]; top?: number; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const story = await getStory(client, o.id);
  const sections = fieldsToSections(team, story.fields, parseSections(loadStoryTemplate(root, team)).sections.map((s) => s.heading));
  const ac = sections.find((s) => headingsMatch(s.heading, "Acceptance criteria"))?.body.trim() ?? "";
  const rest = sections.map((s) => `${s.heading}\n${s.body}`).join("\n");
  const keywords = keywordsOf(story.title, rest);

  const wi = await getWorkItem(client, o.id);
  const prIds: number[] = [];
  const linkedBranches = new Set<string>();
  for (const rel of wi.relations) {
    if (rel.rel !== "ArtifactLink") continue;
    const u = decodeURIComponent(rel.url);
    const pm = /PullRequestId\/.*?(\d+)$/i.exec(u);
    if (pm) prIds.push(Number(pm[1]));
    const bm = /Git\/Ref\/.*?GB(.+)$/i.exec(u);
    if (bm) linkedBranches.add(bm[1]);
  }

  const dirs: RepoDir[] = o.repos?.length ? resolveRepoDirs(o.repos, root, team) : [{ name: client.remote.repo, dir: root }];
  const prs: StoryContext["prs"] = [];
  const ranked: RankedFile[] = [];
  const seenPr = new Set<number>();
  const budget = { left: 80_000_000 };
  for (const r of dirs) {
    const rc = r.dir === root ? client : clientForDir(ctx, r.dir);
    const touched = new Map<string, string[]>();
    for (const id of prIds) {
      const info = await prFiles(rc, id);
      if (!info) continue;
      if (!seenPr.has(id)) (seenPr.add(id), prs.push({ id, title: info.title, status: info.status }));
      for (const f of info.files) touched.set(f, [...(touched.get(f) ?? []), `PR !${id}`]);
    }
    for (const b of new Set([...linkedBranches, ...findStoryBranchNames(r.dir, o.id)])) {
      const base = tryGit(r.dir, ["rev-parse", "--verify", "--quiet", `origin/${b}`]).ok ? `origin/${b}` : tryGit(r.dir, ["rev-parse", "--verify", "--quiet", b]).ok ? b : "";
      if (!base) continue;
      const def = tryGit(r.dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).out.replace(/^origin\//, "") || "main";
      const diff = tryGit(r.dir, ["diff", "--name-only", `origin/${def}...${base}`]);
      for (const f of diff.ok ? diff.out.split("\n").filter(Boolean) : []) {
        const label = `branch ${shortBranch(b)}`;
        if (!(touched.get(f) ?? []).includes(label)) touched.set(f, [...(touched.get(f) ?? []), label]);
      }
    }
    for (const path of listFiles(r.dir)) {
      const t = touched.get(path) ?? [];
      const text = keywords.length && budget.left > 0 ? readText(r.dir, path, budget) : undefined;
      const { score, reason } = scoreFile({ path, text, touchedBy: t }, keywords);
      if (score > 0) ranked.push({ repo: r.name, path, score, reason });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const files = ranked.slice(0, o.top ?? CONTEXT_FILES);

  const result: StoryContext = {
    story: { id: story.id, type: story.type, state: story.state, title: story.title, url: story.url },
    acceptanceCriteria: ac,
    prs,
    branches: [...linkedBranches],
    keywords,
    files,
  };
  if (o.json) return JSON.stringify(result);
  const multi = dirs.length > 1;
  const L = [`Story ${story.id} [${story.type}, ${story.state}] ${story.title}`, story.url];
  L.push("", "Acceptance criteria:", ac || "(none written)");
  if (prs.length) L.push("", "Linked PRs:", ...prs.map((p) => `- !${p.id} [${p.status}] ${p.title}`));
  if (result.branches.length) L.push("", "Linked branches:", ...result.branches.map((b) => `- ${b}`));
  L.push("", `Keywords: ${keywords.join(", ") || "(none)"}`, "", `Most relevant files (top ${files.length}, no contents):`);
  if (!files.length) L.push("(no file matched; read the repository map with your own tools)");
  files.forEach((f, i) => L.push(`${String(i + 1).padStart(2)}. ${multi ? `${f.repo}:` : ""}${f.path}  (${f.reason})`));
  return L.join("\n");
}
