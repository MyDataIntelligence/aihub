import {
  type AdoClient,
  branchRef,
  findActivePr,
  getPr,
  getWorkItemPrIds,
  getWorkItemTitle,
  repoDefaultBranch,
  shortBranch,
  type PullRequest,
} from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import {
  commitsSince,
  currentBranch,
  mergeBase,
  originDefaultBranch,
  pushIfNeeded,
  showFile,
  workItemFromBranch,
  git,
} from "./git.js";
import { compose, DEFAULT_EMPTY, editSection, mergeSections, resolveTemplate, type CodeValues } from "./templates.js";
import { defaultTargetFor, loadTeam, readUtf8 } from "./team.js";

export interface CreateOpts {
  title?: string;
  bodyFile?: string;
  target?: string;
  draft?: boolean;
  workItem?: number;
  dryRun?: boolean;
  json?: boolean;
}

export function parsePrRef(ref: string): number {
  const m = /pullrequest\/(\d+)/i.exec(ref) ?? /^!?(\d+)$/.exec(ref.trim());
  if (!m) throw new AihubError(`'${ref}' is not a pull request number or URL`);
  return Number(m[1]);
}

export function commitList(commits: { sha: string; subject: string }[]): string {
  return commits.map((c) => `- ${c.subject} (${c.sha})`).join("\n");
}

export async function createPr(ctx: Ctx, o: CreateOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const branch = currentBranch(root);
  const team = loadTeam(root);

  const target =
    o.target ??
    defaultTargetFor(team, client.remote.repo) ??
    (originDefaultBranch(root) || undefined) ??
    (await repoDefaultBranch(client)) ??
    "main";
  if (target === branch) throw new AihubError(`you are on the target branch '${branch}'; check out a feature branch first`);

  const wi = o.workItem ?? workItemFromBranch(branch);
  const wiTitle = wi ? await getWorkItemTitle(client, wi) : undefined;
  const commits = commitsSince(root, mergeBase(root, target));
  const title = o.title ?? (wi && wiTitle ? `${wi} ${wiTitle}` : (commits[0]?.subject ?? branch));

  const existing = o.dryRun ? undefined : await findActivePr(client, branch);
  const linkedIds = wi ? (await getWorkItemPrIds(client, wi)).filter((id) => id !== existing?.pullRequestId) : [];
  const code: CodeValues = {
    story: wi ? `AB#${wi}` : undefined,
    commits: commits.length ? commitList(commits) : undefined,
    linked: linkedIds.length ? linkedIds.map((i) => `- !${i}`).join("\n") : undefined,
  };

  const body = o.bodyFile ? readUtf8(o.bodyFile) : "";
  const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), localRoot: root });
  const emptyText = team.pullRequest?.emptySection || DEFAULT_EMPTY;
  let description: string;
  let summary: string;
  if (tpl) {
    const c = compose({ template: tpl.content, body, code, emptyText });
    description = c.text;
    const by = (k: string) => c.filled.filter((f) => f.by === k).map((f) => f.heading);
    summary = [
      by("body").length ? `body: ${by("body").join(", ")}` : "",
      by("code").length ? `code: ${by("code").join(", ")}` : "",
      by("empty").length ? `${emptyText}: ${by("empty").join(", ")}` : "",
      by("extra").length ? `extra: ${by("extra").join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  } else {
    const extra = [code.story, code.commits && `## Commits\n\n${code.commits}`].filter(Boolean).join("\n\n");
    description = [body.trim(), extra].filter(Boolean).join("\n\n") + "\n";
    summary = "no PR template found: body used as is";
  }

  if (o.dryRun) {
    return o.json
      ? JSON.stringify({ dryRun: true, title, target, source: branch, workItem: wi, template: tpl?.path, description })
      : `dry-run: '${title}' ${branch} -> ${target} (${summary})\n${description}`;
  }

  if (existing) {
    const upd: Record<string, unknown> = { description };
    if (o.title) upd.title = o.title;
    if (o.draft !== undefined) upd.isDraft = o.draft;
    await client.patch(`${client.repoPath()}/pullrequests/${existing.pullRequestId}`, upd);
    return line(o, { id: existing.pullRequestId, url: client.prUrl(existing.pullRequestId), action: "updated", summary }, `PR !${existing.pullRequestId} updated`, client, summary);
  }

  pushIfNeeded(root, branch);
  const created = await client.post<PullRequest>(`${client.repoPath()}/pullrequests`, {
    sourceRefName: branchRef(branch),
    targetRefName: branchRef(target),
    title,
    description,
    isDraft: !!o.draft,
    ...(wi ? { workItemRefs: [{ id: String(wi) }] } : {}),
  });
  return line(o, { id: created.pullRequestId, url: client.prUrl(created.pullRequestId), action: "created", summary }, `PR !${created.pullRequestId} created`, client, summary);
}

function line(o: { json?: boolean }, j: { id: number; url: string; action: string; summary: string }, text: string, c: AdoClient, summary: string): string {
  return o.json ? JSON.stringify(j) : `${text}: ${c.prUrl(j.id)} (${summary})`;
}

export interface UpdateOpts {
  pr?: string;
  bodyFile?: string;
  section?: string;
  appendFile?: string;
  replaceFile?: string;
  title?: string;
  draft?: boolean;
  target?: string;
  json?: boolean;
}

export async function resolvePr(ctx: Ctx, client: AdoClient, root: string, ref?: string): Promise<PullRequest> {
  if (ref) return getPr(client, parsePrRef(ref));
  const branch = currentBranch(root);
  const pr = await findActivePr(client, branch);
  if (!pr) throw new AihubError(`no active pull request for branch '${branch}'; pass --pr <number|url> or run 'aihub pr create'`);
  return getPr(client, pr.pullRequestId);
}

export async function updatePr(ctx: Ctx, o: UpdateOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const pr = await resolvePr(ctx, client, root, o.pr);
  let description = pr.description ?? "";
  const changed: string[] = [];

  if (o.bodyFile) {
    description = mergeSections(description, readUtf8(o.bodyFile));
    changed.push("body");
  }
  if (o.section) {
    if (!o.appendFile && !o.replaceFile) throw new AihubError("--section needs --append-file or --replace-file");
    description = editSection(
      description,
      o.section,
      o.replaceFile ? { replace: readUtf8(o.replaceFile) } : { append: readUtf8(o.appendFile!) },
    );
    changed.push(`section ${o.section}`);
  } else if (o.appendFile || o.replaceFile) {
    throw new AihubError("--append-file/--replace-file need --section <heading>");
  }

  const patch: Record<string, unknown> = {};
  if (changed.length) patch.description = description;
  if (o.title) (patch.title = o.title), changed.push("title");
  if (o.draft !== undefined) (patch.isDraft = o.draft), changed.push(o.draft ? "draft" : "ready");
  if (o.target) (patch.targetRefName = branchRef(o.target)), changed.push(`target ${shortBranch(branchRef(o.target))}`);
  if (!changed.length) throw new AihubError("nothing to update: pass --body-file, --section, --title, --draft or --target");

  await client.patch(`${client.repoPath()}/pullrequests/${pr.pullRequestId}`, patch);
  const url = client.prUrl(pr.pullRequestId);
  return o.json ? JSON.stringify({ id: pr.pullRequestId, url, changed }) : `PR !${pr.pullRequestId} updated: ${url} (${changed.join(", ")})`;
}

export { git };
