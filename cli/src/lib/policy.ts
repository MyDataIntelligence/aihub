import { getPr, type AdoClient, type PullRequest } from "./ado.js";
import { getThreads } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { parsePrRef } from "./pr.js";
import { repoInfo } from "./workitems.js";

/** The policy evaluation endpoints are preview-only. */
const PREVIEW = { "api-version": "7.1-preview.1" };

interface RawEvaluation {
  evaluationId: string;
  status: string; // queued | running | approved | rejected | notApplicable | broken
  configuration?: {
    id?: number;
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { displayName?: string };
    settings?: { displayName?: string; minimumApproverCount?: number };
  };
}

export interface PolicyView {
  evaluationId: string;
  name: string;
  kind: "build" | "reviewers" | "comments" | "workitems" | "other";
  status: string;
  blocking: boolean;
  /** true when this evaluation currently stops the completion. */
  blocks: boolean;
}

const OK = new Set(["approved", "notApplicable"]);

export function kindOf(typeName: string): PolicyView["kind"] {
  const t = typeName.toLowerCase();
  if (t.includes("build")) return "build";
  if (t.includes("reviewer") || t.includes("approver")) return "reviewers";
  if (t.includes("comment")) return "comments";
  if (t.includes("work item")) return "workitems";
  return "other";
}

export function viewOf(e: RawEvaluation): PolicyView | undefined {
  const c = e.configuration;
  if (c?.isEnabled === false) return undefined;
  const type = c?.type?.displayName ?? "Policy";
  const extra = c?.settings?.displayName;
  const blocking = c?.isBlocking !== false;
  return {
    evaluationId: e.evaluationId,
    name: extra && extra !== type ? `${type} (${extra})` : type,
    kind: kindOf(type),
    status: e.status,
    blocking,
    blocks: blocking && !OK.has(e.status),
  };
}

export async function evaluations(client: AdoClient, prId: number): Promise<PolicyView[]> {
  const { projectId } = await repoInfo(client);
  const raw = await client.list<RawEvaluation>("policy/evaluations", {
    artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`,
    ...PREVIEW,
  });
  return raw.map(viewOf).filter((v): v is PolicyView => !!v);
}

const HINT: Record<PolicyView["kind"], (id: number) => string> = {
  build: (id) => `follow it with 'aihub pipeline follow --pr ${id}', fix it (pipeline-fix) or re-run it with 'aihub pr requeue --pr ${id} --policy build'`,
  reviewers: () => "needs approvals: ask the reviewers; never bypass",
  comments: (id) => `resolve the open threads: 'aihub comments get --pr ${id}' (review-process)`,
  workitems: () => "link a work item to the PR: 'aihub story link --id N'",
  other: () => "see the policy in Azure DevOps",
};

export interface Checks {
  pr: number;
  status: string;
  draft: boolean;
  conflicts: boolean;
  openThreads: number;
  policies: PolicyView[];
  blockers: string[];
  canComplete: boolean;
}

export async function prChecks(ctx: Ctx, o: { pr: string; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = (await getPr(client, id)) as PullRequest & { mergeStatus?: string };
  const policies = await evaluations(client, id);
  const threads = pr.status === "active" ? await getThreads(client, id, undefined, false) : [];
  const blockers: string[] = [];
  if (pr.status !== "active") blockers.push(`PR is ${pr.status}`);
  if (pr.isDraft) blockers.push("PR is a draft: aihub pr update --draft false");
  if (pr.mergeStatus === "conflicts") blockers.push("merge conflicts: resolve them with your own git (aihub branch update)");
  for (const p of policies.filter((x) => x.blocks)) blockers.push(`${p.name} is ${p.status}: ${HINT[p.kind](id)}`);
  const result: Checks = {
    pr: id,
    status: pr.status,
    draft: !!pr.isDraft,
    conflicts: pr.mergeStatus === "conflicts",
    openThreads: threads.length,
    policies,
    blockers,
    canComplete: blockers.length === 0,
  };
  if (o.json) return JSON.stringify(result);
  const L = [`PR !${id} [${pr.status}${pr.isDraft ? ", draft" : ""}]: ${policies.length} polic${policies.length === 1 ? "y" : "ies"}, ${threads.length} open thread(s)`];
  for (const p of policies) L.push(`  ${p.blocks ? "BLOCKS" : OK.has(p.status) ? "ok    " : "info  "} ${p.name}: ${p.status}${p.blocking ? "" : " (optional)"}`);
  L.push(blockers.length ? `Blocks completion (${blockers.length}):` : "Nothing blocks completion.", ...blockers.map((b) => `  - ${b}`));
  return L.join("\n");
}

export async function prRequeue(ctx: Ctx, o: { pr: string; policy?: string; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const all = await evaluations(client, id);
  const needle = o.policy?.toLowerCase();
  const pick = all.filter((p) => (needle ? p.name.toLowerCase().includes(needle) || p.kind === needle : p.status === "rejected" || p.status === "broken") && p.status !== "queued" && p.status !== "running");
  if (!pick.length) {
    throw new AihubError(needle ? `PR !${id}: no idle policy matches '${o.policy}' (see aihub pr checks --pr ${id})` : `PR !${id}: no failed policy to requeue`);
  }
  for (const p of pick) await client.patch(`policy/evaluations/${p.evaluationId}`, {}, PREVIEW);
  return o.json ? JSON.stringify({ pr: id, requeued: pick.map((p) => p.name) }) : `PR !${id}: requeued ${pick.map((p) => p.name).join(", ")}; follow with aihub pipeline follow --pr ${id}`;
}

/** Does the target branch have an enabled, blocking branch policy (for this repository or every repository of the project)? */
export async function hasBlockingPolicy(client: AdoClient, targetRef: string): Promise<boolean> {
  const { id: repoId } = await repoInfo(client);
  const cfgs = await client.list<{ isEnabled?: boolean; isBlocking?: boolean; settings?: { scope?: { repositoryId?: string | null; refName?: string; matchKind?: string }[] } }>("policy/configurations");
  return cfgs.some((c) => {
    if (c.isEnabled === false || c.isBlocking === false) return false;
    return (c.settings?.scope ?? []).some((s) => {
      if (s.repositoryId && s.repositoryId.toLowerCase() !== repoId.toLowerCase()) return false;
      if (!s.refName) return true;
      return s.matchKind?.toLowerCase() === "prefix" ? targetRef.startsWith(s.refName) : s.refName === targetRef;
    });
  });
}
