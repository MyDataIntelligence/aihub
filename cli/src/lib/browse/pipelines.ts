import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AdoClient } from "../ado.js";
import { branchOf, checkSkips, mergeParameters, mergeVariables, planStages, readChanges, runState, seconds, variablesOf, yamlFacts, type PlanStage, type RawBuild, type RunState, type VarRow } from "../pipelineView.js";
import { BrowseError, cached, guarded, meOf, normPath, parseRef, repoClientOf, TTL, versionQuery, type Browse, type ReadMeta } from "./core.js";
import { NEVER_PUSH } from "./push.js";
import { zipEntries, zipRead } from "./zip.js";

/**
 * The pipeline browser: the pipelines of a project as a folder tree with their latest run, one pipeline with its latest
 * runs, the run form read from the YAML on a branch, a run, the artifacts of a run, and draft pipelines (`draft-<name>` in
 * `\Drafts`, on their own branch) that the one who made them can remove again. Reads are cached like the repository
 * browser; nothing polls.
 */

const ZERO = "0".repeat(40);
export const DRAFT_FOLDER = "\\Drafts";
export const DRAFT_PREFIX = "draft-";

interface DefRaw {
  id: number;
  name: string;
  createdDate?: string;
  path?: string;
  repository?: { id?: string; name?: string; type?: string; defaultBranch?: string };
  process?: { type?: number; yamlFilename?: string };
  authoredBy?: { id?: string; displayName?: string; uniqueName?: string };
  latestBuild?: RawBuild;
  queue?: { id?: number; name?: string };
  variables?: Record<string, { value?: string; isSecret?: boolean; allowOverride?: boolean }>;
}

export interface LatestRun {
  id: number;
  number: string | null;
  state: RunState;
  branch: string;
  /** a pull request run: its number (branch is then the PR's source branch when known, else refs/pull/N/merge) */
  pr: number | null;
  queuedAt: string | null;
  finishedAt: string | null;
}

export interface PipelineRow {
  id: number;
  name: string;
  folder: string;
  repo: string | null;
  yamlPath: string | null;
  defaultBranch: string | null;
  isDraft: boolean;
  mine: boolean;
  latestRun: LatestRun | null;
  webUrl: string;
}

export interface FolderRow {
  path: string;
  name: string;
  parent: string | null;
  pipelines: number;
}

const short = (ref: string | undefined) => (ref ? ref.replace(/^refs\/heads\//, "") : null);
const folderOf = (p: string | undefined) => {
  const s = (p ?? "\\").replace(/\//g, "\\");
  return s.length > 1 ? s.replace(/\\+$/, "") : "\\";
};
export const isDraftDef = (d: { name: string; path?: string }) => d.name.toLowerCase().startsWith(DRAFT_PREFIX) && folderOf(d.path).toLowerCase().startsWith(DRAFT_FOLDER.toLowerCase());

const defUrl = (b: Browse, project: string, id: number) => `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_build?definitionId=${id}`;
const buildUrl = (b: Browse, project: string, id: number) => `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${id}`;

export const prOf = (x: RawBuild): number | null => {
  const n = Number(x.triggerInfo?.["pr.number"] ?? /^refs\/pull\/(\d+)\//.exec(x.sourceBranch ?? "")?.[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const latestOf = (x: RawBuild | undefined): LatestRun | null =>
  x ? { id: x.id, number: x.buildNumber ?? null, state: runState(x), branch: branchOf(x), pr: prOf(x), queuedAt: x.queueTime ?? null, finishedAt: x.finishTime ?? null } : null;

export function rowOfDef(b: Browse, project: string, d: DefRaw, meId: string): PipelineRow {
  return {
    id: d.id,
    name: d.name,
    folder: folderOf(d.path),
    repo: d.repository?.name ?? null,
    yamlPath: d.process?.type === 2 ? (d.process.yamlFilename ?? "").replace(/^\//, "") || null : null,
    defaultBranch: short(d.repository?.defaultBranch),
    isDraft: isDraftDef(d),
    mine: !!meId && d.authoredBy?.id?.toLowerCase() === meId.toLowerCase(),
    latestRun: latestOf(d.latestBuild),
    webUrl: defUrl(b, project, d.id),
  };
}

/** Every folder that holds a pipeline, with its parents; `pipelines` counts the pipelines in it and below. */
export function foldersOf(rows: { folder: string }[]): FolderRow[] {
  const map = new Map<string, FolderRow>();
  for (const r of rows) {
    let p = r.folder;
    for (;;) {
      const key = p.toLowerCase();
      const parent = p === "\\" ? null : p.lastIndexOf("\\") <= 0 ? "\\" : p.slice(0, p.lastIndexOf("\\"));
      const f = map.get(key) ?? { path: p, name: p === "\\" ? "" : p.slice(p.lastIndexOf("\\") + 1), parent, pipelines: 0 };
      f.pipelines++;
      map.set(key, f);
      if (parent === null) break;
      p = parent;
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
}

// ---- pipelines of a project ---------------------------------------------------------------------------------------------

export interface PipelinesResult extends ReadMeta {
  project: string;
  folders: FolderRow[];
  pipelines: PipelineRow[];
}

export async function browsePipelines(b: Browse, project: string): Promise<PipelinesResult> {
  const me = await meOf(b);
  const c = b.client.forProject(project);
  const { data, meta } = await guarded(b, project, () =>
    cached(b, `pipes|${b.org}|${project}`, 15 * 60_000, async () => {
      const defs = await c.list<DefRaw>("build/definitions", { includeLatestBuilds: true, includeAllProperties: true, queryOrder: "definitionNameAscending" });
      return defs.map((d) => rowOfDef(b, project, d, me.id));
    }),
  );
  return { project, ...meta, folders: foldersOf(data), pipelines: data };
}

// ---- one pipeline -----------------------------------------------------------------------------------------------------

export interface PipelineRun {
  id: number;
  number: string | null;
  state: RunState;
  branch: string;
  pr: number | null;
  message: string | null;
  requestedFor: { name: string; isMe: boolean };
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  webUrl: string;
}

export interface PipelineResult extends ReadMeta {
  pipeline: PipelineRow & { yaml: { project: string; repo: string; path: string; defaultBranch: string | null } | null };
  runs: PipelineRun[];
  allRunsUrl: string;
}

async function messages(c: AdoClient, repoId: string | undefined, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!repoId || !ids.length) return out;
  try {
    const r = await c.post<{ value?: { commitId: string; comment?: string }[] }>(`git/repositories/${repoId}/commitsbatch`, { ids: [...new Set(ids)], $top: ids.length });
    for (const x of r.value ?? []) out.set(x.commitId, (x.comment ?? "").split("\n")[0].trim());
  } catch {
    /* the runs still show, without their messages */
  }
  return out;
}

export async function browsePipeline(b: Browse, project: string, id: number, top = 8): Promise<PipelineResult> {
  const me = await meOf(b);
  const c = b.client.forProject(project);
  const now = b.now();
  const { data, meta } = await guarded(b, project, () =>
    cached(b, `pipe|${b.org}|${project}|${id}|${top}`, TTL.short, async () => {
      const d = await c.get<DefRaw>(`build/definitions/${id}`);
      const builds = (await c.get<{ value?: RawBuild[] }>("build/builds", { definitions: id, $top: top, queryOrder: "queueTimeDescending" })).value ?? [];
      const msg = await messages(c, d.repository?.id, builds.map((x) => x.sourceVersion ?? "").filter(Boolean));
      const runs: PipelineRun[] = builds.map((x) => {
        const st = runState(x);
        const done = st !== "queued" && st !== "running" && st !== "cancelling";
        return {
          id: x.id,
          number: x.buildNumber ?? null,
          state: st,
          branch: branchOf(x),
          pr: prOf(x),
          message: (x.sourceVersion && msg.get(x.sourceVersion)) || x.triggerInfo?.["ci.message"] || null,
          requestedFor: { name: x.requestedFor?.displayName ?? "", isMe: !!me.id && x.requestedFor?.id?.toLowerCase() === me.id.toLowerCase() },
          queuedAt: x.queueTime ?? null,
          startedAt: x.startTime ?? null,
          finishedAt: x.finishTime ?? null,
          durationSeconds: seconds(x.startTime, x.finishTime, done ? undefined : now),
          webUrl: x._links?.web?.href ?? buildUrl(b, project, x.id),
        };
      });
      const row = rowOfDef(b, project, { ...d, latestBuild: builds[0] }, me.id);
      return { pipeline: { ...row, yaml: row.yamlPath && row.repo ? { project, repo: row.repo, path: `/${row.yamlPath}`, defaultBranch: row.defaultBranch } : null }, runs };
    }),
  );
  return { ...meta, ...data, allRunsUrl: defUrl(b, project, id) };
}

// ---- run form and run -------------------------------------------------------------------------------------------------

export interface RunPlan {
  pipeline: { id: number; name: string; repo: string | null; yamlPath: string | null };
  ref: { name: string; kind: "branch" | "tag" | "commit"; commit: string; message: string | null };
  parameters: { name: string; displayName: string | null; type: string; default: unknown; values: string[] | null; value: string | null }[];
  variables: VarRow[];
  stages: PlanStage[];
  dependencySource: "yaml" | "unknown";
}

const asText = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

async function planOf(b: Browse, project: string, id: number, ref: string | undefined): Promise<{ plan: RunPlan; def: DefRaw }> {
  const c = b.client.forProject(project);
  const d = await c.get<DefRaw>(`build/definitions/${id}`);
  if (d.process?.type !== 2 || !d.process.yamlFilename || !d.repository?.id) throw new BrowseError("badInput", `pipeline ${d.name} is not a YAML pipeline in Azure Repos; run it in the browser`);
  const spec = parseRef(ref) ?? { name: short(d.repository.defaultBranch) ?? "main", kind: "branch" as const };
  const rc = repoClientOf(b, project, d.repository.id);
  const item = await rc.get<{ content?: string; commitId?: string }>(`${rc.repoPath()}/items`, { path: d.process.yamlFilename, includeContent: true, ...versionQuery(spec) }).catch((e: Error) => {
    throw new BrowseError(/\(404\)|not found/i.test(e.message) ? "notFound" : "failed", `${d.process!.yamlFilename} is not on ${spec.kind} ${spec.name}: ${e.message}`);
  });
  const commit = item.commitId ?? "";
  let message: string | null = null;
  try {
    message = (await rc.get<{ comment?: string }>(`${rc.repoPath()}/commits/${commit}`)).comment?.split("\n")[0].trim() || null;
  } catch {
    message = null;
  }
  const y = yamlFacts(item.content ?? "");
  const stageList = y.stageDeps ? [...y.stageDeps.keys()].map((s) => ({ identifier: s, name: s })) : [];
  return {
    def: d,
    plan: {
      pipeline: { id: d.id, name: d.name, repo: d.repository.name ?? null, yamlPath: d.process.yamlFilename.replace(/^\//, "") },
      ref: { name: spec.name, kind: spec.kind, commit, message },
      parameters: y.parameters.map((p) => ({ ...p, value: asText(p.default) })),
      variables: variablesOf(d.variables, undefined),
      stages: planStages(stageList, y.stageDeps),
      dependencySource: y.stageDeps ? "yaml" : "unknown",
    },
  };
}

export async function browseRunPlan(b: Browse, project: string, id: number, ref?: string): Promise<RunPlan> {
  return guarded(b, project, async () => (await planOf(b, project, id, ref)).plan);
}

export interface RunResult {
  id: number;
  number: string | null;
  pipeline: string;
  branch: string | null;
  tag: string | null;
  commit: string;
  skipped: string[];
  changed: { parameters: string[]; variables: string[] };
  webUrl: string;
}

/** A wrong value, skip or changes file is the user's input: badInput, nothing is queued. */
function checked<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new BrowseError("badInput", (e as Error).message);
  }
}

export async function browseRun(b: Browse, project: string, id: number, o: { branch?: string; tag?: string; commit?: string; changesFile?: string }): Promise<RunResult> {
  if (o.branch && o.tag) throw new BrowseError("badInput", "give --branch or --tag, not both");
  if (o.commit && !/^[0-9a-f]{7,40}$/i.test(o.commit)) throw new BrowseError("badInput", `'${o.commit}' is not a commit id`);
  const changes = checked(() => readChanges(o.changesFile));
  return guarded(b, project, async () => {
    const { plan } = await planOf(b, project, id, o.tag ? `tag:${o.tag}` : o.branch);
    const skipped = checked(() => checkSkips(plan.stages, changes.skipStages ?? []));
    const params = checked(() => mergeParameters(plan.parameters, changes.parameters));
    const vars = checked(() => mergeVariables(plan.variables, changes.variables));
    // the YAML gives the defaults itself: only what the user changed is sent
    const templateParameters = Object.fromEntries(params.changed.map((k) => [k, params.all[k]]));
    const varsChanged = Object.fromEntries(vars.changed.map((k) => [k, vars.send[k]]));
    const refName = plan.ref.kind === "tag" ? `refs/tags/${plan.ref.name}` : `refs/heads/${plan.ref.name}`;
    const body = {
      resources: { repositories: { self: { refName, ...(o.commit ? { version: o.commit } : {}) } } },
      ...(Object.keys(templateParameters).length ? { templateParameters } : {}),
      ...(Object.keys(varsChanged).length ? { variables: varsChanged } : {}),
      ...(skipped.length ? { stagesToSkip: skipped } : {}),
    };
    const r = await b.client.forProject(project).post<{ id: number; name?: string }>(`pipelines/${id}/runs`, body);
    return {
      id: r.id,
      number: r.name ?? null,
      pipeline: plan.pipeline.name,
      branch: plan.ref.kind === "branch" ? plan.ref.name : null,
      tag: plan.ref.kind === "tag" ? plan.ref.name : null,
      commit: o.commit ?? plan.ref.commit,
      skipped,
      changed: { parameters: params.changed, variables: vars.changed },
      webUrl: buildUrl(b, project, r.id),
    };
  });
}

/** After a browse push: can the pipeline run on the new branch (it reads this very file from this repository)? */
export async function runnableOn(b: Browse, project: string, id: number, repo: string, path: string): Promise<{ id: number; name: string; runnable: boolean; reason: string | null }> {
  const d = await b.client.forProject(project).get<DefRaw>(`build/definitions/${id}`);
  const yaml = d.process?.type === 2 ? normPath(d.process.yamlFilename) : undefined;
  const sameRepo = !!d.repository && [d.repository.name, d.repository.id].some((x) => (x ?? "").toLowerCase() === repo.toLowerCase());
  if (!yaml) return { id, name: d.name, runnable: false, reason: `${d.name} is not a YAML pipeline` };
  if (!sameRepo) return { id, name: d.name, runnable: false, reason: `${d.name} reads its YAML from ${d.repository?.name ?? "another repository"}` };
  if (yaml.toLowerCase() !== normPath(path).toLowerCase()) return { id, name: d.name, runnable: true, reason: `${d.name} runs ${yaml}, not this file; it can still run on the new branch` };
  return { id, name: d.name, runnable: true, reason: null };
}

// ---- artifacts -------------------------------------------------------------------------------------------------------

interface ArtifactRaw {
  id?: number;
  name: string;
  resource?: { type?: string; downloadUrl?: string; properties?: { artifactsize?: string } };
}

export const MAX_ARTIFACT_ZIP = 100 * 1024 * 1024;

async function artifactList(b: Browse, project: string, run: number): Promise<ArtifactRaw[]> {
  return (await b.client.forProject(project).get<{ value?: ArtifactRaw[] }>(`build/builds/${run}/artifacts`)).value ?? [];
}

export async function browseArtifacts(b: Browse, project: string, run: number): Promise<{ run: number; artifacts: { name: string; type: string | null; bytes: number | null; files: null }[] }> {
  return guarded(b, project, async () => ({
    run,
    artifacts: (await artifactList(b, project, run)).map((a) => ({ name: a.name, type: a.resource?.type ?? null, bytes: a.resource?.properties?.artifactsize ? Number(a.resource.properties.artifactsize) : null, files: null })),
  }));
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
export const artifactDir = (b: Browse, project: string, run: number, name: string) => join(tmpdir(), "aihub-artifacts", safe(`${b.org}-${project}-${run}-${name}`));

/** The artifact as a zip in a temporary folder; a finished run's artifact does not change, so a zip already there is used again. */
async function artifactZip(b: Browse, project: string, run: number, name: string): Promise<{ zip: string; buf: Buffer } | { tooLarge: number }> {
  const a = (await artifactList(b, project, run)).find((x) => x.name === name);
  if (!a) throw new BrowseError("notFound", `run ${run} has no artifact '${name}'`);
  const size = Number(a.resource?.properties?.artifactsize ?? 0);
  if (size > MAX_ARTIFACT_ZIP) return { tooLarge: size };
  const zip = join(artifactDir(b, project, run, name), `${safe(name)}.zip`);
  if (existsSync(zip) && statSync(zip).size > 0) return { zip, buf: readFileSync(zip) };
  const url = a.resource?.downloadUrl;
  if (!url) throw new BrowseError("failed", `artifact '${name}' has no download address (type ${a.resource?.type ?? "unknown"})`);
  const zipUrl = /format=zip/i.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}%24format=zip`;
  const bytes = Buffer.from(await b.client.fetchBytes(zipUrl, MAX_ARTIFACT_ZIP));
  mkdirSync(dirname(zip), { recursive: true });
  writeFileSync(zip, bytes);
  return { zip, buf: bytes };
}

/** Paths inside the artifact, without the artifact's own top folder. */
const inside = (name: string, p: string) => (p.startsWith(`${name}/`) ? p.slice(name.length + 1) : p);

export async function browseArtifactFiles(b: Browse, project: string, run: number, name: string): Promise<{ run: number; artifact: string; files: { path: string; bytes: number }[] | null; tooLarge: boolean }> {
  return guarded(b, project, async () => {
    const z = await artifactZip(b, project, run, name);
    if ("tooLarge" in z) return { run, artifact: name, files: null, tooLarge: true };
    return { run, artifact: name, files: zipEntries(z.buf).map((e) => ({ path: inside(name, e.path), bytes: e.bytes })), tooLarge: false };
  });
}

const TEXT_EXT = /\.(txt|log|xml|json|md|ya?ml|csv|tsv|py|sql|sh|ps1|trx|ini|cfg|toml|out|err|js|ts|css)$/i;

export function kindOfFile(path: string, data: Buffer): "text" | "html" | "log" | "binary" {
  if (/\.html?$/i.test(path)) return "html";
  if (/\.log$/i.test(path)) return "log";
  if (TEXT_EXT.test(path)) return "text";
  return data.subarray(0, 8000).includes(0) ? "binary" : "text";
}

export interface OpenResult {
  run: number;
  artifact: string;
  path: string | null;
  file: string;
  bytes: number;
  kind: "text" | "html" | "log" | "binary" | "zip";
  content: string | null;
}

export async function browseArtifactOpen(b: Browse, project: string, run: number, name: string, path?: string, maxBytes = 2 * 1024 * 1024): Promise<OpenResult> {
  return guarded(b, project, async () => {
    const z = await artifactZip(b, project, run, name);
    if ("tooLarge" in z) throw new BrowseError("badInput", `artifact '${name}' is ${Math.round(z.tooLarge / 1048576)} MB; open it in the browser`);
    if (!path) return { run, artifact: name, path: null, file: z.zip, bytes: z.buf.length, kind: "zip", content: null };
    const want = path.replace(/^\/+/, "");
    const e = zipEntries(z.buf).find((x) => inside(name, x.path) === want);
    if (!e) throw new BrowseError("notFound", `artifact '${name}' has no file '${want}'`);
    const data = zipRead(z.buf, e);
    const file = join(artifactDir(b, project, run, name), "files", ...want.split("/").map(safe));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
    const kind = kindOfFile(want, data);
    return { run, artifact: name, path: want, file, bytes: data.length, kind, content: kind !== "binary" && data.length <= maxBytes ? data.toString("utf8") : null };
  });
}

// ---- drafts ----------------------------------------------------------------------------------------------------------

export function draftName(name: string): string {
  const n = name.trim().replace(/^draft-/i, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(n)) throw new BrowseError("badInput", `'${name}' is not a draft name: letters, digits and - only (the prefix draft- is added)`);
  return `${DRAFT_PREFIX}${n}`;
}

export function emptyDraftYaml(full: string): string {
  return [
    `# ${full}: a draft pipeline to try things out; remove it with Clean up Drafts`,
    "trigger: none",
    "pr: none",
    "",
    "pool:",
    "  vmImage: ubuntu-latest",
    "",
    "stages:",
    "  - stage: Draft",
    "    jobs:",
    "      - job: run",
    "        steps:",
    `          - script: echo "Hello from ${full}"`,
    "            displayName: Run script",
    "",
  ].join("\n");
}

const protectedBranch = (branch: string) => {
  const s = branch.replace(/^refs\/heads\//, "").toLowerCase();
  return NEVER_PUSH.includes(s) || s.startsWith("release/");
};

export interface DraftCreated {
  pipeline: { id: number; name: string; folder: string };
  repo: string;
  branch: string;
  startedFrom: string;
  yamlPath: string;
  commit: string;
  webUrl: string;
}

export async function browseDraftCreate(b: Browse, o: { project: string; repo: string; name: string; branch: string; fromPipeline?: number; empty?: boolean }): Promise<DraftCreated> {
  const full = draftName(o.name);
  const branch = o.branch.trim().replace(/^refs\/heads\//, "");
  if (!branch || protectedBranch(branch)) throw new BrowseError("protectedBranch", `a draft never goes on ${branch || "an empty branch name"}; give a new feature branch`);
  if (!o.fromPipeline && !o.empty) throw new BrowseError("badInput", "give --from-pipeline <id> (a copy of its YAML) or --empty (one stage, one script step)");
  const c = b.client.forProject(o.project);
  return guarded(b, o.project, async () => {
    const rc = repoClientOf(b, o.project, o.repo);
    const repo = await rc.get<{ id: string; name: string; defaultBranch?: string }>(rc.repoPath());
    const base = short(repo.defaultBranch) ?? "main";
    const refs = (await rc.get<{ value?: { name: string; objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: `heads/${branch}` })).value ?? [];
    if (refs.some((r) => r.name === `refs/heads/${branch}`)) throw new BrowseError("branchExists", `branch ${branch} already exists; pick another name`);
    const baseRef = ((await rc.get<{ value?: { name: string; objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: `heads/${base}` })).value ?? []).find((r) => r.name === `refs/heads/${base}`);
    if (!baseRef) throw new BrowseError("notFound", `the default branch ${base} of ${repo.name} was not found`);
    const existing = (await c.get<{ value?: { id: number; name: string }[] }>("build/definitions", { name: full })).value ?? [];
    if (existing.some((d) => d.name.toLowerCase() === full)) throw new BrowseError("badInput", `a pipeline named ${full} already exists`);
    let content = emptyDraftYaml(full);
    let queue: { id?: number } | undefined;
    if (o.fromPipeline) {
      const src = await c.get<DefRaw>(`build/definitions/${o.fromPipeline}`);
      if (src.process?.type !== 2 || !src.process.yamlFilename || !src.repository?.id) throw new BrowseError("badInput", `pipeline ${src.name} is not a YAML pipeline in Azure Repos; start from the empty template`);
      const sc = repoClientOf(b, o.project, src.repository.id);
      // the pipeline's own default branch first, then the repository's (a pipeline's branch may be gone)
      const srcRepo = await sc.get<{ defaultBranch?: string }>(sc.repoPath());
      const tries = [...new Set([short(src.repository.defaultBranch), short(srcRepo.defaultBranch)].filter((x): x is string => !!x))];
      let text: string | undefined;
      for (const br of tries) {
        try {
          text = (await sc.get<{ content?: string }>(`${sc.repoPath()}/items`, { path: src.process.yamlFilename, includeContent: true, ...versionQuery({ name: br, kind: "branch" }) })).content ?? "";
          break;
        } catch {
          /* try the next branch */
        }
      }
      if (text === undefined) throw new BrowseError("notFound", `${src.process.yamlFilename} of ${src.name} is not on ${tries.join(" or ")}; start from the empty template or another pipeline`);
      content = `# ${full}: a copy of ${src.name} (${src.process.yamlFilename}) to try things out\n${text}`;
      queue = src.queue;
    }
    if (!queue?.id) queue = ((await c.get<{ value?: { id: number }[] }>("distributedtask/queues", { queueNames: "Azure Pipelines" })).value ?? [])[0];
    const yamlPath = `pipelines/${full}.yml`;
    const push = await rc.post<{ commits?: { commitId: string }[] }>(`${rc.repoPath()}/pushes`, {
      refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: ZERO }],
      commits: [{ comment: `ci: draft pipeline ${full}`, parents: [baseRef.objectId], changes: [{ changeType: "add", item: { path: `/${yamlPath}` }, newContent: { content, contentType: "rawtext" } }] }],
    });
    const commit = push.commits?.[0]?.commitId ?? "";
    let made: { id: number; name: string };
    try {
      made = await c.post<{ id: number; name: string }>("build/definitions", {
        name: full,
        path: DRAFT_FOLDER,
        type: "build",
        quality: "definition",
        queueStatus: "enabled",
        process: { type: 2, yamlFilename: yamlPath },
        repository: { id: repo.id, name: repo.name, type: "TfsGit", defaultBranch: `refs/heads/${branch}` },
        ...(queue?.id ? { queue: { id: queue.id } } : {}),
      });
    } catch (e) {
      // no pipeline: the branch goes again, so nothing half-made stays behind
      await rc.post(`${rc.repoPath()}/refs`, [{ name: `refs/heads/${branch}`, oldObjectId: commit, newObjectId: ZERO }]).catch(() => undefined);
      throw e;
    }
    return { pipeline: { id: made.id, name: made.name, folder: DRAFT_FOLDER }, repo: repo.name, branch, startedFrom: base, yamlPath, commit, webUrl: defUrl(b, o.project, made.id) };
  });
}

export interface DraftRow {
  id: number;
  name: string;
  repo: string | null;
  branch: string | null;
  yamlPath: string | null;
  runs: number;
  latestRun: LatestRun | null;
  branchAhead: number | null;
  /** when the pipeline's newest revision was saved: for a draft (never edited here) when it was made */
  createdAt: string | null;
  mine: boolean;
  webUrl: string;
}

async function runCount(c: AdoClient, id: number): Promise<number> {
  return ((await c.get<{ value?: unknown[] }>("build/builds", { definitions: id, $top: 1000 })).value ?? []).length;
}

async function aheadOf(b: Browse, project: string, repoId: string | undefined, branch: string | null): Promise<number | null> {
  if (!repoId || !branch) return null;
  try {
    const rc = repoClientOf(b, project, repoId);
    const r = await rc.get<{ aheadCount?: number }>(`${rc.repoPath()}/stats/branches`, { name: branch });
    return r.aheadCount ?? null;
  } catch {
    return null;
  }
}

export async function browseDrafts(b: Browse, project: string): Promise<{ project: string; drafts: DraftRow[] }> {
  const me = await meOf(b);
  const c = b.client.forProject(project);
  return guarded(b, project, async () => {
    const defs = (await c.list<DefRaw>("build/definitions", { path: DRAFT_FOLDER, includeLatestBuilds: true, includeAllProperties: true })).filter(isDraftDef);
    const drafts: DraftRow[] = [];
    for (const d of defs) {
      const row = rowOfDef(b, project, d, me.id);
      drafts.push({ id: d.id, name: d.name, repo: row.repo, branch: row.defaultBranch, yamlPath: row.yamlPath, runs: await runCount(c, d.id), latestRun: row.latestRun, branchAhead: await aheadOf(b, project, d.repository?.id, row.defaultBranch), createdAt: d.createdDate ?? null, mine: row.mine, webUrl: row.webUrl });
    }
    return { project, drafts };
  });
}

/** Removes a draft pipeline and its branch; only `draft-*` in `\Drafts`, made by the signed-in user, on a branch that is not protected. */
export async function browseDraftDelete(b: Browse, project: string, id: number, o: { keepBranch?: boolean } = {}): Promise<{ deleted: { pipeline: { id: number; name: string }; runs: number; branch: string | null; repo: string | null }; runsKept: number; branchKept: string | null }> {
  const me = await meOf(b);
  const c = b.client.forProject(project);
  return guarded(b, project, async () => {
    const d = await c.get<DefRaw>(`build/definitions/${id}`);
    if (!isDraftDef(d)) throw new BrowseError("badInput", `${d.name} is not a draft (only pipelines named draft-... in ${DRAFT_FOLDER} are removed here)`);
    if (!me.id || d.authoredBy?.id?.toLowerCase() !== me.id.toLowerCase()) throw new BrowseError("noAccess", `${d.name} was made by ${d.authoredBy?.displayName ?? "someone else"}; only the one who made a draft removes it here`);
    const branch = short(d.repository?.defaultBranch);
    // the runs go first (Azure DevOps keeps the runs of a removed pipeline). A run holds the automatic retention leases of its own
    // pipeline ("Pipeline:<id>", "Branch:<repo>:<ref>"): those go with it; a lease of something else (a release, a person) keeps the
    // run, counted in runsKept
    const ids = ((await c.get<{ value?: { id: number }[] }>("build/builds", { definitions: id, $top: 1000 })).value ?? []).map((x) => x.id);
    let runs = 0;
    for (const r of ids) {
      try {
        const leases = (await c.get<{ value?: { leaseId: number; ownerId?: string; definitionId?: number }[] }>(`build/builds/${r}/leases`).catch(() => ({ value: [] }))).value ?? [];
        const own = leases.filter((l) => /^(pipeline|branch):/i.test(l.ownerId ?? "") && (l.definitionId === undefined || l.definitionId === id) && (!/^pipeline:/i.test(l.ownerId ?? "") || (l.ownerId ?? "").toLowerCase() === `pipeline:${id}`));
        if (own.length < leases.length) continue;
        if (own.length) await c.del("build/retention/leases", { ids: own.map((l) => l.leaseId).join(",") });
        await c.del(`build/builds/${r}`);
        runs++;
      } catch {
        /* kept: counted in runsKept */
      }
    }
    await c.del(`build/definitions/${id}`);
    let branchGone: string | null = null;
    let kept: string | null = null;
    // only a branch made for the draft goes with it: its name holds "draft-" (New Draft Pipeline names it so)
    if (branch && o.keepBranch) kept = `branch ${branch} is kept, as asked`;
    else if (branch && !/draft-/i.test(branch)) kept = `branch ${branch} is kept: its name does not say it was made for the draft`;
    else if (branch && protectedBranch(branch)) kept = `branch ${branch} is protected and is kept`;
    else if (branch && d.repository?.id) {
      const rc = repoClientOf(b, project, d.repository.id);
      const repo = await rc.get<{ defaultBranch?: string }>(rc.repoPath());
      const ref = ((await rc.get<{ value?: { name: string; objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: `heads/${branch}` })).value ?? []).find((r) => r.name === `refs/heads/${branch}`);
      if (ref && short(repo.defaultBranch) !== branch) {
        await rc.post(`${rc.repoPath()}/refs`, [{ name: ref.name, oldObjectId: ref.objectId, newObjectId: ZERO }]);
        branchGone = branch;
      } else if (ref) kept = `branch ${branch} is the default branch of the repository and is kept`;
    }
    return { deleted: { pipeline: { id: d.id, name: d.name }, runs, branch: branchGone, repo: d.repository?.name ?? null }, runsKept: ids.length - runs, branchKept: kept };
  });
}
