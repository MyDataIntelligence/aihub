import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { AihubError } from "./errors.js";
import { redact } from "./fabric-redact.js";

/** dbt on Fabric (legacy DbtProjects): detect projects, read profiles and run_results, scaffold, upload and job definition. */
const SKIP_DIRS = new Set(["target", ".venv", "venv", "dbt_packages", "node_modules", ".git", "logs", "__pycache__"]);
const SENSITIVE = /(password|secret|token|key|pwd|client_secret|credential)/i;
export const MAX_FILES = 500;
export const MAX_BYTES = 20 * 1024 * 1024;
export const COMMANDS = ["build", "run", "test", "compile", "show", "seed", "snapshot", "retry", "run-operation", "debug", "deps", "parse", "ls"];

export interface DbtProject {
  path: string;
  name: string;
  profile?: string;
  modelPaths: string[];
  models: number;
  dataTests: number;
}

const yml = (file: string): any => {
  try {
    return parseYaml(readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
};

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 4) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1, out);
    else if (e.isFile() && e.name === "dbt_project.yml") out.push(dir);
  }
}

const countFiles = (dir: string, ext: RegExp): number => {
  let n = 0;
  const go = (d: string) => {
    let es: import("node:fs").Dirent[];
    try {
      es = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (e.isDirectory()) go(join(d, e.name));
      else if (ext.test(e.name)) n++;
    }
  };
  go(dir);
  return n;
};

export function findProjects(root: string): DbtProject[] {
  const dirs: string[] = [];
  walk(root, 0, dirs);
  return dirs.map((d) => {
    const cfg = yml(join(d, "dbt_project.yml"));
    const modelPaths: string[] = cfg["model-paths"] ?? cfg["source-paths"] ?? ["models"];
    return {
      path: relative(root, d).split(sep).join("/") || ".",
      name: String(cfg.name ?? "?"),
      profile: cfg.profile,
      modelPaths,
      models: modelPaths.reduce((n, p) => n + countFiles(join(d, p), /\.sql$/), 0),
      dataTests: countFiles(join(d, "tests"), /\.sql$/),
    };
  });
}

export type Route = "warehouse" | "lakehouse" | "other";
export const routeOf = (adapter: string): Route => (adapter === "fabric" ? "warehouse" : adapter === "fabricspark" ? "lakehouse" : "other");

/** Mask a profile value whose key looks like a credential, unless it is an env_var() reference. */
export function profileValue(key: string, value: unknown): unknown {
  if (typeof value === "string" && SENSITIVE.test(key) && !/^\{\{\s*env_var\(/.test(value.trim())) return "<redacted>";
  if (typeof value === "string") return redact(value);
  return value;
}

export interface ProfileTarget {
  profile: string;
  target: string;
  adapter: string;
  route: Route;
  fields: Record<string, unknown>;
  isDefault: boolean;
}

/** profiles.yml dbt would use: the project folder, then DBT_PROFILES_DIR, then ~/.dbt. */
export function findProfiles(projectDir: string, env: NodeJS.ProcessEnv): { file?: string; targets: ProfileTarget[] } {
  const candidates = [join(projectDir, "profiles.yml"), ...(env.DBT_PROFILES_DIR ? [join(env.DBT_PROFILES_DIR, "profiles.yml")] : []), join(env.HOME || env.USERPROFILE || homedir(), ".dbt", "profiles.yml")];
  const file = candidates.find(existsSync);
  if (!file) return { targets: [] };
  const doc = yml(file);
  const targets: ProfileTarget[] = [];
  for (const [profile, def] of Object.entries<any>(doc)) {
    if (!def?.outputs) continue;
    for (const [target, o] of Object.entries<any>(def.outputs)) {
      const fields = Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, profileValue(k, v)]));
      targets.push({ profile, target, adapter: String(o?.type ?? "?"), route: routeOf(String(o?.type)), fields, isDefault: def.target === target });
    }
  }
  return { file, targets };
}

export interface RunResults {
  command?: string;
  counts: Record<string, number>;
  failures: { id: string; status: string; message: string; file?: string }[];
  warnings: number;
}

export function readRunResults(projectDir: string): RunResults | undefined {
  const f = join(projectDir, "target", "run_results.json");
  if (!existsSync(f)) return undefined;
  let j: any;
  try {
    j = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
  const counts: Record<string, number> = {};
  const failures: RunResults["failures"] = [];
  let warnings = 0;
  for (const r of (j.results ?? []) as any[]) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "warn") warnings++;
    if (["error", "fail"].includes(r.status)) failures.push({ id: r.unique_id, status: r.status, message: redact(String(r.message ?? "")).slice(0, 500), file: r.relation_name });
  }
  return { command: j.args?.which, counts, failures, warnings };
}

export function logTail(projectDir: string, lines = 30): string {
  const f = join(projectDir, "logs", "dbt.log");
  if (!existsSync(f)) return "";
  return redact(readFileSync(f, "utf8").split("\n").slice(-lines).join("\n"));
}

// ---- scaffold ------------------------------------------------------------------------------------------------------

export interface ScaffoldInput {
  route: "warehouse" | "lakehouse" | "job";
  projectName: string;
  target: string;
  schema: string;
  workspaceId: string;
  /** Warehouse: SQL host and database; Lakehouse: id and name. */
  server?: string;
  database?: string;
  lakehouseId?: string;
  lakehouse?: string;
}

/** The files of a new project. Never contains a secret: authentication is the az login. */
export function scaffoldFiles(i: ScaffoldInput): Record<string, string> {
  const files: Record<string, string> = {};
  files["dbt_project.yml"] = yamlStringify({ name: i.projectName, version: "1.0.0", "config-version": 2, profile: i.projectName, "model-paths": ["models"], "test-paths": ["tests"], "target-path": "target", "clean-targets": ["target", "dbt_packages"], models: { [i.projectName]: { staging: { "+materialized": "view" }, marts: { "+materialized": "table" } } } });
  if (i.route === "warehouse") {
    files["profiles.yml"] = yamlStringify({ [i.projectName]: { target: i.target, outputs: { [i.target]: { type: "fabric", driver: "ODBC Driver 18 for SQL Server", server: i.server, database: i.database, schema: i.schema, authentication: "CLI", threads: 4 } } } });
  } else if (i.route === "lakehouse") {
    files["profiles.yml"] = yamlStringify({ [i.projectName]: { target: i.target, outputs: { [i.target]: { type: "fabricspark", method: "livy", authentication: "CLI", endpoint: "https://api.fabric.microsoft.com/v1", workspaceid: i.workspaceId, lakehouseid: i.lakehouseId, lakehouse: i.lakehouse, schema: i.schema, threads: 1, connect_retries: 0, connect_timeout: 10, retry_all: true } } } });
  }
  files["models/staging/stg_example.sql"] = "select 1 as id, 'example' as name\n";
  files["models/marts/mart_example.sql"] = `select id, name from {{ ref('stg_example') }}\n`;
  files["models/schema.yml"] = yamlStringify({ version: 2, models: [{ name: "stg_example", columns: [{ name: "id", data_tests: ["not_null", "unique"] }] }, { name: "mart_example", columns: [{ name: "id", data_tests: ["not_null", "unique"] }] }] });
  files[".gitignore"] = "target/\ndbt_packages/\nlogs/\nprofiles.yml\n.venv/\n";
  files["README.md"] = `# ${i.projectName}\n\ndbt project for Microsoft Fabric (${i.route} route). Authentication is your az login; no secret is stored here.\n\nRun: \`aihub fabric dbt run --workspace <workspace> --command build\`.\n`;
  return files;
}

/** Write scaffold files below `dir`; an existing file is refused, never overwritten. */
export function writeScaffold(dir: string, files: Record<string, string>): string[] {
  const clash = Object.keys(files).filter((f) => existsSync(join(dir, f)));
  if (clash.length) throw new AihubError(`refusing to overwrite: ${clash.join(", ")} already exist in ${dir}`);
  for (const [f, c] of Object.entries(files)) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
  return Object.keys(files);
}

// ---- project file set (upload and job definition) ------------------------------------------------------------------

const EXCLUDE_FILES = new Set(["profiles.yml"]);

export function projectFiles(dir: string): { rel: string; bytes: Buffer }[] {
  const out: { rel: string; bytes: Buffer }[] = [];
  let total = 0;
  const go = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) go(join(d, e.name));
      } else if (e.isFile() && !EXCLUDE_FILES.has(e.name)) {
        const p = join(d, e.name);
        const size = statSync(p).size;
        total += size;
        if (out.length + 1 > MAX_FILES || total > MAX_BYTES) throw new AihubError(`the dbt project is larger than ${MAX_FILES} files / ${MAX_BYTES / 1024 / 1024} MB`);
        out.push({ rel: relative(dir, p).split(sep).join("/"), bytes: readFileSync(p) });
      }
    }
  };
  go(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export const setHash = (files: { rel: string; bytes: Buffer }[]) => {
  const h = createHash("sha256");
  for (const f of files) h.update(f.rel).update(f.bytes);
  return h.digest("hex");
};

/** Job definition shape read back from a job configured in the Fabric UI (legacy 1.50.1 live test). */
export function jobDefinition(o: { folderPath: string; schema: string; warehouseId: string; workspaceId: string; endPoint: string; operation: string; select?: string; exclude?: string; fullRefresh?: boolean; failFast?: boolean; threads?: number }, files: { rel: string; bytes: Buffer }[]) {
  const command = { operation: o.operation, ...(o.select ? { select: o.select } : {}), ...(o.exclude ? { exclude: o.exclude } : {}), ...(o.fullRefresh ? { fullRefresh: true } : {}), ...(o.failFast ? { failFast: true } : {}), ...(o.threads ? { threads: o.threads } : {}) };
  const content = {
    project: { projectType: "OneLake", folderPath: o.folderPath },
    profile: { profileType: "DataWarehouse", schema: o.schema, connectionSettings: { name: "dbt-warehouse", properties: { type: "DataWarehouse", typeProperties: { workspaceId: o.workspaceId, artifactId: o.warehouseId, endPoint: o.endPoint } } } },
    command,
  };
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
  return { parts: [{ path: "dbt-content.json", payload: b64(JSON.stringify(content)), payloadType: "InlineBase64" }, ...files.map((f) => ({ path: `Code/${o.folderPath}/${f.rel}`, payload: b64(f.bytes), payloadType: "InlineBase64" }))] };
}

export const safeProjectDir = (root: string, p?: string): string => {
  const dir = resolve(root, p ?? ".");
  if (dir !== resolve(root) && !dir.startsWith(resolve(root) + sep)) throw new AihubError("--project must be a folder inside the repository");
  return dir;
};
