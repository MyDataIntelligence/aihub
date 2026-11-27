import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configHome } from "./configHome.js";

/**
 * The team repository: where the team.yaml of a set (or of every repository on this PC) lives when a repository has none
 * of its own. `aihub team init --team-repo <project>/<repo>` (or a local folder) points to it; the file is read once
 * through the Azure DevOps API (no clone) and kept as a copy in the user's config folder, so every command can read it
 * without a call. `aihub team show --refresh` reads it again. Nothing here is ever written into a work repository.
 */

export interface TeamRepo {
  org?: string;
  project?: string;
  repo?: string;
  /** a local clone instead of Azure DevOps */
  localPath?: string;
  /** default: the repository's default branch */
  branch?: string;
}

export interface SourceFile {
  /** per set folder (lower case), else `default` for every repository on this PC */
  sets?: Record<string, TeamRepo>;
  default?: TeamRepo;
}

export interface TeamCopy {
  content: string;
  /** the commit the file was read at */
  commit: string;
  /** commit date of the last change of the file, ISO */
  date?: string;
  branch: string;
  path: string;
  readAt: string;
  /** template path -> exists in the team repository (read with the copy) */
  files?: Record<string, boolean>;
}

const sourceFile = (env: NodeJS.ProcessEnv) => join(configHome(env), "team-source.json");
const copyFile = (env: NodeJS.ProcessEnv, r: TeamRepo) =>
  join(configHome(env), "team-copy", `${createHash("sha1").update(repoKey(r)).digest("hex").slice(0, 16)}.json`);

export const repoKey = (r: TeamRepo): string => (r.localPath ? `local|${resolve(r.localPath)}` : `${r.org ?? ""}|${r.project ?? ""}|${r.repo ?? ""}|${r.branch ?? ""}`).toLowerCase();

/** "orders / team-config" or the folder name */
export const repoLabel = (r: TeamRepo): string => (r.localPath ? r.localPath.replace(/[\/]+$/, "").split(/[\/]/).pop()! : `${r.project ?? "?"} / ${r.repo ?? "?"}`);

const writeJson = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
};

export const hasTeamSources = (env: NodeJS.ProcessEnv): boolean => existsSync(sourceFile(env));

export function readSources(env: NodeJS.ProcessEnv): SourceFile {
  try {
    return JSON.parse(readFileSync(sourceFile(env), "utf8")) as SourceFile;
  } catch {
    return {};
  }
}

/** The team repository of a set folder, else the one for every repository, else undefined. */
export function teamRepoFor(env: NodeJS.ProcessEnv, setFolder: string | undefined): TeamRepo | undefined {
  if (!existsSync(sourceFile(env))) return undefined;
  const s = readSources(env);
  return (setFolder ? s.sets?.[resolve(setFolder).toLowerCase()] : undefined) ?? s.default;
}

export function setTeamRepo(env: NodeJS.ProcessEnv, r: TeamRepo, setFolder?: string): void {
  const s = readSources(env);
  if (setFolder) s.sets = { ...(s.sets ?? {}), [resolve(setFolder).toLowerCase()]: r };
  else s.default = r;
  writeJson(sourceFile(env), s);
}

export function readCopy(env: NodeJS.ProcessEnv, r: TeamRepo): (TeamCopy & { ageMs: number }) | undefined {
  const f = copyFile(env, r);
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as TeamCopy;
    return { ...c, ageMs: Date.now() - statSync(f).mtimeMs };
  } catch {
    return undefined;
  }
}

export function writeCopy(env: NodeJS.ProcessEnv, r: TeamRepo, c: TeamCopy): void {
  writeJson(copyFile(env, r), c);
}

/** `orders/team-config`, `org/orders/team-config` or a folder -> a team repository */
export function parseTeamRepo(arg: string, exists: (p: string) => boolean = existsSync): TeamRepo {
  const a = arg.trim();
  if (exists(a)) return { localPath: resolve(a) };
  const parts = a.split("/").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 2) return { project: parts[0], repo: parts[1] };
  if (parts.length === 3) return { org: parts[0], project: parts[1], repo: parts[2] };
  throw new Error(`'${arg}' is not a team repository: use <project>/<repository>, <organization>/<project>/<repository> or a local folder`);
}
