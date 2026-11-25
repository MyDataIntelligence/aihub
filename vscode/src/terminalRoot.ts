// Where a new terminal opens in a multi-root workspace; free of the vscode module so it is unit-testable.
// The same rule (same function, same tests) lives in the PyCharm Git extension (extensions repo,
// vscode/pycharm-git-vscode/src/terminal/rootModel.ts), which points new terminals there; keep the two copies of
// terminalRoot equal (the cwd setting itself is written by PyCharm Git only).
import * as path from "path";

/** The files that mark the folder of a worktree set: Worktree Maker / AI Context Hub, and `aihub worktree`. */
export const SET_FILES = [".worktree-set.json", ".aihub-set.json"] as const;

export interface RootInput {
  /** Absolute paths of the workspace folders, in workspace order. */
  folders: readonly string[];
  /** The .code-workspace file, when the workspace has one on disk. */
  workspaceFile?: string;
  /** The file in the active editor, if any. */
  activeFile?: string;
  platform: NodeJS.Platform;
  home: string;
  /** True when `dir` holds a set file (SET_FILES); a few stat calls by the caller, no process. */
  isSetFolder?: (dir: string) => boolean;
}

/**
 * PyCharm opens the terminal in the project root. With several workspace folders that is, in this order:
 * 1. a worktree set: the set folder (the folder of the .code-workspace file when it holds a set file, else the one set
 *    folder the workspace folders lie in). A repository of the set that lies elsewhere (a reused clone) does not move it.
 * 2. the folder of the .code-workspace file when every folder lies below it;
 * 3. the common parent of the folders, but never above the folder of the .code-workspace file;
 * 4. the folder of the active file, else the first folder.
 * A drive root, the home folder or a folder above home is never a root. Undefined with fewer than two folders (VS Code
 * asks nothing then).
 */
export function terminalRoot(input: RootInput): string | undefined {
  if (input.folders.length < 2) return undefined;
  const p = input.platform === "win32" ? path.win32 : path.posix;
  const norm = (x: string) => {
    const n = p.normalize(x);
    return n.length > p.parse(n).root.length ? n.replace(/[\\/]+$/, "") : n;
  };
  const key = (x: string) => (input.platform === "win32" ? norm(x).toLowerCase() : norm(x));
  const contains = (parent: string, child: string) => key(child) === key(parent) || key(child).startsWith(key(parent).replace(/[\\/]+$/, "") + p.sep);
  const home = norm(input.home);
  const usable = (dir: string) => p.parse(norm(dir)).root !== norm(dir) && !contains(dir, home);
  const folders = input.folders.map(norm);
  const wsDir = input.workspaceFile ? p.dirname(norm(input.workspaceFile)) : undefined;

  const set = setFolder(folders, wsDir, input.isSetFolder, p, key);
  if (set && usable(set)) return set;

  if (wsDir && usable(wsDir) && folders.every((f) => contains(wsDir, f))) return wsDir;

  let common = folders[0];
  while (!folders.every((f) => contains(common, f))) {
    const up = p.dirname(common);
    if (up === common) break;
    common = up;
  }
  if (folders.every((f) => contains(common, f))) {
    // never higher than the folder of the workspace file: above it lie the user"s other clones
    if (wsDir && key(common) !== key(wsDir) && contains(common, wsDir)) common = wsDir;
    if (usable(common)) return common;
  }

  const active = input.activeFile ? folders.filter((f) => contains(f, input.activeFile!)).sort((a, b) => b.length - a.length)[0] : undefined;
  return active ?? folders[0];
}

/** The set folder: the workspace file"s folder when it is one, else the single set folder that holds a workspace folder. */
function setFolder(
  folders: string[],
  wsDir: string | undefined,
  isSetFolder: ((dir: string) => boolean) | undefined,
  p: typeof path.win32,
  key: (x: string) => string,
): string | undefined {
  if (!isSetFolder) return undefined;
  if (wsDir && isSetFolder(wsDir)) return wsDir;
  const found = new Map<string, string>();
  for (const f of folders) {
    const parent = p.dirname(f);
    if (parent !== f && isSetFolder(parent)) found.set(key(parent), parent);
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}
