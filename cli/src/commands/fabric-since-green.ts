import type { AdoClient } from "../lib/ado.js";
import { repoClientAt } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import type { FabricClient, FabricItem, JobInstance } from "../lib/fabric.js";
import { causeOfChain } from "../lib/fabric-diag.js";
import { parseUtc } from "../lib/fabric-ops.js";
import { git } from "../lib/git.js";
import {
  areas,
  commitsBetween,
  commitTitle,
  deployEnvs,
  groupChanges,
  isConfigured,
  label,
  listEnvs,
  matchEnv,
  missingDeployedBy,
  noEnvMessage,
  pullRequestsOf,
  rank,
  runRepositories,
  searchDeployments,
  short,
  storyText,
  type CommitInfo,
  type DeployEnv,
  type Deployment,
  type Suspect,
  type Change,
} from "../lib/sinceGreen.js";
import { loadTeam } from "../lib/team.js";
import type { Link } from "./fabric-deep.js";
import { emit, makeClient, type Setup, type Target } from "./fabric.js";

const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const first = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

/** The display name of a workspace given by id (one read); the input when it is a name or the read fails. */
async function displayName(client: FabricClient | undefined, ws: string): Promise<string> {
  if (!client || !isGuid(ws)) return ws;
  try {
    return ((await client.request("GET", `/workspaces/${ws}`)).data as { displayName?: string }).displayName ?? ws;
  } catch {
    return ws;
  }
}

const envJson = (e: DeployEnv) => ({ name: e.name, branch: e.branch, workspace: e.workspace, pipeline: e.pipeline, stage: e.stage });

// ---- aihub fabric deployed ----------------------------------------------------------------------------------------------

/** `aihub fabric deployed --workspace W | --env ENV`: which commit runs in a CD-filled workspace. */
export async function deployedCmd(s: Setup): Promise<void> {
  const given = (s.v.workspace as string[] | undefined)?.[0];
  const envName = typeof s.v.env === "string" ? s.v.env : undefined;
  if (!s.root) throw new AihubError("aihub fabric deployed reads fabric.environments from team.yaml: run it in a clone of the repository");
  const { client } = repoClientAt(s.ctx, s.root);
  const envs = deployEnvs(loadTeam(s.root), client.remote.repo);
  if (!given && !envName) throw new AihubError(`aihub fabric deployed needs --workspace <name> or --env <ENV>; configured in team.yaml fabric.environments: ${listEnvs(envs)}`);
  const wsName = given ? await displayName(isGuid(given) ? makeClient(s.ctx, s.v) : undefined, given) : undefined;
  const env = matchEnv(envs, { workspace: wsName, env: envName });
  if (!env) throw new AihubError(envName && !given ? `environment '${envName}' is not in team.yaml fabric.environments (configured: ${listEnvs(envs)})` : noEnvMessage(envs, wsName));
  if (!isConfigured(env)) throw new AihubError(missingDeployedBy(env));

  const search = await searchDeployments(client, env, { stop: () => true });
  const d = search.found[0];
  const head = [`environment: ${env.name}`, `workspace: ${env.workspace ?? wsName ?? "-"}`, `branch: ${env.branch}`];
  if (!d) {
    const note = `no run of ${search.definition.name} on ${env.branch} has a succeeded stage ${env.stage} in the newest ${search.looked} run(s) looked at, so the deployed commit is not known`;
    emit(s, { environment: envJson(env), pipeline: search.definition, looked: search.looked, run: null, commit: null, pullRequests: [], otherRepositories: [], note }, [...head, note].join("\n"));
    return;
  }
  const title = (await commitTitle(client, d.commit, d.repositoryId)) ?? d.triggerMessage?.split(/\r?\n/)[0] ?? "";
  const { byCommit, prs } = await pullRequestsOf(client, [{ commit: d.commit, title }], d.repositoryId).catch(() => ({ byCommit: new Map<string, number[]>(), prs: new Map() }));
  const prList = (byCommit.get(d.commit) ?? []).map((id) => prs.get(id)!).filter(Boolean);
  const others = await runRepositories(client, search.definition.id, d.run);
  const lines = [
    ...head,
    `commit: ${short(d.commit)} ${title}`.trimEnd(),
    `run: ${d.run}${d.number ? ` (${d.number})` : ""} of ${search.definition.name}, stage ${env.stage} finished ${d.finished}`,
    `triggered: ${d.reason ?? "-"}${d.requestedFor ? ` by ${d.requestedFor}` : ""}`,
    ...(prList.length ? prList.map((p) => `pull request: ${p.pr} "${p.title}"${p.stories.length ? ` (${storyText(p.stories)})` : ""}`) : ["pull request: none found for this commit"]),
    ...(others && Object.keys(others).length ? [`other repositories: ${Object.entries(others).map(([a, v]) => `${a} ${short(v)}`).join(", ")}`] : []),
  ];
  emit(
    s,
    {
      environment: envJson(env),
      pipeline: search.definition,
      looked: search.looked,
      run: { id: d.run, number: d.number, finished: d.finished, reason: d.reason, requestedFor: d.requestedFor },
      commit: { sha: d.commit, title },
      pullRequests: prList,
      otherRepositories: others ? Object.entries(others).map(([alias, version]) => ({ alias, version })) : [],
    },
    lines.join("\n"),
  );
}

// ---- aihub fabric failures --since-green --------------------------------------------------------------------------------

export type Outcome = "suspects" | "deployedUnrelated" | "nothingDeployed" | "noGreenRun" | "notConfigured" | "unavailable";

export interface SinceGreen {
  window: { failed: { item: string; job: string; start?: string }; green: { job: string; end?: string } | null };
  environment: ReturnType<typeof envJson> | null;
  deployments: { run: number; number?: string; finished: string; commit: string }[];
  before: { run: number; finished: string; commit: string } | null;
  after: { run: number; finished: string; commit: string } | null;
  commits: { commit: string; title: string; pr?: number; paths: string[] }[];
  otherRepositoriesAvailable: boolean;
  otherRepositories: { alias: string; before: string; after: string; changed: boolean }[];
  suspects: { pr?: number; commit?: string; title: string; stories: { id: number; title?: string }[]; reason: string; paths: string[] }[];
  unrelated: { pr?: number; commit?: string; title: string; stories: { id: number; title?: string }[]; paths: string[] }[];
  outcome: Outcome;
  notes: string[];
}

const GREEN = /^(completed|succeeded)$/i;
const depJson = (d: Deployment) => ({ run: d.run, finished: d.finished, commit: d.commit });

/** Names of the items below the failed item in the root-cause chain, deepest first. */
export function chainNames(chain: Link[]): string[] {
  return chain
    .slice(1)
    .filter((l) => l.kind === "spark session" || l.kind.startsWith("activity") || l.kind === "Notebook" || l.kind === "DataPipeline")
    .map((l) => l.name.replace(/\s+\(.*\)$/, "").trim())
    .filter((n) => n && n !== "-" && n !== "?")
    .reverse();
}

/** What changed since the last green run of the failed item: the text lines and the JSON object. */
export async function sinceGreen(s: Setup, fabric: FabricClient, t: Target, f: { item: FabricItem; job: JobInstance }, jobs: JobInstance[], chain: Link[]): Promise<{ lines: string[]; data: SinceGreen }> {
  const fStart = parseUtc(f.job.startTimeUtc);
  const green = jobs
    .filter((j) => j.id !== f.job.id && GREEN.test(j.status) && j.endTimeUtc && parseUtc(j.endTimeUtc) < fStart)
    .sort((a, b) => parseUtc(b.endTimeUtc) - parseUtc(a.endTimeUtc))[0];
  const data: SinceGreen = {
    window: { failed: { item: f.item.displayName, job: f.job.id, start: f.job.startTimeUtc }, green: green ? { job: green.id, end: green.endTimeUtc } : null },
    environment: null,
    deployments: [],
    before: null,
    after: null,
    commits: [],
    otherRepositoriesAvailable: false,
    otherRepositories: [],
    suspects: [],
    unrelated: [],
    outcome: "noGreenRun",
    notes: [],
  };
  const lines = [`since green (what changed since the last green run of ${f.item.displayName}):`, `  red: job ${f.job.id} started ${f.job.startTimeUtc ?? "-"}`];
  const done = (outcome: Outcome, ...notes: string[]) => {
    data.outcome = outcome;
    data.notes.push(...notes);
    for (const n of notes) lines.push(`  ${n.replace(/\n/g, "\n  ")}`);
    lines.push(`  outcome: ${outcome}`);
    return { lines, data };
  };
  if (!green) return done("noGreenRun", `no green run: ${f.item.displayName} never succeeded before this run in the history Fabric returns (${jobs.length} run(s))`);
  lines.push(`  last green: job ${green.id} ended ${green.endTimeUtc}`);
  const gEnd = parseUtc(green.endTimeUtc);

  let ado!: AdoClient;
  let env!: DeployEnv;
  try {
    if (!s.root) throw new AihubError("no repository here: run it in a clone of the repository to read team.yaml and Azure DevOps");
    ado = repoClientAt(s.ctx, s.root).client;
    const envs = deployEnvs(loadTeam(s.root), ado.remote.repo);
    const m = matchEnv(envs, { workspace: await displayName(fabric, t.ws.name) });
    if (!m) return done("notConfigured", noEnvMessage(envs, t.ws.name));
    env = m;
  } catch (e) {
    return done("unavailable", `environment not known: ${first(e)}`);
  }
  data.environment = envJson(env);
  if (!isConfigured(env)) return done("notConfigured", missingDeployedBy(env));
  lines.push(`  environment: ${env.name} (branch ${env.branch}, pipeline ${env.pipeline}, stage ${env.stage})`);

  try {
    const search = await searchDeployments(ado, env, { skipQueuedAfter: fStart, stop: (d) => parseUtc(d.finished) <= gEnd });
    const inWindow = search.found.filter((d) => parseUtc(d.finished) > gEnd && parseUtc(d.finished) <= fStart);
    const before = search.found.find((d) => parseUtc(d.finished) <= gEnd);
    const after = search.found.find((d) => parseUtc(d.finished) <= fStart);
    data.deployments = inWindow.map((d) => ({ run: d.run, number: d.number, finished: d.finished, commit: d.commit }));
    data.before = before ? depJson(before) : null;
    data.after = after ? depJson(after) : null;
    if (!search.reached) data.notes.push(`the newest ${search.looked} run(s) of ${search.definition.name} on ${env.branch} do not reach back to the green run: the deployment live during it is not known`);

    // oldest first, each with the commit it replaced
    const chrono = [...inWindow].reverse();
    if (chrono.length) {
      lines.push(`  deployed between green and red (branch ${env.branch}, stage ${env.stage}):`);
      chrono.forEach((d, i) => lines.push(`    ${d.finished} run ${d.run}${d.number ? ` (${d.number})` : ""} ${i ? short(chrono[i - 1].commit) : before ? short(before.commit) : "?"} -> ${short(d.commit)}`));
    }
    lines.push(`  code during the green run: ${before ? short(before.commit) : "not known"}; during the red run: ${after ? short(after.commit) : "not known"}`);

    // other repositories of the run (templates of a central repository, ...)
    if (before && after) {
      const [rb, ra] = [await runRepositories(ado, search.definition.id, before.run), await runRepositories(ado, search.definition.id, after.run)];
      if (rb && ra) {
        data.otherRepositoriesAvailable = true;
        data.otherRepositories = [...new Set([...Object.keys(rb), ...Object.keys(ra)])].sort().map((alias) => ({ alias, before: rb[alias] ?? "", after: ra[alias] ?? "", changed: rb[alias] !== ra[alias] }));
      }
    }
    lines.push(
      `  other repositories of the run: ${
        !data.otherRepositoriesAvailable ? "not available" : data.otherRepositories.length ? data.otherRepositories.map((r) => `${r.alias} ${r.changed ? `${short(r.before) || "-"} -> ${short(r.after) || "-"}` : `${short(r.after)} unchanged`}`).join(", ") : "none"
      }`,
    );

    if (!inWindow.length) {
      const c = causeOfChain(chain);
      for (const n of data.notes) lines.push(`  ${n}`);
      const note = `nothing was deployed to ${env.name} between the green and the red run: the cause is outside the code (source data, capacity, an upstream that was not ready)${c.kind !== "unknown" ? `; likely cause: ${c.kind}: ${c.hint}` : ""}`;
      return done("nothingDeployed", note);
    }

    // what changed: the commits from the code of the green run to the code of the red run
    const base = before?.commit ?? chrono[0].commit;
    if (!before) data.notes.push(`commits are counted from the oldest deployment found (${short(base)}); what that deployment itself brought is not included`);
    let commits: CommitInfo[] = [];
    if (after && base !== after.commit) {
      const r = await commitsBetween(ado, base, after.commit, after.repositoryId);
      commits = r.commits;
      if (r.capped) data.notes.push(`only the newest ${commits.length} commits of ${short(base)}..${short(after.commit)} were read`);
      if (!r.confirmed) data.notes.push(commits.length ? `the commit list of ${short(base)}..${short(after.commit)} does not hold ${short(after.commit)} itself: it may not be the right range` : `Azure DevOps returned no commits for ${short(base)}..${short(after.commit)} although the deployed commit changed`);
    } else data.notes.push("the deployments in the window redeployed the same commit: no code changed in this repository");
    const { byCommit, prs } = commits.length ? await pullRequestsOf(ado, commits, after?.repositoryId) : { byCommit: new Map<string, number[]>(), prs: new Map() };
    data.commits = commits.map((c) => ({ commit: c.commit, title: c.title, ...(byCommit.get(c.commit)?.[0] !== undefined ? { pr: byCommit.get(c.commit)![0] } : {}), paths: c.paths }));
    const changes = groupChanges(commits, prs, byCommit);

    let clone: { root: string; files: string[] } | undefined;
    const files = git(s.root!, ["ls-files"], { allowFail: true }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (files.length) clone = { root: s.root!, files };
    else data.notes.push("no local clone: items that the failed item calls are not checked");
    const r = rank(changes, { failed: { name: f.item.displayName, type: f.item.type }, chainNames: chainNames(chain), clone });
    const asJson = (c: Change) => ({ ...(c.pr !== undefined ? { pr: c.pr } : { commit: c.commits[0] }), title: c.title, stories: c.stories });
    data.suspects = r.suspects.map((x: Suspect) => ({ ...asJson(x), reason: x.reason, paths: x.touched }));
    data.unrelated = r.unrelated.map((x) => ({ ...asJson(x), paths: x.paths }));

    lines.push(`  commits: ${commits.length} in ${short(base)}..${short(after?.commit)}, ${changes.length} change(s)`);
    if (r.suspects.length) {
      lines.push("  suspects:");
      r.suspects.forEach((x, i) => lines.push(`    ${i + 1}. ${label(x)} "${x.title}"${x.stories.length ? ` (${storyText(x.stories)})` : ""}`, `       ${x.reason}: ${x.touched.slice(0, 3).join(", ")}${x.touched.length > 3 ? ` and ${x.touched.length - 3} more` : ""}`));
    }
    for (const x of r.unrelated) lines.push(`  not suspect: ${label(x)} "${x.title}" touches only ${areas(x.paths)}`);
    // a changed template repository changes what is deployed without a commit here: say it where the reader decides
    const moved = data.otherRepositories.filter((x) => x.changed);
    if (moved.length) data.notes.push(`another repository of the run changed (${moved.map((x) => `${x.alias} ${short(x.before) || "-"} -> ${short(x.after) || "-"}`).join(", ")}): its commits are not read here, so look there too`);
    for (const n of data.notes) lines.push(`  ${n}`);
    data.outcome = r.suspects.length ? "suspects" : "deployedUnrelated";
    lines.push(`  outcome: ${data.outcome}`);
    const top = r.suspects[0];
    if (top) lines.push(`next: ${top.pr !== undefined ? `aihub pr explain --pr ${top.pr}` : `git show ${short(top.commits[0])}`}`);
    return { lines, data };
  } catch (e) {
    return done("unavailable", `deployments not read: ${first(e)}`);
  }
}
