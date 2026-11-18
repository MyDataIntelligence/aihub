import { basename, resolve } from "node:path";
import type { CommandFn } from "../router.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, originDefaultBranch, repoRoot, workItemFromBranch } from "./git.js";
import { ARTIFACT_EXCLUDES, mustGit, tryGit } from "./gitx.js";
import { linkPrs } from "./crossRepoOps.js";
import { resolveRepoDirs } from "./repos.js";
import { appendJournal } from "./journal.js";
import { findSet, type SetInfo } from "./setInfo.js";
import { getStatus, type Status } from "./status.js";
import { defaultTargetFor, loadTeam } from "./team.js";

/** `--all-repos` is understood by these commands only (`search --all-repos` means something else). */
export function wantsAllRepos(name: string, args: string[]): boolean {
  if (!args.includes("--all-repos")) return false;
  const sub = args.find((a) => !a.startsWith("--"));
  if (name === "commit" || name === "status") return true;
  if (name === "pr") return sub === "create" || sub === "update";
  if (name === "pipeline") return sub === "follow";
  return false;
}

/** The repositories to work on: the set when there is one, else the repositories of team.yaml that are checked out next to this one on the same branch. */
export function repoDirsFor(ctx: Ctx): { dirs: { name: string; dir: string }[]; set?: SetInfo; story?: number } {
  const set = findSet(ctx.cwd);
  if (set) return { dirs: set.repos.map((r) => ({ name: r.name, dir: r.path })), set, story: set.story };
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const branch = currentBranch(root);
  const names = (team.repositories ?? []).map((r) => r.name).filter((n): n is string => !!n);
  const found = names.length ? resolveRepoDirs(names, root, team).filter((d) => tryGit(d.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out === branch) : [];
  if (found.length < 2) {
    throw new AihubError("--all-repos works inside a worktree set (aihub worktree create --story N --repos a,b) or when the repositories of team.yaml are checked out next to each other on the same branch");
  }
  return { dirs: found, story: workItemFromBranch(branch) ?? undefined };
}

interface Row {
  repo: string;
  changed: string;
  pushed: string;
  pr: string;
  pipeline: string;
  result: string;
  failed: boolean;
  status?: Status;
}

const changedFiles = (dir: string): number => mustGit(dir, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]).split("\n").filter(Boolean).length;

function aheadOfTarget(dir: string, ctx: Ctx): number {
  const team = loadTeam(dir);
  const target = defaultTargetFor(team, basename(dir)) ?? (originDefaultBranch(dir) || "main");
  const n = Number(tryGit(dir, ["rev-list", "--count", `origin/${target}..HEAD`]).out);
  return Number.isFinite(n) ? n : 1;
}

function table(rows: Row[], withNext: boolean): string[] {
  const head = ["repo", "changed", "pushed", "PR", "pipeline", withNext ? "next step" : "result"];
  const body = rows.map((r) => [r.repo, r.changed, r.pushed, r.pr, r.pipeline, r.result]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)];
}

function rowOf(name: string, dir: string, s: Status | undefined, result: string, failed: boolean): Row {
  const n = (() => {
    try {
      return changedFiles(dir);
    } catch {
      return 0;
    }
  })();
  return {
    repo: name,
    changed: n ? `${n} file(s)` : "no",
    pushed: s ? (s.unpushed > 0 ? `${s.unpushed} ahead` : "yes") : "?",
    pr: s?.pr ? `!${s.pr.id} ${s.pr.status}${s.pr.draft ? " (draft)" : ""}` : "none",
    pipeline: s ? (s.checks === "none" ? "none" : s.checks) : "?",
    result,
    failed,
    status: s,
  };
}

/** Run one command in every repository of the set and print one table: skips repositories without changes, continues after an error. */
export async function runAllRepos(name: string, args: string[], ctx: Ctx, registry: Record<string, CommandFn>): Promise<void> {
  const { dirs, set, story } = repoDirsFor(ctx);
  const rest = args.filter((a) => a !== "--all-repos");
  const sub = name === "pr" || name === "pipeline" ? rest.find((x) => !x.startsWith("--")) : undefined;
  const rows: Row[] = [];
  for (const d of dirs) {
    const lines: string[] = [];
    const child: Ctx = { ...ctx, cwd: d.dir, out: (l) => lines.push(l), err: (l) => lines.push(l) };
    let result = "";
    let failed = false;
    try {
      if (name === "status") {
        result = "";
      } else if (name === "commit" && changedFiles(d.dir) === 0) {
        result = "skipped: nothing to commit";
      } else if (name === "pr" && sub === "create" && aheadOfTarget(d.dir, ctx) === 0) {
        result = "skipped: no commits ahead of the target";
      } else {
        await registry[name](rest, child);
        result = (lines.find((l) => l.trim()) ?? "ok").trim();
      }
    } catch (e) {
      failed = true;
      result = `failed: ${(e as Error).message}`;
    }
    let status: Status | undefined;
    try {
      status = await getStatus(child);
    } catch {
      /* the table still shows what git knows */
    }
    const row = rowOf(d.name, d.dir, status, name === "status" ? (status?.next ?? "") : result.slice(0, 110), failed);
    rows.push(row);
    // every repository keeps its own journal line (the router does not journal --all-repos itself)
    appendJournal(d.dir, name, rest, !failed, [row.result || (status?.next ?? "")], failed ? result : "", (ctx.now ?? Date.now)());
  }
  const short = (x: string) => (/^skipped|^failed/.test(x) ? x : x.replace(/ on \S+ and pushed/, " and pushed").split(": ")[0]).slice(0, 60);
  ctx.out(`${name}${sub ? ` ${sub}` : ""} --all-repos${set ? ` (set story-${set.story})` : ""}: ${rows.map((r) => `${r.repo} ${short(r.result) || "done"}`).join("; ")}`);
  for (const l of table(rows, name === "status")) ctx.out(l);
  if (name === "pr" && sub === "create" && story) {
    if (rows.filter((r) => r.status?.pr).length > 1) {
      try {
        const r = await linkPrs({ ...ctx, cwd: dirs[0].dir }, { story });
        ctx.out(`PRs cross-linked: ${r.results.map((x) => `${x.repo} !${x.pr}`).join(", ")}`);
      } catch (e) {
        ctx.out(`PRs not cross-linked: ${(e as Error).message}`);
      }
    }
  }
  const bad = rows.filter((r) => r.failed);
  if (bad.length) throw new AihubError(`${name}${sub ? ` ${sub}` : ""} failed in ${bad.map((r) => r.repo).join(", ")} (the other repositories were done; details: ${bad.map((r) => `${r.repo}: ${r.result}`).join("; ")})`);
}

/** A line for the end of a single-repository commit or pr create inside a worktree set: the other repositories are not forgotten. */
export function setHint(cwd: string, kind: "commit" | "pr create"): string {
  const set = findSet(cwd);
  if (!set || set.repos.length < 2) return "";
  const here = resolve(cwd);
  const others = set.repos.filter((r) => !here.toLowerCase().startsWith(resolve(r.path).toLowerCase()));
  const busy = kind === "commit" ? others.filter((r) => { try { return changedFiles(r.path) > 0; } catch { return false; } }) : others;
  if (!busy.length) return "";
  return kind === "commit"
    ? `note: set story-${set.story}: ${busy.map((r) => r.name).join(", ")} also ha${busy.length > 1 ? "ve" : "s"} uncommitted changes; aihub commit --all-repos does every repository at once`
    : `note: set story-${set.story} also has ${busy.map((r) => r.name).join(", ")}; aihub pr create --all-repos does every repository with commits and cross-links the PRs`;
}
