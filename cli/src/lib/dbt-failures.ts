import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clean, type Project, type Runner } from "./dbt-run.js";
import { parseManifest, type Manifest } from "./dbt-manifest.js";
import { redact } from "./fabric-redact.js";

/** `dbt failures`: what failed in the last run, with the compiled SQL and the first failing rows of a data test. */
export interface Failure {
  id: string;
  name: string;
  kind: "test" | "unit_test" | "model" | "seed" | "snapshot" | "other";
  status: string;
  file?: string;
  message: string;
  failingRows?: number;
  sql?: string;
  rows?: unknown[];
  rowsNote?: string;
  /** the model or source a test is attached to */
  on?: string;
}

export interface FailureReport {
  command?: string;
  counts: Record<string, number>;
  skipped: number;
  failures: Failure[];
  warnings: { name: string; message: string }[];
  finishedAt?: string;
}

/** dbt show writes run_results.json; samples go to their own target folder so the last run stays readable. */
export const SHOW_TARGET = "target/aihub-show";

const slash = (s: string) => s.replace(/\\/g, "/");

/** Collapse the blank lines dbt leaves in compiled SQL. */
export const tidySql = (sql: string, max = 800): string => {
  const t = sql
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .join("\n")
    .trim();
  return redact(t.length > max ? `${t.slice(0, max)} ...` : t);
};

function kindOf(id: string): Failure["kind"] {
  const k = id.split(".")[0];
  return k === "test" || k === "unit_test" || k === "model" || k === "seed" || k === "snapshot" ? (k as Failure["kind"]) : "other";
}

/** The first rows a failing data test returns: `dbt show --select <test>` read from its structured log. */
export function sampleRows(runner: Runner, test: string, limit: number): { rows?: unknown[]; note?: string } {
  const r = runner.run(["show", "--select", test, "--limit", String(limit), "--output", "json", "--log-format", "json", "--target-path", SHOW_TARGET], 180_000);
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j.info?.name === "ShowNode" && j.data?.preview) return { rows: JSON.parse(j.data.preview).slice(0, limit) };
    } catch {
      /* not a structured line */
    }
  }
  const err = clean(r.stdout + r.stderr).split("\n").filter((l) => /error|Error/.test(l)).slice(0, 2).join(" ").trim();
  return { note: `no sample rows${err ? `: ${err.slice(0, 200)}` : ""}` };
}

export function failureReport(p: Project, runner: Runner | undefined, o: { rows: number; max: number; sample: boolean }): FailureReport | undefined {
  const f = join(p.dir, "target", "run_results.json");
  if (!existsSync(f)) return undefined;
  let j: any;
  try {
    j = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
  let m: Manifest | undefined;
  try {
    m = parseManifest(JSON.parse(readFileSync(join(p.dir, "target", "manifest.json"), "utf8")), p.info.name);
  } catch {
    /* without a manifest the report has no file names */
  }
  const counts: Record<string, number> = {};
  const failures: Failure[] = [];
  const warnings: FailureReport["warnings"] = [];
  let sampled = 0;
  for (const r of (j.results ?? []) as any[]) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const node = m?.nodes.get(r.unique_id);
    const name = node?.name ?? String(r.unique_id).split(".").slice(2, -1).join(".") ?? r.unique_id;
    if (r.status === "warn") warnings.push({ name, message: clean(String(r.message ?? "")).slice(0, 160) });
    if (!["error", "fail"].includes(r.status)) continue;
    const kind = kindOf(String(r.unique_id));
    const fl: Failure = {
      id: r.unique_id,
      name: node?.name ?? name,
      kind,
      status: r.status,
      file: node ? (node.yml && (kind === "test" || kind === "unit_test") ? node.yml : node.file) || node.file : undefined,
      message: clean(String(r.message ?? "")).split("\n").filter((l) => l.trim()).slice(0, kind === "unit_test" ? 30 : 6).join("\n").slice(0, 1500),
      failingRows: typeof r.failures === "number" ? r.failures : undefined,
      on: node?.attached ? m?.nodes.get(node.attached)?.name : undefined,
    };
    if (fl.file) fl.file = slash(fl.file);
    if (r.compiled_code) fl.sql = tidySql(String(r.compiled_code));
    else if (node?.file) {
      const c = join(p.dir, "target", "compiled", node.package || p.info.name, node.file);
      if (existsSync(c)) fl.sql = tidySql(readFileSync(c, "utf8"));
    }
    if (kind === "test" && r.status === "fail" && o.sample && runner && sampled < o.max) {
      sampled++;
      const s = sampleRows(runner, fl.name, o.rows);
      fl.rows = s.rows;
      fl.rowsNote = s.note;
    }
    failures.push(fl);
  }
  return { command: j.args?.which, counts, skipped: counts.skipped ?? counts.skip ?? 0, failures, warnings, finishedAt: j.metadata?.generated_at };
}

export function renderFailures(r: FailureReport): string {
  const c = Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(", ");
  const l = [`dbt ${r.command ?? "run"}: ${c || "no results"}${r.failures.length ? "" : " - nothing failed"}`];
  for (const f of r.failures) {
    l.push(`${f.status.toUpperCase()} ${f.kind} ${f.name}${f.on ? ` on ${f.on}` : ""}${f.file ? ` (${f.file})` : ""}${f.failingRows !== undefined ? ` - ${f.failingRows} failing row(s)` : ""}`);
    if (f.message) l.push(...f.message.split("\n").map((x) => `  ${x}`));
    if (f.sql) l.push("  sql:", ...f.sql.split("\n").map((x) => `    ${x}`));
    if (f.rows) l.push(`  first rows (${f.rows.length}):`, ...f.rows.map((x) => `    ${redact(JSON.stringify(x))}`));
    else if (f.rowsNote) l.push(`  ${f.rowsNote}`);
  }
  if (r.warnings.length) l.push(`warnings (${r.warnings.length}): ${r.warnings.slice(0, 5).map((w) => w.name).join(", ")}`);
  if (r.skipped) l.push(`${r.skipped} node(s) skipped because something upstream failed`);
  return l.join("\n");
}
