import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "./gitEnv.js";
import { spawnSync } from "./proc.js";

/**
 * The uncommitted work of a worktree as a patch (tracked changes and untracked files, binary safe), made with a
 * temporary index: the user's own index (what is staged) and files are not touched, so an action that stops after
 * the backup leaves the worktree exactly as it was. The bytes are kept as git wrote them (CRLF files stay applicable).
 */
export function patchOfWork(worktree: string): { ok: true; patch: Buffer } | { ok: false; error: string } {
  const dir = mkdtempSync(join(tmpdir(), "aihub-index-"));
  const env = gitEnvironment(process.env, { GIT_INDEX_FILE: join(dir, "index") });
  try {
    for (const args of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const r = spawnSync("git", args, { cwd: worktree, env, maxBuffer: 64 * 1024 * 1024 });
      if (r.error || r.status !== 0) return { ok: false, error: (r.error?.message ?? String(r.stderr ?? "")).trim().split("\n")[0] };
    }
    const d = spawnSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: worktree, env, maxBuffer: 1024 * 1024 * 1024 });
    if (d.error || d.status !== 0) return { ok: false, error: (d.error?.message ?? String(d.stderr ?? "")).trim().split("\n")[0] };
    return { ok: true, patch: d.stdout as Buffer };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
