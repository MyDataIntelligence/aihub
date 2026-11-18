import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AihubError } from "./errors.js";
import type { Project, Runner } from "./dbt-run.js";
import { clean } from "./dbt-run.js";

/** The dbt manifest, parsed into what the commands need: models, tests, exposures, the graph. */
export interface Node {
  id: string;
  kind: string; // model | seed | snapshot | test | unit_test | source | exposure | macro | other
  name: string;
  /** file path inside the project, forward slashes */
  file: string;
  /** the YAML file that documents it (models, seeds), forward slashes */
  yml?: string;
  materialized?: string;
  relation?: string;
  description: string;
  tags: string[];
  columns: string[];
  macros: string[];
  parents: string[];
  children: string[];
  /** a test's model or source */
  attached?: string;
  testKind?: string;
  /** exposure fields */
  expo?: { type?: string; maturity?: string; owner?: string; url?: string; fabric: string[] };
  sourceName?: string;
  hasFreshness?: boolean;
  package: string;
}

export interface Manifest {
  version: string;
  project: string;
  nodes: Map<string, Node>;
  byName: Map<string, Node>;
  macroUsers: Map<string, string[]>;
}

const slash = (p: string | undefined): string => (p ?? "").replace(/\\/g, "/");
const strip = (p: string | undefined): string => slash(p).replace(/^[\w-]+:\/\//, "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

function fabricOf(meta: any): string[] {
  const m = meta?.fabric_item ?? meta?.fabric_items ?? meta?.fabric;
  return list(m);
}

export function parseManifest(j: any, project: string): Manifest {
  const nodes = new Map<string, Node>();
  const parents: Record<string, string[]> = j.parent_map ?? {};
  const children: Record<string, string[]> = j.child_map ?? {};
  const base = (id: string, kind: string, o: any): Node => ({
    id,
    kind,
    name: o.name ?? id,
    file: slash(o.original_file_path),
    yml: o.patch_path ? strip(o.patch_path) : undefined,
    materialized: o.config?.materialized,
    relation: o.relation_name ? String(o.relation_name).replace(/"/g, "") : undefined,
    description: String(o.description ?? ""),
    tags: list(o.tags ?? o.config?.tags),
    columns: Object.keys(o.columns ?? {}),
    macros: o.depends_on?.macros ?? [],
    parents: parents[id] ?? o.depends_on?.nodes ?? [],
    children: children[id] ?? [],
    package: String(o.package_name ?? ""),
  });
  for (const [id, o] of Object.entries<any>(j.nodes ?? {})) {
    const rt = String(o.resource_type);
    const kind = ["model", "seed", "snapshot"].includes(rt) ? rt : rt === "test" ? "test" : "other";
    if (kind === "other") continue;
    const n = base(id, kind, o);
    if (kind === "test") {
      n.attached = o.attached_node ?? o.depends_on?.nodes?.find((x: string) => /^(model|seed|snapshot|source)\./.test(x));
      n.testKind = o.test_metadata?.name ?? "singular";
    }
    nodes.set(id, n);
  }
  for (const [id, o] of Object.entries<any>(j.unit_tests ?? {})) {
    const n = base(id, "unit_test", o);
    n.attached = o.depends_on?.nodes?.[0];
    nodes.set(id, n);
  }
  for (const [id, o] of Object.entries<any>(j.sources ?? {})) {
    const n = base(id, "source", o);
    n.name = `${o.source_name}.${o.name}`;
    n.sourceName = o.source_name;
    n.yml = n.file;
    n.relation = o.relation_name ? String(o.relation_name).replace(/"/g, "") : undefined;
    n.hasFreshness = !!(o.freshness?.warn_after?.count || o.freshness?.error_after?.count || o.loaded_at_field);
    nodes.set(id, n);
  }
  for (const [id, o] of Object.entries<any>(j.exposures ?? {})) {
    const n = base(id, "exposure", o);
    n.parents = parents[id] ?? o.depends_on?.nodes ?? [];
    n.expo = { type: o.type, maturity: o.maturity, owner: o.owner?.name ?? o.owner?.email, url: o.url, fabric: fabricOf(o.meta) };
    nodes.set(id, n);
  }
  const macroUsers = new Map<string, string[]>();
  for (const [id, o] of Object.entries<any>(j.macros ?? {})) {
    const n = base(id, "macro", o);
    n.macros = o.depends_on?.macros ?? [];
    nodes.set(id, n);
  }
  for (const n of nodes.values()) for (const m of n.macros) macroUsers.set(m, [...(macroUsers.get(m) ?? []), n.id]);
  const byName = new Map<string, Node>();
  for (const n of nodes.values()) if (["model", "seed", "snapshot"].includes(n.kind) && n.package === project) byName.set(n.name, n);
  return { version: String(j.metadata?.dbt_version ?? "?"), project, nodes, byName, macroUsers };
}

const newest = (dir: string, exts: RegExp, depth = 0): number => {
  let t = 0;
  let es: import("node:fs").Dirent[];
  try {
    es = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of es) {
    if (e.isDirectory()) {
      if (["target", "dbt_packages", "logs", "node_modules"].includes(e.name) || e.name.startsWith(".") || depth > 6) continue;
      t = Math.max(t, newest(join(dir, e.name), exts, depth + 1));
    } else if (exts.test(e.name)) t = Math.max(t, statSync(join(dir, e.name)).mtimeMs);
  }
  return t;
};

export const manifestPath = (p: Project): string => join(p.dir, "target", "manifest.json");

/** `target/manifest.json`, parsed again with `dbt parse` when it is missing or older than a project file. */
export function loadManifest(p: Project, runner: Runner, o: { refresh?: boolean } = {}): Manifest {
  const f = manifestPath(p);
  const stale = !existsSync(f) || (o.refresh ?? false) || statSync(f).mtimeMs < newest(p.dir, /\.(sql|ya?ml|csv|py|md)$/i);
  if (stale) {
    const r = runner.run(["parse"], 300_000);
    if (r.status !== 0 && !existsSync(f)) throw new AihubError(`dbt parse failed (exit ${r.status}):\n${clean(r.stdout + r.stderr).split("\n").slice(-15).join("\n")}`);
  }
  try {
    return parseManifest(JSON.parse(readFileSync(f, "utf8")), p.info.name);
  } catch {
    throw new AihubError(`cannot read ${f}: run \`aihub dbt parse\``);
  }
}

/** Everything below `ids` in the graph (not the ids themselves), in discovery order. */
export function downstream(m: Manifest, ids: string[], depth = Infinity): string[] {
  const seen = new Set(ids);
  const out: string[] = [];
  let level = ids;
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = [];
    for (const id of level) for (const c of m.nodes.get(id)?.children ?? []) if (!seen.has(c) && m.nodes.has(c)) (seen.add(c), out.push(c), next.push(c));
    level = next;
  }
  return out;
}

export function upstream(m: Manifest, ids: string[], depth = Infinity): string[] {
  const seen = new Set(ids);
  const out: string[] = [];
  let level = ids;
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = [];
    for (const id of level) for (const c of m.nodes.get(id)?.parents ?? []) if (!seen.has(c) && m.nodes.has(c)) (seen.add(c), out.push(c), next.push(c));
    level = next;
  }
  return out;
}

export function findNode(m: Manifest, name: string): Node {
  const hit = m.byName.get(name) ?? [...m.nodes.values()].find((n) => n.id === name || (n.kind === "source" && n.name === name) || (n.kind === "exposure" && n.name === name));
  if (!hit) throw new AihubError(`no model, seed, snapshot, source or exposure '${name}' in the project (aihub dbt ls shows the names)`);
  return hit;
}

export const label = (n: Node): string => (n.kind === "source" ? `source:${n.name}` : n.name);
export const isNodeKind = (n: Node, ...k: string[]): boolean => k.includes(n.kind);
