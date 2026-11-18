import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import type { AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { crossRepoConfig, findRepoEntry, isGitDir, mapPaths, repoNameAt, type PathMapping, type RepoEntry } from "./crossRepo.js";
import { changesOf, latestIteration } from "./review.js";
import { parsePrRef } from "./pr.js";
import { loadTeam } from "./team.js";

/**
 * `aihub crossrepo impact --from <pr|sha>`: which files of the other repositories a change reaches, read from
 * `crossRepo.pathMaps` and `repositories[]` in team.yaml. Read-only; `aihub port` does the porting afterwards.
 */
export interface Impact {
  from: string;
  repo: string;
  files: string[];
  maps: {
    map: string;
    /** Repositories this map is meant for: the one named like the map, else every other repository. */
    repos: string[];
    mapped: { from: string; to: string; present: Record<string, boolean | null> }[];
    unmapped: string[];
  }[];
  /** Other repositories of team.yaml that no map names (their impact is unknown). */
  unknown: string[];
  noClone: string[];
}

/** Files of a pull request (number or link) or a commit (sha) in the current repository. */
export async function changedFilesOf(client: AdoClient, from: string): Promise<{ label: string; files: string[] }> {
  if (/^[0-9a-f]{7,40}$/i.test(from) && !/^\d+$/.test(from)) {
    const r = await client.get<{ changes?: { item?: { path?: string; isFolder?: boolean } }[] }>(`${client.repoPath()}/commits/${from}/changes`);
    return { label: `commit ${from.slice(0, 7)}`, files: (r.changes ?? []).filter((c) => c.item?.path && !c.item.isFolder).map((c) => c.item!.path!.replace(/^\//, "")) };
  }
  const id = parsePrRef(from);
  const it = await latestIteration(client, id);
  const changes = await changesOf(client, id, it);
  return { label: `!${id}`, files: changes.map((c) => c.path.replace(/^\//, "")) };
}

/** A local clone of `name`: team.yaml `path`, else a sibling folder with that repository name; undefined when there is none (never cloned here). */
export function localClone(here: string, entry: RepoEntry | undefined, name: string): string | undefined {
  if (entry?.path) {
    const p = isAbsolute(entry.path) ? entry.path : resolve(here, entry.path);
    return isGitDir(p) ? p : undefined;
  }
  const parent = dirname(here);
  try {
    for (const d of readdirSync(parent, { withFileTypes: true })) {
      const p = join(parent, d.name);
      if (d.isDirectory() && isGitDir(p) && repoNameAt(p) === name.toLowerCase()) return p;
    }
  } catch {
    /* no parent folder to look in */
  }
  return undefined;
}

export async function crossImpact(ctx: Ctx, o: { from?: string; json?: boolean }): Promise<string> {
  if (!o.from) throw new AihubError("aihub crossrepo impact needs --from <pr N|link|commit sha>");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const maps = crossRepoConfig(team).pathMaps ?? {};
  if (!Object.keys(maps).length) throw new AihubError("team.yaml has no crossRepo.pathMaps: add a named map (from/to directory prefixes) first, see docs/team-yaml.md");
  const here = client.remote.repo;
  const { label, files } = await changedFilesOf(client, o.from);
  const others = ((team.repositories ?? []) as RepoEntry[]).filter((r) => r.name && r.name.toLowerCase() !== here.toLowerCase());
  const clones = new Map<string, string | undefined>(others.map((r) => [r.name!, localClone(root, r, r.name!)]));
  const impact: Impact = { from: label, repo: here, files, maps: [], unknown: [], noClone: [] };
  const named = new Set<string>();
  for (const [map, list] of Object.entries(maps) as [string, PathMapping[]][]) {
    const entry = findRepoEntry(team, map);
    const repos = entry?.name && entry.name.toLowerCase() !== here.toLowerCase() ? [entry.name] : others.map((r) => r.name!);
    repos.forEach((r) => named.add(r));
    const m = mapPaths(files, list);
    impact.maps.push({
      map,
      repos,
      mapped: m.mapped.map((x) => ({ from: x.from, to: x.to, present: Object.fromEntries(repos.map((r) => [r, clones.get(r) ? existsSync(join(clones.get(r)!, x.to)) : null])) })),
      unmapped: m.unmapped,
    });
  }
  impact.unknown = others.map((r) => r.name!).filter((r) => !named.has(r));
  impact.noClone = others.map((r) => r.name!).filter((r) => !clones.get(r));
  if (o.json) return JSON.stringify(impact);
  return formatImpact(impact);
}

export function formatImpact(i: Impact): string {
  const out = [`impact of ${i.from} in ${i.repo}: ${i.files.length} file(s)`];
  for (const m of i.maps) {
    const present = (x: (typeof m.mapped)[number]) => m.repos.map((r) => (x.present[r] === true ? `exists in ${r}` : x.present[r] === false ? `new in ${r}` : `${r}: no local clone`)).join(", ");
    out.push(`map ${m.map} -> ${m.repos.join(", ") || "(no other repository in team.yaml)"}: ${m.mapped.length} file(s) reach it${m.unmapped.length ? `, ${m.unmapped.length} outside the map` : ""}`);
    for (const x of m.mapped.slice(0, 20)) out.push(`  ${x.from} -> ${x.to} (${present(x)})`);
    if (m.mapped.length > 20) out.push(`  ... ${m.mapped.length - 20} more`);
    if (m.unmapped.length) out.push(`  not covered by ${m.map}: ${m.unmapped.slice(0, 10).join(", ")}${m.unmapped.length > 10 ? ", ..." : ""}`);
    if (m.mapped.length) out.push(`  port it: aihub port --from-repo ${i.repo} --from ${i.from.startsWith("!") ? i.from.slice(1) : i.from.replace("commit ", "")} --to-repo ${m.repos[0] ?? "<repo>"} --map ${m.map}`);
  }
  if (i.unknown.length) out.push(`no map names: ${i.unknown.join(", ")} (impact unknown; add a map to crossRepo.pathMaps)`);
  if (i.noClone.length) out.push(`no local clone of: ${i.noClone.join(", ")} (set repositories[].path to check which files exist)`);
  return out.join("\n");
}
