import { trace } from "./trace.js";
import { findActivePr, type AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch } from "./git.js";
import { cut, day, emit, encode, table, type Flags } from "./devops.js";
import { identityIds } from "./policyAdmin.js";
import { parsePrRef } from "./pr.js";
import { prArtifact, repoInfo } from "./workitems.js";

const VOTES: Record<string, number> = { approve: 10, "approve-with-suggestions": 5, reset: 0, none: 0, wait: -5, "wait-for-author": -5, reject: -10 };
const VOTE_NAME = (n: number) => Object.entries(VOTES).find(([, x]) => x === n)?.[0] ?? String(n);

/** The pull request: --pr, or the active one of the checked-out branch. */
export async function prIdOf(c: AdoClient, root: string, v: Flags, status: "active" | "abandoned" = "active"): Promise<number> {
  if (typeof v.pr === "string" && v.pr) return parsePrRef(v.pr);
  const branch = currentBranch(root);
  const pr = status === "active" ? await findActivePr(c, branch) : (await c.list<{ pullRequestId: number }>(`${c.repoPath()}/pullrequests`, { "searchCriteria.sourceRefName": `refs/heads/${branch}`, "searchCriteria.status": status }))[0];
  if (!pr) throw new AihubError(`no ${status} pull request for branch ${branch}; give --pr <number|url>`);
  return pr.pullRequestId;
}

const base = (c: AdoClient, id: number) => `${c.repoPath()}/pullrequests/${id}`;
const dry = (what: string, done: string) => (trace.dryRun ? `dry-run: would ${what}` : done);

export async function prSetStatus(c: AdoClient, ctx: Ctx, v: Flags, id: number, status: "abandoned" | "active"): Promise<void> {
  const cur = await c.get<{ status: string }>(base(c, id));
  if (cur.status === status) return emit(ctx, v, { pr: id, status, changed: false }, `PR !${id} is already ${status}`);
  if (cur.status === "completed") throw new AihubError(`PR !${id} is completed; a completed PR cannot be ${status === "abandoned" ? "abandoned" : "reactivated"}`);
  await c.patch(base(c, id), { status });
  emit(ctx, v, { pr: id, status, changed: !trace.dryRun }, dry(`${status === "abandoned" ? "abandon" : "reactivate"} PR !${id}`, `PR !${id}: ${status === "abandoned" ? "abandoned" : "reactivated"} (${c.prUrl(id)})`));
}

export async function prSetDraft(c: AdoClient, ctx: Ctx, v: Flags, id: number, isDraft: boolean): Promise<void> {
  await c.patch(base(c, id), { isDraft });
  emit(ctx, v, { pr: id, isDraft, changed: !trace.dryRun }, dry(`${isDraft ? "turn PR !" + id + " into a draft" : "publish PR !" + id}`, `PR !${id}: ${isDraft ? "now a draft" : "published (ready for review)"} (${c.prUrl(id)})`));
}

export async function prCancelAuto(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  await c.patch(base(c, id), { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } });
  emit(ctx, v, { pr: id, autoComplete: false }, dry(`cancel auto-complete of PR !${id}`, `PR !${id}: auto-complete cancelled`));
}

// ---- reviewers and votes -----------------------------------------------------------

interface Reviewer {
  id: string;
  displayName: string;
  vote: number;
  isRequired?: boolean;
  uniqueName?: string;
}

export async function reviewersList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ value?: Reviewer[] }>(`${base(c, id)}/reviewers`);
  const rows = (r.value ?? []).map((x) => ({ id: x.id, name: x.displayName, vote: VOTE_NAME(x.vote), required: !!x.isRequired }));
  emit(ctx, v, rows, rows.length ? table([["reviewer", "vote", ""], ...rows.map((x) => [x.name, x.vote, x.required ? "required" : ""])]) : `PR !${id} has no reviewers`);
}

export async function reviewersAdd(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  if (typeof v.reviewers !== "string") throw new AihubError("--reviewers <id|name|e-mail>[,...] is required");
  const ids = await identityIds(c, v.reviewers);
  for (const rid of ids) await c.put(`${base(c, id)}/reviewers/${rid}`, { vote: 0, isRequired: !!v.required });
  emit(ctx, v, { pr: id, added: ids, required: !!v.required }, dry(`add ${ids.length} reviewer(s) to PR !${id}`, `PR !${id}: added ${ids.length} ${v.required ? "required " : ""}reviewer(s)`));
}

export async function reviewersRemove(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  if (typeof v.reviewers !== "string") throw new AihubError("--reviewers <id|name|e-mail>[,...] is required");
  const ids = await identityIds(c, v.reviewers);
  for (const rid of ids) await c.del(`${base(c, id)}/reviewers/${rid}`);
  emit(ctx, v, { pr: id, removed: ids }, dry(`remove ${ids.length} reviewer(s) from PR !${id}`, `PR !${id}: removed ${ids.length} reviewer(s)`));
}

export async function prVote(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const name = String(v.vote ?? "");
  if (!(name in VOTES)) throw new AihubError(`--vote must be one of ${Object.keys(VOTES).join(", ")}`);
  const me = (await c.getOrg<{ authenticatedUser?: { id?: string } }>("connectionData")).authenticatedUser?.id;
  if (!me) throw new AihubError("could not find your Azure DevOps user id");
  await c.put(`${base(c, id)}/reviewers/${me}`, { vote: VOTES[name] });
  emit(ctx, v, { pr: id, vote: name, value: VOTES[name] }, dry(`vote ${name} on PR !${id}`, `PR !${id}: your vote is now ${name}`));
}

// ---- labels, statuses, work items, iterations -----------------------------------------------

export async function labelsList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ value?: { id: string; name: string }[] }>(`${base(c, id)}/labels`);
  const rows = (r.value ?? []).map((x) => x.name);
  emit(ctx, v, rows, rows.length ? rows.join(", ") : `PR !${id} has no labels`);
}

export async function labelsChange(c: AdoClient, ctx: Ctx, v: Flags, id: number, add: boolean): Promise<void> {
  const names = typeof v.labels === "string" ? v.labels.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!names.length) throw new AihubError("--labels <a,b> is required");
  for (const n of names) {
    if (add) await c.post(`${base(c, id)}/labels`, { name: n });
    else await c.del(`${base(c, id)}/labels/${encode(n)}`);
  }
  emit(ctx, v, { pr: id, [add ? "added" : "removed"]: names }, dry(`${add ? "add" : "remove"} label(s) ${names.join(", ")} on PR !${id}`, `PR !${id}: ${add ? "added" : "removed"} label(s) ${names.join(", ")}`));
}

export async function statusesList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ value?: any[] }>(`${base(c, id)}/statuses`);
  const rows = (r.value ?? []).map((s) => ({ state: s.state, context: `${s.context?.genre ? `${s.context.genre}/` : ""}${s.context?.name}`, description: s.description }));
  emit(ctx, v, rows, rows.length ? rows.map((s) => `${String(s.state).padEnd(10)} ${s.context} ${cut(s.description, 60)}`).join("\n") : `PR !${id} has no statuses`);
}

export async function statusesPost(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const state = String(v.state ?? "");
  if (!["succeeded", "failed", "pending", "error", "notApplicable"].includes(state)) throw new AihubError("--state must be succeeded, failed, pending, error or notApplicable");
  if (typeof v.name !== "string" || !v.name) throw new AihubError("--name <status name> is required");
  const body = { state, description: typeof v.description === "string" ? v.description : state, context: { name: v.name, genre: typeof v.genre === "string" ? v.genre : "aihub" }, targetUrl: typeof v.url === "string" ? v.url : undefined };
  await c.post(`${base(c, id)}/statuses`, body);
  emit(ctx, v, { pr: id, ...body }, dry(`post status ${v.name}=${state} on PR !${id}`, `PR !${id}: status ${v.name}=${state} posted`));
}

export async function workitemsList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ value?: { id: string; url?: string }[] }>(`${base(c, id)}/workitems`);
  const ids = (r.value ?? []).map((x) => Number(x.id));
  const rows: { id: number; title?: string; state?: string }[] = [];
  for (const wi of ids) {
    const w = await c.get<{ fields?: Record<string, string> }>(`wit/workitems/${wi}`, { fields: "System.Title,System.State" });
    rows.push({ id: wi, title: w.fields?.["System.Title"], state: w.fields?.["System.State"] });
  }
  emit(ctx, v, rows, rows.length ? rows.map((x) => `AB#${x.id} ${x.state ?? ""} ${cut(x.title, 70)}`).join("\n") : `PR !${id} has no linked work items`);
}

export async function workitemsChange(c: AdoClient, ctx: Ctx, v: Flags, id: number, add: boolean): Promise<void> {
  const wi = Number(String(v["work-item"] ?? "").replace(/^AB#/i, ""));
  if (!Number.isInteger(wi) || wi <= 0) throw new AihubError("--work-item <number> is required");
  const info = await repoInfo(c);
  const url = prArtifact(info, id);
  if (add) {
    await c.jsonPatch("PATCH", `wit/workitems/${wi}`, [{ op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url, attributes: { name: "Pull Request" } } }]);
  } else {
    const w = await c.get<{ relations?: { rel: string; url: string }[] }>(`wit/workitems/${wi}`, { $expand: "relations" });
    const idx = (w.relations ?? []).findIndex((r) => r.rel === "ArtifactLink" && decodeURIComponent(r.url).toLowerCase() === decodeURIComponent(url).toLowerCase());
    if (idx < 0) throw new AihubError(`work item ${wi} is not linked to PR !${id}`);
    await c.jsonPatch("PATCH", `wit/workitems/${wi}`, [{ op: "remove", path: `/relations/${idx}` }]);
  }
  emit(ctx, v, { pr: id, workItem: wi, linked: add }, dry(`${add ? "link" : "unlink"} work item ${wi} ${add ? "to" : "from"} PR !${id}`, `PR !${id}: work item ${wi} ${add ? "linked" : "unlinked"}`));
}

export async function iterationsList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  if (typeof v.iteration === "string") {
    const n = Number(v.iteration);
    const r = await c.get<{ changeEntries?: { changeType: string; item?: { path?: string } }[] }>(`${base(c, id)}/iterations/${n}/changes`);
    const rows = (r.changeEntries ?? []).map((x) => ({ type: String(x.changeType), path: x.item?.path }));
    return emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.type.padEnd(6)} ${x.path}`).join("\n") : `iteration ${n} has no changes`);
  }
  const r = await c.get<{ value?: any[] }>(`${base(c, id)}/iterations`);
  const rows = (r.value ?? []).map((x) => ({ iteration: x.id, date: day(x.createdDate), commits: x.commits?.length, source: String(x.sourceRefCommit?.commitId ?? "").slice(0, 8), description: x.description }));
  emit(ctx, v, rows, rows.length ? table([["#", "date", "source", "description"], ...rows.map((x) => [String(x.iteration), x.date, x.source, cut(x.description, 60)])]) : `PR !${id} has no iterations`);
}
