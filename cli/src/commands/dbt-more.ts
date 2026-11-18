import { relative } from "node:path";
import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { projectImpact } from "../lib/dbt-changed.js";
import { renderImpactMarkdown, renderImpactText } from "../lib/dbt-impact.js";
import { findNode, loadManifest } from "../lib/dbt-manifest.js";
import { dbtRunner, resolveProject } from "../lib/dbt-run.js";
import { addEntry, columnsOf, entryFile, modelEntry, renderFindings, unitTestEntry, yamlCheck } from "../lib/dbt-yaml.js";
import { shortBranch } from "../lib/ado.js";
import { resolvePr } from "../lib/pr.js";
import { editSection } from "../lib/templates.js";
import { loadTeam } from "../lib/team.js";
import { stringify as yamlStringify } from "yaml";

interface Flags {
  project?: string;
  base?: string;
  state?: string;
  write?: boolean;
  pr?: string;
  json?: boolean;
  "dry-run"?: boolean;
  "unit-test"?: boolean;
  columns?: string;
  strict?: boolean;
}
type Emit = (data: unknown, text: string) => void;

const heading = (nl: boolean) => (nl ? "dbt-impact" : "dbt impact");

export async function impact(ctx: Ctx, v: Flags, emit: Emit): Promise<void> {
  const p = resolveProject(ctx, v.project);
  let base = v.base;
  let pr: Awaited<ReturnType<typeof resolvePr>> | undefined;
  let client: ReturnType<typeof repoClient>["client"] | undefined;
  if (v.write || v.pr) {
    const rc = repoClient(ctx);
    client = rc.client;
    pr = await resolvePr(ctx, client, rc.root, v.pr);
    base ??= shortBranch(pr.targetRefName);
  }
  const imp = projectImpact(ctx, p, { base, state: v.state });
  let written = false;
  const nl = (loadTeam(p.root) as { language?: string }).language === "nl";
  if (v.write && pr && client) {
    const body = renderImpactMarkdown(imp, nl);
    if (v["dry-run"]) {
      ctx.out(`dry-run: would write the '${heading(nl)}' section of PR !${pr.pullRequestId}:\n${body}`);
    } else {
      await client.patch(`${client.repoPath()}/pullrequests/${pr.pullRequestId}`, { description: editSection(pr.description ?? "", heading(nl), { replace: body }) });
      written = true;
    }
  }
  emit({ ...imp, ...(pr ? { pr: pr.pullRequestId } : {}), written }, `${renderImpactText(imp)}${written ? `\nwritten to the '${heading(nl)}' section of PR !${pr!.pullRequestId}` : ""}`);
}

export async function yamlCmd(ctx: Ctx, v: Flags, positionals: string[], emit: Emit): Promise<void> {
  const [what, model] = positionals;
  const p = resolveProject(ctx, v.project);
  const runner = dbtRunner(ctx, p);
  if (what === "check") {
    const findings = yamlCheck(p, loadManifest(p, runner));
    emit({ project: p.info.name, findings }, renderFindings(p.info.name, findings));
    if (v.strict && findings.some((f) => f.level === "warn")) throw new AihubError(`dbt yaml check found ${findings.filter((f) => f.level === "warn").length} warning(s)`);
    return;
  }
  if (what !== "scaffold" || !model) throw new AihubError("usage: aihub dbt yaml check [--strict] | aihub dbt yaml scaffold <model> [--write] [--unit-test] [--columns a,b]");
  const m = loadManifest(p, runner);
  const n = findNode(m, model);
  if (!["model", "seed", "snapshot"].includes(n.kind)) throw new AihubError(`${model} is a ${n.kind}: scaffold works for models`);
  const given = v.columns ? v.columns.split(",").map((c) => ({ name: c.trim() })).filter((c) => c.name) : undefined;
  const cache = new Map<string, ReturnType<typeof columnsOf>>();
  const cols = (x: typeof n) => (x === n && given ? given : (cache.get(x.id) ?? (cache.set(x.id, columnsOf(p, runner, x, m)), cache.get(x.id)!)));
  const own = cols(n);
  if (!own.length) throw new AihubError(`no columns for ${model}: run \`aihub dbt build --select ${model}\` first, or pass --columns a,b`);
  const unit = !!v["unit-test"];
  if (!unit && n.yml) throw new AihubError(`${model} already has an entry in ${n.yml}: run \`aihub dbt yaml check\` to see what is missing, or edit it`);
  const key = unit ? "unit_tests" : "models";
  const entry = unit ? unitTestEntry(n, m, cols, own) : modelEntry(n.name, own);
  const file = n.yml ? `${p.dir}/${n.yml}` : entryFile(p, n);
  const rel = relative(p.dir, file).replace(/\\/g, "/");
  const text = yamlStringify({ [key]: [entry] }, { lineWidth: 0 });
  if (v.write && !v["dry-run"]) addEntry(file, key, entry);
  emit({ model: n.name, file: rel, key, entry, written: !!v.write && !v["dry-run"] }, v.write ? `${v["dry-run"] ? "would add" : "added"} ${unit ? "a unit test" : "the entry"} for ${n.name} to ${rel}\n${text}` : `# ${rel}\n${text}(add --write to put it in ${rel})`);
}
