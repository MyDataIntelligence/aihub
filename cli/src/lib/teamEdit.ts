import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { packRoot } from "./pack.js";
import { remoteOf } from "./pipelineView.js";
import { findSet } from "./setInfo.js";
import { readUtf8, TEAM_FILE } from "./team.js";
import { parseTeam, templatesOf } from "./teamSettings.js";
import { readCopy, teamRepoFor, type TeamRepo } from "./teamSource.js";
import { validateTeamText, type ValidateResult } from "./teamValidate.js";
import type { PreviewKind } from "./teamPreview.js";

/**
 * `aihub team edit`: team.yaml or a template is changed in the team repository through the repository browser's save
 * (`aihub browse push`): one commit on a NEW feature branch and a pull request, never on main or a protected branch.
 * Without --content-file it only says where the file lives (for an editor to open it); with it, a team.yaml with errors
 * is refused before anything is pushed.
 */

export interface EditTarget {
  /** team.yaml, or a template kind */
  what: "team.yaml" | PreviewKind;
  kind: "teamRepo" | "repo";
  org?: string;
  project?: string;
  repo?: string;
  /** a local clone (the repository's own team.yaml, or a local team repository) */
  localPath?: string;
  /** the branch the file is read on and the pull request targets */
  branch?: string;
  /** path in the repository, without a leading slash */
  path: string;
  /** a name for the feature branch: feature/team-<what> */
  suggestedBranch: string;
  prTitle: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Where the file to edit lives: the team repository of the set, else this repository's own team.yaml (its remote). */
export function editTarget(ctx: Ctx, o: { template?: PreviewKind; repo?: string; teamRepo?: TeamRepo } = {}): EditTarget {
  const set = findSet(ctx.cwd);
  const teamRepo = o.teamRepo ?? teamRepoFor(ctx.env, set?.folder);
  const dir = o.repo && set ? set.repos.find((r) => r.name.toLowerCase() === o.repo!.toLowerCase())?.path : undefined;
  const local = dir ?? (set?.repos.find((r) => existsSync(join(r.path, TEAM_FILE)))?.path || ctx.cwd);
  const copy = teamRepo ? readCopy(ctx.env, teamRepo) : undefined;
  const text = copy?.content ?? (existsSync(join(local, TEAM_FILE)) ? readUtf8(join(local, TEAM_FILE)) : "");
  const path = o.template ? templatesOf(parseTeam(text)).find((t) => t.kind === o.template)!.path : TEAM_FILE;
  const what = o.template ?? "team.yaml";
  const name = what === "team.yaml" ? "team" : `team-${what}-template`;
  const base = { what, path: path.replace(/^\/+/, ""), suggestedBranch: `feature/${slug(name)}`, prTitle: what === "team.yaml" ? "Team: change team.yaml" : `Team: change the ${what} template` } as const;
  if (teamRepo && !(o.repo && dir && existsSync(join(dir, TEAM_FILE)))) {
    return { ...base, kind: "teamRepo", org: teamRepo.org, project: teamRepo.project, repo: teamRepo.repo, localPath: teamRepo.localPath, branch: copy?.branch ?? teamRepo.branch };
  }
  let remote: { org: string; project: string; repo: string } | undefined;
  try {
    remote = remoteOf(local);
  } catch {
    remote = undefined;
  }
  return { ...base, kind: "repo", localPath: local, org: remote?.org, project: remote?.project, repo: remote?.repo };
}

/** The pack has this file (the "Create from the team pack" fix of a missing template). */
export function packHas(path: string): boolean {
  try {
    return existsSync(join(packRoot(), "team-pack", path));
  } catch {
    return false;
  }
}

export function packFile(path: string): string {
  return readFileSync(join(packRoot(), "team-pack", path), "utf8").replace(/\r\n/g, "\n");
}

export interface EditSave {
  contentFile: string;
  branch: string;
  title?: string;
  message?: string;
  baseCommit?: string;
  story?: number;
}

export type EditResult = { validation?: ValidateResult; target: EditTarget; push?: unknown };

/** Validates (team.yaml) and pushes to a new branch with a pull request. A team.yaml with errors is refused. */
export async function teamEditSave(ctx: Ctx, t: EditTarget, s: EditSave, push?: (input: Record<string, unknown>) => Promise<unknown>): Promise<EditResult> {
  const content = readUtf8(s.contentFile);
  let validation: ValidateResult | undefined;
  if (t.what === "team.yaml") {
    validation = validateTeamText(content, { packHas });
    if (!validation.ok) throw new AihubError(`team.yaml has ${validation.errors} error(s); fix them first: ${validation.problems.filter((p) => p.severity === "error").map((p) => `line ${p.line}: ${p.message}`).join("; ")}`);
  }
  if (!t.project || !t.repo) throw new AihubError("the team file is not in an Azure DevOps repository (no remote): commit it in that repository yourself");
  const message = s.message?.trim() || s.title?.trim() || t.prTitle;
  const input = { project: t.project, repo: t.repo, path: `/${t.path}`, branch: s.branch, content, message, pr: true, prTitle: s.title?.trim() || t.prTitle, story: s.story, target: t.branch, baseBranch: t.branch, baseCommit: s.baseCommit };
  if (push) return { validation, target: t, push: await push(input) };
  const { browseOf } = await import("./browse/core.js");
  const { browsePush } = await import("./browse/push.js");
  const { browseFile } = await import("./browse/read.js");
  const b = browseOf(ctx, { org: t.org, refresh: true });
  let baseBranch = t.branch;
  let baseCommit = s.baseCommit;
  if (!baseBranch || !baseCommit) {
    // the version the edit starts from: read now (a change made since is then not seen as a conflict)
    const f = await browseFile(b, { project: t.project, repo: t.repo, path: `/${t.path}`, ref: t.branch }).catch(() => undefined);
    baseBranch = baseBranch ?? f?.ref.name;
    baseCommit = baseCommit ?? f?.ref.commit;
    if (!baseBranch || !baseCommit) {
      const { browseRepo } = await import("./browse/read.js");
      const r = await browseRepo(b, { project: t.project, repo: t.repo, ref: t.branch });
      const rr = r as unknown as { ref?: { name?: string; commit?: string }; repo?: { defaultBranch?: string } };
      baseBranch = baseBranch ?? rr.ref?.name ?? rr.repo?.defaultBranch;
      baseCommit = baseCommit ?? rr.ref?.commit;
    }
  }
  if (!baseBranch || !baseCommit) throw new AihubError(`cannot tell the branch and commit of ${t.repo} to start from`);
  const r = await browsePush(b, { ...input, baseBranch, baseCommit, target: t.branch ?? baseBranch });
  return { validation, target: t, push: r };
}
