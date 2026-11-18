import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { tryGit } from "./gitx.js";
import { shortBranch } from "./ado.js";

interface RawRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
  isDisabled?: boolean;
}

export interface ProjectRepo {
  name: string;
  defaultBranch: string;
  remoteUrl: string;
  /** Local clone next to the current repository (or under --root), when there is one. */
  clone?: string;
}

async function projectRepos(ctx: Ctx, root?: string): Promise<{ repos: ProjectRepo[]; base: string; token?: string }> {
  const { root: here, client } = repoClient(ctx);
  const base = resolve(root ?? dirname(here));
  const raw = await client.get<{ value?: RawRepo[] }>("git/repositories");
  const repos = (raw.value ?? [])
    .filter((r) => !r.isDisabled)
    .map((r) => {
      const dir = join(base, r.name);
      return {
        name: r.name,
        defaultBranch: r.defaultBranch ? shortBranch(r.defaultBranch) : "",
        remoteUrl: (r.remoteUrl ?? "").replace(/^(https?:\/\/)[^@/]+@/, "$1"),
        clone: existsSync(join(dir, ".git")) ? dir : undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const pat = ctx.env.AIHUB_ADO_PAT;
  return { repos, base, token: pat ? Buffer.from(`:${pat}`).toString("base64") : undefined };
}

export async function reposList(ctx: Ctx, o: { filter?: string; root?: string; json?: boolean }): Promise<string> {
  const { repos } = await projectRepos(ctx, o.root);
  const f = o.filter?.toLowerCase();
  const shown = f ? repos.filter((r) => r.name.toLowerCase().includes(f)) : repos;
  if (o.json) return JSON.stringify(shown);
  if (!shown.length) return f ? `no repository matches '${o.filter}'` : "the project has no repositories";
  return [`${shown.length} repositor${shown.length === 1 ? "y" : "ies"} (cloned: next to this repository or under --root)`, ...shown.map((r) => `${r.name.padEnd(32)} ${r.defaultBranch.padEnd(12)} ${r.clone ? `cloned: ${r.clone}` : "not cloned"}`)].join("\n");
}

/** Clones the named repositories next to the current one; an existing folder is never touched. */
export async function reposClone(ctx: Ctx, o: { names: string[]; root?: string; json?: boolean }): Promise<string> {
  if (!o.names.length) throw new AihubError("aihub repos clone needs --name <repository>[,<repository>] (see 'aihub repos list')");
  const { repos, base, token } = await projectRepos(ctx, o.root);
  const out: { name: string; dir: string; status: string }[] = [];
  for (const n of o.names) {
    const r = repos.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!r) throw new AihubError(`repository '${n}' not found in the project (see 'aihub repos list')`);
    const dir = join(base, r.name);
    if (r.clone || existsSync(dir)) {
      out.push({ name: r.name, dir, status: "already there" });
      continue;
    }
    mkdirSync(base, { recursive: true }); // --root may not exist yet (git would fail with ENOENT on the missing cwd)
    const args = [...(token ? ["-c", `http.extraheader=Authorization: Basic ${token}`] : []), "clone", "--quiet", r.remoteUrl, dir];
    const res = tryGit(base, args);
    if (!res.ok) throw new AihubError(`git clone of '${r.name}' failed: ${res.err.split("\n")[0]}`);
    out.push({ name: r.name, dir, status: "cloned" });
  }
  return o.json ? JSON.stringify(out) : out.map((x) => `${x.name}: ${x.status} at ${x.dir}`).join("\n");
}
