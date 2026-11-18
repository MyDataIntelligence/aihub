import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse as yaml } from "yaml";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, repoRoot } from "./git.js";
import { changeFacts, languageOf, repoFacts, type ChangeFacts, type RepoFacts, type RangeInput } from "./learn.js";
import { loadTeam } from "./team.js";

/**
 * Pictures and orientation facts for the learn skill: Mermaid text built from facts (never invented), the team's flow,
 * a glossary, your week, an onboarding bundle and a look at one item. Everything is git and files; Azure DevOps and
 * Fabric are not called. iDiagram is optional and only used when configured.
 */
const id = (s: string) => `n_${s.replace(/[^A-Za-z0-9]/g, "_")}`;
const label = (s: string) => s.replace(/["[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
const NL = String.fromCharCode(10);

export interface Diagram {
  kind: "architecture" | "lineage" | "repo" | "flow";
  title: string;
  mermaid: string;
  /** What the picture is built from, so nothing in it is a guess. */
  basedOn: string;
  empty: boolean;
}

/** Callers and tests around the changed names. */
export function architectureDiagram(f: ChangeFacts): Diagram {
  const lines = ["flowchart LR"];
  const names = new Set(f.symbols.filter((s) => s.kind !== "model").map((s) => s.name));
  const changed = [...names].filter((n) => !f.symbols.find((s) => s.name === n && /(^|\/)(tests?)\//.test(s.file)));
  for (const n of changed.slice(0, 8)) lines.push(`  ${id(n)}["${label(n)}"]:::changed`);
  const seen = new Set<string>();
  for (const c of f.impact.callers) {
    const from = `${c.file}`;
    const key = `${from}>${c.symbol}`;
    if (seen.has(key) || seen.size >= 16) continue;
    seen.add(key);
    lines.push(`  ${id(from)}["${label(from)}"] --> ${id(c.symbol)}`);
  }
  for (const t of f.impact.tests) {
    const key = `t:${t.file}>${t.symbol}`;
    if (seen.has(key) || seen.size >= 22) continue;
    seen.add(key);
    lines.push(`  ${id(t.file)}["${label(t.file)}"]:::test -.-> ${id(t.symbol)}`);
  }
  lines.push("  classDef changed fill:#fff3cd,stroke:#d39e00", "  classDef test fill:#e6f4ea,stroke:#3fb950");
  return { kind: "architecture", title: "Wie gebruikt de gewijzigde code", mermaid: lines.join(NL), basedOn: "git grep of the changed names (a text search, not a call graph)", empty: f.impact.callers.length + f.impact.tests.length === 0 };
}

/** dbt models: upstream and downstream of the changed models, or the whole graph of the repository. */
export function lineageDiagram(edges: { from: string; to: string }[], changed: string[] = []): Diagram {
  const lines = ["flowchart LR"];
  const used = new Set<string>();
  for (const e of edges.slice(0, 60)) {
    lines.push(`  ${id(e.from)}["${label(e.from)}"] --> ${id(e.to)}["${label(e.to)}"]`);
    used.add(e.from).add(e.to);
  }
  for (const c of changed) if (used.has(c)) lines.push(`  class ${id(c)} changed`);
  lines.push("  classDef changed fill:#fff3cd,stroke:#d39e00");
  return { kind: "lineage", title: "dbt lineage", mermaid: lines.join(NL), basedOn: "ref() and source() calls in the model files", empty: edges.length === 0 };
}

export function changeLineage(f: ChangeFacts): Diagram {
  const edges: { from: string; to: string }[] = [];
  for (const m of f.impact.dbt) {
    for (const u of m.upstream) edges.push({ from: u, to: m.name });
    for (const s of m.sources) edges.push({ from: s, to: m.name });
    for (const d of m.downstream) edges.push({ from: m.name, to: d });
  }
  return lineageDiagram(edges, f.impact.dbt.map((m) => m.name));
}

export function repoDiagram(r: RepoFacts): Diagram {
  const lines = ["flowchart TD", `  root(["${label(r.name)}"])`];
  for (const f of r.folders.slice(0, 12)) lines.push(`  root --> ${id(f.path)}["${label(f.path)}/ (${f.files} files${f.languages.length ? `, ${f.languages.join(" ")}` : ""})"]`);
  for (const p of r.pipelines.slice(0, 4)) lines.push(`  root -.-> ${id(p)}["${label(p)}"]:::pipe`);
  lines.push("  classDef pipe fill:#e8eefc,stroke:#4d8dff");
  return { kind: "repo", title: "De repository in een oogopslag", mermaid: lines.join(NL), basedOn: `${r.folders.length} top-level folder(s) read from git`, empty: r.folders.length === 0 };
}

export async function diagramFor(ctx: Ctx, o: { kind?: string; range: RangeInput }): Promise<Diagram> {
  const kind = o.kind ?? "architecture";
  if (kind === "repo") return repoDiagram(repoFacts(ctx));
  if (kind === "flow") return flowDiagram(ctx);
  if (kind === "lineage" && !o.range.pr && !o.range.branch && !o.range.range) {
    const r = repoFacts(ctx);
    return lineageDiagram(r.dbt?.edges ?? []);
  }
  const f = await changeFacts(ctx, o.range);
  if (kind === "architecture") return architectureDiagram(f);
  if (kind === "lineage") return changeLineage(f);
  throw new AihubError(`unknown diagram kind '${kind}'; use architecture, lineage, repo or flow`);
}

// ---- the team's flow ---------------------------------------------------------------------------

export interface TeamFlow {
  kind: "team-flow";
  steps: { name: string; detail: string }[];
  source: string;
  mermaid: string;
}

export function teamFlow(ctx: Ctx): TeamFlow {
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const have = Object.keys(team).length > 0;
  const target = team.repositories?.[0]?.defaultTarget ?? "main";
  const steps = [
    { name: "Story", detail: team.workItems?.storyType ? `a ${team.workItems.storyType} from the story template` : "a story in Azure DevOps" },
    { name: "Branch", detail: team.branches?.feature ? `named like ${team.branches.feature}` : "a feature branch with the story id" },
    { name: "Commits", detail: team.commits?.format ? `format ${team.commits.format}` : "small commits" },
    { name: "Pull request", detail: `into ${target}, from the pull request template` },
    { name: "Pipeline", detail: "the build and tests run on the PR" },
    { name: "Review", detail: "threads are answered and resolved" },
    { name: "Merge", detail: `into ${target}${team.branches?.protected?.length ? `, protected: ${team.branches.protected.join(", ")}` : ""}` },
  ];
  const lines = ["flowchart LR", ...steps.map((s, i) => `  s${i}["${label(s.name)}"]${i < steps.length - 1 ? ` --> s${i + 1}` : ""}`)];
  return { kind: "team-flow", steps, source: have ? ".agents/skills/_shared/references/team.yaml" : "no team.yaml found: generic flow", mermaid: lines.join(NL) };
}

export function flowDiagram(ctx: Ctx): Diagram {
  const f = teamFlow(ctx);
  return { kind: "flow", title: "Hoe wij werken", mermaid: f.mermaid, basedOn: f.source, empty: false };
}

// ---- glossary ----------------------------------------------------------------------------------

export interface Term {
  term: string;
  meaning: string;
  where: string;
}

const STOP = new Set(["readme", "index", "main", "init", "test", "tests", "docs", "src", "app", "lib", "utils", "config", "models", "schema"]);

/** Terms the repository itself uses: README headings and bold terms, dbt models and sources, top folders, team.yaml sections. */
export function glossary(ctx: Ctx): { kind: "glossary"; terms: Term[]; notes: string[] } {
  const root = repoRoot(ctx.cwd);
  const r = repoFacts(ctx);
  const terms = new Map<string, Term>();
  const add = (term: string, meaning: string, where: string) => {
    const k = term.toLowerCase();
    if (term.length >= 3 && !STOP.has(k) && !terms.has(k)) terms.set(k, { term, meaning, where });
  };
  const readme = git(root, ["ls-files"]).split(NL).find((p) => /^readme(\.md)?$/i.test(p));
  if (readme) {
    const text = readFileSync(join(root, readme), "utf8");
    for (const m of text.matchAll(/^\s*[-*]\s+\*\*([^*]{3,40})\*\*\s*[:–-]\s*(.+)$/gm)) add(m[1].trim(), m[2].trim().slice(0, 160), readme);
    for (const m of text.matchAll(/^#{2,3}\s+(.+)$/gm)) add(m[1].trim(), "section of the README", readme);
  }
  for (const m of r.dbt?.sources ?? []) add(m, "dbt source", r.dbt?.project ?? "dbt");
  if (r.dbt) for (const e of r.dbt.edges.slice(0, 60)) if (!e.from.includes(".")) add(e.from, "dbt model", "dbt/models");
  for (const f of r.folders.slice(0, 12)) add(f.path, `folder with ${f.files} file(s)${f.languages.length ? ` (${f.languages.join(", ")})` : ""}`, f.path + "/");
  if (r.teamFile) add("team.yaml", "how this team works with aihub: branches, pull requests, templates", ".agents/skills/_shared/references/team.yaml");
  return { kind: "glossary", terms: [...terms.values()].slice(0, 80), notes: ["terms come from the repository's own files; meanings only where the files state them. The learn skill explains the rest, marked as unverified."] };
}

// ---- my week -----------------------------------------------------------------------------------

export interface Week {
  kind: "week";
  since: string;
  author: string;
  commits: { sha: string; date: string; subject: string; branch?: string }[];
  branches: string[];
  files: { path: string; changes: number }[];
}

export function week(ctx: Ctx, days = 7): Week {
  const root = repoRoot(ctx.cwd);
  const author = git(root, ["config", "user.email"], { allowFail: true }).trim();
  const since = `${days}.days.ago`;
  const log = git(root, ["log", "--all", "--no-merges", `--since=${since}`, author ? `--author=${author}` : "--max-count=50", "--format=%h%x09%as%x09%s", "-n", "60"], { allowFail: true });
  const commits = log.split(NL).filter(Boolean).map((l) => {
    const [sha, date, ...s] = l.split("\t");
    return { sha, date, subject: s.join("\t") };
  });
  const branches = [...new Set(git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], { allowFail: true }).split(NL).filter(Boolean))].slice(0, 8);
  const names = git(root, ["log", "--all", "--no-merges", `--since=${since}`, author ? `--author=${author}` : "--max-count=50", "--name-only", "--format="], { allowFail: true }).split(NL).filter(Boolean);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const files = [...count].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([path, changes]) => ({ path, changes }));
  return { kind: "week", since: `${days} days`, author, commits, branches, files };
}

// ---- one item ----------------------------------------------------------------------------------

export interface ItemFacts {
  kind: "item-facts";
  type: "file" | "pipeline" | "fabric-item" | "dbt-model";
  path: string;
  language: string;
  lines: number;
  details: Record<string, unknown>;
  usedBy: { file: string; line: number; text: string }[];
  mermaid?: string;
  notes: string[];
}

export function itemFacts(ctx: Ctx, rel: string): ItemFacts {
  const root = repoRoot(ctx.cwd);
  const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
  const abs = join(root, norm);
  if (!existsSync(abs)) throw new AihubError(`${norm} is not in this checkout`);
  const isDir = !extname(abs) && readdirSafe(abs).length > 0;
  const notes: string[] = [];
  // a Fabric item is a folder named <name>.<Type> (git integration format)
  const fabric = /^(.*?)([^/]+)\.(Notebook|DataPipeline|Lakehouse|SemanticModel|Report|Warehouse|Environment|VariableLibrary|CopyJob)(\/.*)?$/.exec(norm);
  if (fabric) {
    const dir = `${fabric[1]}${fabric[2]}.${fabric[3]}`;
    const parts = readdirSafe(join(root, dir));
    const content = parts.find((p) => /^(notebook-content|pipeline-content)\./.test(p));
    const text = content ? readFileSync(join(root, dir, content), "utf8") : "";
    const refs = [...text.matchAll(/"(?:notebookId|pipelineId|referenceName|name)"\s*:\s*"([^"]{3,60})"/g)].map((m) => m[1]);
    return { kind: "item-facts", type: "fabric-item", path: dir, language: "fabric", lines: text.split(NL).length, details: { name: fabric[2], itemType: fabric[3], parts, references: [...new Set(refs)].slice(0, 20) }, usedBy: usedBy(root, fabric[2]), notes: ["read from the git integration folder, not from the live workspace"] };
  }
  if (isDir) throw new AihubError(`${norm} is a folder; give a file, a pipeline yaml, a dbt model or a Fabric item folder`);
  const text = readFileSync(abs, "utf8");
  const lines = text.split(NL).length;
  const lang = languageOf(norm);
  if (lang === "yaml" && /(^|\/)(azure-pipelines[^/]*|[^/]*pipeline[^/]*)\.ya?ml$/i.test(norm)) {
    const doc = safeYaml(text) as Record<string, unknown> | undefined;
    // a job entry is a `job`, a `deployment` or a `template:` include; a template has no name of its own, so it is shown as `template <path>`
    const jobName = (j: { job?: string; deployment?: string; template?: string }): string => j.job ?? j.deployment ?? (j.template ? `template ${j.template}` : "(unnamed)");
    const stages = ((doc?.stages as { stage?: string; jobs?: { job?: string; deployment?: string; template?: string }[] }[]) ?? []).map((s) => ({ stage: s.stage, jobs: (s.jobs ?? []).map(jobName) }));
    const jobs = ((doc?.jobs as { job?: string; deployment?: string; template?: string }[]) ?? []).map(jobName);
    const steps = ((doc?.steps as Record<string, unknown>[]) ?? []).map((s) => String(s.script ?? s.task ?? s.bash ?? s.pwsh ?? (s.template ? `template ${String(s.template)}` : Object.keys(s)[0])).split(NL)[0].slice(0, 60));
    const mer = ["flowchart LR", ...stages.flatMap((s, i) => [`  ${id("st" + i)}["${label(String(s.stage))}"]${i < stages.length - 1 ? ` --> ${id("st" + (i + 1))}` : ""}`])];
    return { kind: "item-facts", type: "pipeline", path: norm, language: "yaml", lines, details: { trigger: doc?.trigger, pool: doc?.pool, stages, jobs, steps: steps.slice(0, 15), variables: Object.keys((doc?.variables as object) ?? {}) }, usedBy: [], ...(stages.length ? { mermaid: mer.join(NL) } : {}), notes };
  }
  if (lang === "sql" && /(^|\/)models\//.test(norm)) {
    const name = basename(norm, ".sql");
    const up = [...text.matchAll(/ref\(\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => m[1]);
    const src = [...text.matchAll(/source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => `${m[1]}.${m[2]}`);
    const down = git(root, ["grep", "-l", "-I", "-E", `ref\\(\\s*['"]${name}['"]\\s*\\)`, "HEAD", "--", "*.sql"], { allowFail: true }).split(NL).filter(Boolean).map((p) => basename(p.replace("HEAD:", ""), ".sql"));
    const edges = [...up.map((u) => ({ from: u, to: name })), ...src.map((s) => ({ from: s, to: name })), ...down.map((d) => ({ from: name, to: d }))];
    return { kind: "item-facts", type: "dbt-model", path: norm, language: "sql", lines, details: { name, upstream: [...new Set(up)], sources: [...new Set(src)], downstream: [...new Set(down)], materialized: /materialized\s*=\s*['"](\w+)['"]/.exec(text)?.[1] }, usedBy: [], mermaid: lineageDiagram(edges, [name]).mermaid, notes };
  }
  const defs = [...text.matchAll(/^\s*(?:async\s+)?(?:def|function|class|fun)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  const imports = [...text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+)|const .* = require\(['"]([^'"]+))/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
  return { kind: "item-facts", type: "file", path: norm, language: lang, lines, details: { definitions: defs.slice(0, 40), imports: [...new Set(imports)].slice(0, 30) }, usedBy: usedBy(root, basename(norm, extname(norm))), notes: ["usedBy is a text search for the file name, not a call graph"] };
}

const readdirSafe = (p: string) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};
const safeYaml = (t: string) => {
  try {
    return yaml(t);
  } catch {
    return undefined;
  }
};
function usedBy(root: string, name: string): { file: string; line: number; text: string }[] {
  if (name.length < 3) return [];
  const out = git(root, ["grep", "-n", "-w", "-I", "-F", name, "HEAD", "--", ":!*.lock"], { allowFail: true });
  return out.split(NL).filter(Boolean).slice(0, 12).map((l) => {
    const m = /^HEAD:(.*?):(\d+):(.*)$/.exec(l);
    return m ? { file: m[1], line: +m[2], text: m[3].trim().slice(0, 140) } : undefined;
  }).filter((x): x is { file: string; line: number; text: string } => !!x);
}

// ---- onboarding --------------------------------------------------------------------------------

export function onboarding(ctx: Ctx) {
  const repo = repoFacts(ctx);
  return { kind: "onboarding", repo, flow: teamFlow(ctx), glossary: glossary(ctx).terms.slice(0, 30), diagrams: [repoDiagram(repo), ...(repo.dbt ? [lineageDiagram(repo.dbt.edges)] : []), flowDiagram(ctx)], notes: ["facts only; the learn skill writes the welcome lesson from them"] };
}

// ---- iDiagram (optional) -----------------------------------------------------------------------

/** iDiagram is an extra: used only when AIHUB_IDIAGRAM_URL is set. Without it Mermaid is the whole answer. */
export function idiagramStatus(env: NodeJS.ProcessEnv): { configured: boolean; url?: string; message: string } {
  const url = env.AIHUB_IDIAGRAM_URL;
  if (!url) return { configured: false, message: "iDiagram is not configured (set AIHUB_IDIAGRAM_URL to use it); the Mermaid picture is complete without it" };
  return { configured: true, url, message: `iDiagram is configured at ${url}, but pushing a board is not implemented yet: the Mermaid text can be pasted into it` };
}
