import { trackedExecFile } from "../perf/probe";
import * as fs from "fs";
import * as path from "path";
import type { Git, GitResult } from "./git";

// ---------------------------------------------------------------- repo groups

export interface RepoGroup {
  name: string;
  repoPaths: string[];
}

export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const GROUPS_KEY = "worktreeMaker.repoGroups";

function readGroups(store: KeyValueStore): RepoGroup[] {
  const raw = store.get<unknown>(GROUPS_KEY, []);
  if (!Array.isArray(raw)) return [];
  const result: RepoGroup[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && typeof (item as RepoGroup).name === "string" && Array.isArray((item as RepoGroup).repoPaths)) {
      result.push({
        name: (item as RepoGroup).name,
        repoPaths: (item as RepoGroup).repoPaths.filter((p) => typeof p === "string"),
      });
    }
  }
  return result;
}

export function listGroups(store: KeyValueStore): RepoGroup[] {
  return readGroups(store).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveGroup(store: KeyValueStore, group: RepoGroup): Promise<void> {
  const key = group.name.trim().toLowerCase();
  const seen = new Set<string>();
  const repoPaths: string[] = [];
  for (const p of group.repoPaths) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    repoPaths.push(p);
  }
  const others = readGroups(store).filter((g) => g.name.trim().toLowerCase() !== key);
  others.push({ name: group.name.trim(), repoPaths });
  await store.update(GROUPS_KEY, others);
}

export async function deleteGroup(store: KeyValueStore, name: string): Promise<void> {
  const key = name.trim().toLowerCase();
  await store.update(
    GROUPS_KEY,
    readGroups(store).filter((g) => g.name.trim().toLowerCase() !== key),
  );
}

// ---------------------------------------------------------------- copy local files

export interface CopyResult {
  copied: string[];
  missing: string[];
  skipped: string[];
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/").filter((s) => s.length > 0 && s !== ".");
  let source = "^";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    const part = seg
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    source += part + (last ? "" : "/");
  });
  source += "$";
  return new RegExp(source, process.platform === "win32" ? "i" : "");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (folder: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await visit(path.join(folder, entry.name), childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  await visit(root, "");
  return files.sort();
}

export async function copyLocalFiles(source: string, target: string, patterns: string[]): Promise<CopyResult> {
  const result: CopyResult = { copied: [], missing: [], skipped: [] };
  let allFiles: string[] | undefined;
  const handled = new Set<string>();

  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const normalized = pattern.replace(/\\/g, "/");
    if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      result.skipped.push(pattern);
      continue;
    }
    const first = normalized.split("/").find((s) => s.length > 0 && s !== ".");
    if (first === ".git" || first === "node_modules") {
      result.missing.push(pattern);
      continue;
    }

    let matches: string[];
    if (!normalized.includes("*")) {
      const rel = normalized.split("/").filter((s) => s.length > 0 && s !== ".").join("/");
      let isFile = false;
      try {
        isFile = (await fs.promises.stat(path.join(source, rel))).isFile();
      } catch {
        isFile = false;
      }
      matches = isFile ? [rel] : [];
    } else {
      allFiles ??= await walkFiles(source);
      const re = globToRegExp(normalized);
      matches = allFiles.filter((f) => re.test(f));
    }

    if (matches.length === 0) {
      result.missing.push(pattern);
      continue;
    }
    for (const rel of matches) {
      const key = rel.toLowerCase();
      if (handled.has(key)) continue;
      handled.add(key);
      const dest = path.join(target, ...rel.split("/"));
      if (await exists(dest)) {
        result.skipped.push(rel);
        continue;
      }
      try {
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(path.join(source, ...rel.split("/")), dest, fs.constants.COPYFILE_EXCL);
        result.copied.push(rel);
      } catch {
        result.skipped.push(rel);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- branch name template

export function slugifyTitle(title: string, maxLength = 40): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  if (slug[maxLength] === "-") return cut.replace(/-+$/g, "");
  const idx = cut.lastIndexOf("-");
  const result = idx > 0 ? cut.slice(0, idx) : cut;
  return result.replace(/-+$/g, "");
}

function fillPlaceholder(text: string, placeholder: string, value: string): string {
  if (value) return text.split(placeholder).join(value);
  const esc = placeholder.replace(/[<>]/g, "\\$&");
  // Remove the placeholder together with one adjacent "-" (prefer the following one).
  return text.replace(new RegExp(`${esc}-|-${esc}|${esc}`, "g"), "");
}

export function renderBranchTemplate(template: string, vars: { workitem?: string; title?: string }): string {
  const slug = vars.title ? slugifyTitle(vars.title) : "";
  let out = fillPlaceholder(template, "<workitem>", (vars.workitem ?? "").trim());
  out = fillPlaceholder(out, "<slug>", slug);
  out = out.replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-");
  return out.replace(/^[/]+/, "").replace(/[-/]+$/g, "");
}

// ---------------------------------------------------------------- running other CLIs

export type Run = (command: string, args: string[], cwd: string) => Promise<GitResult>;

function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function redactArgs(args: string[]): string {
  return args.map((a, i) => (i > 0 && args[i - 1] === "--description" ? "<description>" : a)).join(" ");
}

export function createRunner(log?: (line: string) => void): Run {
  return (command, args, cwd) =>
    new Promise<GitResult>((resolve) => {
      log?.(`${command} ${redactArgs(args)} (${cwd})`);
      let file = command;
      let finalArgs = args;
      const options: { cwd: string; windowsHide: boolean; maxBuffer: number; timeout: number; windowsVerbatimArguments?: boolean } = {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      };
      if (process.platform === "win32") {
        if (command.toLowerCase() === "az") file = "az.cmd";
        if (/\.(cmd|bat)$/i.test(file)) {
          const line = [file, ...args].map(quoteForCmd).join(" ");
          finalArgs = ["/d", "/s", "/c", `"${line}"`];
          file = process.env.ComSpec || "cmd.exe";
          options.windowsVerbatimArguments = true;
        }
      }
      try {
        trackedExecFile(file, finalArgs, options, (error, stdout, stderr) => {
          const out = String(stdout ?? "");
          const err = String(stderr ?? "");
          if (!error) {
            resolve({ code: 0, stdout: out, stderr: err });
            return;
          }
          const e = error as NodeJS.ErrnoException & { code?: number | string };
          if (typeof e.code === "number") {
            // cmd.exe reports a missing command as exit code 1 with this text.
            if (/is not recognized as an internal or external command/i.test(err)) {
              resolve({ code: -1, stdout: out, stderr: err, spawnError: "ENOENT" });
              return;
            }
            resolve({ code: e.code, stdout: out, stderr: err });
            return;
          }
          const spawnError = String(e.code ?? e.message ?? "UNKNOWN");
          resolve({ code: -1, stdout: out, stderr: err || e.message, spawnError });
        }, { cmd: command, args });
      } catch (e) {
        const spawnError = String((e as NodeJS.ErrnoException).code ?? (e as Error).message);
        resolve({ code: -1, stdout: "", stderr: (e as Error).message, spawnError });
      }
    });
}

const AZ_MISSING = "Azure CLI (az) was not found.";
const AZ_MISSING_NEXT = "Install the Azure CLI, run az login, or type the branch name yourself.";

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function azFailure(res: GitResult): { error: string; nextStep: string } {
  if (res.spawnError) return { error: AZ_MISSING, nextStep: AZ_MISSING_NEXT };
  const err = res.stderr;
  if (/az login|Please run 'az login'|AADSTS|credentials/i.test(err)) {
    return { error: firstLine(err) || "Not signed in to Azure.", nextStep: "Run az login in a terminal, then try again." };
  }
  if (/organization|--org|devops configure/i.test(err)) {
    return {
      error: firstLine(err) || "No Azure DevOps organization configured.",
      nextStep: "Set the defaults once: az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>",
    };
  }
  const line = firstLine(err) || `az exited with code ${res.code}.`;
  return { error: line, nextStep: "Check the Azure CLI output in the Worktree Maker log." };
}

export async function fetchWorkItem(
  run: Run,
  id: string,
  cwd: string,
): Promise<{ id: string; title: string } | { error: string; nextStep: string }> {
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { error: "Work item id must be a number.", nextStep: "Type the work item number, for example 12345." };
  }
  const res = await run("az", ["boards", "work-item", "show", "--id", trimmed, "--query", 'fields."System.Title"', "-o", "tsv"], cwd);
  if (res.code !== 0) return azFailure(res);
  const title = res.stdout.trim();
  if (!title) return { error: `Work item ${trimmed} has no title.`, nextStep: "Check the id, or type the branch name yourself." };
  return { id: trimmed, title };
}

// ---------------------------------------------------------------- set operations

export interface StepResult {
  status: "ok" | "skipped" | "error";
  message: string;
  nextStep?: string;
}

export async function syncRepo(git: Git, worktree: string, remote: string): Promise<StepResult> {
  const fetch = await git(["fetch", remote], worktree);
  if (fetch.code !== 0) {
    return { status: "error", message: firstLine(fetch.stderr) || "git fetch failed." };
  }
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{u}"], worktree);
  if (upstream.code !== 0) {
    return { status: "skipped", message: "No upstream yet (branch not pushed); nothing to pull." };
  }
  const pull = await git(["pull", "--ff-only"], worktree);
  if (pull.code === 0) {
    const text = `${pull.stdout}\n${pull.stderr}`;
    return { status: "ok", message: /already up[ -]to[ -]date/i.test(text) ? "Up to date" : "Fast-forwarded" };
  }
  if (/not possible to fast-forward|diverg/i.test(`${pull.stderr}\n${pull.stdout}`)) {
    return {
      status: "error",
      message: "Local and remote have diverged; not fast-forwarded.",
      nextStep: "Rebase or merge in a terminal (git pull --rebase), then sync again.",
    };
  }
  return { status: "error", message: firstLine(pull.stderr) || firstLine(pull.stdout) || "git pull failed." };
}

export async function pushRepo(git: Git, worktree: string, remote: string, branch: string): Promise<StepResult> {
  const res = await git(["push", "-u", remote, branch], worktree);
  if (res.code === 0) return { status: "ok", message: `Pushed ${branch} to ${remote}.` };
  if (/rejected|non-fast-forward|fetch first|failed to push/i.test(res.stderr)) {
    return { status: "error", message: "Push rejected: the remote has commits you do not have.", nextStep: "Sync the set first." };
  }
  return { status: "error", message: firstLine(res.stderr) || "git push failed." };
}

export function isAzureDevOpsRemote(url: string): boolean {
  const u = url.trim();
  return /(^|[/@.])dev\.azure\.com([:/]|$)/i.test(u) || /(^|[/@.])[a-z0-9-]+\.visualstudio\.com([:/]|$)/i.test(u) || /(^|[@/])ssh\.dev\.azure\.com[:/]/i.test(u);
}

export async function remoteUrl(git: Git, repoPath: string, remote: string): Promise<string | undefined> {
  const res = await git(["remote", "get-url", remote], repoPath);
  if (res.code !== 0) return undefined;
  const url = res.stdout.trim();
  return url || undefined;
}

export interface PullRequestResult {
  ok: boolean;
  id?: number;
  url?: string;
  message: string;
  nextStep?: string;
}

export async function createPullRequest(
  run: Run,
  cwd: string,
  opts: { source: string; target: string; title: string; description: string },
): Promise<PullRequestResult> {
  const res = await run(
    "az",
    [
      "repos",
      "pr",
      "create",
      "--detect",
      "true",
      "--source-branch",
      opts.source,
      "--target-branch",
      opts.target,
      "--title",
      opts.title,
      "--description",
      opts.description,
      "-o",
      "json",
    ],
    cwd,
  );
  if (res.code !== 0) {
    if (!res.spawnError && /already exists/i.test(res.stderr)) {
      return { ok: false, message: "A pull request for this branch already exists." };
    }
    const f = azFailure(res);
    return { ok: false, message: f.error, nextStep: f.nextStep };
  }
  try {
    const json = JSON.parse(res.stdout) as { pullRequestId?: number; repository?: { webUrl?: string } };
    const id = json.pullRequestId;
    const webUrl = json.repository?.webUrl;
    if (typeof id !== "number") throw new Error("no id");
    const url = webUrl ? `${webUrl}/pullrequest/${id}` : undefined;
    return { ok: true, id, url, message: `Pull request ${id} created.` };
  } catch {
    return { ok: false, message: "Azure CLI returned an unexpected answer.", nextStep: "Check the pull request in Azure DevOps." };
  }
}

// ---------------------------------------------------------------- environment checks

export const LOW_DISK_BYTES: number = 2 * 1024 * 1024 * 1024;

export async function freeDiskBytes(folder: string): Promise<number | undefined> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
  if (typeof statfs !== "function") return undefined;
  let current = path.resolve(folder);
  for (let i = 0; i < 64; i++) {
    if (await exists(current)) {
      try {
        const s = await statfs.call(fs.promises, current);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

export function longPathWarning(paths: string[], platform: NodeJS.Platform = process.platform, limit = 240): string | undefined {
  if (platform !== "win32") return undefined;
  const longest = paths.reduce((m, p) => Math.max(m, p.length), 0);
  if (longest < limit) return undefined;
  return `Some worktree paths are very long (${longest} characters); Windows limits paths to 260. Enable long paths for git: git config --global core.longpaths true`;
}

export async function longPathsEnabled(git: Git, cwd: string): Promise<boolean> {
  const res = await git(["config", "--get", "core.longpaths"], cwd);
  return res.code === 0 && res.stdout.trim() === "true";
}

export async function findOnPath(name: string): Promise<string | undefined> {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter((d) => d.length > 0);
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      try {
        if ((await fs.promises.stat(candidate)).isFile()) return candidate;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}
