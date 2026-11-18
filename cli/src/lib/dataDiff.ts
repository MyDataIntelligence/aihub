import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { chooseWorkspace, fabricWorkspaces, guardEnv, inferEnv, matchingWorkspaces, type FabricWorkspace } from "./fabric.js";
import { sqlGuard } from "./fabric-diag.js";
import { resolvePr } from "./pr.js";
import { loadTeam, type TeamConfig } from "./team.js";
import { editSection } from "./templates.js";
import { shortBranch } from "./ado.js";

/**
 * `aihub pr data-diff`: the same read-only checks against the baseline workspace (where the target branch lives) and the feature
 * workspace of the branch, as a before/after table with deltas and a one-line verdict. Never ACC/PRD: such a workspace is refused.
 */
export interface DataTable {
  /** schema.table or table */
  name: string;
  count?: boolean;
  nulls?: string[];
  sums?: string[];
  distinct?: string[];
  /** one custom SELECT returning one row; every column becomes a metric */
  sql?: string;
}

export interface DataChecks {
  /** Warehouse or Lakehouse (name) that exists in both workspaces */
  item: string;
  baseline?: string;
  feature?: string;
  section?: string;
  tables: DataTable[];
}

export interface Rows {
  columns: string[];
  rows: unknown[][];
}

/** Runs one SELECT in a workspace; `how` says through what (SQL endpoint or Livy). */
export type DataRunner = (workspace: string, item: string, sql: string) => Promise<Rows & { how: string }>;

export interface Metric {
  table: string;
  metric: string;
  before?: number | string | null;
  after?: number | string | null;
  delta?: number;
  pct?: number;
  changed: boolean;
  error?: string;
}

export interface DataDiff {
  baseline: string;
  feature: string;
  item: string;
  how: string;
  metrics: Metric[];
  verdict: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bracket = (id: string): string => `[${id}]`;

function ident(v: string, what: string): string {
  if (!IDENT.test(v)) throw new AihubError(`dataChecks: ${what} '${v}' is not a plain identifier (letters, digits, underscore)`);
  return v;
}

/** schema.table -> [schema].[table]; a bare table stays [table]. */
function tableRef(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2) throw new AihubError(`dataChecks: table '${name}' must be schema.table or table`);
  return parts.map((p) => bracket(ident(p, "table"))).join(".");
}

/** The SELECT of one table's built-in metrics (one row) with the metric names, or a custom SELECT. */
export function queryFor(t: DataTable): { sql: string; metrics: string[] } {
  if (t.sql) return { sql: sqlGuard(t.sql), metrics: [] };
  const cols: string[] = [];
  const names: string[] = [];
  const add = (name: string, expr: string) => (names.push(name), cols.push(`${expr} AS ${bracket(name)}`));
  if (t.count !== false) add("count", "COUNT_BIG(*)");
  for (const c of t.nulls ?? []) add(`nulls_${ident(c, "column")}`, `SUM(CASE WHEN ${bracket(c)} IS NULL THEN 1 ELSE 0 END)`);
  for (const c of t.sums ?? []) add(`sum_${ident(c, "column")}`, `SUM(CAST(${bracket(c)} AS FLOAT))`);
  for (const c of t.distinct ?? []) add(`distinct_${ident(c, "column")}`, `COUNT(DISTINCT ${bracket(c)})`);
  if (!cols.length) throw new AihubError(`dataChecks: table '${t.name}' has no check (count, nulls, sums, distinct or sql)`);
  return { sql: sqlGuard(`SELECT ${cols.join(", ")} FROM ${tableRef(t.name)}`), metrics: names };
}

export function dataChecksOf(team: TeamConfig): DataChecks | undefined {
  const d = (team as { dataChecks?: Partial<DataChecks> }).dataChecks;
  if (!d || !Array.isArray(d.tables) || !d.tables.length) return undefined;
  if (!d.item) throw new AihubError("dataChecks.item is required: the Warehouse or Lakehouse (name) that exists in both workspaces");
  return d as DataChecks;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

async function measure(run: DataRunner, ws: string, item: string, checks: DataChecks): Promise<{ values: Map<string, number | string | null>; errors: Map<string, string>; how: string }> {
  const values = new Map<string, number | string | null>();
  const errors = new Map<string, string>();
  let how = "";
  for (const t of checks.tables) {
    try {
      const q = queryFor(t);
      const r = await run(ws, item, q.sql);
      how = how || r.how;
      const row = r.rows[0] ?? [];
      r.columns.forEach((c, i) => {
        const v = row[i];
        values.set(`${t.name}\u0000${c}`, num(v) ?? (v === null || v === undefined ? null : String(v)));
      });
    } catch (e) {
      errors.set(t.name, (e as Error).message.split("\n")[0]);
    }
  }
  return { values, errors, how };
}

export async function computeDataDiff(run: DataRunner, checks: DataChecks, baseline: string, feature: string): Promise<DataDiff> {
  const [a, b] = [await measure(run, baseline, checks.item, checks), await measure(run, feature, checks.item, checks)];
  const metrics: Metric[] = [];
  for (const t of checks.tables) {
    const err = a.errors.get(t.name) ?? b.errors.get(t.name);
    if (err) {
      metrics.push({ table: t.name, metric: "-", changed: false, error: err });
      continue;
    }
    const keys = [...new Set([...a.values.keys(), ...b.values.keys()])].filter((k) => k.startsWith(`${t.name}\u0000`));
    for (const k of keys) {
      const before = a.values.get(k) ?? null;
      const after = b.values.get(k) ?? null;
      const nb = num(before);
      const na = num(after);
      const m: Metric = { table: t.name, metric: k.slice(t.name.length + 1), before, after, changed: before !== after };
      if (nb !== undefined && na !== undefined) {
        m.delta = Math.round((na - nb) * 1e6) / 1e6;
        if (nb !== 0) m.pct = Math.round(((na - nb) / Math.abs(nb)) * 1000) / 10;
        m.changed = na !== nb;
      }
      metrics.push(m);
    }
  }
  return { baseline, feature, item: checks.item, how: a.how || b.how, metrics, verdict: verdictOf(metrics) };
}

const fmt = (v: unknown): string => (v === null || v === undefined ? "NULL" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)) : String(v));
const sign = (n: number): string => (n > 0 ? `+${fmt(n)}` : fmt(n));

export function verdictOf(metrics: Metric[]): string {
  const bad = metrics.filter((m) => m.error);
  const ok = metrics.filter((m) => !m.error);
  const changed = ok.filter((m) => m.changed);
  const parts: string[] = [];
  if (!ok.length && bad.length) return `no data could be measured (${bad.length} table(s) failed)`;
  parts.push(changed.length ? `${changed.length} of ${ok.length} metrics changed: ${changed.slice(0, 5).map((m) => `${m.table} ${m.metric} ${m.delta !== undefined ? sign(m.delta) : `${fmt(m.before)} -> ${fmt(m.after)}`}`).join(", ")}${changed.length > 5 ? ", ..." : ""}` : `no metric changed (${ok.length} measured)`);
  if (bad.length) parts.push(`${bad.length} table(s) failed: ${bad.map((m) => m.table).join(", ")}`);
  return parts.join("; ");
}

export function renderText(d: DataDiff): string {
  const rows = d.metrics.map((m) => (m.error ? [m.table, "-", "-", "-", `error: ${m.error}`] : [m.table, m.metric, fmt(m.before), fmt(m.after), m.delta !== undefined ? `${sign(m.delta)}${m.pct !== undefined ? ` (${m.pct > 0 ? "+" : ""}${m.pct}%)` : ""}` : m.changed ? "changed" : "="]));
  const head = ["table", "metric", "before", "after", "delta"];
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd();
  return [`Data before/after: baseline ${d.baseline}, feature ${d.feature}, ${d.item} (read-only, via ${d.how || "n/a"})`, line(head), ...rows.map(line), `Verdict: ${d.verdict}`].join("\n");
}

export function sectionHeading(team: TeamConfig, checks: DataChecks): string {
  if (checks.section) return checks.section;
  return (team as { language?: string }).language === "nl" ? "Data vóór/na" : "Data before/after";
}

/** The PR section: a markdown table with deltas and the verdict, code-owned like Changes. */
export function renderMarkdown(d: DataDiff, lang?: string): string {
  const nl = lang === "nl";
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const rows = d.metrics.map((m) => (m.error ? `| ${esc(m.table)} | - | - | - | ${esc(m.error)} |` : `| ${esc(m.table)} | ${esc(m.metric)} | ${fmt(m.before)} | ${fmt(m.after)} | ${m.delta !== undefined ? `${sign(m.delta)}${m.pct !== undefined ? ` (${m.pct > 0 ? "+" : ""}${m.pct}%)` : ""}` : m.changed ? (nl ? "gewijzigd" : "changed") : "="} |`));
  return [
    `| ${nl ? "Tabel" : "Table"} | ${nl ? "Meting" : "Metric"} | ${nl ? "Vóór" : "Before"} | ${nl ? "Na" : "After"} | Delta |`,
    "|---|---|---|---|---|",
    ...rows,
    "",
    nl ? `**Oordeel:** ${d.verdict}` : `**Verdict:** ${d.verdict}`,
    "",
    nl ? `Gemeten (alleen lezen) in ${d.baseline} (vóór) en ${d.feature} (na) op ${d.item}, via ${d.how || "n/a"}.` : `Measured (read-only) in ${d.baseline} (before) and ${d.feature} (after) on ${d.item}, via ${d.how || "n/a"}.`,
  ].join("\n");
}

// ---- workspaces -------------------------------------------------------------------------------------------------------

function pickWorkspace(list: FabricWorkspace[], name: string | undefined, branch: string, what: "baseline" | "feature"): string {
  const byName = name ? (list.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? ({ name, environment: inferEnv(name) } as FabricWorkspace)) : undefined;
  // baseline: the workspace of the target branch, else the dev workspace; feature: the workspace of the branch, else a feature workspace, else dev
  const byRule = what === "baseline" ? (matchingWorkspaces(list, branch)[0] ?? list.find((x) => x.environment === "dev")) : chooseWorkspace(list, { branch });
  const w = byName ?? byRule;
  if (!w) throw new AihubError(`no ${what} workspace: set dataChecks.${what} in team.yaml, give --${what} <workspace>, or add a fabric.workspaces entry whose branches match '${branch}'`);
  guardEnv(w, undefined); // ACC and PRD are never read by the CLI
  return w.name;
}

export interface DataDiffOpts {
  pr?: string;
  write?: boolean;
  baseline?: string;
  feature?: string;
  json?: boolean;
}

/** The default runner: `aihub fabric sql` (SQL endpoint), falling back to `aihub fabric livy run` (Spark SQL in the Lakehouse). */
export function fabricRunner(ctx: Ctx, fabricRun: (argv: string[], ctx: Ctx) => Promise<void>): DataRunner {
  const call = async (argv: string[]): Promise<{ result: Record<string, unknown> }> => {
    const out: string[] = [];
    await fabricRun([...argv, "--json"], { ...ctx, out: (l) => out.push(l) });
    return JSON.parse(out.join("\n"));
  };
  return async (workspace, item, sql) => {
    try {
      const r = (await call(["sql", "--workspace", workspace, "--item", item, "--query", sql])).result as { columns: string[]; rows: unknown[][] };
      return { columns: r.columns, rows: r.rows, how: "the SQL endpoint" };
    } catch (sqlError) {
      try {
        const r = (await call(["livy", "run", "--workspace", workspace, "--lakehouse", item, "--code", sql, "--kind", "sql"])).result as { columns?: { name: string }[]; rows?: unknown[][] };
        if (!r.columns) throw new AihubError("Livy returned no table");
        return { columns: r.columns.map((c) => c.name), rows: r.rows ?? [], how: "Livy (Spark SQL; the SQL endpoint failed)" };
      } catch {
        throw sqlError;
      }
    }
  };
}

export async function prDataDiff(ctx: Ctx, o: DataDiffOpts, run: DataRunner): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const checks = dataChecksOf(team);
  if (!checks) throw new AihubError("no dataChecks in team.yaml: add dataChecks.item and dataChecks.tables (see docs/team-yaml.md)");
  const pr = await resolvePr(ctx, client, root, o.pr);
  const source = shortBranch(pr.sourceRefName);
  const target = shortBranch(pr.targetRefName);
  const list = fabricWorkspaces(team);
  const baseline = pickWorkspace(list, o.baseline ?? checks.baseline, target, "baseline");
  const feature = pickWorkspace(list, o.feature ?? checks.feature, source, "feature");
  if (baseline.toLowerCase() === feature.toLowerCase()) throw new AihubError(`baseline and feature are the same workspace (${baseline}); nothing to compare. Set dataChecks.feature or --feature <workspace>`);
  const diff = await computeDataDiff(run, checks, baseline, feature);
  let written = false;
  if (o.write) {
    const lang = (team as { language?: string }).language;
    const heading = sectionHeading(team, checks);
    const description = editSection(pr.description ?? "", heading, { replace: renderMarkdown(diff, lang) });
    await client.patch(`${client.repoPath()}/pullrequests/${pr.pullRequestId}`, { description });
    written = true;
  }
  if (o.json) return JSON.stringify({ pr: pr.pullRequestId, written, ...diff });
  return `${renderText(diff)}${written ? `\nwritten to the '${sectionHeading(team, checks)}' section of PR !${pr.pullRequestId}` : ""}`;
}
