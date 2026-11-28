import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { repoClient } from "./context.js";
import { DEFAULT_COMMIT_FORMAT, formatCommit, inferScope } from "./commit.js";
import { commitsSince, currentBranch, git, mergeBase, workItemFromBranch } from "./git.js";
import { createPr } from "./pr.js";
import { findSet } from "./setInfo.js";
import { storyShow, findStoryTemplate } from "./story.js";
import { loadTeam, readUtf8 } from "./team.js";
import { codeKindOf, compose, DEFAULT_EMPTY, emptyFor, fallbackKindOf, parseSections, renderSections } from "./templates.js";
import { COMMIT_TEMPLATE } from "./teamSettings.js";
import { findTypeTemplate } from "./workItemType.js";
import { AihubError } from "./errors.js";

/**
 * `aihub team preview --template pr|story|bug|commit`: a team template filled with the real data of the current branch
 * (or one repository of the set), through the same code that writes the real thing (`aihub pr create --dry-run`, the
 * story read, the commit format). Nothing is created. Each value says where it came from.
 */

export type PreviewKind = "pr" | "story" | "bug" | "commit";

export interface ValueSource {
  /** `{storyId} {storyTitle}`, a section heading, ... */
  what: string;
  value: string;
  from: string;
  /** filled: from data; empty: left empty, the team text was used; agent: the agent writes it when the PR is made */
  how: "filled" | "empty" | "agent";
}

export interface TeamPreview {
  kind: PreviewKind;
  repo: string;
  branch: string;
  story?: number;
  template: { path?: string; source: string };
  title?: { pattern?: string; text: string; target?: string; source?: string; createTitle?: string };
  /** the filled template, markdown */
  markdown: string;
  emptyText: string;
  sources: ValueSource[];
  note?: string;
}

const KINDS: PreviewKind[] = ["pr", "story", "bug", "commit"];
export const parseKind = (v: string | undefined): PreviewKind => {
  const k = (v ?? "").toLowerCase().replace(/^pull-?request$/, "pr");
  if (!KINDS.includes(k as PreviewKind)) throw new AihubError(`--template must be one of ${KINDS.join(", ")}`);
  return k as PreviewKind;
};

/** The repository folder: --repo <name> of the set, else this folder. */
function repoDir(ctx: Ctx, repo?: string): { dir: string; name: string } {
  const set = findSet(ctx.cwd);
  if (repo && set) {
    const r = set.repos.find((x) => x.name.toLowerCase() === repo.toLowerCase());
    if (!r) throw new AihubError(`'${repo}' is not in this set (${set.repos.map((x) => x.name).join(", ")})`);
    return { dir: r.path, name: r.name };
  }
  const dir = git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
  return { dir, name: dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir };
}

export { fillTitle } from "./prTitle.js";
import { fillTitle } from "./prTitle.js";

export async function teamPreview(ctx: Ctx, o: { kind: PreviewKind; repo?: string }): Promise<TeamPreview> {
  const { dir, name } = repoDir(ctx, o.repo);
  const rctx: Ctx = { ...ctx, cwd: dir };
  const team = loadTeam(dir);
  const branch = currentBranch(dir);
  const story = workItemFromBranch(branch);
  const emptyText = emptyFor(team);

  if (o.kind === "pr") {
    const j = JSON.parse(await createPr(rctx, { dryRun: true, json: true })) as {
      title: string;
      target: string;
      source: string;
      workItem?: number;
      workItemTitle?: string;
      template?: string;
      description: string;
      filled?: { heading: string; by: string }[];
      emptyText?: string;
      commits?: number;
      files?: string;
    };
    const nl = team.language === "nl";
    j.files = /(\d+) files? changed/.exec(j.description)?.[0]?.replace(" changed", "");
    const pattern = team.pullRequest?.title || undefined;
    // aihub pr create applies pullRequest.title itself (prTitle), so the dry run gives the real title
    const title = j.title;
    const empty = j.emptyText || emptyText;
    const sources: ValueSource[] = [];
    if (j.workItem) sources.push({ what: "{storyId} {storyTitle}", value: `${j.workItem} ${j.workItemTitle ?? ""}`.trim(), from: "work item in Azure DevOps", how: "filled" });
    sources.push({ what: "{branch}", value: branch, from: `git, ${name}`, how: "filled" });
    const commitsText = j.commits ? `${j.commits} commit${j.commits === 1 ? "" : "s"}` : "no commits";
    const codeSource = (heading: string): ValueSource => {
      const kind = codeKindOf(heading);
      if (kind === "story") return { what: heading, value: j.workItem ? `link to #${j.workItem}` : "", from: "work item", how: "filled" };
      if (kind === "commits") return { what: heading, value: commitsText, from: `git log ${j.target}..branch`, how: "filled" };
      if (kind === "linked") return { what: heading, value: "linked pull requests", from: `work item ${j.workItem ?? ""}`.trim(), how: "filled" };
      const fb = fallbackKindOf(heading);
      if (fb === "tests") return { what: heading, value: nl ? "Nog niet uitgevoerd." : "Not run yet.", from: "no test result yet: the agent fills it after a real run", how: "empty" };
      return { what: heading, value: `${commitsText}${j.files ? `, ${j.files}` : ""}`, from: `git log ${j.target}..branch`, how: "filled" };
    };
    for (const f of j.filled ?? [])
      sources.push(
        f.by === "code"
          ? codeSource(f.heading)
          : f.by === "empty"
            ? { what: f.heading, value: empty, from: "pullRequest.emptySection", how: "empty" }
            : { what: f.heading, value: "", from: "the agent writes it when the pull request is made", how: "agent" },
      );
    return {
      kind: "pr",
      repo: name,
      branch,
      story: j.workItem,
      template: { path: j.template, source: j.template ? `${name}: ${j.template}` : "no pull request template: aihub writes a plain description" },
      title: { pattern, text: title, target: j.target, source: branch },
      markdown: j.description,
      emptyText: empty,
      sources,
    };
  }

  if (o.kind === "story" || o.kind === "bug") {
    let client;
    try {
      client = repoClient(rctx).client;
    } catch {
      client = undefined;
    }
    const found = o.kind === "story" ? await findStoryTemplate(dir, client, team) : await findTypeTemplate(dir, client, team, "Bug");
    const heads = parseSections(found.text).sections.map((s) => s.heading);
    if (o.kind === "story" && story && client) {
      const s = JSON.parse(await storyShow(rctx, { id: story, json: true })) as { id: number; title: string; sections: { heading: string; body: string }[] };
      const md = renderSections(s.sections.map((x) => ({ heading: x.heading, body: x.body?.trim() || emptyText })));
      return {
        kind: "story",
        repo: name,
        branch,
        story,
        template: { source: found.source },
        title: { text: `${s.id} ${s.title}` },
        markdown: md,
        emptyText,
        sources: [
          { what: "story", value: `${s.id} ${s.title}`, from: "work item in Azure DevOps (from the branch name)", how: "filled" },
          ...s.sections.map((x) => (x.body?.trim() ? { what: x.heading, value: "", from: `work item ${s.id}`, how: "filled" as const } : { what: x.heading, value: emptyText, from: "empty in the work item", how: "empty" as const })),
        ],
      };
    }
    const c = compose({ template: found.text, body: "", code: {}, emptyText });
    return {
      kind: o.kind,
      repo: name,
      branch,
      story,
      template: { source: found.source },
      markdown: c.text,
      emptyText,
      sources: heads.map((h) => ({ what: h, value: emptyText, from: o.kind === "bug" ? "a new bug starts empty; the agent fills it" : "no story on this branch", how: "empty" as const })),
      note: o.kind === "story" ? "no story number in the branch name: the empty template is shown" : undefined,
    };
  }

  // commit: the team's format with the newest commit of the branch, and the commit template text
  const format = team.commits?.format || DEFAULT_COMMIT_FORMAT;
  let base = "";
  try {
    base = mergeBase(dir, team.repositories?.[0]?.defaultTarget ?? "main");
  } catch {
    base = "";
  }
  const commits = base ? commitsSince(dir, base) : [];
  const files = base ? git(dir, ["diff", "--name-only", `${base}..HEAD`], { allowFail: true }).split("\n").filter(Boolean) : [];
  const subject = (commits[0]?.subject ?? "describe the change").replace(/^\w+(\([^)]*\))?!?:\s*/, "").replace(/\s*\(AB#\d+\)\s*$/, "");
  const type = team.commits?.types?.[0] ?? "feat";
  const scope = team.commits?.scope || inferScope(files);
  const line = formatCommit(format, { type, scope, subject, storyId: story });
  const tplPath = join(dir, COMMIT_TEMPLATE);
  const rule = existsSync(tplPath) ? readUtf8(tplPath).trim() : "";
  return {
    kind: "commit",
    repo: name,
    branch,
    story,
    template: { path: existsSync(tplPath) ? COMMIT_TEMPLATE : undefined, source: existsSync(tplPath) ? `${name}: ${COMMIT_TEMPLATE}` : "commits.format in team.yaml" },
    title: { pattern: format, text: line },
    markdown: ["```", line, "```", rule ? `\n${rule}` : ""].join("\n").trim() + "\n",
    emptyText,
    sources: [
      { what: "{type}", value: type, from: team.commits?.types ? "commits.types (first)" : "default", how: "filled" },
      { what: "{scope}", value: scope ?? "", from: team.commits?.scope ? "commits.scope" : "most common folder of the changed files", how: scope ? "filled" : "empty" },
      { what: "{subject}", value: subject, from: commits[0] ? `newest commit ${commits[0].sha}` : "the agent writes it", how: commits[0] ? "filled" : "agent" },
      { what: "{storyId}", value: story ? String(story) : "", from: "branch name", how: story ? "filled" : "empty" },
    ],
  };
}
