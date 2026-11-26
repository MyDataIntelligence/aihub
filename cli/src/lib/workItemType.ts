import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AdoClient } from "./ado.js";
import { AihubError } from "./errors.js";
import type { TeamConfig } from "./team.js";
import { findWorkItemTemplate, type FoundTemplate } from "./workItemTemplate.js";

// ---- templates of Bug and Task ---------------------------------------------

export const DEFAULT_TEMPLATES: Record<string, string> = {
  Bug: `## Description
<what is wrong, in one or two sentences>

## Steps to reproduce
1. <step>

## Expected result
<what should happen>

## Actual result
<what happens>
`,
  Task: `## Description
<what has to be done and why>

## Done when
- [ ] <observable result>
`,
};

/** The Bug / Task key of a type name (case-insensitive) among the built-ins and the keys of `workItems.templates`, if any. */
export function knownType(team: TeamConfig, type: string): string | undefined {
  const known = [...Object.keys(DEFAULT_TEMPLATES), ...Object.keys(team.workItems?.templates ?? {})];
  return known.find((k) => k.toLowerCase() === type.trim().toLowerCase());
}

/** Bug / Task, matched case-insensitively against the built-ins and the keys of `workItems.templates`. */
export function resolveType(team: TeamConfig, type: string | undefined): string {
  const t = (type ?? "").trim();
  if (!t) throw new AihubError("aihub workitem create needs --type Bug|Task");
  const hit = knownType(team, t);
  if (!hit) {
    const known = [...Object.keys(DEFAULT_TEMPLATES), ...Object.keys(team.workItems?.templates ?? {})];
    throw new AihubError(`--type '${t}' is not supported here (${known.join(", ")}); stories go through 'aihub story create'`);
  }
  return hit;
}

/** The template of a Bug or Task in the fixed order (team.yaml path, repository files, the team's Azure DevOps template, built-in). */
export async function findTypeTemplate(root: string, client: AdoClient | undefined, team: TeamConfig, type: string): Promise<FoundTemplate> {
  const configured = team.workItems?.templates?.[type];
  if (configured && !existsSync(join(root, configured))) throw new AihubError(`template for ${type} not found: ${configured} (workItems.templates.${type})`);
  return findWorkItemTemplate({ root, client, team, type, configured, fileName: `${type.toLowerCase()}-template.md`, builtIn: DEFAULT_TEMPLATES[type] ?? "## Description\n" });
}
