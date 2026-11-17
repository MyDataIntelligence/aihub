import type { AdoClient } from "./ado.js";
import { AihubError } from "./errors.js";
import type { TeamConfig } from "./team.js";

export interface WorkItem {
  id: number;
  type: string;
  title: string;
  state: string;
  relations: { rel: string; url: string; attributes?: Record<string, unknown> }[];
}

export async function getWorkItem(c: AdoClient, id: number): Promise<WorkItem> {
  const r = await c.get<{ id: number; fields?: Record<string, string>; relations?: WorkItem["relations"] }>(`wit/workitems/${id}`, {
    $expand: "relations",
  });
  return {
    id: r.id ?? id,
    type: r.fields?.["System.WorkItemType"] ?? "",
    title: r.fields?.["System.Title"] ?? "",
    state: r.fields?.["System.State"] ?? "",
    relations: r.relations ?? [],
  };
}

export async function setWorkItemState(c: AdoClient, id: number, state: string): Promise<void> {
  await c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "add", path: "/fields/System.State", value: state }]);
}

/** Adds an ArtifactLink unless the work item already has it. Returns true when added. */
export async function addArtifactLink(c: AdoClient, wi: WorkItem, url: string, name: string): Promise<boolean> {
  const norm = (u: string) => decodeURIComponent(u).toLowerCase();
  if (wi.relations.some((r) => r.rel === "ArtifactLink" && norm(r.url) === norm(url))) return false;
  await c.jsonPatch("PATCH", `wit/workitems/${wi.id}`, [
    { op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url, attributes: { name } } },
  ]);
  wi.relations.push({ rel: "ArtifactLink", url });
  return true;
}

export interface RepoInfo {
  id: string;
  projectId: string;
}

export async function repoInfo(c: AdoClient): Promise<RepoInfo> {
  const r = await c.get<{ id: string; project?: { id: string } }>(c.repoPath());
  if (!r.id || !r.project?.id) throw new AihubError("Azure DevOps did not return the repository id");
  return { id: r.id, projectId: r.project.id };
}

export const branchArtifact = (i: RepoInfo, branch: string) => `vstfs:///Git/Ref/${i.projectId}%2F${i.id}%2FGB${encodeURIComponent(branch)}`;
export const prArtifact = (i: RepoInfo, prId: number) => `vstfs:///Git/PullRequestId/${i.projectId}%2F${i.id}%2F${prId}`;

export function slugify(title: string, max = 40): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/g, "") || "story";
}

export function storyBranchName(team: TeamConfig, id: number, title: string): string {
  const pattern = (team.branches as { feature?: string } | undefined)?.feature || "feature/{storyId}-{slug}";
  return pattern.replace(/\{storyId\}/g, String(id)).replace(/\{slug\}/g, slugify(title));
}

export interface StoryStates {
  active: string;
  finished: string;
}

export function storyStates(team: TeamConfig): StoryStates {
  const s = ((team.workItems as { states?: Partial<StoryStates> } | undefined)?.states ?? {}) as Partial<StoryStates>;
  return { active: s.active || "Active", finished: s.finished || "Done" };
}

export function isProtected(team: TeamConfig, branch: string): boolean {
  const pats = ((team.branches as { protected?: string[] } | undefined)?.protected ?? []).concat(["main", "master", "develop", "staging", "release/*"]);
  return pats.some((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(branch));
}
