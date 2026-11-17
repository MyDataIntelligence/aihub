import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, gitRaw } from "./git.js";
import { resolvePr } from "./pr.js";
import { shortBranch } from "./ado.js";

export interface ChangesOpts {
  pr?: string;
  sinceIteration?: number;
  paths?: string[];
  page?: number;
  json?: boolean;
}

interface Iteration {
  id: number;
  sourceRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
}

export const PAGE_LINES = 300;

interface FileChange {
  status: string;
  path: string;
  added: number;
  deleted: number;
}

const short = (s: string) => s.slice(0, 7);

function has(root: string, sha: string): boolean {
  return gitRaw(root, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/** Diff of a pull request against its real target, without touching the user's checkout. */
export async function prChanges(ctx: Ctx, o: ChangesOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const pr = await resolvePr(ctx, client, root, o.pr);
  const id = pr.pullRequestId;
  const its = (await client.list<Iteration>(`${client.repoPath()}/pullrequests/${id}/iterations`)).sort((a, b) => a.id - b.id);
  const last = its[its.length - 1];
  const src = shortBranch(pr.sourceRefName);
  const tgt = shortBranch(pr.targetRefName);

  // Hidden refs under refs/aihub/: nothing visible in the user's branch list changes.
  const srcRef = `refs/aihub/pr/${id}/source`;
  const tgtRef = `refs/aihub/pr/${id}/target`;
  const gotSrc = gitRaw(root, ["fetch", "--quiet", "origin", `+refs/heads/${src}:${srcRef}`]).status === 0;
  const gotTgt = gitRaw(root, ["fetch", "--quiet", "origin", `+refs/heads/${tgt}:${tgtRef}`]).status === 0;

  const headSha = last?.sourceRefCommit?.commitId ?? pr.lastMergeSourceCommit?.commitId ?? (gotSrc ? git(root, ["rev-parse", srcRef]) : "");
  if (!headSha) throw new AihubError(`cannot determine the source commit of PR !${id}`);
  if (!has(root, headSha)) gitRaw(root, ["fetch", "--quiet", "origin", headSha]);
  if (!has(root, headSha)) throw new AihubError(`source commit ${short(headSha)} of PR !${id} is not available; fetch '${src}' first`);

  let base: string | undefined;
  let sinceNote = "";
  if (o.sinceIteration !== undefined) {
    const it = its.find((x) => x.id === o.sinceIteration);
    if (!it) throw new AihubError(`PR !${id} has no iteration ${o.sinceIteration} (it has 1..${last?.id ?? 0})`);
    base = it.sourceRefCommit?.commitId;
    if (base && !has(root, base)) gitRaw(root, ["fetch", "--quiet", "origin", base]);
    if (!base || !has(root, base)) throw new AihubError(`iteration ${o.sinceIteration} commit is no longer available (force push); use the full diff`);
    sinceNote = `, since iteration ${o.sinceIteration}`;
  } else {
    const common = last?.commonRefCommit?.commitId;
    const mb = gotTgt ? gitRaw(root, ["merge-base", tgtRef, headSha]).stdout.trim() : "";
    base = pr.status === "active" ? mb || common : common || mb;
    if (base && !has(root, base)) base = mb || undefined;
    if (!base) throw new AihubError(`cannot determine the merge base of '${src}' and '${tgt}'`);
  }

  const spec = (o.paths ?? []).filter(Boolean).map((p) => `:(glob)${p}`);
  const tail = spec.length ? ["--", ...spec] : [];
  const nameStatus = git(root, ["diff", "--no-color", "-M", "--name-status", base, headSha, ...tail]).split("\n").filter(Boolean);
  const numstat = git(root, ["diff", "--no-color", "-M", "--numstat", base, headSha, ...tail]).split("\n").filter(Boolean);
  const files: FileChange[] = nameStatus.map((l, i) => {
    const parts = l.split("\t");
    const [a, d] = (numstat[i] ?? "0\t0").split("\t");
    return { status: parts[0].charAt(0), path: parts.slice(1).join(" -> "), added: Number(a) || 0, deleted: Number(d) || 0 };
  });
  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);
  const diffLines = files.length ? git(root, ["diff", "--no-color", "-M", base, headSha, ...tail]).split("\n") : [];
  const pages = Math.max(1, Math.ceil(diffLines.length / PAGE_LINES));
  const page = o.page ?? 1;
  if (page < 1 || page > pages) throw new AihubError(`page ${page} does not exist; this diff has ${pages} page(s)`);
  const slice = diffLines.slice((page - 1) * PAGE_LINES, page * PAGE_LINES);

  const head = `PR !${id} ${src} -> ${tgt}  base ${short(base)}  head ${short(headSha)}  (iteration ${last?.id ?? "?"}${sinceNote})`;
  if (o.json) {
    return JSON.stringify({ id, source: src, target: tgt, base, head: headSha, iteration: last?.id, files, added, deleted, page, pages, diff: slice.join("\n") });
  }
  const out = [head, `${files.length} file(s) changed, +${added} -${deleted}${spec.length ? ` (paths: ${(o.paths ?? []).join(", ")})` : ""}`];
  for (const f of files) out.push(`${f.status}  +${f.added} -${f.deleted}  ${f.path}`);
  if (!files.length) out.push("no changes");
  else {
    out.push(`--- diff, page ${page}/${pages}${page < pages ? ` (next: --page ${page + 1})` : ""} ---`);
    out.push(...slice);
  }
  return out.join("\n");
}
