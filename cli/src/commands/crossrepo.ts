import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { crossStatus, formatStatus, linkPrs, testResources } from "../lib/crossRepoOps.js";

const USAGE =
  "aihub crossrepo status --story N | link-prs --story N [--pr repo!42] | test-resources --from-repo A --to-repo B --target BRANCH --paths GLOB [--message-file F] [--run-pipeline NAME]";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "status") {
    const v = parse(rest, { story: { type: "string" }, json: { type: "boolean" } }).values;
    const story = num(v.story, "--story");
    if (!story) throw new AihubError("aihub crossrepo status needs --story N");
    const rows = await crossStatus(ctx, { story });
    ctx.out(v.json ? JSON.stringify({ story, repos: rows }) : formatStatus(story, rows));
    return;
  }
  if (sub === "link-prs") {
    const v = parse(rest, { story: { type: "string" }, pr: { type: "string", multiple: true }, json: { type: "boolean" } }).values;
    const story = num(v.story, "--story");
    if (!story) throw new AihubError("aihub crossrepo link-prs needs --story N");
    const r = await linkPrs(ctx, { story, extra: v.pr });
    if (v.json) ctx.out(JSON.stringify(r));
    else {
      for (const x of r.results) ctx.out(`${x.repo} !${x.pr}: ${x.updated ? "related PRs section updated" : "already up to date"}`);
      if (r.linkedToStory.length) ctx.out(`linked to story ${story}: ${r.linkedToStory.map((i) => `!${i}`).join(", ")}`);
    }
    return;
  }
  if (sub === "test-resources") {
    const v = parse(rest, {
      "from-repo": { type: "string" },
      "to-repo": { type: "string" },
      target: { type: "string" },
      paths: { type: "string" },
      "to-path": { type: "string" },
      "message-file": { type: "string" },
      "run-pipeline": { type: "string" },
      "no-follow": { type: "boolean" },
      json: { type: "boolean" },
    }).values;
    const r = await testResources(ctx, {
      fromRepo: v["from-repo"],
      toRepo: v["to-repo"],
      target: v.target,
      paths: v.paths,
      toPath: v["to-path"],
      messageFile: v["message-file"],
      runPipeline: v["run-pipeline"],
      noFollow: v["no-follow"],
    });
    if (v.json) ctx.out(JSON.stringify(r));
    else {
      ctx.out(`test-resources -> ${r.repo}/${r.branch}: ${r.result}  ${r.detail}`);
      for (const f of r.files.slice(0, 50)) ctx.out(`  ${f}`);
      if (r.build?.summary) ctx.out(r.build.summary);
      else if (r.build) ctx.out(`pipeline build ${r.build.id} queued`);
    }
    if (r.result === "failed" || r.result === "refused") throw new AihubError(`test-resources stopped: ${r.detail}`);
    return;
  }
  throw new AihubError(`usage: ${USAGE}`);
}
