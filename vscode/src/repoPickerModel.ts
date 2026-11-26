/**
 * The repo opener's pick list, pure: saved groups (★) and recent repositories on top, then per Azure DevOps project
 * its repositories (cloned: branch and folder; else "not cloned ↓"), then local clones that are not in Azure DevOps.
 * The data is `aihub repos local --json` (at once) and `aihub repos ado --json` (added when it is there).
 */
import type { GroupJson } from "./repoSetModel";

export interface LocalRepoJson {
  name: string;
  path: string;
  branch: string;
  key?: string;
  project?: string;
  /** other clones of the same remote; the CLI already chose this one (aihub repos local) */
  otherClones?: string[];
}

export interface AdoRepoJson {
  project: string;
  name: string;
  key: string;
  path?: string;
  branch?: string;
  otherClones?: string[];
}

export interface RecentRepo {
  path: string;
  name: string;
  lastUsed: string;
}

/** What one row stands for. */
export type RepoPick = { kind: "group"; group: GroupJson } | { kind: "local"; path: string; name: string } | { kind: "clone"; project: string; name: string };

export interface RepoRow {
  label: string;
  description?: string;
  detail?: string;
  separator?: boolean;
  value?: RepoPick;
  /** a stable id, so a ticked row stays ticked when the Azure DevOps list is added */
  id?: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const branchText = (b: string | undefined) => (b ? b : "(detached)");
/** "branch · folder", plus "+N more" and the other folders when the repository is cloned more than once. */
const where = (l: { branch?: string; path?: string; otherClones?: string[] }): { description: string; detail?: string } =>
  l.otherClones?.length ? { description: `${branchText(l.branch)} · ${l.path}  +${l.otherClones.length} more`, detail: `also cloned at ${l.otherClones.join(", ")}` } : { description: `${branchText(l.branch)} · ${l.path}` };

export function repoRows(o: { groups: GroupJson[]; recent: RecentRepo[]; local: LocalRepoJson[]; ado?: AdoRepoJson[]; adoError?: string }): RepoRow[] {
  const rows: RepoRow[] = [];
  // a recent folder that is another clone of a listed repository counts as that repository
  const localByPath = new Map(o.local.flatMap((l) => [l.path, ...(l.otherClones ?? [])].map((p) => [norm(p), l] as const)));
  if (o.groups.length) {
    rows.push({ label: "Groups", separator: true });
    for (const g of o.groups) rows.push({ id: `g:${g.name}`, label: `★ ${g.name}`, description: `${g.repos.length} repos${g.source === "team" ? " · team.yaml" : ""}`, detail: g.repos.map((r) => r.name).join(", ") + (g.missing?.length ? `   [not on this PC: ${g.missing.join(", ")}]` : ""), value: { kind: "group", group: g } });
  }
  const recent = o.recent.filter((r) => localByPath.has(norm(r.path)));
  const shown = new Set<string>();
  if (recent.length) {
    rows.push({ label: "Recent", separator: true });
    for (const r of recent) {
      const l = localByPath.get(norm(r.path))!;
      if (shown.has(norm(l.path))) continue;
      shown.add(norm(l.path));
      rows.push({ id: `l:${norm(l.path)}`, label: l.name, ...where(l), value: { kind: "local", path: l.path, name: l.name } });
    }
  }
  const adoKeys = new Set<string>();
  if (o.ado) {
    const projects = [...new Set(o.ado.map((a) => a.project))];
    for (const p of projects) {
      rows.push({ label: `Azure DevOps · ${p}`, separator: true });
      for (const a of o.ado.filter((x) => x.project === p)) {
        adoKeys.add(a.key);
        if (a.path) {
          if (shown.has(norm(a.path))) continue;
          shown.add(norm(a.path));
          rows.push({ id: `l:${norm(a.path)}`, label: a.name, ...where(a), value: { kind: "local", path: a.path, name: a.name } });
        } else rows.push({ id: `c:${a.project}/${a.name}`, label: a.name, description: "not cloned ↓", detail: `cloned into the repos root when you pick it`, value: { kind: "clone", project: a.project, name: a.name } });
      }
    }
  }
  const rest = o.local.filter((l) => !shown.has(norm(l.path)) && !(l.key && adoKeys.has(l.key)));
  if (rest.length) {
    rows.push({ label: o.ado ? "Local, not in Azure DevOps" : "Local", separator: true });
    for (const l of rest) rows.push({ id: `l:${norm(l.path)}`, label: l.name, ...where(l), value: { kind: "local", path: l.path, name: l.name } });
  }
  if (o.adoError) rows.push({ label: `Azure DevOps could not be read: ${o.adoError}`, separator: true });
  return rows;
}

export interface Selection {
  /** local folders (absolute) */
  paths: string[];
  /** to clone first: `project/name` */
  clone: string[];
  /** a single group ticked alone: open it by name */
  group?: string;
  names: string[];
}

/** The ticked rows as folders and clones; a group stands for its repositories. */
export function selectionOf(picks: RepoPick[]): Selection {
  const paths: string[] = [];
  const names: string[] = [];
  const clone: string[] = [];
  const add = (p: string, n: string) => {
    if (paths.some((x) => norm(x) === norm(p))) return;
    paths.push(p);
    names.push(n);
  };
  for (const p of picks) {
    if (p.kind === "group") for (const r of p.group.repos) add(r.path, r.name);
    else if (p.kind === "local") add(p.path, p.name);
    else if (!clone.includes(`${p.project}/${p.name}`)) {
      clone.push(`${p.project}/${p.name}`);
      names.push(p.name);
    }
  }
  const groups = picks.filter((p) => p.kind === "group");
  return { paths, clone, names, group: groups.length === 1 && picks.length === 1 ? (groups[0] as { group: GroupJson }).group.name : undefined };
}

export function addRecentRepos(recent: RecentRepo[], picked: { path: string; name: string }[], now: number, max = 10): RecentRepo[] {
  const at = new Date(now).toISOString();
  const fresh = picked.map((p) => ({ path: p.path, name: p.name, lastUsed: at }));
  return [...fresh, ...recent.filter((r) => !picked.some((p) => norm(p.path) === norm(r.path)))].slice(0, max);
}

/** A workspace file for "Open as they are": the folders as they are, no worktree, no switch. */
export function plainWorkspace(paths: string[], label: string): string {
  return JSON.stringify({ folders: paths.map((p) => ({ path: p.replace(/\\/g, "/") })), settings: { "aihub.set": { group: label, branch: "", mode: "plain", repos: paths.map((p) => ({ name: p.replace(/\\/g, "/").split("/").pop(), branch: "" })) } } }, null, 2);
}
