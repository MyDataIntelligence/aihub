import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { findSet } from "../lib/setInfo.js";
import { readUtf8, TEAM_FILE } from "../lib/team.js";
import { editTarget, packHas, teamEditSave } from "../lib/teamEdit.js";
import { parseKind } from "../lib/teamPreview.js";
import { readTeamRepo, schemaHelp, teamShow, templatePaths } from "../lib/teamSettings.js";
import { SCHEMA_FILE } from "../lib/teamSchema.js";
import { packRoot } from "../lib/pack.js";
import { parseTeamRepo, readCopy, setTeamRepo, teamRepoFor, writeCopy } from "../lib/teamSource.js";
import { formatProblems, validateTeamText } from "../lib/teamValidate.js";

/** aihub team validate [--file f] [--json]: the file given, else the team.yaml that applies here. Exit 1 on errors. */
export async function validateCmd(argv: string[], ctx: Ctx): Promise<void> {
  const p = parse(argv, { file: { type: "string" }, json: { type: "boolean" }, schema: { type: "boolean" } });
  if (p.values.schema) {
    // the key help of an editor: every key, its explanation and an example block per top-level key
    return void ctx.out(JSON.stringify(schemaHelp(readFileSync(join(packRoot(), ...SCHEMA_FILE), "utf8"))));
  }
  let text: string;
  let label: string;
  let files: Record<string, boolean> | undefined;
  let localRoot: string | undefined;
  if (p.values.file) {
    if (!existsSync(p.values.file)) throw new AihubError(`no file ${p.values.file}`);
    text = readUtf8(p.values.file);
    label = p.values.file;
    const teamRepo = teamRepoFor(ctx.env, findSet(ctx.cwd)?.folder);
    files = teamRepo ? readCopy(ctx.env, teamRepo)?.files : undefined;
  } else {
    const page = await teamShow(ctx, {});
    const own = page.repos.find((r) => r.name === page.scope.current && r.teamFile.exists);
    if (own) {
      text = readUtf8(join(own.path, TEAM_FILE));
      label = `${own.name}/${TEAM_FILE}`;
      localRoot = own.path;
    } else {
      const teamRepo = teamRepoFor(ctx.env, findSet(ctx.cwd)?.folder);
      const copy = teamRepo ? readCopy(ctx.env, teamRepo) : undefined;
      if (!copy) throw new AihubError(`no team.yaml here and no team repository: run aihub team init`);
      text = copy.content;
      label = `${page.source.label}/${TEAM_FILE}`;
      files = copy.files;
    }
  }
  const r = validateTeamText(text, {
    packHas,
    fileExists: (f) => (files ? files[f] : localRoot ? existsSync(join(localRoot, f)) : undefined),
  });
  if (p.values.json) ctx.out(JSON.stringify({ file: label, ...r }));
  else for (const l of formatProblems(r, label)) ctx.out(l);
  if (!r.ok && !p.values.json) process.exitCode = 1; // --json: the answer says ok: false; a tool reads it, not the exit code
}

/** aihub team edit: where the file lives, or (with --content-file) a new branch + pull request in the team repository. */
export async function editCmd(argv: string[], ctx: Ctx): Promise<void> {
  const p = parse(argv, {
    template: { type: "string" },
    repo: { type: "string" },
    "content-file": { type: "string" },
    branch: { type: "string" },
    title: { type: "string" },
    "base-commit": { type: "string" },
    story: { type: "string" },
    json: { type: "boolean" },
  });
  const t = editTarget(ctx, { template: p.values.template ? parseKind(p.values.template) : undefined, repo: p.values.repo });
  if (!p.values["content-file"]) {
    if (p.values.json) return void ctx.out(JSON.stringify(t));
    return void ctx.out(`${t.what}: ${t.kind === "teamRepo" ? `team repository ${t.project ?? ""}/${t.repo ?? t.localPath}` : `repository ${t.repo ?? t.localPath}`} ${t.branch ?? ""} ${t.path}\nsave with: aihub team edit${p.values.template ? ` --template ${p.values.template}` : ""} --content-file <file> --branch ${t.suggestedBranch} --title "${t.prTitle}"`);
  }
  if (!p.values.branch) throw new AihubError(`--branch is needed: a new feature branch, for example ${t.suggestedBranch}`);
  const story = p.values.story ? Number(String(p.values.story).replace(/^AB#/i, "")) : undefined;
  const r = await teamEditSave(ctx, t, { contentFile: p.values["content-file"], branch: p.values.branch, title: p.values.title, baseCommit: p.values["base-commit"], story: Number.isInteger(story) ? story : undefined });
  if (p.values.json) return void ctx.out(JSON.stringify(r));
  const push = r.push as { status?: string; branch?: string; pr?: { id: number; webUrl: string } | null; prError?: string | null };
  if (push?.status === "conflict") return void ctx.out(`not saved: ${t.path} changed in ${t.repo} since it was read; open it again and redo the change`);
  ctx.out(`pushed ${t.path} to ${push?.branch} in ${t.repo}${push?.pr ? `; pull request ${push.pr.id}: ${push.pr.webUrl}` : push?.prError ? `; no pull request: ${push.prError}` : ""}`);
}

/** aihub team init --from-pack | --team-repo <x> */
export async function initCmd(argv: string[], ctx: Ctx): Promise<void> {
  const p = parse(argv, { "from-pack": { type: "boolean" }, "team-repo": { type: "string" }, everywhere: { type: "boolean" }, repo: { type: "string" }, language: { type: "string" }, json: { type: "boolean" } });
  const set = findSet(ctx.cwd);
  if (p.values["team-repo"]) {
    let r;
    try {
      r = parseTeamRepo(p.values["team-repo"]);
    } catch (e) {
      throw new AihubError((e as Error).message);
    }
    // read it first: a pointer to a repository without a team.yaml is refused, nothing is stored
    const copy = await readTeamRepo(ctx, r, templatePaths);
    const folder = p.values.everywhere ? undefined : set?.folder;
    setTeamRepo(ctx.env, r, folder);
    writeCopy(ctx.env, r, copy);
    const out = { teamRepo: r, scope: folder ? `set ${folder}` : "every repository on this PC", commit: copy.commit, branch: copy.branch };
    return void ctx.out(p.values.json ? JSON.stringify(out) : `team repository set for ${out.scope}: ${r.localPath ?? `${r.project}/${r.repo}`} (${copy.branch} ${copy.commit.slice(0, 7)}); repositories without their own team.yaml use it`);
  }
  if (p.values["from-pack"]) {
    const dir = p.values.repo && set ? set.repos.find((x) => x.name.toLowerCase() === p.values.repo!.toLowerCase())?.path : undefined;
    if (p.values.repo && !dir) throw new AihubError(`'${p.values.repo}' is not in this set`);
    const { runInit, reportInit } = await import("../lib/init.js");
    const r = await runInit({ ...ctx, cwd: dir ?? ctx.cwd }, { language: p.values.language });
    return void (p.values.json ? ctx.out(JSON.stringify(r)) : reportInit(r).forEach((l) => ctx.out(l)));
  }
  throw new AihubError("usage: aihub team init --from-pack [--repo <name>] | --team-repo <project>/<repo>|<folder> [--everywhere]");
}
