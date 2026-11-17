import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sh, tmp, write, type Route } from "./helpers.js";

export const ORG = "https://dev.azure.com/ferron-org/test-project";

/** A clone named `name` in `parent`, origin = Azure DevOps URL rewritten to a local bare repository. */
export function makeNamedRepo(parent: string, name: string): { dir: string; bare: string } {
  const bare = join(parent, "_remotes", `${name}.git`);
  const dir = join(parent, name);
  mkdirSync(bare, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const url = `${ORG}/_git/${name}`;
  sh(bare, ["init", "--bare", "-b", "main"]);
  sh(dir, ["init", "-b", "main"]);
  sh(dir, ["config", "remote.origin.url", url]);
  sh(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  sh(dir, ["config", `url.${bare.replace(/\\/g, "/")}.insteadOf`, url]);
  write(dir, "README.md", `${name}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "initial"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["fetch", "origin"]);
  sh(dir, ["remote", "set-head", "origin", "main"]);
  return { dir, bare };
}

export const newParent = (): string => tmp("aihub-parity-");

export interface WorkItemState {
  title?: string;
  state?: string;
  relations?: { rel: string; url: string }[];
}

/** Routes for one work item plus repository info; records the JSON patches. */
export function storyRoutes(id: number, wi: WorkItemState, patches: { ops: any[]; contentType: string }[] = []): Route[] {
  return [
    {
      match: new RegExp(`/_apis/wit/workitems/${id}\\?`),
      respond: () => ({
        body: {
          id,
          fields: { "System.Title": wi.title ?? "Zoekfunctie bouwen", "System.State": wi.state ?? "New", "System.WorkItemType": "User Story" },
          relations: wi.relations ?? [],
        },
      }),
    },
    {
      method: "PATCH",
      match: new RegExp(`/_apis/wit/workitems/${id}\\?`),
      respond: (c) => {
        patches.push({ ops: c.body, contentType: c.headers["Content-Type"] });
        return { body: { id } };
      },
    },
    {
      match: /_apis\/git\/repositories\/([^/?]+)\?/,
      respond: (c) => ({ body: { id: `repo-${/repositories\/([^/?]+)\?/.exec(c.url)![1]}`, project: { id: "proj-1" }, defaultBranch: "refs/heads/main" } }),
    },
  ];
}
