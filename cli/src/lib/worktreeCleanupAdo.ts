import type { AdoClient, PullRequest } from "./ado.js";

/** The newest pull request per branch (any status), one request per branch; a failed read leaves the branch out. */
export async function findPullRequests(client: AdoClient, branches: string[]): Promise<Map<string, { id: number; status: string }>> {
  const out = new Map<string, { id: number; status: string }>();
  await Promise.all(
    [...new Set(branches)].map(async (b) => {
      try {
        const prs = await client.list<PullRequest & { creationDate?: string }>(`${client.repoPath()}/pullrequests`, { "searchCriteria.sourceRefName": `refs/heads/${b}`, "searchCriteria.status": "all", $top: 10 });
        const newest = [...prs].sort((x, y) => String(y.creationDate ?? "").localeCompare(String(x.creationDate ?? "")) || y.pullRequestId - x.pullRequestId)[0];
        if (newest) out.set(b, { id: newest.pullRequestId, status: newest.status });
      } catch {
        /* no answer for this branch: the row just has no PR */
      }
    }),
  );
  return out;
}
