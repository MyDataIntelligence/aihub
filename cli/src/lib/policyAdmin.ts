import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import { AihubError } from "./errors.js";
import { cut, encode, emit, readJsonFile, table, top, type Flags } from "./devops.js";
import type { Ctx } from "./context.js";

/** Branch policy types by the short name the command takes -> the display name of the type in Azure DevOps (ids are looked up, never typed). */
export const POLICY_TYPES: Record<string, RegExp> = {
  "min-reviewers": /minimum number of reviewers/i,
  build: /^build$/i,
  "work-item-linking": /work item linking/i,
  "comment-resolution": /comment (requirements|resolution)/i,
  "required-reviewers": /required reviewers/i,
  "merge-strategy": /merge strategy/i,
  status: /^status$/i,
};

interface PolicyType {
  id: string;
  displayName: string;
}

export interface PolicyConfig {
  id: number;
  isEnabled: boolean;
  isBlocking: boolean;
  type: { id: string; displayName?: string };
  settings: any;
}

export async function policyTypes(c: AdoClient): Promise<PolicyType[]> {
  return c.list<PolicyType>("policy/types");
}

export async function resolveType(c: AdoClient, short: string): Promise<PolicyType> {
  const re = POLICY_TYPES[short];
  if (!re) throw new AihubError(`--type must be one of ${Object.keys(POLICY_TYPES).join(", ")}`);
  const t = (await policyTypes(c)).find((x) => re.test(x.displayName));
  if (!t) throw new AihubError(`this organisation has no policy type like '${short}'; see: aihub policy types`);
  return t;
}

async function repoId(c: AdoClient): Promise<string> {
  const r = await c.get<{ id: string }>(c.repoPath());
  return r.id;
}

/** The scope of a policy: a branch, a branch prefix, the default branch, or every repository (--all-repos). */
export async function scopeOf(c: AdoClient, v: Flags): Promise<object[]> {
  const kinds = ["branch", "branch-prefix", "default-branch"].filter((k) => v[k]);
  if (kinds.length !== 1) throw new AihubError("give exactly one of --branch <name>, --branch-prefix <prefix> or --default-branch");
  const repositoryId = v["all-repos"] ? null : await repoId(c);
  if (v.branch) return [{ repositoryId, refName: `refs/heads/${String(v.branch).replace(/^refs\/heads\//, "")}`, matchKind: "Exact" }];
  if (v["branch-prefix"]) return [{ repositoryId, refName: `refs/heads/${String(v["branch-prefix"]).replace(/^refs\/heads\//, "").replace(/\/$/, "")}`, matchKind: "Prefix" }];
  return [{ repositoryId, matchKind: "DefaultBranch" }];
}

function bool(v: Flags, name: string, fallback: boolean): boolean {
  const x = v[name];
  if (x === undefined) return fallback;
  if (typeof x === "boolean") return x;
  return /^(true|yes|1|on)$/i.test(x);
}

function intFlag(v: Flags, name: string, fallback?: number): number | undefined {
  const x = v[name];
  if (x === undefined) return fallback;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 0) throw new AihubError(`--${name} must be a number`);
  return n;
}

async function identityIds(c: AdoClient, raw: string): Promise<string[]> {
  const out: string[] = [];
  for (const r of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) {
      out.push(r);
      continue;
    }
    const found = await c.forService("vssps").get<{ value?: { id: string; providerDisplayName?: string }[] }>("identities", { searchFilter: "General", filterValue: r, queryMembership: "None", "api-version": "7.1" });
    const one = found.value ?? [];
    if (one.length !== 1) throw new AihubError(`reviewer '${r}' matches ${one.length} identities; give the id (guid) or a more exact name or e-mail address`);
    out.push(one[0].id);
  }
  return out;
}

/** Settings of a policy from the flags of `policy create|update`; `current` = the existing settings that stay unless a flag changes them. */
export async function settingsFor(c: AdoClient, short: string, v: Flags, current: any = {}): Promise<any> {
  const patterns = typeof v.path === "string" ? v.path.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const withPaths = (s: any) => (patterns ? { ...s, filenamePatterns: patterns } : s);
  switch (short) {
    case "min-reviewers":
      return withPaths({
        minimumApproverCount: intFlag(v, "count", current.minimumApproverCount ?? 1),
        creatorVoteCounts: bool(v, "creator-vote-counts", current.creatorVoteCounts ?? false),
        allowDownvotes: bool(v, "allow-downvotes", current.allowDownvotes ?? false),
        resetOnSourcePush: bool(v, "reset-on-push", current.resetOnSourcePush ?? false),
        requireVoteOnLastIteration: bool(v, "require-vote-on-last-iteration", current.requireVoteOnLastIteration ?? false),
        blockLastPusherVote: bool(v, "block-last-pusher-vote", current.blockLastPusherVote ?? false),
      });
    case "build": {
      let def = intFlag(v, "definition", current.buildDefinitionId);
      if (def === undefined && typeof v.pipeline === "string") {
        const defs = await c.list<{ id: number; name: string }>("build/definitions", { name: v.pipeline });
        const hit = defs.find((d) => d.name.toLowerCase() === String(v.pipeline).toLowerCase());
        if (!hit) throw new AihubError(`pipeline '${v.pipeline}' not found; see: aihub pipeline def list`);
        def = hit.id;
      }
      if (def === undefined) throw new AihubError("a build policy needs --definition <id> or --pipeline <name>");
      return withPaths({
        buildDefinitionId: def,
        displayName: typeof v.name === "string" ? v.name : current.displayName ?? null,
        queueOnSourceUpdateOnly: bool(v, "queue-on-update-only", current.queueOnSourceUpdateOnly ?? true),
        manualQueueOnly: bool(v, "manual", current.manualQueueOnly ?? false),
        validDuration: intFlag(v, "valid-minutes", current.validDuration ?? 720),
      });
    }
    case "work-item-linking":
    case "comment-resolution":
      return {};
    case "required-reviewers": {
      const ids = typeof v.reviewers === "string" ? await identityIds(c, v.reviewers) : current.requiredReviewerIds;
      if (!ids || !ids.length) throw new AihubError("required reviewers need --reviewers <id|name|email>[,...]");
      return withPaths({ requiredReviewerIds: ids, addedFilesOnly: bool(v, "added-files-only", current.addedFilesOnly ?? false), message: typeof v.message === "string" ? v.message : current.message });
    }
    case "merge-strategy": {
      const s = {
        allowNoFastForward: bool(v, "allow-merge", current.allowNoFastForward ?? false),
        allowSquash: bool(v, "allow-squash", current.allowSquash ?? false),
        allowRebase: bool(v, "allow-rebase", current.allowRebase ?? false),
        allowRebaseMerge: bool(v, "allow-rebase-merge", current.allowRebaseMerge ?? false),
      };
      if (!s.allowNoFastForward && !s.allowSquash && !s.allowRebase && !s.allowRebaseMerge) throw new AihubError("allow at least one strategy: --allow-squash, --allow-merge, --allow-rebase, --allow-rebase-merge");
      return s;
    }
    case "status": {
      const name = typeof v["status-name"] === "string" ? v["status-name"] : current.statusName;
      if (!name) throw new AihubError("a status policy needs --status-name <name> (and optionally --status-genre)");
      return withPaths({
        statusName: name,
        statusGenre: typeof v["status-genre"] === "string" ? v["status-genre"] : current.statusGenre,
        invalidateOnSourceUpdate: bool(v, "invalidate-on-update", current.invalidateOnSourceUpdate ?? true),
        defaultDisplayName: typeof v.name === "string" ? v.name : current.defaultDisplayName,
      });
    }
  }
  throw new AihubError(`--type must be one of ${Object.keys(POLICY_TYPES).join(", ")}`);
}

/** One readable line per policy. */
export function describe(p: PolicyConfig): string {
  const s = p.settings ?? {};
  const bits: string[] = [];
  const scope = (s.scope ?? [])
    .map((x: any) => (x.matchKind === "DefaultBranch" ? "default branch" : `${String(x.refName ?? "").replace("refs/heads/", "")}${x.matchKind === "Prefix" ? "*" : ""}`) + (x.repositoryId ? "" : " (all repos)"))
    .join(", ");
  const t = p.type.displayName ?? p.type.id;
  if (/minimum number of reviewers/i.test(t)) bits.push(`${s.minimumApproverCount ?? "?"} reviewer(s)`, s.creatorVoteCounts ? "creator vote counts" : "creator vote does not count", s.resetOnSourcePush ? "votes reset on push" : "votes kept on push");
  else if (/^build$/i.test(t)) bits.push(`definition ${s.buildDefinitionId}`, s.displayName ?? "", s.manualQueueOnly ? "manual" : "automatic", `valid ${s.validDuration ?? "?"} min`);
  else if (/required reviewers/i.test(t)) bits.push(`${(s.requiredReviewerIds ?? []).length} required`, s.message ?? "");
  else if (/merge strategy/i.test(t)) bits.push(["allowSquash:squash", "allowNoFastForward:merge", "allowRebase:rebase", "allowRebaseMerge:rebase-merge"].filter((k) => s[k.split(":")[0]]).map((k) => k.split(":")[1]).join("+"));
  else if (/^status$/i.test(t)) bits.push(`${s.statusGenre ? `${s.statusGenre}/` : ""}${s.statusName}`);
  if (s.filenamePatterns?.length) bits.push(`paths ${s.filenamePatterns.join(",")}`);
  return `#${p.id} ${t}${bits.filter(Boolean).length ? ` (${bits.filter(Boolean).join("; ")})` : ""} [${p.isEnabled ? "on" : "off"}, ${p.isBlocking ? "blocking" : "optional"}] ${scope}`.trimEnd();
}

export async function policyList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const q: Record<string, string> = {};
  if (!v["all-repos"]) q.repositoryId = await repoId(c);
  if (typeof v.branch === "string") q.refName = `refs/heads/${v.branch.replace(/^refs\/heads\//, "")}`;
  const all = await c.list<PolicyConfig>("policy/configurations", q);
  const typeRe = typeof v.type === "string" ? POLICY_TYPES[v.type] : undefined;
  if (typeof v.type === "string" && !typeRe) throw new AihubError(`--type must be one of ${Object.keys(POLICY_TYPES).join(", ")}`);
  const ref = typeof v.branch === "string" ? `refs/heads/${v.branch.replace(/^refs\/heads\//, "")}` : undefined;
  // the server returns every policy of the repository; --branch keeps the ones whose scope covers that branch
  const covers = (p: PolicyConfig) => !ref || (p.settings?.scope ?? []).some((x: any) => x.matchKind === "DefaultBranch" || (x.matchKind === "Prefix" ? ref.startsWith(x.refName) : x.refName === ref));
  const rows = all.filter((p) => (!typeRe || typeRe.test(p.type.displayName ?? "")) && covers(p)).slice(0, top(v, 100));
  emit(ctx, v, rows, rows.length ? rows.map(describe).join("\n") : "no branch policies match");
}

export async function policyShow(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const p = await c.get<PolicyConfig>(`policy/configurations/${id}`);
  emit(ctx, v, p, `${describe(p)}\n${JSON.stringify(p.settings, null, 2)}`);
}

export async function policyTypesCmd(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const types = await policyTypes(c);
  const known = Object.entries(POLICY_TYPES);
  emit(ctx, v, types, table([["--type", "display name", "id"], ...types.map((t) => [known.find(([, re]) => re.test(t.displayName))?.[0] ?? "-", cut(t.displayName, 50), t.id])]));
}

export async function policyCreate(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const short = String(v.type ?? "");
  const type = await resolveType(c, short);
  const body = { isEnabled: !bool(v, "disabled", false), isBlocking: !bool(v, "optional", false), type: { id: type.id }, settings: { ...(await settingsFor(c, short, v)), scope: await scopeOf(c, v) } };
  const made = await c.post<PolicyConfig>("policy/configurations", body);
  emit(ctx, v, made, trace.dryRun ? `dry-run: would create ${type.displayName}` : `created: ${describe(made)}`);
}

export async function policyUpdate(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const cur = await c.get<PolicyConfig>(`policy/configurations/${id}`);
  const short = typeof v.type === "string" ? v.type : (Object.entries(POLICY_TYPES).find(([, re]) => re.test(cur.type.displayName ?? ""))?.[0] ?? "");
  const hasScope = ["branch", "branch-prefix", "default-branch"].some((k) => v[k]);
  const settings = { ...cur.settings, ...(await settingsFor(c, short, v, cur.settings)), scope: hasScope ? await scopeOf(c, v) : cur.settings.scope };
  const body = {
    ...cur,
    isEnabled: v.enable ? true : v.disable ? false : cur.isEnabled,
    isBlocking: v.optional ? false : v.blocking ? true : cur.isBlocking,
    settings,
  };
  const done = await c.put<PolicyConfig>(`policy/configurations/${id}`, body);
  emit(ctx, v, done, trace.dryRun ? `dry-run: would update policy #${id}` : `updated: ${describe(done)}`);
}

export async function policyDelete(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  await c.del(`policy/configurations/${id}`);
  emit(ctx, v, { id, deleted: !trace.dryRun }, trace.dryRun ? `dry-run: would delete policy #${id}` : `deleted policy #${id}`);
}

export { encode, readJsonFile };
