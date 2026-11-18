import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface TeamConfig {
  repositories?: { name?: string; defaultTarget?: string }[];
  pullRequest?: { emptySection?: string; optionalSections?: string[] };
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
  tests?: { command?: string; map?: { source: string | string[]; tests: string | string[] }[] };
  cherryPick?: { groups?: Record<string, string[]> };
  pipelines?: { repository?: string; name?: string; required?: boolean }[];
  [k: string]: unknown;
}

export const TEAM_FILE = ".agents/skills/_shared/references/team.yaml";

/** Read a UTF-8 file, dropping a BOM and normalising CRLF. */
export function readUtf8(path: string): string {
  return readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

export function loadTeam(repoRoot: string): TeamConfig {
  const p = join(repoRoot, TEAM_FILE);
  if (!existsSync(p)) return {};
  try {
    return (parse(readUtf8(p)) as TeamConfig) ?? {};
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
