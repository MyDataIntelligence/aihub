import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, emit, encode, guardStage, readJsonFile, stdinText, table, top, type Flags } from "./devops.js";

/** Variable groups are the Library of Azure DevOps. Preview API on purpose: it is the one the portal uses. */
const VG = "distributedtask/variablegroups";
const PREVIEW = { "api-version": "7.1-preview.2" };

export interface VarValue {
  value?: string | null;
  isSecret?: boolean;
  enabled?: boolean;
  contentType?: string;
  expires?: string;
}

export interface VariableGroup {
  id: number;
  name: string;
  description?: string;
  type?: string; // Vsts | AzureKeyVault
  variables: Record<string, VarValue>;
  providerData?: { serviceEndpointId?: string; vault?: string };
  variableGroupProjectReferences?: unknown[];
}

const REDACTED = "***";

/** What may be shown: secret values and Key Vault values are never printed. */
export function safeView(g: VariableGroup): object {
  const vars: Record<string, { value?: string; secret?: boolean; keyVault?: boolean }> = {};
  for (const [k, x] of Object.entries(g.variables ?? {})) {
    vars[k] = g.type === "AzureKeyVault" ? { keyVault: true } : x.isSecret ? { value: REDACTED, secret: true } : { value: x.value ?? "" };
  }
  return { id: g.id, name: g.name, type: g.type ?? "Vsts", description: g.description ?? "", keyVault: g.type === "AzureKeyVault" ? g.providerData?.vault : undefined, variables: vars };
}

function line(name: string, x: { value?: string; secret?: boolean; keyVault?: boolean }): string {
  return x.keyVault ? `  ${name} = keyvault secret` : x.secret ? `  ${name} = ${REDACTED} (secret)` : `  ${name} = ${x.value}`;
}

function describeGroup(g: VariableGroup): string {
  const v = safeView(g) as { variables: Record<string, any> };
  const n = Object.keys(v.variables).length;
  const kv = g.type === "AzureKeyVault" ? `, Key Vault ${g.providerData?.vault ?? ""}` : "";
  return [`#${g.id} ${g.name} (${g.type ?? "Vsts"}${kv}) ${n} variable(s)${g.description ? ` - ${cut(g.description, 60)}` : ""}`, ...Object.entries(v.variables).map(([k, x]) => line(k, x))].join("\n");
}

export async function findGroup(c: AdoClient, ref: string): Promise<VariableGroup> {
  if (/^\d+$/.test(ref)) {
    const g = await c.get<VariableGroup>(`${VG}/${ref}`, PREVIEW);
    if (!g || !g.id) throw new AihubError(`variable group ${ref} not found; see: aihub library list`);
    return g;
  }
  const found = await c.list<VariableGroup>(VG, { ...PREVIEW, groupName: ref });
  const exact = found.filter((g) => g.name.toLowerCase() === ref.toLowerCase());
  if (exact.length !== 1) throw new AihubError(exact.length ? `variable group name '${ref}' is not unique` : `variable group '${ref}' not found; see: aihub library list`);
  return exact[0];
}

export async function libraryList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await c.list<VariableGroup>(VG, PREVIEW);
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = all.filter((g) => !f || g.name.toLowerCase().includes(f)).slice(0, top(v, 100));
  emit(ctx, v, rows.map((g) => ({ id: g.id, name: g.name, type: g.type ?? "Vsts", variables: Object.keys(g.variables ?? {}).length })), rows.length ? table([["id", "name", "type", "vars"], ...rows.map((g) => [String(g.id), g.name, g.type ?? "Vsts", String(Object.keys(g.variables ?? {}).length)])]) : "no variable groups match");
}

export async function libraryShow(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const g = await findGroup(c, ref);
  emit(ctx, v, safeView(g), describeGroup(g));
}

async function projectRef(c: AdoClient): Promise<{ id: string; name: string }> {
  const r = await c.request<{ id: string; name: string }>("GET", `projects/${encode(c.remote.project)}`, { orgLevel: true, query: { "api-version": "7.1" } });
  return { id: r.data.id, name: r.data.name };
}

/** A value from --value, --value-stdin (secrets) or a file of plain variables. */
function valueOf(ctx: Ctx, v: Flags, secret: boolean): string {
  if (v["value-stdin"]) return stdinText(ctx);
  if (typeof v.value === "string") {
    if (secret) throw new AihubError("a secret value goes in with --value-stdin, never on the command line");
    return v.value;
  }
  throw new AihubError("give --value <text> (plain) or --value-stdin (secret)");
}

export async function libraryCreate(c: AdoClient, ctx: Ctx, v: Flags, name: string): Promise<void> {
  guardStage(name, v, "variable group");
  const vars: Record<string, VarValue> = {};
  let type = "Vsts";
  let providerData: VariableGroup["providerData"];
  if (typeof v["vars-file"] === "string") {
    const j = readJsonFile(v["vars-file"]);
    for (const [k, x] of Object.entries(j as Record<string, unknown>)) {
      if (x && typeof x === "object") throw new AihubError(`--vars-file takes plain "name": "value" pairs; set secret '${k}' afterwards with: aihub library set --group ${name} --name ${k} --secret --value-stdin`);
      vars[k] = { value: String(x ?? ""), isSecret: false };
    }
  }
  if (typeof v.keyvault === "string") {
    const [conn, vault] = v.keyvault.split("/");
    if (!conn || !vault) throw new AihubError("--keyvault <service connection name>/<vault name>");
    const eps = await c.list<{ id: string; name: string }>("serviceendpoint/endpoints", { endpointNames: conn, "api-version": "7.1" });
    const ep = eps.find((e) => e.name.toLowerCase() === conn.toLowerCase());
    if (!ep) throw new AihubError(`service connection '${conn}' not found; see: aihub pipeline connections list`);
    type = "AzureKeyVault";
    providerData = { serviceEndpointId: ep.id, vault };
    const secrets = typeof v.secrets === "string" ? v.secrets.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!secrets.length) throw new AihubError("a Key Vault group needs --secrets <name>[,<name>...] (the secret names in the vault)");
    for (const s of secrets) vars[s] = { enabled: true, isSecret: true, contentType: "", value: null };
  }
  const p = await projectRef(c);
  const body = { name, type, description: typeof v.description === "string" ? v.description : "", variables: vars, providerData, variableGroupProjectReferences: [{ projectReference: p, name, description: typeof v.description === "string" ? v.description : "" }] };
  const made = await c.post<VariableGroup>(VG, body, PREVIEW);
  emit(ctx, v, safeView(made.id ? made : { ...body, id: 0 } as VariableGroup), trace.dryRun ? `dry-run: would create variable group '${name}' (${type}, ${Object.keys(vars).length} variable(s))` : `created ${describeGroup(made)}`);
}

async function putGroup(c: AdoClient, g: VariableGroup): Promise<VariableGroup> {
  // the group comes back with project references the server then refuses on a PUT: send the one this project needs
  const p = await projectRef(c);
  return c.put<VariableGroup>(`${VG}/${g.id}`, { ...g, variableGroupProjectReferences: [{ projectReference: p, name: g.name, description: g.description ?? "" }] }, PREVIEW);
}

export async function librarySet(c: AdoClient, ctx: Ctx, v: Flags, ref: string, name: string): Promise<void> {
  const g = await findGroup(c, ref);
  guardStage(g.name, v, "variable group");
  if (g.type === "AzureKeyVault") throw new AihubError(`'${g.name}' is a Key Vault group: its values live in the vault; change them there`);
  const secret = !!v.secret;
  const existing = g.variables?.[name];
  const value = valueOf(ctx, v, secret);
  g.variables = { ...g.variables, [name]: { value, isSecret: secret || (existing?.isSecret && !v.plain) ? true : false } };
  const done = await putGroup(c, g);
  const shown = secret || g.variables[name].isSecret ? `${REDACTED} (secret, ${value.length} chars)` : value;
  emit(ctx, v, { group: g.name, name, secret: !!g.variables[name].isSecret, changed: !trace.dryRun, updated: done?.id ?? g.id }, trace.dryRun ? `dry-run: would set ${name} in '${g.name}' = ${shown}` : `set ${name} in '${g.name}' = ${shown}`);
}

export async function libraryUnset(c: AdoClient, ctx: Ctx, v: Flags, ref: string, name: string): Promise<void> {
  const g = await findGroup(c, ref);
  guardStage(g.name, v, "variable group");
  if (!(name in (g.variables ?? {}))) throw new AihubError(`'${g.name}' has no variable '${name}'`);
  const { [name]: _gone, ...rest } = g.variables;
  g.variables = rest;
  await putGroup(c, g);
  emit(ctx, v, { group: g.name, removed: name }, trace.dryRun ? `dry-run: would remove ${name} from '${g.name}'` : `removed ${name} from '${g.name}'`);
}

export async function libraryDelete(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const g = await findGroup(c, ref);
  guardStage(g.name, v, "variable group");
  const p = await projectRef(c);
  await c.del(`${VG}/${g.id}`, { ...PREVIEW, projectIds: p.id });
  emit(ctx, v, { id: g.id, name: g.name, deleted: !trace.dryRun }, trace.dryRun ? `dry-run: would delete variable group '${g.name}'` : `deleted variable group '${g.name}'`);
}

/** Authorize a pipeline to use a group (the portal's "Pipeline permissions"). */
export async function libraryAuthorize(c: AdoClient, ctx: Ctx, v: Flags, ref: string, pipeline: string): Promise<void> {
  const g = await findGroup(c, ref);
  guardStage(g.name, v, "variable group");
  const defs = await c.list<{ id: number; name: string }>("build/definitions", { name: pipeline });
  const d = defs.find((x) => x.name.toLowerCase() === pipeline.toLowerCase() || String(x.id) === pipeline);
  if (!d) throw new AihubError(`pipeline '${pipeline}' not found; see: aihub pipeline def list`);
  await c.patch(`pipelines/pipelinePermissions/variablegroup/${g.id}`, { pipelines: [{ id: d.id, authorized: !v.revoke }] }, { "api-version": "7.1-preview.1" });
  emit(ctx, v, { group: g.name, pipeline: d.name, authorized: !v.revoke }, `${trace.dryRun ? "dry-run: would " : ""}${v.revoke ? "revoke" : "authorize"} pipeline '${d.name}' for '${g.name}'`);
}

/** Pipelines that use a group: the classic definitions' variable groups, and with --scan-yaml the `group:` entries of the YAML files of this repository. */
export async function libraryUsage(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const g = await findGroup(c, ref);
  const defs = await c.list<any>("build/definitions", { includeAllProperties: true });
  const used: { id: number; name: string; via: string }[] = [];
  for (const d of defs) {
    if ((d.variableGroups ?? []).some((x: any) => x.id === g.id)) used.push({ id: d.id, name: d.name, via: "definition" });
    else if (v["scan-yaml"] && d.process?.yamlFilename && d.repository?.id && d.repository.type === "TfsGit") {
      try {
        const text = await c.getText(`git/repositories/${d.repository.id}/items`, { path: d.process.yamlFilename, "versionDescriptor.version": String(d.repository.defaultBranch ?? "main").replace("refs/heads/", ""), "$format": "text" });
        if (new RegExp(`group:\\s*['"]?${g.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*$`, "im").test(text)) used.push({ id: d.id, name: d.name, via: `yaml ${d.process.yamlFilename}` });
      } catch {
        /* a definition whose YAML cannot be read is skipped */
      }
    }
  }
  emit(ctx, v, { group: g.name, usedBy: used }, used.length ? `'${g.name}' is used by:\n${used.map((u) => `  ${u.id} ${u.name} (${u.via})`).join("\n")}` : `no pipeline definition uses '${g.name}'${v["scan-yaml"] ? "" : " (add --scan-yaml to read the YAML files too)"}`);
}

/** Differences between two groups, secrets compared by presence only. */
export async function libraryDiff(c: AdoClient, ctx: Ctx, v: Flags, a: string, b: string): Promise<void> {
  const [ga, gb] = [await findGroup(c, a), await findGroup(c, b)];
  const names = [...new Set([...Object.keys(ga.variables ?? {}), ...Object.keys(gb.variables ?? {})])].sort();
  const view = (g: VariableGroup, n: string) => {
    const x = g.variables?.[n];
    return x === undefined ? undefined : g.type === "AzureKeyVault" || x.isSecret ? REDACTED : String(x.value ?? "");
  };
  const rows = names.map((n) => ({ name: n, [ga.name]: view(ga, n), [gb.name]: view(gb, n), same: view(ga, n) === view(gb, n) && view(ga, n) !== REDACTED }));
  const diff = rows.filter((r) => !(r.same || (r[ga.name] === REDACTED && r[gb.name] === REDACTED)));
  emit(ctx, v, { a: ga.name, b: gb.name, differences: diff }, diff.length ? table([["variable", ga.name, gb.name], ...diff.map((r) => [r.name, String(r[ga.name] ?? "(missing)"), String(r[gb.name] ?? "(missing)")])]) : `'${ga.name}' and '${gb.name}' have the same variables (secrets compared by name only)`);
}
