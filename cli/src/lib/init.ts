import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseRemote } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, hasRef, originDefaultBranch, pushIfNeeded, remoteUrl, repoRoot, showFile } from "./git.js";
import { listFiles, packRoot, readPackFile } from "./pack.js";
import { createPr } from "./pr.js";
import { trace } from "./trace.js";
import { agentsBlock, detectAreas, instructionFile, instructionsReadme, planAgentsMd, trackedFiles } from "./initExtras.js";
import { TEAM_FILE } from "./team.js";
import { resolveTemplate } from "./templates.js";

export type Language = "nl" | "en";
export const PACK_BRANCH = "chore/aihub-team-pack";
export const STORY_TEMPLATE = ".agents/skills/_shared/assets/story-template.md";
export const COMMIT_TEMPLATE = ".agents/skills/_shared/assets/commit-template.txt";
export const PR_TEMPLATE = ".azuredevops/pull_request_template.md";

export interface InitOpts {
  repo?: string;
  noPr?: boolean;
  language?: string;
  /** Also write the slash commands into the repository (.opencode/command, .github/prompts); by default only team knowledge goes in. */
  intoRepo?: boolean;
  /** Skip the .github/instructions skeletons. */
  noInstructions?: boolean;
  /** Skip the AGENTS.md block. */
  noAgentsMd?: boolean;
}

export interface Planned {
  path: string;
  content: string;
  /** The file exists: this is its new content (an aihub block appended), written only for AGENTS.md. */
  append?: boolean;
}

export interface InitResult {
  created: string[];
  /** existing files that got an aihub block appended (AGENTS.md) */
  updated: string[];
  skipped: { path: string; reason: string }[];
  branch?: string;
  pr?: string;
}

export function parseLanguage(v: string | undefined): Language {
  if (!v) return "en";
  if (v === "nl" || v === "en") return v;
  throw new AihubError(`--language must be nl or en, not '${v}'`);
}

/** The team pack files (the single source: team-pack/ in the repository, pack/team-pack in the npm package). */
export function teamPackDir(): string {
  return join(packRoot(), "team-pack");
}

/** team-pack/team.yaml with the values of this repository filled in; the comments of the example stay. */
function teamYaml(src: string, o: { org: string; project: string; repo: string; target: string; language: Language; prTemplate: string; states?: ProjectStates }): string {
  const doc = parseDocument(src);
  doc.setIn(["language"], o.language);
  doc.setIn(["azureDevOps", "organization"], o.org);
  doc.setIn(["azureDevOps", "project"], o.project);
  doc.setIn(["repositories", 0, "name"], o.repo);
  doc.setIn(["repositories", 0, "defaultTarget"], o.target);
  doc.setIn(["repositories", 0, "aliases"], doc.createNode([]));
  doc.setIn(["pullRequest", "template"], o.prTemplate);
  doc.setIn(["pullRequest", "emptySection"], o.language === "nl" ? "n.v.t." : "-");
  if (o.states) {
    doc.setIn(["workItems", "states", "active"], o.states.active);
    doc.setIn(["workItems", "states", "finished"], o.states.finished);
  }
  doc.setIn(["branches", "protected", 0], o.target);
  doc.deleteIn(["pipelines"]);
  doc.deleteIn(["guidelines"]);
  doc.deleteIn(["cherryPick"]);
  return "# Proposed by 'aihub init': check every value and change it through a pull request.\n" + String(doc);
}
/** Where Azure DevOps already finds a PR template for the target branch, or undefined. */
export function existingPrTemplate(root: string, target: string): string | undefined {
  return resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), localRoot: root })?.path;
}

/** Everything `aihub init` would like to have in the repository (before skipping what exists). */
export function planFiles(root: string, o: { org: string; project: string; repo: string; target: string; language: Language; intoRepo?: boolean; states?: ProjectStates; noInstructions?: boolean; noAgentsMd?: boolean }): { plan: Planned[]; skips: Record<string, string> } {
  const pack = packRoot();
  const dir = teamPackDir();
  const en = o.language === "en";
  // team-pack holds Dutch files and `name.en.ext` English variants; the repository gets the plain name either way
  const read = (rel: string) => {
    const enRel = rel.replace(/(\.[^./]+)$/, ".en$1");
    return readPackFile(join(dir, en && existsSync(join(dir, enRel)) ? enRel : rel));
  };
  const found = existingPrTemplate(root, o.target);
  const plan: Planned[] = [
    { path: TEAM_FILE, content: teamYaml(readPackFile(join(dir, TEAM_FILE)), { ...o, prTemplate: found && !found.includes("/branches/") ? found : PR_TEMPLATE }) },
    { path: STORY_TEMPLATE, content: read(STORY_TEMPLATE) },
    { path: COMMIT_TEMPLATE, content: read(COMMIT_TEMPLATE) },
  ];
  if (!found) plan.push({ path: PR_TEMPLATE, content: read(PR_TEMPLATE) });  if (o.intoRepo) {
    for (const f of listFiles(join(pack, "commands", "opencode"))) {
      plan.push({ path: `.opencode/command/${f}`, content: readPackFile(join(pack, "commands", "opencode", f)) });
    }
    for (const f of listFiles(join(pack, "commands", "copilot"))) {
      plan.push({ path: `.github/prompts/${f}`, content: readPackFile(join(pack, "commands", "copilot", f)) });
    }
  }
  const skips: Record<string, string> = found ? { [PR_TEMPLATE]: `a pull request template already exists (${found})` } : {};
  if (!o.noInstructions) {
    for (const a of detectAreas(trackedFiles(root))) plan.push(instructionFile(a, o.language));
    plan.push(instructionsReadme(o.language));
  }
  if (!o.noAgentsMd) {
    const prTemplate = found && !found.includes("/branches/") ? found : PR_TEMPLATE;
    const a = planAgentsMd(root, agentsBlock(o.language, { prTemplate, teamFile: TEAM_FILE, instructions: !o.noInstructions }));
    if ("skip" in a) skips["AGENTS.md"] = a.skip;
    else plan.push({ path: "AGENTS.md", content: a.content, append: a.append });
  }
  return { plan, skips };
}

/** Write planned files that do not exist yet; never touches an existing file. */
export function writePlanned(root: string, plan: Planned[], skipExtra: Record<string, string> = {}): InitResult {
  const res: InitResult = { created: [], updated: [], skipped: [] };
  for (const [path, reason] of Object.entries(skipExtra)) res.skipped.push({ path, reason });
  for (const p of plan) {
    const abs = join(root, p.path);
    if (existsSync(abs) && !p.append) {
      res.skipped.push({ path: p.path, reason: "exists" });
      continue;
    }
    if (trace.dryRun) trace.plan(`would write ${abs}`);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, p.content, "utf8");
    }
    (p.append ? res.updated : res.created).push(p.path);
  }
  return res;
}

function prBody(language: Language, r: InitResult): string {
  const nl = language === "nl";
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``).join("\n") : nl ? "- geen" : "- none");
  return [
    `## ${nl ? "Samenvatting" : "Summary"}`, // the first heading of the bundled PR templates, so the text lands in the template instead of an extra section
    "",
    nl
      ? "Voorstel van `aihub init` voor het teampakket: teambestand, sjablonen, instructieskeletten en een AGENTS.md-blok. Bestaande bestanden zijn niet aangepast (AGENTS.md krijgt alleen een aihub-blok als er nog geen aihub-regel in staat). Controleer de waarden in `team.yaml` voor het mergen."
      : "Proposal from `aihub init` for the team pack: team file, templates, instruction skeletons and an AGENTS.md block. Existing files were not changed (AGENTS.md only gets an aihub block when it has no aihub line). Check the values in `team.yaml` before merging.",
    "",
    nl ? "Aangemaakt:" : "Created:",
    list(r.created),
    "",
    ...(r.updated.length ? [nl ? "Bijgewerkt (aihub-blok toegevoegd, de rest ongewijzigd):" : "Updated (aihub block appended, the rest unchanged):", list(r.updated), ""] : []),
    nl ? "Overgeslagen (bestond al):" : "Skipped (already existed):",
    list(r.skipped.map((s) => s.path)),
    "",
  ].join("\n");
}

export interface ProjectStates {
  active: string;
  finished: string;
}

/**
 * The states of the story work item type of this project: the first InProgress and the first Completed one
 * (Basic: Doing/Done, Agile: Active/Closed, Scrum: Committed/Done). undefined when Azure DevOps cannot be asked.
 */
export async function projectStates(ctx: Ctx, root: string, type = "User Story"): Promise<ProjectStates | undefined> {
  try {
    const client = repoClient({ ...ctx, cwd: root }).client;
    const r = await client.get<{ value?: { name: string; category?: string }[] }>(`wit/workitemtypes/${encodeURIComponent(type)}/states`);
    const list = r.value ?? [];
    const active = list.find((x) => x.category === "InProgress")?.name;
    const finished = list.find((x) => x.category === "Completed")?.name;
    return active && finished ? { active, finished } : undefined;
  } catch {
    return undefined;
  }
}

export async function runInit(ctx: Ctx, o: InitOpts): Promise<InitResult> {
  const language = parseLanguage(o.language);
  const root = repoRoot(resolve(ctx.cwd, o.repo ?? "."));
  const remote = parseRemote(remoteUrl(root));
  const target = originDefaultBranch(root) || "main";
  const states = existsSync(join(root, TEAM_FILE)) ? undefined : await projectStates(ctx, root); // only needed for a new team.yaml
  const info = { org: remote.org, project: remote.project, repo: remote.repo, target, language, intoRepo: !!o.intoRepo, states, noInstructions: !!o.noInstructions, noAgentsMd: !!o.noAgentsMd };

  if (o.noPr) {
    const p = planFiles(root, info);
    return writePlanned(root, p.plan, p.skips);
  }

  const original = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (hasRef(root, `refs/heads/${PACK_BRANCH}`) || git(root, ["ls-remote", "--heads", "origin", PACK_BRANCH], { allowFail: true }).trim()) {
    throw new AihubError(`branch '${PACK_BRANCH}' already exists; merge or delete it first, or run 'aihub init --no-pr'`);
  }
  git(root, ["switch", "-c", PACK_BRANCH, hasRef(root, `origin/${target}`) ? `origin/${target}` : "HEAD"]);
  const back = () => {
    if (original !== "HEAD") git(root, ["switch", original], { allowFail: true });
  };
  try {
    const p = planFiles(root, info);
    const result = writePlanned(root, p.plan, p.skips);
    result.branch = PACK_BRANCH;
    const touched = [...result.created, ...result.updated];
    if (!touched.length) {
      back();
      git(root, ["branch", "-D", PACK_BRANCH], { allowFail: true });
      result.branch = undefined;
      return result;
    }
    git(root, ["add", "--", ...touched]);
    git(root, ["commit", "-m", "chore: aihub team pack", "--", ...touched]);
    pushIfNeeded(root, PACK_BRANCH);
    const bodyFile = join(mkdtempSync(join(tmpdir(), "aihub-init-")), "body.md");
    writeFileSync(bodyFile, prBody(language, result), "utf8");
    result.pr = await createPr({ ...ctx, cwd: root }, { title: "chore: aihub team pack", bodyFile, target });
    back();
    return result;
  } catch (e) {
    back();
    throw e;
  }
}

export function reportInit(r: InitResult): string[] {
  const lines = [
    ...r.created.map((p) => `created  ${p}`),
    ...r.updated.map((p) => `updated  ${p} (aihub block appended)`),
    ...r.skipped.map((s) => `skipped  ${s.path} (${s.reason})`),
  ];
  if (!r.created.length && !r.updated.length) lines.push("nothing to create: the team pack is already in place");
  if (r.pr) lines.push(r.pr);
  else if ((r.created.length || r.updated.length) && !r.branch) lines.push("files written, no pull request (--no-pr): review, commit and push them yourself");
  return lines;
}
