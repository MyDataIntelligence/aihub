import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** "Which Fabric items do I run to test this branch?" (legacy FabricTestPlanner): item folders, callers of changed items, order. */
export interface PlanFolderItem {
  folder: string;
  type: string;
  name: string;
  logicalId?: string;
}
export interface PlanStep {
  item: PlanFolderItem;
  changedFiles: string[];
  /** The changed item this one calls (undefined for a changed item). */
  via?: PlanFolderItem;
  /** Name of the pipeline activity that calls `via`. */
  activity?: string;
  functions: { name: string; params: string }[];
}
export interface TestPlan {
  steps: PlanStep[];
  dbtModels: string[];
  /** Changed items of a type with no start or check. */
  skipped: PlanFolderItem[];
}

export type Mode = "start" | "check" | "none";
export const STARTS = ["DataPipeline", "Notebook", "UserDataFunction", "DataBuildToolJob", "SparkJobDefinition", "CopyJob", "Dataflow"];
export const CHECKS = ["Eventstream", "Lakehouse", "Eventhouse", "KQLDatabase", "Warehouse"];
const has = (l: string[], t: string) => l.some((x) => x.toLowerCase() === t.toLowerCase());
export const modeOf = (type: string): Mode => (has(STARTS, type) ? "start" : has(CHECKS, type) ? "check" : "none");

const ITEM_FOLDER = /^(.+)\.([A-Z][A-Za-z]+)$/;
const UDF_FUNCTION = /@udf\.function\(\)\s*(?:@[^\n]*\s*)*def\s+(\w+)\s*\(([^)]*)\)/g;
const MAX_FILE = 2_000_000;
const MAX_STEPS = 25;
const RANK = ["Lakehouse", "Warehouse", "Eventhouse", "KQLDatabase", "Notebook", "SparkJobDefinition", "UserDataFunction", "CopyJob", "Dataflow", "DataBuildToolJob", "DataPipeline", "Eventstream"];
const rank = (t: string) => {
  const i = RANK.findIndex((x) => x.toLowerCase() === t.toLowerCase());
  return i < 0 ? RANK.length : i;
};

export function itemFolder(path: string): { folder: string; name: string; type: string } | undefined {
  const seg = path.replace(/\\/g, "/").split("/");
  for (let i = 0; i < seg.length - 1; i++) {
    const m = ITEM_FOLDER.exec(seg[i]);
    if (m) return { folder: seg.slice(0, i + 1).join("/"), name: m[1], type: m[2] };
  }
  return undefined;
}

function read(file: string): string {
  try {
    return existsSync(file) && statSync(file).isFile() && statSync(file).size <= MAX_FILE ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

export function planItems(root: string, files: string[]): PlanFolderItem[] {
  const seen = new Map<string, { folder: string; name: string; type: string }>();
  for (const f of files) {
    const it = itemFolder(f);
    if (it && !seen.has(it.folder)) seen.set(it.folder, it);
  }
  return [...seen.values()].map(({ folder, name, type }) => {
    let meta: any = {};
    try {
      meta = JSON.parse(read(join(root, folder, ".platform")) || "{}");
    } catch {
      meta = {};
    }
    return { folder, type: meta.metadata?.type ?? type, name: meta.metadata?.displayName ?? name, logicalId: meta.config?.logicalId?.toLowerCase() };
  });
}

/** Name of the innermost pipeline activity whose JSON mentions the id. */
function activityNaming(text: string, id: string): string | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  const find = (el: unknown): string | undefined => {
    if (Array.isArray(el)) {
      for (const x of el) {
        const r = find(x);
        if (r) return r;
      }
      return undefined;
    }
    if (!el || typeof el !== "object") return undefined;
    const node = el as Record<string, unknown>;
    for (const v of Object.values(node)) {
      const r = find(v);
      if (r) return r;
    }
    return typeof node.name === "string" && "type" in node && JSON.stringify(node).toLowerCase().includes(id) ? node.name : undefined;
  };
  return find(root);
}

function functionsOf(root: string, item: PlanFolderItem): { name: string; params: string }[] {
  if (item.type.toLowerCase() !== "userdatafunction") return [];
  return [...read(join(root, item.folder, "function_app.py")).matchAll(UDF_FUNCTION)].map((m) => ({ name: m[1], params: m[2].replace(/\s+/g, " ").trim() }));
}

/** dbt model files among the changed paths, for repositories with a dbt_project.yml. */
function dbtModels(root: string, files: string[], changed: string[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((x) => x.endsWith("dbt_project.yml"))) {
    let cfg: any = {};
    try {
      cfg = parseYaml(read(join(root, f))) ?? {};
    } catch {
      cfg = {};
    }
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    const roots = ((cfg["model-paths"] ?? cfg["source-paths"] ?? ["models"]) as string[]).map((p) => `${dir}${p.replace(/^\/+|\/+$/g, "")}/`);
    out.push(...changed.filter((c) => c.endsWith(".sql") && roots.some((r) => c.startsWith(r))));
  }
  return [...new Set(out)];
}

export function buildTestPlan(root: string, files: string[], changed: string[]): TestPlan {
  const all = planItems(root, files);
  const byFolder = new Map(all.map((i) => [i.folder, i]));
  const changedBy = new Map<PlanFolderItem, string[]>();
  for (const p of changed) {
    const it = itemFolder(p);
    const item = it && byFolder.get(it.folder);
    if (item) changedBy.set(item, [...(changedBy.get(item) ?? []), p]);
  }
  const texts = new Map(all.map((i) => [i, files.filter((f) => f.startsWith(`${i.folder}/`) && !f.endsWith("/.platform")).map((f) => read(join(root, f)))]));
  const refs = new Map<PlanFolderItem, { target: PlanFolderItem; activity?: string }[]>();
  for (const caller of all) {
    const lowered = texts.get(caller)!.map((t) => t.toLowerCase());
    for (const target of all.filter((t) => t !== caller && t.logicalId)) {
      const idx = lowered.findIndex((t) => t.includes(target.logicalId!));
      if (idx >= 0) refs.set(caller, [...(refs.get(caller) ?? []), { target, activity: activityNaming(texts.get(caller)![idx], target.logicalId!) }]);
    }
  }
  const steps = new Map<PlanFolderItem, PlanStep>();
  for (const [item, paths] of changedBy) steps.set(item, { item, changedFiles: paths, functions: functionsOf(root, item) });
  let frontier = [...steps.keys()];
  while (frontier.length && steps.size < MAX_STEPS) {
    const next: PlanFolderItem[] = [];
    for (const caller of all.filter((i) => !steps.has(i))) {
      const hit = refs.get(caller)?.find((r) => frontier.includes(r.target));
      if (hit) {
        steps.set(caller, { item: caller, changedFiles: [], via: hit.target, activity: hit.activity, functions: functionsOf(root, caller) });
        next.push(caller);
      }
    }
    frontier = next;
  }
  const models = dbtModels(root, files, changed);
  if (models.length) for (const i of all.filter((x) => x.type.toLowerCase() === "databuildtooljob" && !steps.has(x))) steps.set(i, { item: i, changedFiles: [], functions: [] });
  const planned = [...steps.values()].filter((s) => modeOf(s.item.type) !== "none");
  // referenced before referencer (depth first), ties by rank and name
  const byItem = new Map(planned.map((s) => [s.item, s]));
  const done = new Set<PlanFolderItem>();
  const visiting = new Set<PlanFolderItem>();
  const cmp = (a: PlanFolderItem, b: PlanFolderItem) => rank(a.type) - rank(b.type) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const visit = (i: PlanFolderItem) => {
    if (done.has(i) || visiting.has(i)) return;
    visiting.add(i);
    for (const r of (refs.get(i) ?? []).map((x) => x.target).filter((t) => byItem.has(t)).sort(cmp)) visit(r);
    visiting.delete(i);
    done.add(i);
  };
  for (const i of planned.map((s) => s.item).sort(cmp)) visit(i);
  return { steps: [...done].map((i) => byItem.get(i)!).slice(0, MAX_STEPS), dbtModels: models, skipped: [...steps.values()].map((s) => s.item).filter((i) => modeOf(i.type) === "none") };
}

// ---- test strategy (legacy FabricTestStrategy, repository names from team.yaml) ------------------------------------------

export type Environment = "feature" | "dev" | "test";
export type StrategyKind = "fabric-api" | "azure-devops-integration" | "robot-integration" | "blocked";
export interface Decision {
  repository: string;
  environment: Environment;
  strategy: StrategyKind;
  executable: boolean;
  reason: string;
}
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

/**
 * Routing: a repository listed as integration repository uses the existing Azure DevOps integration test flow; a
 * repository listed as robot-gated needs an exact deployed-commit match in TEST before Robot counts as proof; the rest
 * validates live Fabric items in the DEV/FEATURE (or generic TEST) workspace.
 */
export function testStrategy(repository: string, environment: Environment, cfg: { integrationRepositories?: string[]; robotGatedRepositories?: string[] }, desired?: string, deployed?: string): Decision {
  const n = norm(repository);
  if ((cfg.integrationRepositories ?? []).some((r) => norm(r) === n)) return { repository, environment, strategy: "azure-devops-integration", executable: true, reason: "Use the existing Azure DevOps integration test flow. Unit tests are supplementary only." };
  if (environment !== "test") return { repository, environment, strategy: "fabric-api", executable: true, reason: "Validate live Fabric items, execution and results in a DEV or FEATURE workspace." };
  if (!(cfg.robotGatedRepositories ?? []).some((r) => norm(r) === n)) return { repository, environment, strategy: "fabric-api", executable: true, reason: "Use the generic Fabric API test lane in the TEST workspace; this does not replace a repository-specific integration suite." };
  return desired && deployed && desired.toLowerCase() === deployed.toLowerCase()
    ? { repository, environment, strategy: "robot-integration", executable: true, reason: "Deployment commit matches the requested revision; run the configured TEST Robot suites." }
    : { repository, environment, strategy: "blocked", executable: false, reason: "An exact deployment commit match in TEST is required before Robot integration tests may be presented as proof." };
}

const NL: Record<string, string> = { DataPipeline: "Pipeline", Notebook: "Notebook", UserDataFunction: "User Data Function", DataBuildToolJob: "dbt job", SparkJobDefinition: "Spark job", CopyJob: "Copy job" };
export const stepLabel = (i: PlanFolderItem) => `${NL[i.type] ?? i.type} "${i.name}"`;
