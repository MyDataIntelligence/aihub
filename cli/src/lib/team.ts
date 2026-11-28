import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { findSet } from "./setInfo.js";
import { hasTeamSources, readCopy, teamRepoFor } from "./teamSource.js";

export interface TeamConfig {
  repositories?: { name?: string; defaultTarget?: string }[];
  pullRequest?: {
    template?: string;
    /** title pattern: {storyId} {storyTitle} {branch}; used by aihub pr create (a pattern naming the story only when the story is known) */
    title?: string;
    emptySection?: string;
    optionalSections?: string[];
    /** headings of template sections that list what readers must do themselves after the merge; the CLI refuses vague text there (--as-is overrides) */
    actionSections?: string[];
    /** who the action sections are for, the platform contract (globs; a change there touches users) and where users keep their files (globs per repository); `aihub pr impact` reads it */
    userImpact?: { audience?: string; contractPaths?: string[]; userFiles?: { repository?: string; paths?: string[] }[] };
    /** done by `aihub pr create` right after a new PR exists: story state, auto-complete (only when the target branch has a blocking policy) */
    afterCreate?: { storyState?: string; autoComplete?: boolean };
  };
  workItems?: {
    storyType?: string;
    storyTemplate?: string;
    /** template path per work item type, e.g. Bug and Task (aihub workitem create) */
    templates?: Record<string, string>;
    emptySection?: string;
    /** heading -> ADO field reference name, merged over the defaults */
    sectionFields?: Record<string, string>;
    areaPath?: string;
    iterationPath?: string;
    tags?: string[];
  };
  branches?: { feature?: string; protected?: string[] };
  commits?: { format?: string; types?: string[]; scope?: string };
  tests?: { command?: string; /** run once in the temporary copy of `browse change verify` before the tests (a venv, pip install -r requirements.txt) */ setup?: string; map?: { source: string | string[]; tests: string | string[] }[] };
  cherryPick?: { groups?: Record<string, string[]> };
  /** wiki updates (aihub wiki update): `pageTemplate` is the path of the markdown template a NEW wiki page follows */
  wiki?: { pageTemplate?: string };
  pipelines?: { repository?: string; name?: string; required?: boolean; purpose?: string; yaml?: string; validates?: string[]; requiredTemplates?: string[] }[];
  [k: string]: unknown;
}

export const TEAM_FILE = ".agents/skills/_shared/references/team.yaml";

/** Read a UTF-8 file, dropping a BOM and normalising CRLF. */
/** A text file without BOM and with \n line ends; UTF-16 files (Windows PowerShell `>` and Out-File) are decoded too. */
export function readUtf8(path: string): string {
  const b = readFileSync(path);
  const utf16 = b[0] === 0xff && b[1] === 0xfe ? b.subarray(2) : b[0] === 0xfe && b[1] === 0xff ? Buffer.from(b.subarray(2)).swap16() : undefined;
  return (utf16 ? utf16.toString("utf16le") : b.toString("utf8")).replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

export function loadTeam(repoRoot: string): TeamConfig {
  const p = join(repoRoot, TEAM_FILE);
  if (!existsSync(p)) return teamRepoTeam(repoRoot);
  try {
    return (parse(readUtf8(p)) as TeamConfig) ?? {};
  } catch {
    return {};
  }
}

/**
 * A repository without its own team.yaml uses the team repository set with `aihub team init --team-repo` (for its set,
 * else for every repository): the copy kept in the config folder, read without a call. Nothing set: {} (the defaults).
 */
function teamRepoTeam(repoRoot: string, env: NodeJS.ProcessEnv = process.env): TeamConfig {
  if (!hasTeamSources(env)) return {}; // the usual case: one file check, no folder walk
  try {
    const r = teamRepoFor(env, findSet(repoRoot)?.folder);
    const copy = r ? readCopy(env, r) : undefined;
    return copy ? ((parse(copy.content) as TeamConfig) ?? {}) : {};
  } catch {
    return {};
  }
}

export function defaultTargetFor(team: TeamConfig, repoName: string): string | undefined {
  const repos = team.repositories ?? [];
  const r = repos.find((x) => x.name?.toLowerCase() === repoName.toLowerCase()) ?? (repos.length === 1 && !repos[0].name ? repos[0] : undefined);
  return r?.defaultTarget;
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "@@")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/@@/g, ".*");
  return new RegExp(`^${esc}$`);
}

export const globMatch = (glob: string, name: string): boolean => globToRegExp(glob).test(name);

export function isProtected(team: TeamConfig, branch: string): boolean {
  return (team.branches?.protected ?? []).some((g) => globMatch(g, branch));
}
