import { machineFolders } from "./machineFolders.js";
import { scanMachine } from "./machineScan.js";
import { readSeenStories } from "./storyCache.js";
import type { Ctx } from "./context.js";

/** `aihub worktree list --all`: every set and every repository clone on this PC (the folders to look in, a cached scan). */
export function listEverything(ctx: Ctx, o: { json?: boolean; refresh?: boolean }): string {
  const folders = machineFolders(ctx.env, ctx.cwd);
  const scan = scanMachine(ctx.env, folders, { refresh: o.refresh, now: (ctx.now ?? Date.now)() });
  const stories = readSeenStories(ctx.env);
  const sets = scan.sets.map((s) => ({ id: s.id, folder: s.folder, story: s.story, ...(s.story && stories[s.story] ? { title: stories[s.story].title, ...(stories[s.story].state ? { state: stories[s.story].state } : {}) } : {}), ...(s.group ? { group: s.group } : {}), branch: s.branch, repos: s.repos }));
  if (o.json) return JSON.stringify({ lookIn: folders, sets, repositories: scan.repos.map(({ name, path, branch, remote }) => ({ name, path, branch, ...(remote ? { remote } : {}) })) });
  const lines = [`looking in: ${folders.join(", ") || "(nothing known yet: aihub worktree look-in <folder>)"}`, "", `worktree sets (${sets.length}):`];
  for (const s of sets) lines.push(`  ${s.story ? `story ${s.story}${"title" in s && s.title ? ` ${s.title}` : ""}` : s.group ?? s.branch}  '${s.branch}'  ${s.folder}`, ...s.repos.map((r) => `    ${r.name}${r.branch !== s.branch ? ` on '${r.branch}'` : ""}${r.exists ? "" : " (folder missing)"}`));
  lines.push("", `repositories (${scan.repos.length}):`, ...scan.repos.map((r) => `  ${r.name}  ${r.branch || "(detached)"}  ${r.path}`));
  return lines.join("\n");
}
