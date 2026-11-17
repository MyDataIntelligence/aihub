import { shortBranch, type AdoClient, type PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { latestPerDefinition, type Build } from "./pipeline.js";
import { loadTeam } from "./team.js";

export async function myId(client: AdoClient): Promise<string> {
  const r = await client.getOrg<{ authenticatedUser?: { id?: string } }>("connectionData");
  return r.authenticatedUser?.id ?? "";
}

export async function listPrs(client: AdoClient, o: { mine?: boolean; status?: string }): Promise<PullRequest[]> {
  const creator = o.mine ? await myId(client) : undefined;
  return client.list<PullRequest>(`${client.repoPath()}/pullrequests`, {
    "searchCriteria.status": o.status ?? "active",
    ...(creator ? { "searchCriteria.creatorId": creator } : {}),
  });
}

async function openThreads(client: AdoClient, id: number): Promise<number> {
  const threads = await client.list<{ status?: string; isDeleted?: boolean; comments?: { commentType?: string }[] }>(`${client.repoPath()}/pullrequests/${id}/threads`);
  return threads.filter((t) => !t.isDeleted && (t.status === "active" || t.status === "pending") && t.comments?.[0]?.commentType !== "system").length;
}

async function prBuilds(client: AdoClient, pr: PullRequest): Promise<Build[]> {
  const q = (branchName: string) => client.get<{ value?: Build[] }>("build/builds", { branchName, queryOrder: "queueTimeDescending", $top: 10 }).then((r) => r.value ?? []);
  const b = await q(`refs/pull/${pr.pullRequestId}/merge`);
  return b.length ? b : q(pr.sourceRefName);
}

export async function work(ctx: Ctx, o: { json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const type = team.workItems?.storyType ?? "User Story";

  const storiesP = (async () => {
    const q = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.WorkItemType] = '${type.replace(/'/g, "''")}' AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') ORDER BY [System.ChangedDate] DESC`,
    });
    const ids = (q.workItems ?? []).slice(0, 25).map((w) => w.id);
    if (!ids.length) return [];
    const r = await client.get<{ value?: { id: number; fields: Record<string, string> }[] }>("wit/workitems", { ids: ids.join(","), fields: "System.Id,System.Title,System.State" });
    return (r.value ?? []).map((w) => ({ id: w.id, state: w.fields["System.State"], title: w.fields["System.Title"] }));
  })();

  const prsP = (async () => {
    const prs = await listPrs(client, { mine: true });
    return Promise.all(
      prs.map(async (pr) => {
        const [threads, builds] = await Promise.all([openThreads(client, pr.pullRequestId), prBuilds(client, pr)]);
        const b = latestPerDefinition(builds);
        return {
          id: pr.pullRequestId,
          title: pr.title,
          source: shortBranch(pr.sourceRefName),
          target: shortBranch(pr.targetRefName),
          status: pr.isDraft ? "draft" : pr.status,
          openThreads: threads,
          pipelines: b.map((x) => ({ name: x.definition?.name ?? "pipeline", number: x.buildNumber, state: x.status === "completed" ? (x.result ?? "completed") : x.status })),
        };
      }),
    );
  })();

  const [stories, prs] = await Promise.all([storiesP, prsP]);
  if (o.json) return JSON.stringify({ stories, prs });
  const out = [`My open stories (${stories.length})`];
  for (const s of stories) out.push(`  ${s.id} [${s.state}] ${s.title}`);
  out.push(`My pull requests (${prs.length})`);
  for (const p of prs) {
    const pl = p.pipelines.length ? p.pipelines.map((x) => `${x.name} #${x.number}: ${x.state}`).join("; ") : "no run";
    out.push(`  !${p.id} ${p.status} ${p.source} -> ${p.target}  open threads: ${p.openThreads}  pipeline: ${pl}`);
  }
  return out.join("\n");
}
