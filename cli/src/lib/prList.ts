import { getPr, type AdoClient } from "./ado.js";
import { getThreads } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { evaluations } from "./policy.js";
import { parsePrRef } from "./pr.js";
import { loadTeam } from "./team.js";
import { whoAmI } from "./watchMine.js";

/** Reviewer as every JSON consumer (status, pr list, pr show) sees it. vote: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting, -10 rejected. */
export interface Reviewer {
  name: string;
  vote: number;
  voteName: string;
  required: boolean;
}

export interface PrListItem {
  id: number;
  title: string;
  repo: string;
  source: string;
  target: string;
  status: string;
  draft: boolean;
  author: string;
  reviewers: Reviewer[];
  url: string;
  created: string;
}

interface RawIdentity {
  displayName?: string;
  id?: string;
  vote?: number;
  isRequired?: boolean;
}
interface RawPr {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  createdBy?: RawIdentity;
  creationDate?: string;
  sourceRefName: string;
  targetRefName: string;
  reviewers?: RawIdentity[];
  repository?: { id?: string; name?: string };
  mergeStatus?: string;
}

export const voteName = (v?: number): string => (v === 10 ? "approved" : v === 5 ? "approved with suggestions" : v === -5 ? "waiting for the author" : v === -10 ? "rejected" : "no vote");

export function reviewersOf(pr: { reviewers?: RawIdentity[] }): Reviewer[] {
  return (pr.reviewers ?? []).map((r) => ({ name: r.displayName ?? "?", vote: r.vote ?? 0, voteName: voteName(r.vote), required: !!r.isRequired }));
}

const short = (r: string) => r.replace(/^refs\/heads\//, "");

export function prUrl(client: AdoClient, repo: string, id: number): string {
  const r = client.remote;
  return `${r.orgUrl}/${encodeURIComponent(r.project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
}

function itemOf(client: AdoClient, pr: RawPr): PrListItem {
  const repo = pr.repository?.name ?? client.remote.repo;
  return {
    id: pr.pullRequestId,
    title: pr.title,
    repo,
    source: short(pr.sourceRefName),
    target: short(pr.targetRefName),
    status: pr.status,
    draft: !!pr.isDraft,
    author: pr.createdBy?.displayName ?? "?",
    reviewers: reviewersOf(pr),
    url: prUrl(client, repo, pr.pullRequestId),
    created: pr.creationDate ?? "",
  };
}

export interface PrListOpts {
  mine?: boolean;
  reviewer?: boolean;
  branch?: string;
  status?: string;
  repo?: string;
  json?: boolean;
}

const STATUSES = ["active", "completed", "abandoned", "all"];

export async function prList(ctx: Ctx, o: PrListOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const status = o.status ?? "active";
  if (!STATUSES.includes(status)) throw new AihubError(`--status must be one of ${STATUSES.join(", ")}`);
  const q: Record<string, string | number> = { "searchCriteria.status": status, $top: 100 };
  if (o.mine || o.reviewer) {
    const me = await whoAmI(client);
    if (o.mine) q["searchCriteria.creatorId"] = me.id;
    if (o.reviewer) q["searchCriteria.reviewerId"] = me.id;
  }
  if (o.branch) q["searchCriteria.sourceRefName"] = o.branch.startsWith("refs/") ? o.branch : `refs/heads/${o.branch}`;
  let list = await client.list<RawPr>("git/pullrequests", q);
  // the team's repositories (team.yaml) unless one repository is asked for
  const teamRepos = ((loadTeam(root).repositories ?? []) as { name?: string }[]).map((r) => r.name).filter((n): n is string => !!n);
  const only = o.repo ? [o.repo] : teamRepos;
  if (only.length) list = list.filter((p) => only.some((n) => n.toLowerCase() === (p.repository?.name ?? "").toLowerCase()));
  const items = list.map((p) => itemOf(client, p)).sort((a, b) => b.created.localeCompare(a.created));
  if (o.json) return JSON.stringify(items);
  if (!items.length) return `no ${status === "all" ? "" : `${status} `}pull requests found`;
  return [
    `${items.length} pull request(s)`,
    ...items.map((p) => {
      const votes = p.reviewers.filter((r) => r.vote !== 0).map((r) => `${r.name}: ${r.voteName}`);
      return `!${p.id} [${p.status}${p.draft ? ", draft" : ""}] ${p.title} (${p.repo}: ${p.source} -> ${p.target}) by ${p.author}${votes.length ? `  votes: ${votes.join(", ")}` : ""}`;
    }),
  ].join("\n");
}

export interface PrShow extends PrListItem {
  description: string;
  mergeStatus?: string;
  policies: { total: number; approved: number; blocking: string[] };
  threads: { total: number; open: number };
}

const head = (d: string): string => {
  const t = d.trim();
  const lines = t.split("\n").slice(0, 12).join("\n");
  return lines.length > 600 ? `${lines.slice(0, 599)}…` : lines;
};

export async function prShow(ctx: Ctx, o: { pr: string; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = (await getPr(client, id)) as unknown as RawPr;
  const base = itemOf(client, pr);
  let policies: PrShow["policies"] = { total: 0, approved: 0, blocking: [] };
  try {
    const ev = await evaluations(client, id);
    policies = { total: ev.length, approved: ev.filter((e) => e.status === "approved" || e.status === "notApplicable").length, blocking: ev.filter((e) => e.blocks).map((e) => `${e.name}: ${e.status}`) };
  } catch {
    /* policies are a hint: the PR is still shown */
  }
  const threads = await getThreads(client, id, undefined, true);
  const show: PrShow = {
    ...base,
    description: head(pr.description ?? ""),
    mergeStatus: pr.mergeStatus,
    policies,
    threads: { total: threads.length, open: threads.filter((t) => ["active", "pending"].includes(t.status)).length },
  };
  if (o.json) return JSON.stringify(show);
  const l = [`!${show.id} ${show.title} (${show.status}${show.draft ? ", draft" : ""}) by ${show.author}`, `${show.repo}: ${show.source} -> ${show.target}`, show.url];
  if (show.description) l.push("", show.description);
  l.push("", `Reviewers: ${show.reviewers.length ? show.reviewers.map((r) => `${r.name}${r.required ? " (required)" : ""}: ${r.voteName}`).join(", ") : "none"}`);
  l.push(`Policies: ${policies.approved}/${policies.total} ok${policies.blocking.length ? `; blocking: ${policies.blocking.join(", ")}` : ""}`);
  l.push(`Threads: ${show.threads.total} (${show.threads.open} open)`);
  return l.join("\n");
}
