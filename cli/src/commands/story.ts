import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { loadStoryTemplate, storyCreate, storyRefine, storyShow } from "../lib/story.js";
import { loadTeam } from "../lib/team.js";

/** Accepts `--id 123` and the positional form `story show 123` used by the skills. */
function idOf(v: { id?: string }, pos: string[]): number {
  const id = num(v.id ?? pos[0], "--id");
  if (!id) throw new AihubError("pass the story id: --id <number>");
  return id;
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const p = parse(
    rest,
    { id: { type: "string" }, title: { type: "string" }, "body-file": { type: "string" }, parent: { type: "string" }, type: { type: "string" }, json: { type: "boolean" } },
    true,
  );
  const v = p.values;
  // the team story template as written in the repo: the headings (and hints) a story body must use
  if (sub === "template") return void ctx.out(loadStoryTemplate(repoRoot(ctx.cwd), loadTeam(repoRoot(ctx.cwd))).trimEnd());
  if (sub === "show") return void ctx.out(await storyShow(ctx, { id: idOf(v, p.positionals), json: v.json }));
  if (sub === "create") {
    return void ctx.out(await storyCreate(ctx, { title: v.title, bodyFile: v["body-file"], parent: num(v.parent, "--parent"), type: v.type, json: v.json }));
  }
  if (sub === "refine") return void ctx.out(await storyRefine(ctx, { id: idOf(v, p.positionals), bodyFile: v["body-file"], json: v.json }));
  throw new AihubError("usage: aihub story show|create|refine|template [flags]");
}
