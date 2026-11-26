import { cloneRepoName, looseName } from "../../../cli/src/lib/findClone";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** The repository named in the CLI's "can't find the clone of '<repo>'" failure; undefined for any other failure. No vscode here. */
export function missingCloneRepo(e: unknown): string | undefined {
  const text = e instanceof Error ? e.message : String(e);
  return /can't find the clone of '([^']+)'/.exec(text)?.[1];
}

/**
 * Is `dir` a folder the user may choose as the clone of `repo`? A git clone whose remote points to that repository (names compared loosely:
 * "Repo X" = repo_x). Returns undefined when it is, else one sentence saying why not. Reads files only.
 */
export function whyNotTheClone(dir: string, repo: string): string | undefined {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    /* not there */
  }
  if (!isDir || !existsSync(join(dir, ".git"))) return `That folder is not a git clone, so it cannot be the clone of ${repo}.`;
  const remote = cloneRepoName(dir);
  if (!remote) return `That clone has no remote, so I cannot tell that it belongs to ${repo}.`;
  if (looseName(remote) !== looseName(repo)) return `That clone belongs to ${remote}, not to ${repo}.`;
  return undefined;
}

/** The failure text of the first repository of an open result whose clone could not be found (the CLI reports it per repository, not as an error); undefined when there is none. */
export function lostCloneIn(repos: { ok: boolean; note: string }[]): string | undefined {
  return repos.find((r) => !r.ok && missingCloneRepo(r.note))?.note;
}
