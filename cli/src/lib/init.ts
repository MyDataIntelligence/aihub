import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseRemote } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, hasRef, originDefaultBranch, pushIfNeeded, remoteUrl, repoRoot, showFile } from "./git.js";
import { listFiles, packRoot, readPackFile } from "./pack.js";
import { createPr } from "./pr.js";
import { trace } from "./trace.js";
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
}

export interface Planned {
  path: string;
  content: string;
}

export interface InitResult {
  created: string[];
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
function teamYaml(src: string, o: { org: string; project: string; repo: string; target: string; language: Language; prTemplate: string }): string {
  const doc = parseDocument(src);
  doc.setIn(["language"], o.language);
  doc.setIn(["azureDevOps", "organization"], o.org);
  doc.setIn(["azureDevOps", "project"], o.project);
  doc.setIn(["repositories", 0, "name"], o.repo);
  doc.setIn(["repositories", 0, "defaultTarget"], o.target);
  doc.setIn(["repositories", 0, "aliases"], doc.createNode([]));
  doc.setIn(["pullRequest", "template"], o.prTemplate);
  doc.setIn(["pullRequest", "emptySection"], o.language === "nl" ? "n.v.t." : "-");
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
export function planFiles(root: string, o: { org: string; project: string; repo: string; target: string; language: Language; intoRepo?: boolean }): { plan: Planned[]; skips: Record<string, string> } {
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
  return { plan, skips: found ? { [PR_TEMPLATE]: `a pull request template already exists (${found})` } : {} };
}

/** Write planned files that do not exist yet; never touches an existing file. */
export function writePlanned(root: string, plan: Planned[], skipExtra: Record<string, string> = {}): InitResult {
  const res: InitResult = { created: [], skipped: [] };
  for (const [path, reason] of Object.entries(skipExtra)) res.skipped.push({ path, reason });
  for (const p of plan) {
    const abs = join(root, p.path);
    if (existsSync(abs)) {
      res.skipped.push({ path: p.path, reason: "exists" });
      continue;
    }
    if (trace.dryRun) trace.plan(`would write ${abs}`);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, p.content, "utf8");
    }
    res.created.push(p.path);
  }
  return res;
}

function prBody(language: Language, r: InitResult): string {
  const nl = language === "nl";
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``).join("\n") : nl ? "- geen" : "- none");
  return [
    `## ${nl ? "Beschrijving" : "Description"}`,
    "",
    nl
      ? "Voorstel van `aihub init` voor het teampakket: teambestand en sjablonen. Bestaande bestanden zijn niet aangepast. Controleer de waarden in `team.yaml` voor het mergen."
      : "Proposal from `aihub init` for the team pack: team file and templates. Existing files were not changed. Check the values in `team.yaml` before merging.",
    "",
    nl ? "Aangemaakt:" : "Created:",
    list(r.created),
    "",
    nl ? "Overgeslagen (bestond al):" : "Skipped (already existed):",
    list(r.skipped.map((s) => s.path)),
    "",
  ].join("\n");
}

export async function runInit(ctx: Ctx, o: InitOpts): Promise<InitResult> {
  const language = parseLanguage(o.language);
  const root = repoRoot(resolve(ctx.cwd, o.repo ?? "."));
  const remote = parseRemote(remoteUrl(root));
  const target = originDefaultBranch(root) || "main";
  const info = { org: remote.org, project: remote.project, repo: remote.repo, target, language, intoRepo: !!o.intoRepo };

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
    if (!result.created.length) {
      back();
      git(root, ["branch", "-D", PACK_BRANCH], { allowFail: true });
      result.branch = undefined;
      return result;
    }
    git(root, ["add", "--", ...result.created]);
    git(root, ["commit", "-m", "chore: aihub team pack", "--", ...result.created]);
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
    ...r.skipped.map((s) => `skipped  ${s.path} (${s.reason})`),
  ];
  if (!r.created.length) lines.push("nothing to create: the team pack is already in place");
  if (r.pr) lines.push(r.pr);
  else if (r.created.length && !r.branch) lines.push("files written, no pull request (--no-pr): review, commit and push them yourself");
  return lines;
}
