import { spawnSync } from "node:child_process";
import type { AdoClient } from "./ado.js";
import { getWorkItemTitle } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { git } from "./git.js";
import { parseDuration } from "./pipeline.js";
import { loadTeam } from "./team.js";
import { isAlive, readSpecs } from "./watch.js";
import { whoAmI, type Me } from "./watchMine.js";

/**
 * `aihub standup` and `aihub handoff`: read-only summaries of my own work, from commits, pull requests, reviews, builds and
 * work items. Every call is a GET (or a read-only WIQL query); nothing is written unless `handoff --wiki` is asked for.
 */
export type Lang = "nl" | "en";

export interface PrRef {
  id: number;
  title: string;
  repo?: string;
}

export interface Activity {
  me: string;
  since: string;
  commits: { repo: string; count: number }[];
  prs: { created: PrRef[]; merged: PrRef[]; updated: PrRef[] };
  reviews: { pr: PrRef; comments: number }[];
  builds: { total: number; succeeded: number; failed: number; other: number };
  stories: { id: number; title?: string; from?: string; to: string }[];
}

interface RawPr {
  pullRequestId: number;
  title?: string;
  status?: string;
  isDraft?: boolean;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  createdBy?: { id?: string };
  repository?: { id?: string; name?: string };
  reviewers?: { displayName?: string; vote?: number }[];
}

const DAY = 24 * 3_600_000;
const MAX_PRS = 10;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (s: string | undefined, n = 60) => ((s ?? "").length > n ? `${(s ?? "").slice(0, n - 1)}…` : (s ?? ""));
const ref = (p: RawPr): PrRef => ({ id: p.pullRequestId, title: p.title ?? "", repo: p.repository?.name });
const branchOf = (r?: string) => (r ?? "").replace(/^refs\/heads\//, "");
const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `--since`: yesterday (default; on a Monday: Friday) or today (start of the local day), or a duration such as 24h, 3d. Epoch ms. */
export function sinceFrom(spec: string | undefined, now: number): number {
  const s = (spec ?? "yesterday").trim().toLowerCase();
  if (s === "yesterday" || s === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (s === "today") return start.getTime();
    const back = start.getDay() === 1 ? 3 : start.getDay() === 0 ? 2 : 1;
    start.setDate(start.getDate() - back);
    return start.getTime();
  }
  const days = /^(\d+)d$/.exec(s);
  if (days) return now - Number(days[1]) * DAY;
  return now - parseDuration(s, 0, { flag: "--since", unitRequired: true });
}

function repoNames(ctx: Ctx, client: AdoClient, root: string): string[] {
  const names = ((loadTeam(root).repositories ?? []) as { name?: string }[]).map((r) => r.name).filter((n): n is string => !!n);
  return names.length ? names : [client.remote.repo];
}

export const teamLang = (root: string): Lang => (loadTeam(root).language === "nl" ? "nl" : "en");

// ---- standup -----------------------------------------------------------------------------------------

export async function gatherActivity(client: AdoClient, me: Me, repos: string[], sinceMs: number): Promise<Activity> {
  const iso = new Date(sinceMs).toISOString();
  const inWindow = (d?: string) => !!d && Date.parse(d) >= sinceMs;
  const q = (extra: Record<string, string | number>) => ({ "searchCriteria.creatorId": me.id, "searchCriteria.status": "all", $top: 50, ...extra });
  const inRepos = (p: RawPr) => !repos.length || repos.some((r) => same(r, p.repository?.name));

  // commits per repository
  const commits: Activity["commits"] = [];
  for (const repo of repos) {
    try {
      const r = await client.get<{ value?: unknown[] }>(`git/repositories/${encodeURIComponent(repo)}/commits`, { "searchCriteria.author": me.name, "searchCriteria.fromDate": iso, "searchCriteria.$top": 100 });
      if (r.value?.length) commits.push({ repo, count: r.value.length });
    } catch {
      /* a repository I cannot read does not stop the summary */
    }
  }

  // my pull requests: created, merged, updated (an older active PR whose branch got my commits)
  const mine = (await client.list<RawPr>("git/pullrequests", q({}))).filter(inRepos);
  const created = mine.filter((p) => inWindow(p.creationDate));
  const merged = mine.filter((p) => p.status === "completed" && inWindow(p.closedDate));
  const updated: RawPr[] = [];
  for (const p of mine.filter((x) => x.status === "active" && !inWindow(x.creationDate)).slice(0, 10)) {
    try {
      const r = await client.get<{ value?: unknown[] }>(`git/repositories/${p.repository?.id}/commits`, { "searchCriteria.itemVersion.version": branchOf(p.sourceRefName), "searchCriteria.itemVersion.versionType": "branch", "searchCriteria.author": me.name, "searchCriteria.fromDate": iso, "searchCriteria.$top": 1 });
      if (r.value?.length) updated.push(p);
    } catch {
      /* branch gone */
    }
  }

  // reviews I gave: comments of mine on other people's PRs
  const reviewing = (await client.list<RawPr>("git/pullrequests", { "searchCriteria.reviewerId": me.id, "searchCriteria.status": "all", $top: 30 })).filter((p) => inRepos(p) && !same(p.createdBy?.id, me.id) && (p.status === "active" || inWindow(p.closedDate)));
  const reviews: Activity["reviews"] = [];
  for (const p of reviewing.slice(0, 15)) {
    try {
      const threads = await client.list<{ isDeleted?: boolean; comments?: { author?: { id?: string }; publishedDate?: string; isDeleted?: boolean; commentType?: string }[] }>(`git/repositories/${p.repository?.id}/pullRequests/${p.pullRequestId}/threads`);
      const n = threads.filter((t) => !t.isDeleted).flatMap((t) => t.comments ?? []).filter((c) => !c.isDeleted && c.commentType !== "system" && same(c.author?.id, me.id) && inWindow(c.publishedDate)).length;
      if (n) reviews.push({ pr: ref(p), comments: n });
    } catch {
      /* skip */
    }
  }

  // builds I queued
  const bs = await client.get<{ value?: { result?: string; status?: string }[] }>("build/builds", { requestedFor: me.id, minTime: iso, $top: 100, queryOrder: "queueTimeDescending" });
  const list = bs.value ?? [];
  const builds = { total: list.length, succeeded: list.filter((b) => b.result === "succeeded").length, failed: list.filter((b) => b.result === "failed").length, other: 0 };
  builds.other = builds.total - builds.succeeded - builds.failed;

  // story state changes
  const stories: Activity["stories"] = [];
  const wiql = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", { query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= '${dateOnly(sinceMs)}' ORDER BY [System.ChangedDate] DESC` });
  for (const w of (wiql.workItems ?? []).slice(0, 15)) {
    try {
      const u = await client.get<{ value?: { revisedDate?: string; fields?: Record<string, { oldValue?: string; newValue?: string }> }[] }>(`wit/workItems/${w.id}/updates`);
      const changes = (u.value ?? []).filter((x) => inWindow(x.revisedDate) && x.fields?.["System.State"]?.newValue);
      if (!changes.length) continue;
      const first = changes[0].fields!["System.State"];
      const last = changes[changes.length - 1].fields!["System.State"];
      stories.push({ id: w.id, title: await getWorkItemTitle(client, w.id), from: first.oldValue, to: last.newValue! });
    } catch {
      /* skip */
    }
  }
  return { me: me.name, since: iso, commits, prs: { created: created.map(ref), merged: merged.map(ref), updated: updated.map(ref) }, reviews, builds, stories };
}

const TXT = {
  nl: {
    commits: "Commits", repos: "repository", reposN: "repositories", prs: "PR's", created: "aangemaakt", merged: "gemerged", updated: "bijgewerkt",
    reviews: "Reviews", on: "op", comments: "opmerkingen", runs: "Runs", builds: "builds", ok: "geslaagd", bad: "mislukt", other: "overig",
    stories: "Stories", nothing: "Niets geregistreerd sinds", open: "Open PR's", stor: "Stories", branches: "Branches met werk dat nog niet gepusht is", watches: "Lopende watches", failing: "Falende runs",
    none: "Niets open.", more: "en nog", handoff: "Overdracht", to: "aan", draft: "concept", ready: "klaar", threads: "open threads", build: "build", unpushed: "niet gepusht", ahead: "commit(s) voor", mine: "alles van mij (PR's, vermeldingen, reviews)", every: "elke", noVotes: "geen stemmen",
  },
  en: {
    commits: "Commits", repos: "repository", reposN: "repositories", prs: "PRs", created: "created", merged: "merged", updated: "updated",
    reviews: "Reviews", on: "on", comments: "comments", runs: "Runs", builds: "builds", ok: "succeeded", bad: "failed", other: "other",
    stories: "Stories", nothing: "Nothing recorded since", open: "Open PRs", stor: "Stories", branches: "Branches with work not pushed yet", watches: "Running watches", failing: "Failing runs",
    none: "Nothing open.", more: "and more PRs", handoff: "Handoff", to: "to", draft: "draft", ready: "ready", threads: "open threads", build: "build", unpushed: "not pushed", ahead: "commit(s) ahead", mine: "everything of mine (PRs, mentions, reviews)", every: "every", noVotes: "no votes",
  },
} as const;

const prList = (xs: PrRef[]) => xs.slice(0, 4).map((p) => `!${p.id} ${short(p.title, 40)}`).join(", ") + (xs.length > 4 ? ` +${xs.length - 4}` : "");

/** 3 to 5 lines; a part without activity is left out. */
export function renderStandup(a: Activity, lang: Lang): string[] {
  const t = TXT[lang];
  const lines: string[] = [];
  const many = (n: number) => (n >= 100 ? "100+" : String(n));
  const nCommits = a.commits.reduce((s, c) => s + c.count, 0);
  if (nCommits) lines.push(`${t.commits}: ${many(nCommits)} (${a.commits.length} ${a.commits.length === 1 ? t.repos : t.reposN}: ${a.commits.map((c) => `${c.repo} ${many(c.count)}`).join(", ")})`);
  const parts = [
    a.prs.created.length ? `${a.prs.created.length} ${t.created} (${prList(a.prs.created)})` : "",
    a.prs.merged.length ? `${a.prs.merged.length} ${t.merged} (${prList(a.prs.merged)})` : "",
    a.prs.updated.length ? `${a.prs.updated.length} ${t.updated} (${prList(a.prs.updated)})` : "",
  ].filter(Boolean);
  if (parts.length) lines.push(`${t.prs}: ${parts.join("; ")}`);
  if (a.reviews.length) lines.push(`${t.reviews}: ${a.reviews.slice(0, 4).map((r) => `${t.on} !${r.pr.id} (${r.comments} ${t.comments})`).join(", ")}${a.reviews.length > 4 ? ` +${a.reviews.length - 4}` : ""}`);
  if (a.builds.total) lines.push(`${t.runs}: ${a.builds.total} ${t.builds} (${a.builds.succeeded} ${t.ok}, ${a.builds.failed} ${t.bad}${a.builds.other ? `, ${a.builds.other} ${t.other}` : ""})`);
  if (a.stories.length) lines.push(`${t.stories}: ${a.stories.slice(0, 4).map((s) => `AB#${s.id}${s.title ? ` ${short(s.title, 30)}` : ""} ${s.from ? `${s.from} -> ` : ""}${s.to}`).join("; ")}${a.stories.length > 4 ? ` +${a.stories.length - 4}` : ""}`);
  return lines.length ? lines : [`${t.nothing} ${a.since.slice(0, 16).replace("T", " ")}.`];
}

export async function standup(ctx: Ctx, o: { since?: string; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const now = (ctx.now ?? Date.now)();
  const sinceMs = sinceFrom(o.since, now);
  const me = await whoAmI(client);
  const activity = await gatherActivity(client, me, repoNames(ctx, client, root), sinceMs);
  return o.json ? JSON.stringify(activity) : renderStandup(activity, teamLang(root)).join("\n");
}

// ---- handoff -----------------------------------------------------------------------------------------

export interface Handoff {
  me: string;
  date: string;
  prs: { pr: PrRef; draft: boolean; votes: string[]; openThreads: number; build?: string }[];
  /** Open PRs beyond the ones listed in detail. */
  morePrs: number;
  stories: { id: number; title: string; state: string }[];
  branches: { branch: string; note: string }[];
  watches: { id: string; what: string }[];
  failing: { run: number; branch: string; pipeline?: string }[];
}

export async function gatherHandoff(ctx: Ctx, client: AdoClient, me: Me, root: string, repos: string[], now: number): Promise<Handoff> {
  const VOTE: Record<number, string> = { 10: "approved", 5: "approved with suggestions", [-5]: "waiting for author", [-10]: "rejected" };
  const mine = (await client.list<RawPr>("git/pullrequests", { "searchCriteria.creatorId": me.id, "searchCriteria.status": "active", $top: 50 })).filter((p) => !repos.length || repos.some((r) => same(r, p.repository?.name)));
  const prs: Handoff["prs"] = [];
  for (const p of mine.slice(0, MAX_PRS)) {
    let openThreads = 0;
    try {
      const threads = await client.list<{ isDeleted?: boolean; status?: string; comments?: { commentType?: string; isDeleted?: boolean }[] }>(`git/repositories/${p.repository?.id}/pullRequests/${p.pullRequestId}/threads`);
      openThreads = threads.filter((t) => !t.isDeleted && (!t.status || t.status === "active" || t.status === "pending") && (t.comments ?? []).some((c) => !c.isDeleted && c.commentType !== "system")).length;
    } catch {
      /* unknown */
    }
    let build: string | undefined;
    try {
      const b = await client.get<{ value?: { status?: string; result?: string }[] }>("build/builds", { branchName: `refs/pull/${p.pullRequestId}/merge`, queryOrder: "queueTimeDescending", $top: 1 });
      const x = b.value?.[0];
      build = x ? (x.status === "completed" ? (x.result ?? "completed") : (x.status ?? "unknown")) : undefined;
    } catch {
      /* no build access */
    }
    prs.push({ pr: ref(p), draft: !!p.isDraft, votes: (p.reviewers ?? []).filter((r) => r.vote).map((r) => `${r.displayName ?? "?"} ${VOTE[r.vote!] ?? r.vote}`), openThreads, build });
  }

  const stories: Handoff["stories"] = [];
  const wiql = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", { query: "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') AND [System.WorkItemType] IN ('User Story','Bug','Task') ORDER BY [System.ChangedDate] DESC" });
  for (const w of (wiql.workItems ?? []).slice(0, 15)) {
    try {
      const f = await client.get<{ fields?: Record<string, string> }>(`wit/workItems/${w.id}`, { fields: "System.Title,System.State" });
      stories.push({ id: w.id, title: f.fields?.["System.Title"] ?? "", state: f.fields?.["System.State"] ?? "" });
    } catch {
      /* skip */
    }
  }

  const branches: Handoff["branches"] = [];
  const refs = git(root, ["for-each-ref", "--format=%(refname:short)|%(upstream:short)|%(upstream:track)", "refs/heads"], { allowFail: true });
  for (const line of refs.split("\n").filter(Boolean)) {
    const [branch, upstream, track] = line.split("|");
    if (/^(main|master|develop|staging|release\/)/.test(branch)) continue;
    const ahead = /ahead (\d+)/.exec(track ?? "")?.[1];
    if (!upstream) branches.push({ branch, note: "unpushed" });
    else if (ahead) branches.push({ branch, note: `ahead ${ahead}` });
  }

  const watches = readSpecs(root).filter((s) => isAlive(s.pid)).map((s) => ({ id: s.id, what: s.mine ? "mine" : s.pr ? `PR !${s.pr}` : `branch ${s.branch}` }));

  const failed = await client.get<{ value?: { id: number; sourceBranch?: string; definition?: { name?: string }; reason?: string }[] }>("build/builds", { requestedFor: me.id, resultFilter: "failed", statusFilter: "completed", minTime: new Date(now - 7 * DAY).toISOString(), queryOrder: "finishTimeDescending", $top: 20 });
  const seen = new Set<string>();
  const failing: Handoff["failing"] = [];
  for (const b of failed.value ?? []) {
    const prMerge = /^refs\/pull\/(\d+)\//.exec(b.sourceBranch ?? "");
    const branch = prMerge ? `PR !${prMerge[1]}` : (b.sourceBranch ?? "").replace(/^refs\/heads\//, "");
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    failing.push({ run: b.id, branch, pipeline: b.definition?.name });
  }
  void ctx;
  return { me: me.name, date: new Date(now).toISOString().slice(0, 10), prs, morePrs: Math.max(0, mine.length - MAX_PRS), stories, branches, watches, failing };
}

/** The handoff as a short markdown note; empty parts are left out. */
export function renderHandoff(h: Handoff, lang: Lang, to?: string): string {
  const t = TXT[lang];
  const out: string[] = [`# ${t.handoff} ${h.me}${to ? ` ${t.to} ${to}` : ""} (${h.date})`, ""];
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, ...lines.map((l) => `- ${l}`), "");
  section(t.open, [...h.prs.map((p) => `!${p.pr.id} ${p.pr.title}${p.pr.repo ? ` (${p.pr.repo})` : ""}: ${p.draft ? t.draft : t.ready}; ${p.votes.length ? p.votes.join(", ") : t.noVotes}; ${p.openThreads} ${t.threads}${p.build ? `; ${t.build} ${p.build}` : ""}`), ...(h.morePrs ? [`${t.more}: ${h.morePrs}`] : [])]);
  section(t.stor, h.stories.map((s) => `AB#${s.id} ${s.title}: ${s.state}`));
  section(t.branches, h.branches.map((b) => `${b.branch}: ${b.note.startsWith("ahead") ? `${b.note.slice(6)} ${t.ahead}` : t.unpushed}`));
  section(t.watches, h.watches.map((w) => (w.what === "mine" ? t.mine : w.what)));
  section(t.failing, h.failing.slice(0, 5).map((f) => `${t.build} ${f.run} ${f.pipeline ? `(${f.pipeline}) ` : ""}${t.on} ${f.branch}`));
  if (out.length === 2) out.push(t.none);
  return out.join("\n").trimEnd() + "\n";
}

export type Clipboard = (text: string) => boolean;

export const systemClipboard: Clipboard = (text) => {
  const tries: [string, string[]][] = process.platform === "win32" ? [["clip.exe", []]] : process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of tries) if (spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0) return true;
  return false;
};

export async function handoff(ctx: Ctx, o: { to?: string; json?: boolean; clipboard?: boolean; wiki?: boolean; wikiPage?: string }, clipboard: Clipboard = systemClipboard): Promise<string> {
  const { root, client } = repoClient(ctx);
  const now = (ctx.now ?? Date.now)();
  const me = await whoAmI(client);
  const h = await gatherHandoff(ctx, client, me, root, repoNames(ctx, client, root), now);
  const text = renderHandoff(h, teamLang(root), o.to);
  const notes: string[] = [];
  if (o.clipboard) notes.push(clipboard(text) ? "(copied to the clipboard)" : "(no clipboard tool found; nothing copied)");
  if (o.wiki) {
    const { wikiUpdate } = await import("./wiki.js");
    const { aihubDir, ensureDir } = await import("./aihubDir.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const file = join(ensureDir(aihubDir(root, "tmp")), "handoff.md");
    writeFileSync(file, text, "utf8");
    notes.push(await wikiUpdate(ctx, { page: o.wikiPage ?? `Handoff/${h.me}`, bodyFile: file, publish: true }));
  }
  if (o.json) return JSON.stringify({ ...h, markdown: text, notes });
  return [text.trimEnd(), ...notes].join("\n");
}
