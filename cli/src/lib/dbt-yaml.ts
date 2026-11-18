import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isMap, isSeq, parse as parseYaml, parseDocument } from "yaml";
import { SHOW_TARGET } from "./dbt-failures.js";
import type { Manifest, Node } from "./dbt-manifest.js";
import type { Project, Runner } from "./dbt-run.js";
import { AihubError } from "./errors.js";

/** Validate and generate dbt YAML: model entries, data tests, unit tests. Reads the manifest; writes only on `--write`. */
export interface Finding {
  level: "warn" | "info";
  where: string;
  what: string;
  fix: string;
}

const KEY_TESTS = new Set(["unique", "not_null", "unique_combination_of_columns", "primary_key"]);
const slash = (s: string) => s.replace(/\\/g, "/");

function ymlFiles(dir: string, depth = 0, out: string[] = []): string[] {
  let es: import("node:fs").Dirent[];
  try {
    es = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of es) {
    if (e.isDirectory()) {
      if (!["target", "dbt_packages", "logs", "node_modules"].includes(e.name) && !e.name.startsWith(".") && depth < 8) ymlFiles(join(dir, e.name), depth + 1, out);
    } else if (/\.ya?ml$/i.test(e.name) && !["dbt_project.yml", "packages.yml", "profiles.yml", "selectors.yml", "package-lock.yml", "dependencies.yml"].includes(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Find `tests:` keys (deprecated since dbt 1.8, now `data_tests:`) under models, seeds, snapshots and sources. */
function deprecatedTests(doc: any): string[] {
  const hits: string[] = [];
  const walk = (o: any, path: string) => {
    if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k === "tests" && Array.isArray(v)) hits.push(path);
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  for (const k of ["models", "seeds", "snapshots", "sources"]) {
    for (const e of doc?.[k] ?? []) walk(e, `${k}:${e?.name ?? "?"}`);
  }
  return hits;
}

export function yamlCheck(p: Project, m: Manifest): Finding[] {
  const out: Finding[] = [];
  const models = [...m.byName.values()].filter((n) => n.kind === "model");
  const testsOn = (n: Node) => [...m.nodes.values()].filter((t) => t.kind === "test" && (t.attached === n.id || t.parents.includes(n.id)));
  const unit = new Set([...m.nodes.values()].filter((n) => n.kind === "unit_test").flatMap((n) => n.parents));
  for (const n of models) {
    if (!n.yml) {
      out.push({ level: "warn", where: n.file, what: `model ${n.name} has no YAML entry`, fix: `aihub dbt yaml scaffold ${n.name} --write` });
      continue;
    }
    if (!n.description.trim()) out.push({ level: "warn", where: n.yml, what: `model ${n.name} has no description`, fix: "add description: to the model entry" });
    const t = testsOn(n);
    if (!t.length) out.push({ level: "warn", where: n.yml, what: `model ${n.name} has no data tests`, fix: "unique + not_null on its key column" });
    else if (!t.some((x) => KEY_TESTS.has(x.testKind ?? ""))) out.push({ level: "info", where: n.yml, what: `model ${n.name} has tests but no key test (unique, not_null)`, fix: "add unique and not_null on the key column" });
  }
  for (const f of ymlFiles(p.dir)) {
    let doc: any;
    try {
      doc = parseYaml(readFileSync(f, "utf8"));
    } catch {
      out.push({ level: "warn", where: slash(relative(p.dir, f)), what: "YAML does not parse", fix: "fix the YAML" });
      continue;
    }
    const rel = slash(relative(p.dir, f));
    for (const hit of deprecatedTests(doc)) out.push({ level: "warn", where: rel, what: `${hit} uses tests: (deprecated since dbt 1.8)`, fix: "rename to data_tests:" });
    for (const e of doc?.models ?? []) if (e?.name && !m.byName.has(e.name)) out.push({ level: "warn", where: rel, what: `entry ${e.name} has no model (no .sql or .py file with that name)`, fix: "rename the entry or add the model" });
  }
  for (const x of m.nodes.values()) if (x.kind === "exposure" && !x.expo?.owner) out.push({ level: "warn", where: x.file, what: `exposure ${x.name} has no owner`, fix: "owner: {name: ..., email: ...}" });
  const noFresh = [...m.nodes.values()].filter((x) => x.kind === "source" && !x.hasFreshness).map((x) => x.name);
  if (noFresh.length) out.push({ level: "info", where: "sources", what: `${noFresh.length} source table(s) without loaded_at_field or freshness: ${noFresh.slice(0, 6).join(", ")}${noFresh.length > 6 ? ", ..." : ""}`, fix: "loaded_at_field + freshness: {warn_after, error_after}" });
  const covered = models.filter((n) => unit.has(n.id)).length;
  out.push({ level: "info", where: "unit tests", what: `${covered} of ${models.length} model(s) have a unit test`, fix: "aihub dbt yaml scaffold <model> --unit-test for models with real logic" });
  return out;
}

export function renderFindings(project: string, f: Finding[]): string {
  const warn = f.filter((x) => x.level === "warn").length;
  return [`dbt yaml check of ${project}: ${warn} warning(s), ${f.length - warn} note(s)`, ...f.slice(0, 60).map((x) => `  ${x.level} ${x.where}: ${x.what}. Fix: ${x.fix}`), ...(f.length > 60 ? [`  ... and ${f.length - 60} more`] : [])].join("\n");
}

// ---- scaffold --------------------------------------------------------------------------------------------------------

export interface Column {
  name: string;
  /** dbt show value type (number, string, boolean) when known; never the value itself */
  type?: string;
}

/** Columns of a node: the YAML, then target/catalog.json (dbt docs generate), then one row of `dbt show`. */
export function columnsOf(p: Project, runner: Runner | undefined, n: Node, m: Manifest): Column[] {
  const cat = join(p.dir, "target", "catalog.json");
  if (existsSync(cat)) {
    try {
      const c = JSON.parse(readFileSync(cat, "utf8"));
      const e = (c.nodes?.[n.id] ?? c.sources?.[n.id])?.columns;
      if (e) return Object.values<any>(e).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => ({ name: String(x.name).toLowerCase(), type: typeName(String(x.type ?? "")) }));
    } catch {
      /* fall through */
    }
  }
  if (!runner) return n.columns.map((name) => ({ name }));
  const args = n.kind === "source" ? ["show", "--inline", `select * from {{ source('${n.name.split(".")[0]}', '${n.name.split(".")[1]}') }}`] : ["show", "--select", `${n.name},resource_type:${n.kind}`];
  const r = runner.run([...args, "--limit", "1", "--output", "json", "--log-format", "json", "--target-path", SHOW_TARGET], 180_000);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j.info?.name === "ShowNode" && j.data?.preview) {
        const row = JSON.parse(j.data.preview)[0];
        if (row) return Object.entries(row).map(([name, v]) => ({ name, type: v === null ? undefined : typeof v }));
      }
    } catch {
      /* not a structured line */
    }
  }
  return n.columns.map((name) => ({ name }));
}

function typeName(t: string): string | undefined {
  const x = t.toLowerCase();
  if (/int|num|dec|float|double|real|long/.test(x)) return "number";
  if (/bool|bit/.test(x)) return "boolean";
  if (x) return "string";
  return undefined;
}

const KEY_NAME = /(^id$|_id$|_key$|_sk$)/i;

export function modelEntry(name: string, cols: Column[]): Record<string, unknown> {
  const key = cols.find((c) => KEY_NAME.test(c.name)) ?? cols[0];
  return {
    name,
    description: "TODO describe the model",
    columns: cols.map((c) => ({ name: c.name, description: "TODO", ...(c === key ? { data_tests: ["unique", "not_null"] } : {}) })),
  };
}

const placeholder = (c: Column): unknown => (c.type === "number" ? 1 : c.type === "boolean" ? true : "x");

/** A unit test skeleton: one given per input with placeholder rows (types only, never real values) and an expect to fill in. */
export function unitTestEntry(n: Node, m: Manifest, cols: (x: Node) => Column[], own: Column[]): Record<string, unknown> {
  const inputs = n.parents.map((id) => m.nodes.get(id)).filter((x): x is Node => !!x && ["model", "seed", "snapshot", "source"].includes(x.kind));
  const row = (cs: Column[]) => Object.fromEntries(cs.map((c) => [c.name, placeholder(c)]));
  return {
    name: `${n.name}_todo_describe_the_case`,
    model: n.name,
    given: inputs.map((x) => ({ input: x.kind === "source" ? `source('${x.name.split(".")[0]}', '${x.name.split(".")[1]}')` : `ref('${x.name}')`, rows: [row(cols(x))] })),
    expect: { rows: [row(own)] },
  };
}

/** The schema file for a new entry: the model's folder has one (`schema.yml` or any file with `models:`), else a new `schema.yml`. */
export function entryFile(p: Project, n: Node): string {
  const folder = join(p.dir, dirname(n.file));
  const candidates = ymlFiles(folder, 7).filter((f) => dirname(f) === folder);
  const withModels = candidates.find((f) => /^models:/m.test(readFileSync(f, "utf8")));
  return withModels ?? join(folder, "schema.yml");
}

/** Add an entry to a top-level list (`models`, `unit_tests`) of a YAML file, keeping the rest of the file as it is. */
export function addEntry(file: string, key: "models" | "unit_tests", entry: Record<string, unknown>): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "version: 2\n";
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new AihubError(`${basename(file)} is not a YAML mapping`);
  const list = doc.get(key, true);
  if (isSeq(list)) list.add(doc.createNode(entry));
  else doc.set(key, doc.createNode([entry]));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}
