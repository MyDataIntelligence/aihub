import { parse as parseYaml } from "yaml";
import { downstream, label, type Manifest, type Node } from "./dbt-manifest.js";

/** What a branch changes in a dbt project: the changed nodes, everything downstream, the tests and exposures that follow. */
export interface Exposure {
  name: string;
  type?: string;
  maturity?: string;
  owner?: string;
  url?: string;
  fabric: string[];
  via: string;
}

export interface Impact {
  project: string;
  baseRef: string;
  base: string;
  /** "files": changed files mapped through the manifest; "state": dbt's own state:modified against a base manifest */
  mode: "files" | "state";
  changedFiles: string[];
  removed: string[];
  projectWide: string[];
  /** changed nodes: `data` = SQL, seed, source or macro change; `docs` = only YAML (description, tests) */
  changed: { name: string; kind: string; file: string; change: "data" | "docs"; why: string }[];
  downstream: { name: string; kind: string; materialized?: string }[];
  tests: { count: number; names: string[] };
  unitTests: string[];
  exposures: Exposure[];
  tables: string[];
  fabricItems: string[];
  /** dbt selector words that cover the change: `a+ b` */
  selector: string[];
  notes: string[];
}

type Entry = { kind: "model" | "seed" | "snapshot" | "source" | "exposure" | "unit_test"; name: string; body: unknown };

/** The entries of one YAML file as comparable values: models, seeds, snapshots, source tables, exposures, unit tests. */
export function yamlEntries(text: string | undefined): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!text) return out;
  let doc: any;
  try {
    doc = parseYaml(text) ?? {};
  } catch {
    return out;
  }
  const put = (kind: Entry["kind"], name: unknown, body: unknown) => typeof name === "string" && out.set(`${kind}:${name}`, { kind, name, body });
  for (const k of ["models", "seeds", "snapshots"] as const) for (const e of doc[k] ?? []) put(k.slice(0, -1) as Entry["kind"], e?.name, e);
  for (const s of doc.sources ?? []) {
    const { tables, ...rest } = s ?? {};
    for (const t of tables ?? []) put("source", `${s.name}.${t?.name}`, { rest, t });
  }
  for (const e of doc.exposures ?? []) put("exposure", e?.name, e);
  for (const e of doc.unit_tests ?? []) put("unit_test", e?.name, e);
  return out;
}

/** Entries that are new or different between two versions of a YAML file. */
export function changedEntries(before: string | undefined, after: string | undefined): Entry[] {
  const b = yamlEntries(before);
  const out: Entry[] = [];
  for (const [k, e] of yamlEntries(after)) if (JSON.stringify(b.get(k)?.body) !== JSON.stringify(e.body)) out.push(e);
  return out;
}

const PROJECT_WIDE = /(^|\/)(dbt_project\.yml|packages\.yml|package-lock\.yml|dependencies\.yml)$/;

export interface ImpactInput {
  m: Manifest;
  /** changed files relative to the project folder, forward slashes (existing files) */
  changed: string[];
  removed: string[];
  /** the YAML text before and after for a changed YAML file */
  yml: (file: string) => { before?: string; after?: string };
  project: string;
  baseRef: string;
  base: string;
}

export function filesImpact(i: ImpactInput): Impact {
  const { m } = i;
  const direct = new Map<string, { n: Node; change: "data" | "docs"; why: string }>();
  const addDirect = (n: Node | undefined, change: "data" | "docs", why: string) => {
    if (!n) return;
    const had = direct.get(n.id);
    if (!had || (had.change === "docs" && change === "data")) direct.set(n.id, { n, change, why });
  };
  const byFile = [...m.nodes.values()];
  const projectWide: string[] = [];
  const exposuresDirect: Node[] = [];
  const unitDirect: Node[] = [];
  for (const f of i.changed) {
    if (PROJECT_WIDE.test(f)) projectWide.push(f);
    else if (/\.(sql|py|csv)$/i.test(f)) {
      for (const n of byFile.filter((x) => x.file === f && ["model", "seed", "snapshot"].includes(x.kind))) addDirect(n, "data", f);
      const macros = byFile.filter((x) => x.kind === "macro" && x.file === f);
      if (macros.length) {
        // a macro change reaches every node that calls it, also through other macros
        const reach = new Set(macros.map((x) => x.id));
        let grew = true;
        while (grew) {
          grew = false;
          for (const id of [...reach]) for (const u of m.macroUsers.get(id) ?? []) if (m.nodes.get(u)?.kind === "macro" && !reach.has(u)) (reach.add(u), (grew = true));
        }
        for (const id of reach) for (const u of m.macroUsers.get(id) ?? []) addDirect(m.nodes.get(u) && ["model", "seed", "snapshot"].includes(m.nodes.get(u)!.kind) ? m.nodes.get(u) : undefined, "data", `macro ${macros[0].name} (${f})`);
      }
    } else if (/\.ya?ml$/i.test(f)) {
      const { before, after } = i.yml(f);
      for (const e of changedEntries(before, after)) {
        if (e.kind === "source") addDirect([...m.nodes.values()].find((x) => x.kind === "source" && x.name === e.name), "data", `${f} (source)`);
        else if (e.kind === "exposure") {
          const x = byFile.find((n) => n.kind === "exposure" && n.name === e.name);
          if (x) exposuresDirect.push(x);
        } else if (e.kind === "unit_test") {
          const x = byFile.find((n) => n.kind === "unit_test" && n.name === e.name);
          if (x) unitDirect.push(x);
        } else addDirect(m.byName.get(e.name), "docs", `${f} (yml)`);
      }
    }
  }
  const data = [...direct.values()].filter((d) => d.change === "data").map((d) => d.n.id);
  const below = downstream(m, data);
  const belowModels = below.map((id) => m.nodes.get(id)!).filter((n) => ["model", "snapshot"].includes(n.kind));
  const scope = new Set<string>([...direct.keys(), ...below]);
  const tests = [...m.nodes.values()].filter((n) => n.kind === "test" && ((n.attached && scope.has(n.attached)) || n.parents.some((p) => scope.has(p))));
  const unit = new Set<string>([...unitDirect.map((u) => u.name), ...[...m.nodes.values()].filter((n) => n.kind === "unit_test" && (scope.has(n.attached ?? "") || n.parents.some((p) => scope.has(p)))).map((n) => n.name)]);
  const exposures: Exposure[] = [];
  const addExpo = (x: Node, via: string) => !exposures.some((e) => e.name === x.name) && exposures.push({ name: x.name, ...x.expo!, fabric: x.expo?.fabric ?? [], via });
  for (const x of exposuresDirect) addExpo(x, "changed");
  for (const id of scope) for (const c of m.nodes.get(id)?.children ?? []) if (m.nodes.get(c)?.kind === "exposure") addExpo(m.nodes.get(c)!, m.nodes.get(id)!.name);
  const tables = [...scope].map((id) => m.nodes.get(id)).filter((n): n is Node => !!n && ["model", "seed", "snapshot", "source"].includes(n.kind) && !!n.relation && n.materialized !== "ephemeral").map((n) => n.relation!);
  const fabricItems = [...new Set(exposures.flatMap((e) => e.fabric))].sort();
  const selectorWords = [...direct.values()].map((d) => `${label(d.n)}${d.change === "data" ? "+" : ""}`);
  const notes: string[] = [];
  if (projectWide.length) notes.push(`project configuration changed (${projectWide.join(", ")}): any model can be affected; the pipeline runs the whole project`);
  if (i.removed.length) notes.push(`removed: ${i.removed.join(", ")} (models that still ref() a removed model fail at parse)`);
  if (!direct.size && !exposuresDirect.length && !unitDirect.length && !projectWide.length) notes.push("no model, seed, snapshot, source, macro or exposure changed");
  return {
    project: i.project,
    baseRef: i.baseRef,
    base: i.base,
    mode: "files",
    changedFiles: i.changed,
    removed: i.removed,
    projectWide,
    changed: [...direct.values()].map((d) => ({ name: label(d.n), kind: d.n.kind, file: d.n.file, change: d.change, why: d.why })),
    downstream: belowModels.map((n) => ({ name: n.name, kind: n.kind, materialized: n.materialized })),
    tests: { count: tests.length, names: tests.slice(0, 12).map((t) => t.name) },
    unitTests: [...unit],
    exposures,
    tables: [...new Set(tables)],
    fabricItems,
    selector: selectorWords,
    notes,
  };
}

/** The same report from dbt's own `state:modified` (and `+`) ids, listed against a base manifest. */
export function stateImpact(m: Manifest, modified: string[], withDownstream: string[], meta: { project: string; baseRef: string; base: string; stateDir: string }): Impact {
  const direct = modified.map((id) => m.nodes.get(id)).filter((n): n is Node => !!n);
  const dataIds = direct.filter((n) => ["model", "seed", "snapshot", "source"].includes(n.kind)).map((n) => n.id);
  const below = withDownstream.filter((id) => !modified.includes(id)).map((id) => m.nodes.get(id)).filter((n): n is Node => !!n);
  const scope = new Set<string>([...dataIds, ...below.map((n) => n.id)]);
  const tests = [...m.nodes.values()].filter((n) => n.kind === "test" && ((n.attached && scope.has(n.attached)) || n.parents.some((p) => scope.has(p))));
  const exposures: Exposure[] = [];
  for (const n of [...direct, ...below].filter((x) => x.kind === "exposure")) exposures.push({ name: n.name, ...n.expo!, fabric: n.expo?.fabric ?? [], via: "state" });
  const tables = [...scope].map((id) => m.nodes.get(id)).filter((n): n is Node => !!n && !!n.relation && n.materialized !== "ephemeral").map((n) => n.relation!);
  return {
    project: meta.project,
    baseRef: meta.baseRef,
    base: meta.base,
    mode: "state",
    changedFiles: [],
    removed: [],
    projectWide: [],
    changed: direct.filter((n) => ["model", "seed", "snapshot", "source"].includes(n.kind)).map((n) => ({ name: label(n), kind: n.kind, file: n.file, change: "data" as const, why: `state:modified against ${meta.stateDir}` })),
    downstream: below.filter((n) => ["model", "snapshot"].includes(n.kind)).map((n) => ({ name: n.name, kind: n.kind, materialized: n.materialized })),
    tests: { count: tests.length, names: tests.slice(0, 12).map((t) => t.name) },
    unitTests: [],
    exposures,
    tables: [...new Set(tables)],
    fabricItems: [...new Set(exposures.flatMap((e) => e.fabric))].sort(),
    selector: ["state:modified+"],
    notes: [],
  };
}

const cap = (a: string[], n = 15): string => (a.length > n ? `${a.slice(0, n).join(", ")} and ${a.length - n} more` : a.join(", "));

export function renderImpactText(i: Impact): string {
  const l: string[] = [`dbt impact of ${i.project} vs ${i.baseRef} (${i.mode === "state" ? "dbt state:modified" : `merge base ${i.base}`}): ${i.changed.length} changed, ${i.downstream.length} downstream model(s), ${i.tests.count} test(s), ${i.exposures.length} exposure(s)`];
  if (i.changed.length) l.push("changed:", ...i.changed.map((c) => `  ${c.name} [${c.kind}, ${c.change === "data" ? "logic or data" : "yml only"}] ${c.why}`));
  if (i.downstream.length) l.push(`downstream models (${i.downstream.length}): ${cap(i.downstream.map((d) => d.name))}`);
  if (i.tests.count) l.push(`tests that run on them (${i.tests.count}): ${cap(i.tests.names, 8)}${i.unitTests.length ? `; unit tests: ${cap(i.unitTests, 8)}` : ""}`);
  if (i.exposures.length) l.push("exposures:", ...i.exposures.map((e) => `  ${e.name} [${e.type ?? "?"}${e.maturity ? `, ${e.maturity}` : ""}]${e.owner ? ` owner ${e.owner}` : ""}${e.url ? ` ${e.url}` : ""} (via ${e.via})${e.fabric.length ? ` fabric: ${e.fabric.join(", ")}` : ""}`));
  if (i.fabricItems.length) l.push(`Fabric items that read them: ${i.fabricItems.join(", ")}`);
  if (i.tables.length) l.push(`tables written or read: ${cap(i.tables, 10)}`);
  if (i.selector.length) l.push(`dbt selector: ${i.selector.join(" ")}`);
  l.push(...i.notes.map((n) => `note: ${n}`));
  return l.join("\n");
}

export function renderImpactMarkdown(i: Impact, nl = false): string {
  const t = (en: string, du: string) => (nl ? du : en);
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const rows = [
    ...i.changed.map((c) => `| ${esc(c.name)} | ${c.kind} | ${c.change === "data" ? t("logic or data", "logica of data") : t("yml only", "alleen yml")} |`),
    ...i.downstream.map((d) => `| ${esc(d.name)} | ${d.kind} | ${t("downstream", "downstream")} |`),
  ];
  const out = [`| ${t("Node", "Node")} | ${t("Kind", "Soort")} | ${t("Change", "Wijziging")} |`, "|---|---|---|", ...(rows.length ? rows : ["| - | - | - |"]), ""];
  out.push(t(`${i.tests.count} test(s) run on these models${i.unitTests.length ? `, ${i.unitTests.length} unit test(s)` : ""}.`, `${i.tests.count} test(s) draaien op deze modellen${i.unitTests.length ? `, ${i.unitTests.length} unit test(s)` : ""}.`));
  if (i.exposures.length) out.push("", t("Exposures:", "Exposures:"), ...i.exposures.map((e) => `- ${e.name} (${e.type ?? "?"}${e.maturity ? `, ${e.maturity}` : ""})${e.owner ? `, ${e.owner}` : ""}${e.fabric.length ? `, Fabric: ${e.fabric.join(", ")}` : ""}`));
  if (i.notes.length) out.push("", ...i.notes.map((n) => `- ${n}`));
  out.push("", t(`Computed from the manifest of ${i.project} against ${i.baseRef}.`, `Berekend uit het manifest van ${i.project} tegen ${i.baseRef}.`));
  return out.join("\n");
}
