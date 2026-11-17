import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { sectionsToFields } from "./story.js";
import { compose, DEFAULT_EMPTY, parseSections } from "./templates.js";
import { loadTeam, readUtf8, type TeamConfig } from "./team.js";

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

const REPRO_FIELD = "Microsoft.VSTS.TCM.ReproSteps";

/** Bug / Task, matched case-insensitively against the built-ins and the keys of `workItems.templates`. */
export function resolveType(team: TeamConfig, type: string | undefined): string {
  const t = (type ?? "").trim();
  if (!t) throw new AihubError("aihub workitem create needs --type Bug|Task");
  const known = [...Object.keys(DEFAULT_TEMPLATES), ...Object.keys(team.workItems?.templates ?? {})];
  const hit = known.find((k) => k.toLowerCase() === t.toLowerCase());
  if (!hit) throw new AihubError(`--type '${t}' is not supported here (${known.join(", ")}); stories go through 'aihub story create'`);
  return hit;
}

export function loadWorkItemTemplate(root: string, team: TeamConfig, type: string): string {
  const configured = team.workItems?.templates?.[type];
  const candidates = [configured, `skills/_shared/assets/${type.toLowerCase()}-template.md`].filter(Boolean) as string[];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return readUtf8(p);
  }
  if (configured) throw new AihubError(`template for ${type} not found: ${configured} (workItems.templates.${type})`);
  return DEFAULT_TEMPLATES[type] ?? "## Description\n";
}

export interface CreateWorkItemOpts {
  type?: string;
  title?: string;
  bodyFile?: string;
  parent?: number;
  json?: boolean;
}

export async function createWorkItem(ctx: Ctx, o: CreateWorkItemOpts): Promise<string> {
  if (!o.title) throw new AihubError("aihub workitem create needs --title");
  if (!o.bodyFile) throw new AihubError("aihub workitem create needs --body-file <file.md>");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const type = resolveType(team, o.type);
  const wi = team.workItems ?? {};
  const empty = wi.emptySection || team.pullRequest?.emptySection || DEFAULT_EMPTY;
  const composed = compose({ template: loadWorkItemTemplate(root, team, type), body: readUtf8(o.bodyFile), code: {}, emptyText: empty });
  // A Bug keeps its repro steps in the repro field unless the team maps the heading elsewhere.
  const mapped: TeamConfig = {
    ...team,
    workItems: { ...wi, sectionFields: { ...(type === "Bug" ? { "Steps to reproduce": REPRO_FIELD, "Repro steps": REPRO_FIELD } : {}), ...(wi.sectionFields ?? {}) } },
  };
  const fields = sectionsToFields(mapped, parseSections(composed.text).sections);
  const ops: unknown[] = [{ op: "add", path: "/fields/System.Title", value: o.title }];
  for (const [f, v] of Object.entries(fields)) ops.push({ op: "add", path: `/fields/${f}`, value: v });
  if (wi.areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: wi.areaPath });
  if (wi.iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: wi.iterationPath });
  if (wi.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: wi.tags.join("; ") });
  if (o.parent) {
    ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${client.remote.orgUrl}/_apis/wit/workItems/${o.parent}` } });
  }
  const created = await client.jsonPatch<{ id: number }>("POST", `wit/workitems/$${encodeURIComponent(type)}`, ops);
  const url = client.workItemUrl(created.id);
  const empties = composed.filled.filter((f) => f.by === "empty").map((f) => f.heading);
  return o.json
    ? JSON.stringify({ id: created.id, type, url, parent: o.parent, emptySections: empties })
    : `${type} ${created.id} created: ${url}${o.parent ? ` (child of ${o.parent})` : ""}${empties.length ? ` (${empty}: ${empties.join(", ")})` : ""}`;
}
