import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The repository browser: the aihub.bar.browse* commands. Each one is one `aihub browse ...` process and answers with
 * the CLI's JSON, or with `{ error: { kind, message } }` (never a popup: the caller shows it). The CLI prints its own
 * `{"error":{kind,message}}` on a failure; the kinds that stay true for a while (not signed in, no access, no Code Search,
 * CLI missing or too old) are remembered 5 minutes per command, so a click does not wait on a call that cannot work.
 * Two identical reads at the same moment share one process. Nothing runs at activation, nothing polls.
 * The JSON shapes are in docs/cli-json.md ("Repository browser").
 */

export type BrowseErrorKind =
  | "signedOut"
  | "noAccess"
  | "notFound"
  | "searchUnavailable"
  | "protectedBranch"
  | "branchExists"
  | "offline"
  | "badInput"
  | "failed"
  | "cliMissing"
  | "cliTooOld";

export interface BrowseError {
  error: { kind: BrowseErrorKind; message: string };
}

export const BROWSE_UPDATE_COMMAND = "npm i -g @ferronhooi/aihub@next";
const KINDS: BrowseErrorKind[] = ["signedOut", "noAccess", "notFound", "searchUnavailable", "protectedBranch", "branchExists", "offline", "badInput", "failed"];
const LASTING: BrowseErrorKind[] = ["signedOut", "noAccess", "searchUnavailable", "cliMissing", "cliTooOld"];

/** The CLI's own error JSON inside a failure text (stderr and stdout are joined), or a kind from the words. */
export function browseErrorOf(e: unknown): BrowseError {
  const err = e as { message?: string; kind?: string };
  const raw = String(err?.message ?? e).trim();
  const at = raw.lastIndexOf('{"error":');
  if (at >= 0) {
    try {
      const j = JSON.parse(raw.slice(at)) as BrowseError;
      if (j?.error && KINDS.includes(j.error.kind)) return { error: { kind: j.error.kind, message: j.error.message } };
    } catch {
      /* not the CLI's JSON: classify the words */
    }
  }
  if (err?.kind === "missing") return { error: { kind: "cliMissing", message: raw } };
  if (err?.kind === "old" || /unknown command 'browse'|usage: aihub browse/i.test(raw))
    return { error: { kind: "cliTooOld", message: `This needs a newer aihub CLI with the repository browser. Update it with: ${BROWSE_UPDATE_COMMAND}` } };
  if (/not signed in|az login|AIHUB_ADO_PAT/i.test(raw)) return { error: { kind: "signedOut", message: "Not signed in to Azure DevOps: run az login (or set AIHUB_ADO_PAT)." } };
  return { error: { kind: "failed", message: raw.replace(/^aihub:\s*/, "") } };
}

export const REMEMBER_FAILURE_MS = 5 * 60_000;

/** Remembers the lasting failures per key and shares a read that is still running. */
export class BrowseMemo {
  private failed = new Map<string, { at: number; value: BrowseError }>();
  private running = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  async read<T>(key: string, failKey: string, work: () => Promise<T>): Promise<T | BrowseError> {
    const f = this.failed.get(failKey);
    if (f && this.now() - f.at < REMEMBER_FAILURE_MS) return f.value;
    const busy = this.running.get(key);
    if (busy) return busy as Promise<T | BrowseError>;
    const p = (async () => {
      try {
        const v = await work();
        this.failed.delete(failKey);
        return v;
      } catch (e) {
        const out = browseErrorOf(e);
        if (LASTING.includes(out.error.kind)) this.failed.set(failKey, { at: this.now(), value: out });
        return out;
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }

  forget(): void {
    this.failed.clear();
  }
}

// ---- arguments ---------------------------------------------------------------------------------------------------

export interface Common {
  /** default: the organisation of this window's repository, else the last one used */
  org?: string;
  /** skip the CLI's cache (Refresh, Retry) */
  refresh?: boolean;
}
export interface RepoArg extends Common {
  project: string;
  repo: string;
  /** a branch name, `tag:<name>` or `commit:<sha>`; default: the default branch */
  ref?: string;
}
export interface ProjectArg extends Common {
  project: string;
  days?: number;
}
export interface ItemsArg extends RepoArg {
  path?: string;
  lastCommit?: boolean;
}
export interface FileArg extends RepoArg {
  path: string;
  maxBytes?: number;
}
export interface BranchesArg extends RepoArg {
  filter?: string;
  top?: number;
}
export interface HistoryArg extends RepoArg {
  path?: string;
  top?: number;
  skip?: number;
}
export interface DiffArg extends Common {
  project: string;
  repo: string;
  commit: string;
  path: string;
}
export interface FindArg extends Common {
  query: string;
  top?: number;
  /** favourites, `project/repo`: searched by the fallback when there is no Code Search */
  repos?: string[];
}
export interface SearchArg extends Common {
  text: string;
  project?: string;
  repo?: string;
  path?: string;
  ext?: string[];
  top?: number;
}
export interface PushArg extends Common {
  project: string;
  repo: string;
  path: string;
  /** ref.commit of the browseFile answer the edit started from */
  baseCommit: string;
  /** the branch the file was read on */
  baseBranch: string;
  content: string;
  branch: string;
  message: string;
  pr?: boolean;
  target?: string;
  story?: number;
  prTitle?: string;
  draft?: boolean;
  /** "Rebase my change" after a conflict */
  rebase?: boolean;
}
export interface PrArg extends Common {
  project: string;
  repo: string;
  branch: string;
  /** default: the default branch */
  target?: string;
  story?: number;
  prTitle?: string;
  draft?: boolean;
}
export interface SuggestArg {
  story?: number;
  path: string;
  title?: string;
}

const posInt = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : typeof n === "string" && /^\d+$/.test(n) && Number(n) > 0 ? Number(n) : undefined);
const s = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function common(a: Common | undefined, out: string[]): string[] {
  if (s(a?.org)) out.push("--org", a!.org!);
  if (a?.refresh) out.push("--refresh");
  return out;
}

function repoFlags(a: RepoArg | DiffArg, out: string[]): string[] {
  if (!s(a?.project) || !s(a?.repo)) throw new Error("a project and a repository are needed ({ project, repo })");
  out.push("--project", a.project, "--repo", a.repo);
  if ("ref" in a && s(a.ref)) out.push("--ref", a.ref);
  return out;
}

const opt = (out: string[], flag: string, v: unknown) => {
  if (s(v)) out.push(flag, v);
  else if (typeof v === "number" && posInt(v)) out.push(flag, String(v));
  return out;
};

/** The `aihub browse ...` arguments of each command; throws on a missing required argument (the caller turns it into badInput). */
export const browseArgs = {
  projects: (a: Common = {}) => common(a, ["browse", "projects"]),
  project: (a: ProjectArg) => {
    if (!s(a?.project)) throw new Error("a project is needed ({ project })");
    return common(a, opt(["browse", "project", "--project", a.project], "--days", a.days));
  },
  repo: (a: RepoArg) => common(a, repoFlags(a, ["browse", "repo"])),
  items: (a: ItemsArg) => {
    const out = opt(repoFlags(a, ["browse", "items"]), "--path", a.path);
    if (a.lastCommit) out.push("--last-commit");
    return common(a, out);
  },
  file: (a: FileArg) => {
    if (!s(a?.path)) throw new Error("a file path is needed ({ path })");
    return common(a, opt(opt(repoFlags(a, ["browse", "file"]), "--path", a.path), "--max-bytes", a.maxBytes));
  },
  branches: (a: BranchesArg) => common(a, opt(opt(repoFlags(a, ["browse", "branches"]), "--filter", a.filter), "--top", a.top)),
  history: (a: HistoryArg) => {
    const out = opt(opt(repoFlags(a, ["browse", "history"]), "--path", a.path), "--top", a.top);
    if (posInt(a.skip)) out.push("--skip", String(a.skip));
    return common(a, out);
  },
  diff: (a: DiffArg) => {
    if (!s(a?.commit) || !s(a?.path)) throw new Error("a commit and a path are needed ({ commit, path })");
    return common(a, repoFlags(a, ["browse", "diff", "--commit", a.commit, "--path", a.path]));
  },
  blame: (a: FileArg) => {
    if (!s(a?.path)) throw new Error("a file path is needed ({ path })");
    return common(a, repoFlags(a, ["browse", "blame", "--path", a.path]));
  },
  find: (a: FindArg) => {
    if (!s(a?.query)) throw new Error("a file name is needed ({ query })");
    const out = opt(["browse", "find", "--query", a.query], "--top", a.top);
    if (a.repos?.length) out.push("--repos", a.repos.join(","));
    return common(a, out);
  },
  search: (a: SearchArg) => {
    if (!s(a?.text)) throw new Error("a search text is needed ({ text })");
    const out = opt(opt(opt(opt(["browse", "search", "--text", a.text], "--project", a.project), "--repo", a.repo), "--path", a.path), "--top", a.top);
    if (a.ext?.length) out.push("--ext", a.ext.join(","));
    return common(a, out);
  },
  createPr: (a: PrArg) => {
    if (!s(a?.branch)) throw new Error("a branch is needed ({ branch })");
    const out = opt(opt(opt(repoFlags(a as never, ["browse", "pr", "--branch", a.branch]), "--target", a.target), "--story", a.story), "--pr-title", a.prTitle);
    if (a.draft) out.push("--draft");
    return common({ org: a.org }, out);
  },
  suggestBranch: (a: SuggestArg) => opt(opt(opt(["browse", "suggest-branch"], "--story", a?.story), "--path", a?.path), "--title", a?.title),
};

/** The content and the message go in private files (an edit can be long, and never shows in the process list); removed after. */
export function pushFiles(a: PushArg): { args: string[]; dir: string } {
  for (const k of ["project", "repo", "path", "baseCommit", "baseBranch", "branch", "message"] as const) if (!s(a?.[k])) throw new Error(`browsePush needs ${k}`);
  if (typeof a.content !== "string") throw new Error("browsePush needs content");
  const dir = mkdtempSync(join(tmpdir(), "aihub-push-"));
  const content = join(dir, "content");
  const message = join(dir, "message.txt");
  writeFileSync(content, a.content, { encoding: "utf8", mode: 0o600 });
  writeFileSync(message, a.message, { encoding: "utf8", mode: 0o600 });
  const args = ["browse", "push", "--project", a.project, "--repo", a.repo, "--path", a.path, "--base-commit", a.baseCommit, "--base-branch", a.baseBranch, "--content-file", content, "--branch", a.branch, "--message-file", message];
  if (a.pr) {
    args.push("--pr");
    opt(args, "--target", a.target);
    opt(args, "--story", a.story);
    opt(args, "--pr-title", a.prTitle);
    if (a.draft) args.push("--draft");
  }
  if (a.rebase) args.push("--rebase");
  return { args: common({ org: a.org }, args), dir };
}

export function removePushFiles(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp folder is cleaned by the OS */
  }
}

/** The failure-memory scope of a call: per organisation and repository (or the whole organisation). */
export function scopeOf(a: { org?: string; project?: string; repo?: string } | undefined, what: string): string {
  return [what, a?.org ?? "", a?.project ?? "", a?.repo ?? ""].join("|").toLowerCase();
}
