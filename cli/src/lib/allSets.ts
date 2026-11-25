import { machineFolders } from "./machineFolders.js";
import { scanMachine } from "./machineScan.js";
import { dedupeClones, readPreferredClones } from "./repoPicker.js";
import { readSeenStories } from "./storyCache.js";
import type { Ctx } from "./context.js";

/** `aihub worktree list --all`: every set and every repository clone on this PC (the folders to look in, a cached scan). */
export function listEverything(ctx: Ctx, o: { json?: boolean; refresh?: boolean }): string {
  const folders = machineFolders(ctx.env, ctx.cwd);
  const scan = scanMachine(ctx.env, folders, { refresh: o.refresh, now: (ctx.now ?? Date.now)() });
  const stories = readSeenStories(ctx.env);
  // one repository is one entry however often it is cloned (the same rule as `aihub repos local`)
  const repos = dedupeClones(scan.repos.map((r) => ({ name: r.name, path: r.path, branch: r.branch, remoteUrl: r.remote })), readPreferredClones(ctx.env));
  const sets = scan.sets.map((s) => ({ id: s.id, folder: s.folder, story: s.story, ...(s.story && stories[s.story] ? { title: stories[s.story].title, ...(stories[s.story].state ? { state: stories[s.story].state } : {}) } : {}), ...(s.group ? { group: s.group } : {}), branch: s.branch, repos: s.repos }));
  if (o.json) return JSON.stringify({ lookIn: folders, ...(scan.truncated ? { truncated: true } : {}), ...(scan.skippedRemote?.length ? { skippedRemote: scan.skippedRemote } : {}), sets, repositories: repos.map(({ name, path, branch, remoteUrl, otherClones }) => ({ name, path, branch, ...(remoteUrl ? { remote: remoteUrl } : {}), ...(otherClones?.length ? { otherClones } : {}) })) });
  const lines = [`looking in: ${folders.join(", ") || "(nothing known yet: aihub worktree look-in <folder>)"}`, "", `worktree sets (${sets.length}):`];
  for (const s of sets) lines.push(`  ${s.story ? `story ${s.story}${"title" in s && s.title ? ` ${s.title}` : ""}` : s.group ?? s.branch}  '${s.branch}'  ${s.folder}`, ...s.repos.map((r) => `    ${r.name}${r.branch !== s.branch ? ` on '${r.branch}'` : ""}${r.exists ? "" : " (folder missing)"}`));
  lines.push("", `repositories (${repos.length}):`, ...repos.map((r) => `  ${r.name}  ${r.branch || "(detached)"}  ${r.path}${r.otherClones?.length ? `  +${r.otherClones.length} more` : ""}`));
  if (scan.truncated) lines.push("", "Not everything was scanned (too many folders): narrow the folders to look in: aihub worktree look-in");
  if (scan.skippedRemote?.length) lines.push("", `left out (OneDrive or network; add them to look-in to scan them): ${scan.skippedRemote.join(", ")}`);
  return lines.join("\n");
}
