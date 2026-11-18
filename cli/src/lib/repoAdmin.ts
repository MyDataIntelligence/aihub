import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { confirmDelete, cut, day, emit, encode, table, top, type Flags } from "./devops.js";

const ZERO = "0000000000000000000000000000000000000000";
const short = (b: string) => b.replace(/^refs\/(heads|tags)\//, "");

interface Ref {
  name: string;
  objectId: string;
  isLocked?: boolean;
  creator?: { displayName?: string };
}

/** Which version a read applies to: --branch, --tag or --commit (default: the default branch). */
export function versionQuery(v: Flags, prefix = "versionDescriptor"): Record<string, string> {
  const set = ["branch", "tag", "commit"].filter((k) => typeof v[k] === "string" && v[k]);
  if (set.length > 1) throw new AihubError("give only one of --branch, --tag, --commit");
  if (set.length === 0) return {};
  const k = set[0];
  return { [`${prefix}.version`]: String(v[k]), [`${prefix}.versionType`]: k };
}

export async function repoShow(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<any>(c.repoPath());
  const data = { id: r.id, name: r.name, defaultBranch: short(r.defaultBranch ?? ""), sizeKb: Math.round((r.size ?? 0) / 1024), isFork: !!r.isFork, parent: r.parentRepository?.name, disabled: !!r.isDisabled, webUrl: r.webUrl, remoteUrl: r.remoteUrl };
  emit(ctx, v, data, [`${data.name} (${data.id})`, `  default branch ${data.defaultBranch || "-"}, ${data.sizeKb} KB${data.isFork ? `, fork of ${data.parent}` : ""}${data.disabled ? ", DISABLED" : ""}`, `  ${data.webUrl}`].join("\n"));
}

async function refs(c: AdoClient, filter: string): Promise<Ref[]> {
  return c.list<Ref>(`${c.repoPath()}/refs`, { filter, includeStatuses: false });
}

async function defaultBranch(c: AdoClient): Promise<string> {
  const r = await c.get<{ defaultBranch?: string }>(c.repoPath());
  return short(r.defaultBranch ?? "main");
}

async function shaOf(c: AdoClient, from: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(from)) return from;
  const hit = (await refs(c, `heads/${from}`)).find((r) => r.name === `refs/heads/${from}`) ?? (await refs(c, `tags/${from}`)).find((r) => r.name === `refs/tags/${from}`);
  if (!hit) throw new AihubError(`'${from}' is not a branch, tag or commit of ${c.remote.repo}`);
  return hit.objectId;
}

export async function branchList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const f = typeof v.filter === "string" ? v.filter : "";
  const all = (await refs(c, `heads/${f}`)).slice(0, top(v, 100));
  let stats: Record<string, { ahead: number; behind: number }> = {};
  if (v.stats) {
    const s = await c.get<{ value?: { name: string; aheadCount: number; behindCount: number }[] }>(`${c.repoPath()}/stats/branches`);
    stats = Object.fromEntries((s.value ?? []).map((x) => [x.name, { ahead: x.aheadCount, behind: x.behindCount }]));
  }
  const rows = all.map((r) => ({ name: short(r.name), sha: r.objectId.slice(0, 8), locked: !!r.isLocked, creator: r.creator?.displayName, ...(stats[short(r.name)] ?? {}) }));
  emit(ctx, v, rows, rows.length ? table([["branch", "sha", "", ...(v.stats ? ["ahead/behind"] : [])], ...rows.map((r: any) => [r.name, r.sha, r.locked ? "locked" : "", ...(v.stats ? [r.ahead === undefined ? "-" : `${r.ahead}/${r.behind}`] : [])])]) : "no branches match");
}

async function updateRef(c: AdoClient, name: string, oldId: string, newId: string): Promise<void> {
  const r = await c.post<{ value?: { success?: boolean; updateStatus?: string; customMessage?: string }[] }>(`${c.repoPath()}/refs`, [{ name, oldObjectId: oldId, newObjectId: newId }]);
  if (trace.dryRun) return;
  const x = r.value?.[0];
  if (!x?.success) throw new AihubError(`Azure DevOps refused the ref update of ${name}: ${x?.updateStatus ?? "unknown"}${x?.customMessage ? ` (${x.customMessage})` : ""}`);
}

export async function branchCreate(c: AdoClient, ctx: Ctx, v: Flags, name: string): Promise<void> {
  const from = typeof v.from === "string" ? v.from : await defaultBranch(c);
  const sha = await shaOf(c, from);
  if ((await refs(c, `heads/${name}`)).some((r) => r.name === `refs/heads/${name}`)) throw new AihubError(`branch '${name}' already exists`);
  await updateRef(c, `refs/heads/${name}`, ZERO, sha);
  emit(ctx, v, { branch: name, from, sha, created: !trace.dryRun }, `${trace.dryRun ? "dry-run: would create" : "created"} branch ${name} from ${from} (${sha.slice(0, 8)})`);
}

export async function branchDelete(c: AdoClient, ctx: Ctx, v: Flags, name: string): Promise<void> {
  confirmDelete(v, `branch '${name}'`);
  if (name === (await defaultBranch(c))) throw new AihubError(`'${name}' is the default branch of ${c.remote.repo}; it is not deleted from the CLI`);
  const sha = await shaOf(c, name);
  await updateRef(c, `refs/heads/${name}`, sha, ZERO);
  emit(ctx, v, { branch: name, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} branch ${name}`);
}

export async function branchLock(c: AdoClient, ctx: Ctx, v: Flags, name: string, locked: boolean): Promise<void> {
  await c.patch(`${c.repoPath()}/refs`, { isLocked: locked }, { filter: `heads/${name}` });
  emit(ctx, v, { branch: name, locked }, `${trace.dryRun ? "dry-run: would " : ""}${locked ? "lock" : "unlock"} branch ${name}`);
}

export async function tagList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = (await refs(c, `tags/${typeof v.filter === "string" ? v.filter : ""}`)).slice(0, top(v, 100));
  emit(ctx, v, all.map((r) => ({ tag: short(r.name), sha: r.objectId })), all.length ? table([["tag", "object"], ...all.map((r) => [short(r.name), r.objectId.slice(0, 8)])]) : "no tags match");
}

export async function tagCreate(c: AdoClient, ctx: Ctx, v: Flags, name: string): Promise<void> {
  const from = typeof v.from === "string" ? v.from : await defaultBranch(c);
  const sha = await shaOf(c, from);
  if (v.lightweight) await updateRef(c, `refs/tags/${name}`, ZERO, sha);
  else {
    const message = typeof v.message === "string" ? v.message : name;
    await c.post(`${c.repoPath()}/annotatedtags`, { name, message, taggedObject: { objectId: sha } });
  }
  emit(ctx, v, { tag: name, from, sha, annotated: !v.lightweight }, `${trace.dryRun ? "dry-run: would create" : "created"} ${v.lightweight ? "lightweight " : ""}tag ${name} at ${from} (${sha.slice(0, 8)})`);
}

export async function tagDelete(c: AdoClient, ctx: Ctx, v: Flags, name: string): Promise<void> {
  confirmDelete(v, `tag '${name}'`);
  const hit = (await refs(c, `tags/${name}`)).find((r) => r.name === `refs/tags/${name}`);
  if (!hit) throw new AihubError(`tag '${name}' not found`);
  await updateRef(c, `refs/tags/${name}`, hit.objectId, ZERO);
  emit(ctx, v, { tag: name, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} tag ${name}`);
}

export async function repoTree(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const path = typeof v.path === "string" ? (v.path.startsWith("/") ? v.path : `/${v.path}`) : "/";
  const items = await c.list<{ path: string; isFolder?: boolean; size?: number }>(`${c.repoPath()}/items`, { scopePath: path, recursionLevel: v.recursive ? "Full" : "OneLevel", ...versionQuery(v) });
  const rows = items.filter((i) => i.path !== path).slice(0, top(v, 200));
  emit(ctx, v, rows, rows.length ? rows.map((i) => `${i.isFolder ? "d" : "-"} ${i.path.slice(1)}${i.isFolder ? "/" : ""}`).join("\n") : `nothing under ${path}`);
}

export async function repoFile(c: AdoClient, ctx: Ctx, v: Flags, path: string): Promise<void> {
  const text = await c.getText(`${c.repoPath()}/items`, { path: path.startsWith("/") ? path : `/${path}`, $format: "text", ...versionQuery(v) });
  const lines = text.split("\n");
  let from = 1;
  let to = lines.length;
  if (typeof v.lines === "string") {
    const m = /^(\d+)-(\d+)$/.exec(v.lines);
    if (!m) throw new AihubError("--lines takes a range such as 10-40");
    from = Number(m[1]);
    to = Number(m[2]);
  }
  const max = 2000;
  const cutTo = Math.min(to, from + max - 1);
  const body = lines.slice(from - 1, cutTo).join("\n");
  const note = cutTo < Math.min(to, lines.length) ? `\n... ${lines.length - cutTo} more line(s); use --lines ${cutTo + 1}-${cutTo + max}` : "";
  emit(ctx, v, { path, lines: lines.length, from, to: cutTo, content: body }, body + note);
}

export async function commitsList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const q: Record<string, string | number> = { "searchCriteria.$top": top(v, 20), ...versionQuery(v, "searchCriteria.itemVersion") };
  if (typeof v.path === "string") q["searchCriteria.itemPath"] = v.path;
  if (typeof v.author === "string") q["searchCriteria.author"] = v.author;
  if (typeof v.since === "string") q["searchCriteria.fromDate"] = v.since;
  if (typeof v.until === "string") q["searchCriteria.toDate"] = v.until;
  const r = await c.get<{ value?: any[] }>(`${c.repoPath()}/commits`, q);
  const rows = (r.value ?? []).map((x) => ({ commitId: x.commitId, author: x.author?.name, date: day(x.author?.date), comment: x.comment }));
  emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.commitId.slice(0, 8)} ${x.date} ${cut(x.author, 22)} ${cut(x.comment, 70)}`).join("\n") : "no commits match");
}

export async function commitShow(c: AdoClient, ctx: Ctx, v: Flags, id: string): Promise<void> {
  const cm = await c.get<any>(`${c.repoPath()}/commits/${encode(id)}`);
  const ch = await c.get<{ changes?: any[] }>(`${c.repoPath()}/commits/${encode(id)}/changes`);
  const changes = (ch.changes ?? []).map((x) => ({ type: String(x.changeType), path: x.item?.path }));
  emit(ctx, v, { commitId: cm.commitId, author: cm.author?.name, date: cm.author?.date, comment: cm.comment, changes }, [`${cm.commitId.slice(0, 8)} ${day(cm.author?.date)} ${cm.author?.name}`, `  ${cut(cm.comment, 200)}`, ...changes.slice(0, top(v, 100)).map((x) => `  ${x.type.padEnd(6)} ${x.path}`)].join("\n"));
}

export async function repoDiff(c: AdoClient, ctx: Ctx, v: Flags, base: string, target: string): Promise<void> {
  const type = (x: string) => (/^[0-9a-f]{40}$/i.test(x) ? "commit" : v["base-tag"] ? "tag" : "branch");
  const r = await c.get<{ changes?: any[]; changeCounts?: Record<string, number>; aheadCount?: number; behindCount?: number }>(`${c.repoPath()}/diffs/commits`, {
    "baseVersion": base,
    "baseVersionType": type(base),
    "targetVersion": target,
    "targetVersionType": type(target),
    $top: top(v, 200),
  });
  const rows = (r.changes ?? []).map((x) => ({ type: String(x.changeType), path: x.item?.path }));
  emit(ctx, v, { base, target, ahead: r.aheadCount, behind: r.behindCount, counts: r.changeCounts, changes: rows }, [`${target} is ${r.aheadCount ?? 0} ahead and ${r.behindCount ?? 0} behind ${base}; ${rows.length} file change(s)`, ...rows.map((x) => `  ${x.type.padEnd(6)} ${x.path}`)].join("\n"));
}

export async function pushesList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const q: Record<string, string | number> = { $top: top(v, 20) };
  if (typeof v.branch === "string") q["searchCriteria.refName"] = `refs/heads/${v.branch}`;
  const r = await c.get<{ value?: any[] }>(`${c.repoPath()}/pushes`, q);
  const rows = (r.value ?? []).map((p) => ({ pushId: p.pushId, by: p.pushedBy?.displayName, date: day(p.date) }));
  emit(ctx, v, rows, rows.length ? rows.map((p) => `push ${p.pushId} ${p.date} ${p.by}`).join("\n") : "no pushes match");
}

export async function statusList(c: AdoClient, ctx: Ctx, v: Flags, sha: string): Promise<void> {
  const r = await c.get<{ value?: any[] }>(`${c.repoPath()}/commits/${encode(sha)}/statuses`);
  const rows = (r.value ?? []).map((s) => ({ state: s.state, context: `${s.context?.genre ? `${s.context.genre}/` : ""}${s.context?.name}`, description: s.description }));
  emit(ctx, v, rows, rows.length ? rows.map((s) => `${s.state.padEnd(10)} ${s.context} ${cut(s.description, 60)}`).join("\n") : "no statuses on this commit");
}

export async function statusPost(c: AdoClient, ctx: Ctx, v: Flags, sha: string): Promise<void> {
  const state = String(v.state ?? "");
  if (!["succeeded", "failed", "pending", "error", "notApplicable"].includes(state)) throw new AihubError("--state must be succeeded, failed, pending, error or notApplicable");
  if (typeof v.name !== "string" || !v.name) throw new AihubError("--name <status name> is required");
  const body = { state, description: typeof v.description === "string" ? v.description : state, context: { name: v.name, genre: typeof v.genre === "string" ? v.genre : "aihub" }, targetUrl: typeof v.url === "string" ? v.url : undefined };
  await c.post(`${c.repoPath()}/commits/${encode(sha)}/statuses`, body);
  emit(ctx, v, { sha, ...body }, `${trace.dryRun ? "dry-run: would post" : "posted"} status ${v.name}=${state} on ${sha.slice(0, 8)}`);
}

export async function forksList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const repo = await c.get<{ id: string }>(c.repoPath());
  const org = await c.getOrg<{ instanceId?: string }>("connectionData");
  const r = await c.get<{ value?: any[] }>(`git/repositories/${repo.id}/forks/${org.instanceId}`);
  const rows = (r.value ?? []).map((x) => ({ name: x.name, project: x.project?.name, id: x.id }));
  emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.project}/${x.name}`).join("\n") : `${c.remote.repo} has no forks`);
}

export async function forkCreate(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : `${c.remote.repo}-fork`;
  const repo = await c.get<{ id: string; project: { id: string } }>(c.repoPath());
  const projectName = typeof v["into-project"] === "string" ? v["into-project"] : c.remote.project;
  const target = projectName === c.remote.project ? repo.project : await c.request<{ id: string }>("GET", `projects/${encode(projectName)}`, { orgLevel: true, query: { "api-version": "7.1" } }).then((r) => r.data);
  const made = await c.post<{ id?: string; name?: string }>("git/repositories", { name, parentRepository: { id: repo.id, project: { id: repo.project.id } }, project: { id: target.id } }, { sourceRef: v.branch ? `refs/heads/${v.branch}` : undefined });
  emit(ctx, v, { name, project: projectName, id: made.id }, `${trace.dryRun ? "dry-run: would create" : "created"} fork ${projectName}/${name} of ${c.remote.repo}`);
}
