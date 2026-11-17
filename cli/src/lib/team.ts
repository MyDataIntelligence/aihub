import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface TeamConfig {
  repositories?: { name?: string; defaultTarget?: string }[];
  pullRequest?: { emptySection?: string; optionalSections?: string[] };
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
