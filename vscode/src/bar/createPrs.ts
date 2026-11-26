import { unfit } from "./batch";
import type { BarRepo } from "./types";

/**
 * Create Pull Requests for the repositories of a story set: which repositories are offered (and which are not, with the
 * reason), and the `aihub` calls. No vscode here.
 */
export interface PrOffer {
  repo: string;
  path: string;
  branch: string;
  /** can a pull request be made now */
  enabled: boolean;
  /** ticked at the start: only the enabled ones */
  picked: boolean;
  /** why it is not offered, or a remark for an offered one */
  reason?: string;
}

/** Offered: a repository on a story branch without a pull request. The others say why not. Uncommitted work is named, never taken along. */
export function prOffers(repos: BarRepo[]): PrOffer[] {
  return repos.map((r) => {
    const base = { repo: r.name, path: r.path, branch: r.branch };
    const changes = r.changes ?? r.dirty ?? 0;
    if (!r.storyBranch) return { ...base, enabled: false, picked: false, reason: "not on a story branch" };
    if (r.pr) return { ...base, enabled: false, picked: false, reason: r.pr.status === "merged" ? `${r.pr.id} merged` : `${r.pr.id} exists · ${r.pr.status}` };
    return { ...base, enabled: true, picked: true, ...(changes ? { reason: `${changes} uncommitted file${changes === 1 ? "" : "s"} stay out` } : {}) };
  });
}

export interface PrResult {
  repo: string;
  ok: boolean;
  line: string;
  id?: number;
  url?: string;
}

type Cli = (args: string[], cwd: string) => Promise<string>;

/**
 * `aihub pr create` in each ticked repository (the team template, linked to the story by `--work-item`; the CLI pushes
 * the branch and names uncommitted work), then one `aihub crossrepo link-prs` so the pull requests of the story list
 * each other. A failure in one repository only fails that one.
 */
export async function createPullRequests(cli: Cli, picked: { name: string; path: string; target?: string }[], story: number): Promise<{ results: PrResult[]; linked?: string }> {
  const results: PrResult[] = [];
  for (const r of picked) {
    const why = unfit(r.path);
    if (why) {
      results.push({ repo: r.name, ok: false, line: `${r.name}: ${why}` });
      continue;
    }
    try {
      const out = await cli(["pr", "create", "--work-item", String(story), ...(r.target ? ["--target", r.target] : []), "--json"], r.path);
      const j = JSON.parse(out.slice(out.indexOf("{"))) as { id?: number; url?: string; action?: string };
      results.push({ repo: r.name, ok: true, line: `${r.name}: PR !${j.id} ${j.action ?? "created"}`, id: j.id, url: j.url });
    } catch (e) {
      results.push({ repo: r.name, ok: false, line: `${r.name}: ${(e as Error).message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "failed"}` });
    }
  }
  const made = results.filter((r) => r.ok);
  if (made.length < 1 || !picked.length) return { results };
  try {
    const first = picked.find((p) => made.some((m) => m.repo === p.name))!;
    await cli(["crossrepo", "link-prs", "--story", String(story), "--json"], first.path);
    return { results, linked: `the pull requests of story ${story} list each other` };
  } catch (e) {
    return { results, linked: `not linked to each other: ${(e as Error).message.split(/\r?\n/)[0]}` };
  }
}
