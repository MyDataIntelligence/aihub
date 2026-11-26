import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gitDirFor, headBranchOf } from "./machineScan.js";
import { readJsonText, readSetFile, repoBranch, setRepoBranchInPlace, writeAtomic, type SetMeta } from "./setFile.js";
import { join } from "node:path";

/**
 * The folder name in the Explorer is the branch the repository is really on: "<repo> (<branch>)", also when the branch
 * was changed outside aihub (`git switch` in a terminal, by an agent, in the branch menu). Reads and writes files only
 * (no git process, no timer): the extension calls it when the HEAD of a repository of the open set changed.
 */
export const folderLabel = (repo: string, head: string): string => `${repo} (${head})`;

/** What HEAD says: the branch, or for a detached HEAD the short commit hash. */
export function headOf(repoPath: string): { branch?: string; detached?: string } {
  const branch = headBranchOf(repoPath);
  if (branch) return { branch };
  const gitDir = gitDirFor(repoPath);
  try {
    const hash = gitDir ? /^[0-9a-f]{7,64}/i.exec(readFileSync(join(gitDir, "HEAD"), "utf8").trim())?.[0] : undefined;
    return hash ? { detached: hash.slice(0, 7) } : {};
  } catch {
    return {};
  }
}

export interface SyncResult {
  /** the folder name (and the aihub.set row) in the workspace file was changed */
  workspace: boolean;
  /** repos[].branch in the set file was changed */
  setFile: boolean;
}

/**
 * Brings the workspace file and the set file in line with the real HEAD of `repoPath`. Writes only a value that really
 * differs (one atomic write per file, none when they already agree); a detached HEAD only changes the folder name to the
 * short hash and never the set file; a workspace file that is not plain JSON (hand-edited, with comments) is left alone.
 */
export function syncRepoName(o: { setFolder: string; workspaceFile?: string; repoPath: string }): SyncResult {
  const res: SyncResult = { workspace: false, setFile: false };
  const head = headOf(o.repoPath);
  const shown = head.branch ?? head.detached;
  if (!shown) return res;
  const file = readSetFile(o.setFolder);
  const metas: SetMeta[] = file ? [file.top, ...(file.top.others ?? [])] : [];
  const meta = metas.find((m) => m.repos.some((r) => samePlace(r.path, o.repoPath)));
  const entry = meta?.repos.find((r) => samePlace(r.path, o.repoPath));
  const name = entry?.name ?? o.repoPath.split(/[\\/]/).pop() ?? "";
  if (file && meta && entry && head.branch && repoBranch(meta, entry) !== head.branch) {
    // only this repository's branch inside its own set: the other sets of the folder keep their place
    res.setFile = setRepoBranchInPlace(o.setFolder, o.repoPath, head.branch);
  }
  const ws = o.workspaceFile ?? meta?.workspace;
  if (ws && existsSync(ws)) {
    try {
      const j = JSON.parse(readJsonText(ws)) as { folders?: { name?: string; path: string }[]; settings?: { "aihub.set"?: { repos?: { name: string; branch: string }[] } } };
      const base = dirname(ws);
      const f = (j.folders ?? []).find((x) => samePlace(resolve(base, x.path), o.repoPath));
      const label = folderLabel(name, shown);
      const row = j.settings?.["aihub.set"]?.repos?.find((x) => x.name === name);
      const rowChanged = !!row && !!head.branch && row.branch !== head.branch;
      if (f && (f.name !== label || rowChanged)) {
        f.name = label;
        if (row && head.branch) row.branch = head.branch;
        writeAtomic(ws, JSON.stringify(j, null, 2));
        res.workspace = true;
      }
    } catch {
      /* a hand-edited workspace file (with comments) is left alone */
    }
  }
  return res;
}

const samePlace = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, "").toLowerCase() === resolve(b).replace(/[\\/]+$/, "").toLowerCase();
