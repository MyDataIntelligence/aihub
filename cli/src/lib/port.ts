import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchRef, getWorkItemTitle, type AdoClient, type PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { parseSources, resolveSources, type Source } from "./cherryPick.js";
import { crossRepoConfig, mapPaths, parsePathMap, resolveRepo, slug, storyPrs, type PathMapping, type RepoHandle } from "./crossRepo.js";
import { AihubError } from "./errors.js";
import { fetchBranch, git, gitRaw, originDefaultBranch, showFile, withTempWorktree } from "./git.js";
import { commitList } from "./pr.js";
import { compose, DEFAULT_EMPTY, resolveTemplate } from "./templates.js";
import { defaultTargetFor, loadTeam, readUtf8, type TeamConfig } from "./team.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---- patch rewriting ---------------------------------------------------------

export interface FilePatch {
  path: string;
  text: string;
}

const fromLatin1 = (s: string) => Buffer.from(s, "latin1").toString("utf8");
const toLatin1 = (s: string) => Buffer.from(s, "utf8").toString("latin1");

/** Split a `git diff --no-renames` into per-file chunks (text is byte-exact in latin1). */
export function splitPatch(raw: string): FilePatch[] {
  const out: FilePatch[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(raw); m; m = re.exec(raw)) starts.push(m.index);
  starts.forEach((s, i) => {
    const text = raw.slice(s, starts[i + 1] ?? raw.length);
    const head = text.slice(0, text.indexOf("\n")).slice("diff --git ".length);
    const path = fromLatin1(head.slice(2, 2 + (head.length - 5) / 2));
    out.push({ path, text });
  });
  return out;
}

/** Rewrite the paths in the header lines of one file chunk. */
export function rewritePatch(p: FilePatch, to: string): string {
  const lines = p.text.split("\n");
  const a = toLatin1(p.path);
  const b = toLatin1(to);
  let inHeader = true;
  return lines
    .map((l) => {
      if (!inHeader) return l;
      if (l.startsWith("@@") || l.startsWith("GIT binary patch") || l.startsWith("Binary files")) {
        inHeader = false;
        return l;
      }
      if (l === `diff --git a/${a} b/${a}`) return `diff --git a/${b} b/${b}`;
      if (l === `--- a/${a}`) return `--- a/${b}`;
      if (l === `+++ b/${a}`) return `+++ b/${b}`;
      return l;
    })
    .join("\n");
}

function rawDiff(root: string, sha: string): string {
  const parent = git(root, ["rev-parse", "--verify", "--quiet", `${sha}^1`], { allowFail: true }).trim() || EMPTY_TREE;
  const r = spawnSync("git", ["-c", "core.quotepath=false", "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", parent, sha], {
    cwd: root,
    encoding: "latin1",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) throw new AihubError(`git diff of ${sha.slice(0, 7)} failed: ${(r.stderr || "").split("\n")[0]}`);
  return r.stdout;
}

// ---- port --------------------------------------------------------------------

export interface PortOpts {
  fromRepo: string;
  from: string;
  toRepo: string;
  toBranch?: string;
  pathMaps?: string[];
  map?: string;
  strict?: boolean;
  pr?: boolean;
  bodyFile?: string;
  json?: boolean;
}

export interface PortResult {
  result: "ok" | "conflict" | "already-applied" | "nothing-to-port" | "failed" | "refused";
  detail: string;
  branch?: string;
  target: string;
  files: { from: string; to: string }[];
  unmapped: string[];
  pr?: { id: number; url: string };
}

export function resolveMaps(team: TeamConfig, o: Pick<PortOpts, "pathMaps" | "map">): PathMapping[] {
  const maps: PathMapping[] = [];
  if (o.map) {
    const named = crossRepoConfig(team).pathMaps?.[o.map];
    if (!named?.length) throw new AihubError(`path map '${o.map}' is not in team.yaml (crossRepo.pathMaps)`);
    maps.push(...named);
  }
  for (const s of o.pathMaps ?? []) maps.push(parsePathMap(s));
  return maps;
}

export const portBranchName = (label: string, fromRepo: string) => `port/${slug(label)}-from-${slug(fromRepo)}`;

/** Story sources become the story's merged PRs of repository A (a story may span several repositories). */
async function expandStories(base: AdoClient, repoA: string, sources: Source[]): Promise<Source[]> {
  const out: Source[] = [];
  for (const s of sources) {
    if (s.kind !== "story") {
      out.push(s);
      continue;
    }
    const prs = (await storyPrs(base, s.id)).filter((p) => p.repository?.name?.toLowerCase() === repoA.toLowerCase());
    if (!prs.length) throw new AihubError(`story ${s.id} has no linked pull requests in ${repoA}`);
    out.push(...prs.map((p) => ({ kind: "pr" as const, id: p.pullRequestId })));
  }
  return out;
}

export async function port(ctx: Ctx, o: PortOpts): Promise<PortResult> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const maps = resolveMaps(team, o);
  const a = resolveRepo(ctx, team, o.fromRepo);
  const b = resolveRepo(ctx, team, o.toRepo);
  try {
    if (a.root === b.root) throw new AihubError("--from-repo and --to-repo are the same repository; use aihub cherry-pick for branches");
    const target = o.toBranch ?? defaultTargetFor(team, b.name) ?? (originDefaultBranch(b.root) || "main");
    const sources = await expandStories(client, a.name, parseSources(o.from));
    const src = await resolveSources(a.client, a.root, sources);
    if (!src.commits.length) throw new AihubError("nothing to port: the source has no commits");
    const label = src.label;
    const res = await portInto(a, b, team, src.commits, label, target, maps, o);
    if (res.result === "ok" && o.pr) {
      const prIds = sources.filter((s): s is { kind: "pr"; id: number } => s.kind === "pr").map((s) => s.id);
      res.pr = await createPortPr(a, b, team, { label, target, branch: res.branch!, commits: src.commits, story: src.story, prIds, bodyFile: o.bodyFile, unmapped: res.unmapped });
    }
    return res;
  } finally {
    a.release();
    b.release();
  }
}

async function portInto(
  a: RepoHandle,
  b: RepoHandle,
  team: TeamConfig,
  commits: { sha: string; subject: string }[],
  label: string,
  target: string,
  maps: PathMapping[],
  o: PortOpts,
): Promise<PortResult> {
  const res: PortResult = { result: "ok", detail: "", target, files: [], unmapped: [] };
  const done = (r: Partial<PortResult>): PortResult => ({ ...res, ...r });
  if (!fetchBranch(b.root, target)) return done({ result: "failed", detail: `branch '${target}' not found on origin of ${b.name}` });
  const branch = portBranchName(label, a.name);
  const unmapped = new Set<string>();
  const files: { from: string; to: string }[] = [];
  const outcome = await withTempWorktree(b.root, `origin/${target}`, async (wt): Promise<PortResult> => {
    const start = git(wt, ["rev-parse", "HEAD"]);
    const tmp = mkdtempSync(join(tmpdir(), "aihub-port-"));
    try {
      let n = 0;
      let skipped = 0;
      for (const c of commits) {
        const chunks = splitPatch(rawDiff(a.root, c.sha));
        const m = mapPaths(chunks.map((x) => x.path), maps);
        m.unmapped.forEach((f) => unmapped.add(f));
        if (!m.mapped.length) continue;
        const to = new Map(m.mapped.map((x) => [x.from, x.to]));
        const patch = chunks.filter((x) => to.has(x.path)).map((x) => rewritePatch(x, to.get(x.path)!)).join("");
        const file = join(tmp, `${n++}.patch`);
        writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`, "latin1");
        if (gitRaw(wt, ["apply", "--check", "--reverse", file]).status === 0) {
          skipped++;
          continue;
        }
        const r = gitRaw(wt, ["apply", "--index", "--whitespace=nowarn", file]);
        if (r.status !== 0) {
          const bad = [...new Set([...r.stderr.matchAll(/^error: (?:patch failed: )?(.+?)(?::\d+|: [^\n]*)$/gm)].map((x) => x[1]))];
          const where = bad.length ? bad.join(", ") : m.mapped.map((x) => x.to).join(", ");
          return { ...res, result: "conflict", detail: `conflict in ${where} (${c.sha.slice(0, 7)}); nothing pushed`, unmapped: [...unmapped] };
        }
        files.push(...m.mapped.map((x) => ({ from: x.from, to: x.to })));
        const msg = `${c.subject || `Port ${label}`}\n\nPorted from ${a.name} ${c.sha.slice(0, 12)} (${label}).`;
        const cr = gitRaw(wt, ["commit", "-q", "-m", msg]);
        if (cr.status !== 0) return { ...res, result: "failed", detail: `commit failed: ${cr.stderr.split("\n")[0]}`, unmapped: [...unmapped] };
      }
      const un = [...unmapped];
      if (o.strict && un.length) return { ...res, result: "refused", detail: `${un.length} file(s) are outside the path mapping and --strict is set`, unmapped: un };
      if (git(wt, ["rev-parse", "HEAD"]) === start) {
        const detail = skipped ? "target already contains these changes" : "no file of the source is inside the path mapping";
        return { ...res, result: skipped ? "already-applied" : "nothing-to-port", detail, unmapped: un };
      }
      const push = gitRaw(wt, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
      if (push.status !== 0) return { ...res, result: "failed", detail: `push of '${branch}' rejected: ${push.stderr.split("\n").pop()}`, unmapped: un };
      return { ...res, result: "ok", branch, detail: `pushed ${branch} to ${b.name}`, files, unmapped: un };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  return outcome;
}

async function createPortPr(
  a: RepoHandle,
  b: RepoHandle,
  team: TeamConfig,
  i: { label: string; target: string; branch: string; commits: { sha: string; subject: string }[]; story?: number; prIds: number[]; bodyFile?: string; unmapped: string[] },
): Promise<{ id: number; url: string }> {
  const commits = i.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject }));
  const wiTitle = i.story ? await getWorkItemTitle(b.client, i.story) : undefined;
  const title = `Port ${i.label} from ${a.name}: ${commits[0].subject}`.slice(0, 200);
  const body = i.bodyFile ? readUtf8(i.bodyFile) : "";
  const tpl = resolveTemplate(i.target, { readRef: (br, p) => showFile(b.root, br, p), localRoot: b.root });
  const linked = i.prIds.map((id) => `- [${a.name} !${id}](${a.client.prUrl(id)})`).join("\n") || undefined;
  const code = { story: i.story ? `AB#${i.story}${wiTitle ? ` ${wiTitle}` : ""}` : undefined, commits: commitList(commits), linked };
  const unmappedNote = i.unmapped.length ? `Not ported (outside the path mapping): ${i.unmapped.join(", ")}` : "";
  let description: string;
  if (tpl) description = compose({ template: tpl.content, body: [body.trim(), unmappedNote].filter(Boolean).join("\n\n"), code, emptyText: team.pullRequest?.emptySection || DEFAULT_EMPTY }).text;
  else description = [body.trim(), `## Commits\n\n${code.commits}`, linked ? `## Related PRs\n\n${linked}` : "", unmappedNote].filter(Boolean).join("\n\n") + "\n";
  const created = await b.client.post<PullRequest>(`${b.client.repoPath()}/pullrequests`, {
    sourceRefName: branchRef(i.branch),
    targetRefName: branchRef(i.target),
    title,
    description,
    ...(i.story ? { workItemRefs: [{ id: String(i.story) }] } : {}),
  });
  return { id: created.pullRequestId, url: b.client.prUrl(created.pullRequestId) };
}

export function formatPort(r: PortResult, from: string, to: string): string[] {
  const lines = [`port ${from} -> ${to}/${r.target}: ${r.result}  ${r.detail}${r.pr ? `  PR !${r.pr.id} ${r.pr.url}` : ""}`];
  for (const f of r.files.slice(0, 50)) lines.push(`  ${f.from === f.to ? f.to : `${f.from} -> ${f.to}`}`);
  if (r.unmapped.length) {
    lines.push(`not ported (outside the path mapping, ${r.unmapped.length}):`);
    for (const f of r.unmapped) lines.push(`  ${f}`);
  }
  return lines;
}
