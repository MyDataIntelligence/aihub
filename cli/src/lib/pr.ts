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
  diffSummary,
  currentBranch,
  mergeBase,
  pushIfNeeded,
  listRefFiles,
  showFile,
  workItemFromBranch,
  git,
} from "./git.js";
import { compose, DEFAULT_EMPTY, emptyFor, checkDescriptionLength, editSection, headingsMatch, mergeSections, parseSections, renderSections, resolveTemplate, templateSourceText, type CodeValues } from "./templates.js";
import { CONTEXT_RE, notesText, readNotes, unwovenNotes, weaveNotes } from "./notes.js";
import { loadTeam, readUtf8 } from "./team.js";
import { prTitle } from "./prTitle.js";
import { checkActionSections } from "./prActions.js";
import { checkNoise } from "./prNoise.js";
import { impactWarning } from "./prImpact.js";
import { derivedNote, targetFor } from "./baseBranch.js";

export interface CreateOpts {
  title?: string;
  /** Short prose for the first template section (the summary/context), inline instead of a body file. */
  summaryText?: string;
  bodyFile?: string;
  target?: string;
  draft?: boolean;
  workItem?: number;
  dryRun?: boolean;
  noNotes?: boolean;
  /** skip the check of the sections that list actions for the reader */
  asIs?: boolean;
  /** create it although not every acceptance criterion of the story is proven */
  anyway?: boolean;
  json?: boolean;
}

export function parsePrRef(ref: string): number {
  const m = /pullrequest\/(\d+)/i.exec(ref) ?? /^!?(\d+)$/.exec(ref.trim());
  if (!m) throw new AihubError(`'${ref}' is not a pull request number or URL`);
  return Number(m[1]);
}

/** The Changes section when the agent wrote none: one line per commit and the size of the diff. */
export function changesText(commits: { sha: string; subject: string }[], diff?: string): string | undefined {
  if (!commits.length) return undefined;
  return `${commitList(commits)}${diff ? `

${diff}` : ""}`;
}

export function commitList(commits: { sha: string; subject: string }[]): string {
  return commits.map((c) => `- ${c.subject} (${c.sha})`).join("\n");
}

export async function createPr(ctx: Ctx, o: CreateOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const branch = currentBranch(root);
  const team = loadTeam(root);

  // --target, else team.yaml, else the branch this one was cut from (local git; unsure = one question before anything is made)
  const derived = o.target ? undefined : targetFor(ctx, root, branch, team, client.remote.repo);
  const target = o.target ?? derived?.target ?? (await repoDefaultBranch(client)) ?? "main";
  if (target === branch) throw new AihubError(`you are on the target branch '${branch}'; check out a feature branch first`);

  const wi = o.workItem ?? workItemFromBranch(branch);
  const wiTitle = wi ? await getWorkItemTitle(client, wi) : undefined;
  const commits = commitsSince(root, mergeBase(root, target));
  const title = prTitle({ given: o.title, pattern: team?.pullRequest?.title, storyId: wi, storyTitle: wiTitle, branch, firstCommit: commits[0]?.subject });

  const existing = o.dryRun ? undefined : await findActivePr(client, branch);
  const linkedIds = wi ? (await getWorkItemPrIds(client, wi)).filter((id) => id !== existing?.pullRequestId) : [];
  const code: CodeValues = {
    story: wi ? `AB#${wi}` : undefined,
    commits: commits.length ? commitList(commits) : undefined,
    linked: linkedIds.length ? linkedIds.map((i) => `- !${i}`).join("\n") : undefined,
  };

  const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), listRef: (b) => listRefFiles(root, b), localRoot: root });
  const tplSource = templateSourceText(tpl, target);
  // Private branch notes (aihub note add) are woven into the context section as plain prose.
  const notes = o.noNotes ? [] : readNotes(root, branch);
  const tplHeadings = tpl ? parseSections(tpl.content).sections.map((s) => s.heading) : [];
  let given = o.bodyFile ? readUtf8(o.bodyFile) : "";
  if (o.summaryText?.trim()) {
    const first = tplHeadings[0];
    given = first ? `## ${first}\n${o.summaryText.trim()}\n\n${given}` : `${o.summaryText.trim()}\n\n${given}`;
  }
  const body = weaveNotes(given, tplHeadings, notes);
  const emptyText = emptyFor(team);
  let description: string;
  let summary: string;
  let filled: { heading: string; by: string }[] = [];
  if (tpl) {
    const fallback = {
      changes: changesText(commits, diffSummary(root, mergeBase(root, target))),
      tests: team.language === "nl" ? "Nog niet uitgevoerd." : "Not run yet.",
    };
    const c = compose({ template: tpl.content, body, code, emptyText, fallback, dropExtra: !o.asIs });
    for (const h of c.dropped) ctx.err(`warning: section "${h}" is not in the team template; left out`);
    description = c.text;
    filled = c.filled;
    const by = (k: string) => c.filled.filter((f) => f.by === k).map((f) => f.heading);
    summary = [
      by("body").length ? `body: ${by("body").join(", ")}` : "",
      by("code").length ? `code: ${by("code").join(", ")}` : "",
      by("empty").length ? `${emptyText}: ${by("empty").join(", ")}` : "",
      by("extra").length ? `extra: ${by("extra").join(", ")}` : "",
      c.dropped.length ? `left out (not in the team template): ${c.dropped.join(", ")}` : "",
    ]
      .filter(Boolean)
      .concat(tplSource)
      .join("; ");
  } else {
    const extra = [code.story, code.commits && `## Commits\n\n${code.commits}`].filter(Boolean).join("\n\n");
    description = [body.trim(), extra].filter(Boolean).join("\n\n") + "\n";
    summary = tplSource;
  }
  if (!o.asIs) checkNoise(given, "created");
  if (!o.asIs) checkActionSections({ description, configured: team.pullRequest?.actionSections, emptyText, template: tpl?.content, verb: "created" });
  // the story's acceptance criteria with their test status: the required section, "N/M proven" on top; not all proven
  // stops here (nothing written) unless the user chose --draft or --anyway
  const crit = wi ? await (await import("./e2e/prSection.js")).prCriteria(ctx, client, wi, team.language as string | undefined).catch(() => undefined) : undefined;
  if (crit) {
    const ps = await import("./e2e/prSection.js");
    description = ps.withCriteria(description, crit.status, crit.lang);
    summary = [summary, `criteria ${crit.status.proven}/${crit.status.total} proven`].filter(Boolean).join("; ");
    if (crit.status.proven < crit.status.total && !o.dryRun && !o.draft && !o.anyway) throw ps.notProvenError(crit.status, wi!, crit.lang);
  }
  const note = derivedNote(derived);
  if (note) summary = [summary, note].filter(Boolean).join("; ");
  const warn = impactWarning(root, mergeBase(root, target), team, description);
  if (warn) summary = [summary, warn].filter(Boolean).join("; ");

  if (o.dryRun) {
    return o.json
      ? JSON.stringify({ dryRun: true, title, target, source: branch, workItem: wi, workItemTitle: wiTitle, template: tpl?.path, description, filled, emptyText, commits: commits.length })
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
  const after = await runAfterCreate(ctx, team, created.pullRequestId, wi, target);
  return line(o, { id: created.pullRequestId, url: client.prUrl(created.pullRequestId), action: "created", summary, afterCreate: after }, `PR !${created.pullRequestId} created`, client, summary + (after.length ? `; after create: ${after.join("; ")}` : ""));
}

function line(o: { json?: boolean }, j: { id: number; url: string; action: string; summary: string; afterCreate?: string[] }, text: string, c: AdoClient, summary: string): string {
  return o.json ? JSON.stringify(j) : `${text}: ${c.prUrl(j.id)} (${summary})`;
}

/**
 * team.yaml pullRequest.afterCreate: set the story state and ask for auto-complete once a NEW pull request exists. A failure never undoes the PR;
 * it is reported in the result. Auto-complete is only requested when the target branch has a blocking policy (policies stay required: without
 * one Azure DevOps would merge the PR at once), and it never bypasses a policy.
 */
async function runAfterCreate(ctx: Ctx, team: ReturnType<typeof loadTeam>, id: number, story: number | undefined, target: string): Promise<string[]> {
  const cfg = team.pullRequest?.afterCreate;
  if (!cfg) return [];
  const notes: string[] = [];
  const { client } = repoClient(ctx);
  if (cfg.storyState) {
    if (!story) notes.push(`story state '${cfg.storyState}' skipped: no story linked`);
    else {
      try {
        const { setWorkItemState } = await import("./workitems.js");
        await setWorkItemState(client, story, cfg.storyState);
        notes.push(`story AB#${story} -> ${cfg.storyState}`);
      } catch (e) {
        notes.push(`story state not set: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  if (cfg.autoComplete) {
    try {
      const { hasBlockingPolicy } = await import("./policy.js");
      if (!(await hasBlockingPolicy(client, branchRef(target)))) notes.push(`auto-complete not requested: '${target}' has no blocking policy, it would merge at once (complete it yourself when it is ready)`);
      else {
        const { prComplete } = await import("./review.js");
        notes.push((await prComplete(ctx, { pr: String(id), auto: true })).replace(/ \(https?:[^)]*\)$/, "").replace(/^PR !\d+: /, ""));
      }
    } catch (e) {
      notes.push(`auto-complete not set: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return notes;
}

export interface UpdateOpts {
  pr?: string;
  bodyFile?: string;
  section?: string;
  appendFile?: string;
  appendText?: string;
  replaceFile?: string;
  replaceText?: string;
  title?: string;
  draft?: boolean;
  target?: string;
  noNotes?: boolean;
  asIs?: boolean;
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
  // the headings the team template of the target has, plus those the PR already has: nothing else is added (no own headings)
  const tplOfTarget = resolveTemplate(shortBranch(pr.targetRefName), { readRef: (b, p) => showFile(root, b, p), listRef: (b) => listRefFiles(root, b), localRoot: root });
  const known = (h: string) =>
    [...parseSections(description).sections.map((s) => s.heading), ...(tplOfTarget ? parseSections(tplOfTarget.content).sections.map((s) => s.heading) : [])].some((k) => headingsMatch(k, h));
  const appendText0 = o.appendText ?? (o.appendFile ? readUtf8(o.appendFile) : undefined);
  const replaceText0 = o.replaceText ?? (o.replaceFile ? readUtf8(o.replaceFile) : undefined);
  const bodyText = o.bodyFile ? readUtf8(o.bodyFile) : undefined;
  let leftOut = 0;
  if (!o.asIs) for (const t of [bodyText, appendText0, replaceText0]) if (t) checkNoise(t, "updated");
  if (bodyText !== undefined) {
    let patch = bodyText;
    const parsed = parseSections(bodyText);
    if (!o.asIs && parsed.sections.length) {
      const left = parsed.sections.filter((s) => !known(s.heading));
      leftOut = left.length;
      for (const s of left) ctx.err(`warning: section "${s.heading}" is not in the team template; left out`);
      patch = renderSections(parsed.sections.filter((s) => known(s.heading)));
    }
    if (patch.trim()) {
      description = mergeSections(description, patch);
      changed.push("body");
    }
  }
  if (!o.noNotes && (o.bodyFile || o.section)) {
    // private branch notes join the context section as plain prose, once
    const fresh = unwovenNotes(description, readNotes(root, shortBranch(pr.sourceRefName)));
    if (fresh.length) {
      const heading = parseSections(description).sections.map((s) => s.heading).find((h) => CONTEXT_RE.test(h)) ?? "Context";
      description = editSection(description, heading, { append: notesText(fresh) });
      changed.push("context");
    }
  }
  const appendText = o.appendText ?? (o.appendFile ? readUtf8(o.appendFile) : undefined);
  const replaceText = o.replaceText ?? (o.replaceFile ? readUtf8(o.replaceFile) : undefined);
  if (o.section) {
    if (!o.asIs && !known(o.section)) throw new AihubError(`section "${o.section}" is not in the team template or in this PR; use one of its headings (or --as-is)`);
    if (appendText === undefined && replaceText === undefined) throw new AihubError("--section needs --append-text, --append-file, --replace-text or --replace-file");
    description = editSection(description, o.section, replaceText !== undefined ? { replace: replaceText } : { append: appendText! });
    changed.push(`section ${o.section}`);
  } else if (appendText !== undefined || replaceText !== undefined) {
    throw new AihubError("--append-*/--replace-* need --section <heading>");
  }

  if (!o.asIs && changed.length) {
    const team = loadTeam(root);
    const touched = [...(o.section ? [o.section] : []), ...(o.bodyFile ? parseSections(readUtf8(o.bodyFile)).sections.map((s) => s.heading) : [])];
    checkActionSections({ description, only: touched, configured: team.pullRequest?.actionSections, emptyText: emptyFor(team), verb: "updated" });
  }
  const patch: Record<string, unknown> = {};
  if (changed.length) {
    checkDescriptionLength(description);
    patch.description = description;
  }
  if (o.title) (patch.title = o.title), changed.push("title");
  if (o.draft !== undefined) (patch.isDraft = o.draft), changed.push(o.draft ? "draft" : "ready");
  if (o.target) (patch.targetRefName = branchRef(o.target)), changed.push(`target ${shortBranch(branchRef(o.target))}`);
  if (!changed.length && leftOut) throw new AihubError("nothing updated: every section of the body is not in the team template (see the warnings)");
  if (!changed.length) throw new AihubError("nothing to update: pass --body-file, --section, --title, --draft or --target");

  await client.patch(`${client.repoPath()}/pullrequests/${pr.pullRequestId}`, patch);
  const url = client.prUrl(pr.pullRequestId);
  return o.json ? JSON.stringify({ id: pr.pullRequestId, url, changed }) : `PR !${pr.pullRequestId} updated: ${url} (${changed.join(", ")})`;
}

export { git };
