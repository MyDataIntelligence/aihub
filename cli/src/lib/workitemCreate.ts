import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { sectionsToFields } from "./story.js";
import { compose, DEFAULT_EMPTY, parseSections } from "./templates.js";
import { loadTeam, readUtf8 } from "./team.js";
import { typeLayout } from "./fieldLayout.js";
import { findTypeTemplate, resolveType } from "./workItemType.js";

export interface CreateWorkItemOpts {
  type?: string;
  title?: string;
  bodyFile?: string;
  parent?: number;
  json?: boolean;
  refreshTemplate?: boolean;
}

export async function createWorkItem(ctx: Ctx, o: CreateWorkItemOpts): Promise<string> {
  if (!o.title) throw new AihubError("aihub workitem create needs --title");
  if (!o.bodyFile) throw new AihubError("aihub workitem create needs --body-file <file.md>");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const type = resolveType(team, o.type);
  const wi = team.workItems ?? {};
  const empty = wi.emptySection || team.pullRequest?.emptySection || DEFAULT_EMPTY;
  const found = await findTypeTemplate(root, client, team, type, o.refreshTemplate);
  const composed = compose({ template: found.text, body: readUtf8(o.bodyFile), code: {}, emptyText: empty });
  // the text goes in the main field of the type: ReproSteps for a Bug that has no Description
  const layout = await typeLayout(root, client, type);
  const fields = sectionsToFields(team, parseSections(composed.text).sections, layout);
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
    ? JSON.stringify({ id: created.id, type, url, parent: o.parent, emptySections: empties, template: found.source })
    : `${type} ${created.id} created: ${url}${o.parent ? ` (child of ${o.parent})` : ""}${empties.length ? ` (${empty}: ${empties.join(", ")})` : ""}; template: ${found.source}`;
}
