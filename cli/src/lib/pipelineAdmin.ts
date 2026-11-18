import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { confirmDelete, cut, day, emit, encode, guardStage, table, top, type Flags } from "./devops.js";

const PREVIEW = { "api-version": "7.1-preview.1" };

interface Definition {
  id: number;
  name: string;
  path?: string;
  queueStatus?: string;
  revision?: number;
  repository?: { id?: string; name?: string; type?: string; defaultBranch?: string };
  process?: { type?: number; yamlFilename?: string };
  variableGroups?: { id: number; name?: string }[];
  triggers?: { triggerType?: string }[];
}

async function findDef(c: AdoClient, ref: string): Promise<Definition> {
  if (/^\d+$/.test(ref)) return c.get<Definition>(`build/definitions/${ref}`);
  const defs = await c.list<Definition>("build/definitions", { name: ref });
  const hit = defs.filter((d) => d.name.toLowerCase() === ref.toLowerCase());
  if (hit.length !== 1) throw new AihubError(hit.length ? `pipeline name '${ref}' is not unique; use the id` : `pipeline '${ref}' not found; see: aihub pipeline def list`);
  return c.get<Definition>(`build/definitions/${hit[0].id}`);
}

const line = (d: Definition) => `${String(d.id).padEnd(5)} ${d.name}${d.path && d.path !== "\\" ? `  (${d.path})` : ""}  ${d.process?.yamlFilename ?? (d.process?.type === 1 ? "classic" : "")}${d.queueStatus && d.queueStatus !== "enabled" ? `  [${d.queueStatus}]` : ""}`;

export async function defList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const q: Record<string, string | number> = { $top: top(v, 100) };
  if (typeof v.filter === "string") q.name = `*${v.filter}*`;
  const defs = await c.list<Definition>("build/definitions", q);
  emit(ctx, v, defs.map((d) => ({ id: d.id, name: d.name, path: d.path, yaml: d.process?.yamlFilename, queueStatus: d.queueStatus })), defs.length ? defs.map(line).join("\n") : "no pipelines match");
}

export async function defShow(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const d = await findDef(c, ref);
  const data = { id: d.id, name: d.name, folder: d.path, queueStatus: d.queueStatus, repository: d.repository?.name, branch: d.repository?.defaultBranch, yaml: d.process?.yamlFilename, variableGroups: (d.variableGroups ?? []).map((g) => g.name ?? g.id), triggers: (d.triggers ?? []).map((t) => t.triggerType) };
  emit(ctx, v, data, [line(d), `  repository ${data.repository ?? "-"} @ ${String(data.branch ?? "-").replace("refs/heads/", "")}`, `  triggers ${data.triggers.join(", ") || "none"}`, `  variable groups ${data.variableGroups.join(", ") || "none"}`].join("\n"));
}

export async function defCreate(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  const yaml = typeof v.yaml === "string" ? v.yaml : "";
  if (!name || !yaml) throw new AihubError("aihub pipeline def create needs --name <pipeline name> and --yaml <path of the YAML file in the repository>");
  guardStage(name, v, "pipeline");
  const repo = await c.get<{ id: string; name: string }>(c.repoPath());
  const body = { name, folder: typeof v.folder === "string" ? v.folder : "\\", configuration: { type: "yaml", path: yaml.replace(/^\//, ""), repository: { id: repo.id, name: repo.name, type: "azureReposGit" } } };
  const made = await c.post<{ id?: number; name?: string }>("pipelines", body, { "api-version": "7.1" });
  emit(ctx, v, { id: made.id, name, yaml }, trace.dryRun ? `dry-run: would create pipeline '${name}' from ${yaml}` : `created pipeline #${made.id} '${name}' from ${yaml}`);
}

export async function defUpdate(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const d = await findDef(c, ref);
  guardStage(d.name, v, "pipeline");
  const changes: string[] = [];
  const body: any = { ...d };
  if (typeof v.name === "string") (body.name = v.name), changes.push(`name -> ${v.name}`);
  if (typeof v.folder === "string") (body.path = v.folder), changes.push(`folder -> ${v.folder}`);
  if (typeof v.yaml === "string") (body.process = { ...d.process, yamlFilename: v.yaml.replace(/^\//, "") }), changes.push(`yaml -> ${v.yaml}`);
  if (typeof v.status === "string") {
    if (!["enabled", "paused", "disabled"].includes(v.status)) throw new AihubError("--status must be enabled, paused or disabled");
    body.queueStatus = v.status;
    changes.push(`status -> ${v.status}`);
  }
  if (!changes.length) throw new AihubError("nothing to change: give --name, --folder, --yaml or --status");
  await c.put(`build/definitions/${d.id}`, body);
  emit(ctx, v, { id: d.id, changes }, `${trace.dryRun ? "dry-run: would update" : "updated"} pipeline #${d.id} '${d.name}': ${changes.join(", ")}`);
}

export async function defDelete(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const d = await findDef(c, ref);
  guardStage(d.name, v, "pipeline");
  confirmDelete(v, `pipeline '${d.name}'`);
  await c.del(`build/definitions/${d.id}`);
  emit(ctx, v, { id: d.id, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} pipeline #${d.id} '${d.name}'`);
}

/** The YAML pipeline of this repository that runs `file` (its yamlFilename), else the first YAML pipeline of the repository. */
export async function pipelineForFile(c: AdoClient, root: string, file: string | undefined): Promise<string> {
  const repo = await c.get<{ id: string }>(c.repoPath());
  const defs = (await c.list<Definition>("build/definitions", { repositoryId: repo.id, repositoryType: "TfsGit", includeAllProperties: true })).filter((d) => d.process?.yamlFilename);
  if (!defs.length) throw new AihubError("this repository has no YAML pipeline to validate against; create one with: aihub pipeline def create --name N --yaml <file>");
  const slash = (p: string) => p.replace(/\\/g, "/");
  const rel = file ? slash(resolve(file)).replace(slash(resolve(root)), "").replace(/^[/]/, "").toLowerCase() : "";
  const hit = defs.find((d) => String(d.process?.yamlFilename).replace(/^[/]/, "").toLowerCase() === rel) ?? defs[0];
  return String(hit.id);
}

/** Expand the YAML of a pipeline without running it: the final YAML, or the errors Azure DevOps reports. */
export async function validate(c: AdoClient, ctx: Ctx, v: Flags, ref: string, conventions: { name?: string; requiredTemplates?: string[] }[] = []): Promise<void> {
  const d = await findDef(c, ref);
  const required = conventions.find((p) => String(p.name).toLowerCase() === d.name.toLowerCase() || String(p.name) === String(d.id))?.requiredTemplates ?? [];
  const body: any = { previewRun: true, resources: { repositories: { self: { refName: `refs/heads/${typeof v.branch === "string" ? v.branch : String(d.repository?.defaultBranch ?? "main").replace("refs/heads/", "")}` } } } };
  if (typeof v.file === "string") {
    try {
      body.yamlOverride = readFileSync(v.file, "utf8");
    } catch (e) {
      throw new AihubError(`cannot read ${v.file}: ${(e as Error).message}`);
    }
  }
  try {
    const r = await c.request<{ finalYaml?: string }>("POST", `pipelines/${d.id}/runs`, { body, query: { "api-version": "7.1" } });
    const final = r.data.finalYaml ?? "";
    const missing = required.filter((t) => !final.includes(t) && !(typeof body.yamlOverride === "string" && body.yamlOverride.includes(t)));
    const note = missing.length ? `\n  team convention (team.yaml pipelines[].requiredTemplates): missing ${missing.join(", ")}` : "";
    emit(ctx, v, { pipeline: d.name, valid: true, finalYamlLines: final.split("\n").length, missingRequiredTemplates: missing }, v["show-yaml"] ? final : `pipeline '${d.name}': the YAML is valid (${final.split("\n").length} lines after template expansion; aihub pipeline expand prints it)${note}`);
  } catch (e) {
    if (!(e instanceof AihubError) || !/failed \(400\)|\(400\)/.test(e.message)) throw e;
    const why = e.message.replace(/^Azure DevOps POST [^:]*: ?/, "");
    if (v.json) ctx.out(JSON.stringify({ pipeline: d.name, valid: false, errors: [why] }, null, 2));
    throw new AihubError(`pipeline '${d.name}': the YAML is NOT valid: ${why}`);
  }
}

export async function cancel(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const b = await c.get<{ id: number; status: string; definition?: { name?: string } }>(`build/builds/${run}`);
  guardStage(b.definition?.name ?? "", v, "pipeline");
  if (b.status === "completed") return emit(ctx, v, { run, cancelled: false }, `run ${run} is already completed`);
  await c.patch(`build/builds/${run}`, { status: "cancelling" });
  emit(ctx, v, { run, cancelled: !trace.dryRun }, `${trace.dryRun ? "dry-run: would cancel" : "cancelling"} run ${run}${b.definition?.name ? ` of ${b.definition.name}` : ""}`);
}

export async function artifacts(c: AdoClient, ctx: Ctx, v: Flags, action: string, run: number): Promise<void> {
  const r = await c.get<{ value?: { id: number; name: string; resource?: { type?: string; downloadUrl?: string; properties?: { artifactsize?: string } } }[] }>(`build/builds/${run}/artifacts`);
  const list = r.value ?? [];
  if (action === "list") return emit(ctx, v, list.map((a) => ({ name: a.name, type: a.resource?.type, bytes: Number(a.resource?.properties?.artifactsize ?? 0) })), list.length ? table([["artifact", "type", "size"], ...list.map((a) => [a.name, a.resource?.type ?? "", a.resource?.properties?.artifactsize ? `${Math.round(Number(a.resource.properties.artifactsize) / 1024)} KB` : ""])]) : `run ${run} has no artifacts`);
  const name = typeof v.artifact === "string" ? v.artifact : typeof v.download === "string" ? v.download : list.length === 1 ? list[0].name : "";
  const a = list.find((x) => x.name === name);
  if (!a) throw new AihubError(`give --artifact <name>; this run has: ${list.map((x) => x.name).join(", ") || "none"}`);
  const url = a.resource?.downloadUrl;
  if (!url) throw new AihubError(`artifact '${a.name}' has no download address (type ${a.resource?.type})`);
  if (trace.dryRun) return emit(ctx, v, { artifact: a.name }, `dry-run: would download ${a.name}`);
  const out = resolve(typeof v.out === "string" ? v.out : ".");
  mkdirSync(out, { recursive: true });
  const bytes = await c.fetchBytes(url);
  const file = join(out, `${a.name.replace(/[^\w.-]/g, "_")}.zip`);
  writeFileSync(file, bytes);
  emit(ctx, v, { artifact: a.name, file, bytes: bytes.length }, `downloaded ${a.name} (${Math.round(bytes.length / 1024)} KB) to ${file}`);
}

// ---- environments, checks, approvals -------------------------------------------------------

interface Environment {
  id: number;
  name: string;
  description?: string;
}

async function findEnv(c: AdoClient, ref: string): Promise<Environment> {
  if (/^\d+$/.test(ref)) return c.get<Environment>(`pipelines/environments/${ref}`, PREVIEW);
  const envs = await c.list<Environment>("pipelines/environments", { ...PREVIEW, name: ref });
  const hit = envs.find((e) => e.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new AihubError(`environment '${ref}' not found; see: aihub pipeline env list`);
  return hit;
}

export async function envList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await c.list<Environment>("pipelines/environments", PREVIEW);
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = all.filter((e) => !f || e.name.toLowerCase().includes(f)).slice(0, top(v, 100));
  emit(ctx, v, rows, rows.length ? table([["id", "environment", "description"], ...rows.map((e) => [String(e.id), e.name, cut(e.description, 60)])]) : "no environments match");
}

export async function envShow(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const e = await findEnv(c, ref);
  const full = await c.get<any>(`pipelines/environments/${e.id}`, { ...PREVIEW, expands: "resourceReferences" });
  const res = (full.resources ?? []).map((r: any) => `${r.type}:${r.name}`);
  emit(ctx, v, { id: e.id, name: e.name, description: e.description, resources: res }, [`#${e.id} ${e.name}${e.description ? ` - ${e.description}` : ""}`, `  resources ${res.join(", ") || "none"}`].join("\n"));
}

export async function envCreate(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  if (!name) throw new AihubError("aihub pipeline env create needs --name");
  guardStage(name, v, "environment");
  const made = await c.post<{ id?: number }>("pipelines/environments", { name, description: typeof v.description === "string" ? v.description : "" }, PREVIEW);
  emit(ctx, v, { id: made.id, name }, `${trace.dryRun ? "dry-run: would create" : "created"} environment '${name}'${made.id ? ` (#${made.id})` : ""}`);
}

export async function envDelete(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const e = await findEnv(c, ref);
  guardStage(e.name, v, "environment");
  confirmDelete(v, `environment '${e.name}'`);
  await c.del(`pipelines/environments/${e.id}`, PREVIEW);
  emit(ctx, v, { id: e.id, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} environment '${e.name}'`);
}

export async function envDeployments(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const e = await findEnv(c, ref);
  const r = await c.get<{ value?: any[] }>(`pipelines/environments/${e.id}/environmentdeploymentrecords`, { ...PREVIEW, top: top(v, 20) });
  const rows = (r.value ?? []).map((d) => ({ run: d.owner?.id, pipeline: d.definition?.name, stage: d.stageName, result: d.result, date: day(d.startTime) }));
  emit(ctx, v, rows, rows.length ? table([["run", "pipeline", "stage", "result", "date"], ...rows.map((d) => [String(d.run ?? ""), d.pipeline ?? "", d.stage ?? "", d.result ?? "", d.date])]) : `no deployments to '${e.name}'`);
}

export async function envChecks(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const e = await findEnv(c, ref);
  const r = await c.get<{ value?: any[] }>("pipelines/checks/configurations", { ...PREVIEW, resourceType: "environment", resourceId: String(e.id), $expand: "settings" });
  const rows = (r.value ?? []).map((k) => ({ id: k.id, type: k.type?.name, timeout: k.timeout, approvers: (k.settings?.approvers ?? []).map((a: any) => a.displayName ?? a.uniqueName ?? a.id) }));
  emit(ctx, v, rows, rows.length ? rows.map((k) => `#${k.id} ${k.type}${k.approvers.length ? ` (${k.approvers.join(", ")})` : ""}${k.timeout ? ` timeout ${k.timeout} min` : ""}`).join("\n") : `'${e.name}' has no approvals or checks`);
}

interface Approval {
  id: string;
  status: string;
  createdOn?: string;
  pipeline?: { id?: number; name?: string; owner?: { id?: number; name?: string } };
  resource?: { type?: string; name?: string };
  steps?: { assignedApprover?: { displayName?: string }; status?: string; comment?: string }[];
}

/**
 * The approvals API does not say which environment an approval guards. The run's timeline links the approval to its
 * checkpoint, and the checkpoint's check runs name the environment. Failing to find it leaves the field empty.
 */
async function withEnvironment(c: AdoClient, a: Approval): Promise<Approval> {
  const run = a.pipeline?.owner?.id;
  if (a.resource?.name || !run) return a;
  try {
    const t = await c.get<{ records?: { id: string; type: string; parentId?: string | null }[] }>(`build/builds/${run}/timeline`);
    const point = (t.records ?? []).find((r) => r.id === a.id && r.parentId);
    if (!point?.parentId) return a;
    const checks = await c.get<{ checkRuns?: { checkConfigurationRef?: { resource?: { type?: string; name?: string } } }[] }>(`pipelines/checks/runs/${encode(point.parentId)}`, { ...PREVIEW, $expand: "resources" });
    const resource = (checks.checkRuns ?? []).map((k) => k.checkConfigurationRef?.resource).find((x) => x?.name);
    return resource ? { ...a, resource } : a;
  } catch {
    return a;
  }
}

export async function approvalsList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<{ value?: Approval[] }>("pipelines/approvals", { ...PREVIEW, state: typeof v.state === "string" ? v.state : "pending", $expand: "steps" });
  const found = await Promise.all((r.value ?? []).slice(0, top(v, 50)).map((a) => withEnvironment(c, a)));
  const rows = found.map((a) => ({ id: a.id, status: a.status, environment: a.resource?.name, pipeline: a.pipeline?.name ?? a.pipeline?.owner?.name, run: a.pipeline?.owner?.id, since: day(a.createdOn), approvers: (a.steps ?? []).map((s) => s.assignedApprover?.displayName).filter(Boolean) }));
  emit(ctx, v, rows, rows.length ? table([["approval", "status", "environment", "pipeline", "run"], ...rows.map((a) => [a.id, a.status, a.environment ?? "", a.pipeline ?? "", String(a.run ?? "")])]) : "no approvals match");
}

/** The answer of an approval names no environment: read the environments the run's pipeline YAML deploys to. */
async function approvalEnvironments(c: AdoClient, a: Approval): Promise<string[]> {
  const runId = a.pipeline?.owner?.id;
  if (!runId) return [];
  try {
    const b = await c.get<{ definition?: { id?: number }; sourceVersion?: string }>(`build/builds/${runId}`);
    if (!b.definition?.id) return [];
    const d = await c.get<Definition>(`build/definitions/${b.definition.id}`);
    if (!d.process?.yamlFilename || !d.repository?.id) return [];
    const text = await c.getText(`git/repositories/${d.repository.id}/items`, { path: d.process.yamlFilename, "versionDescriptor.version": b.sourceVersion ?? "", "versionDescriptor.versionType": "commit", $format: "text" });
    const names = [...text.matchAll(/^\s*(?:-\s*)?environment:(?:\s*\n\s+name:)?\s*['"]?([\w.-]+)/gm)].map((m) => m[1]);
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/** Approve or reject. Refused when the environment or the pipeline is ACC or PRD, unless --allow-env names that stage. */
export async function approvalsDecide(c: AdoClient, ctx: Ctx, v: Flags, id: string, approve: boolean): Promise<void> {
  const a = await withEnvironment(c, await c.get<Approval>(`pipelines/approvals/${encode(id)}`, { ...PREVIEW, $expand: "steps" }));
  const envs = a.resource?.name ? [a.resource.name] : await approvalEnvironments(c, a);
  for (const n of [...envs, a.pipeline?.name, a.pipeline?.owner?.name]) if (n) guardStage(n, v, "approval for");
  if (!envs.length && !(typeof v["allow-env"] === "string" && v["allow-env"])) throw new AihubError(`cannot tell which environment approval ${id} belongs to (the answer names none and the pipeline YAML shows none); give --allow-env <stage> only when the developer asked for that stage`);
  if (a.status !== "pending") throw new AihubError(`approval ${id} is ${a.status}, not pending`);
  await c.patch("pipelines/approvals", [{ approvalId: id, status: approve ? "approved" : "rejected", comment: typeof v.comment === "string" ? v.comment : "" }], PREVIEW);
  emit(ctx, v, { approval: id, decision: approve ? "approved" : "rejected", environment: a.resource?.name }, `${trace.dryRun ? "dry-run: would " + (approve ? "approve" : "reject") : approve ? "approved" : "rejected"} approval ${id} (${a.resource?.name ?? a.pipeline?.name ?? ""})`);
}

// ---- secure files and service connections: metadata only ------------------------------------------

export async function secureFiles(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<{ value?: { id: string; name: string; createdBy?: { displayName?: string }; modifiedOn?: string }[] }>("distributedtask/securefiles", PREVIEW);
  const rows = (r.value ?? []).map((f) => ({ id: f.id, name: f.name, modified: day(f.modifiedOn), by: f.createdBy?.displayName }));
  emit(ctx, v, rows, rows.length ? table([["name", "modified", "by"], ...rows.map((f) => [f.name, f.modified, f.by ?? ""])]) : "no secure files (their content is never shown)");
}

interface Endpoint {
  id: string;
  name: string;
  type: string;
  isShared?: boolean;
  isReady?: boolean;
  url?: string;
  authorization?: { scheme?: string };
  description?: string;
}

const endpointView = (e: Endpoint) => ({ id: e.id, name: e.name, type: e.type, scheme: e.authorization?.scheme, shared: !!e.isShared, ready: e.isReady !== false, url: e.url });

export async function connections(c: AdoClient, ctx: Ctx, v: Flags, ref?: string): Promise<void> {
  const all = await c.list<Endpoint>("serviceendpoint/endpoints", { "api-version": "7.1" });
  const f = (ref ?? (typeof v.filter === "string" ? v.filter : "")).toLowerCase();
  const rows = all.filter((e) => !f || e.name.toLowerCase().includes(f)).slice(0, top(v, 100)).map(endpointView);
  if (ref && rows.length !== 1 && !rows.some((r) => r.name.toLowerCase() === f)) throw new AihubError(rows.length ? `'${ref}' matches ${rows.length} service connections; be more exact` : `service connection '${ref}' not found`);
  emit(ctx, v, rows, rows.length ? table([["name", "type", "auth", "ready"], ...rows.map((e) => [e.name, e.type, e.scheme ?? "", e.ready ? "yes" : "NO"])]) : "no service connections match (credentials are never shown)");
}
