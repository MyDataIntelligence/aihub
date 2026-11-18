import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { apply, GROUPS, scan, sweep, type Item, type Run } from "../lib/legacy.js";

const USAGE =
  "usage: aihub legacy remove [--dry-run] [--yes] [--keep-data] [--keep-settings] [--repos <dir>[,<dir>...]]...\n" +
  "  Takes back everything the old AI Context Hub (v1.x/2.x: Kotlin core, hub CLI package, VS Code extension, agent hooks) put on this machine.\n" +
  "  Without --yes (or with --dry-run) it only lists what it would remove, grouped; nothing is changed.\n" +
  "  Only provably Hub-owned things go (marker, generated shape, exact name); your own files, hooks and settings stay.\n" +
  "  --keep-data      keep the old Hub's settings, stories, logs and caches (%LOCALAPPDATA%\AIContextHub, .aihub folders)\n" +
  "  --keep-settings  keep the old aiContextHub.* keys in VS Code settings\n" +
  "  --repos <dir>    also clean the repositories in <dir> (the repositories of the old hub registry and the current one are always checked)";

/** One line for the skills of one folder, not one per skill. */
function collapse(items: Item[]): Item[] {
  const out: Item[] = [];
  const skills = new Map<string, Item[]>();
  for (const i of items) {
    if (!i.what.startsWith("delete skill ")) {
      out.push(i);
      continue;
    }
    const key = `${i.client}|${dirname(dirname(i.where))}`;
    skills.set(key, [...(skills.get(key) ?? []), i]);
  }
  for (const [, group] of skills)
    out.push({ ...group[0], what: `delete ${group.length} old Hub skill${group.length === 1 ? "" : "s"}: ${group.map((g) => g.what.replace("delete skill ", "")).join(", ")}`, where: dirname(dirname(group[0].where)) });
  return out;
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "remove") throw new AihubError(USAGE);
  let v: Record<string, string | boolean | string[] | undefined>;
  try {
    v = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" }, yes: { type: "boolean" }, "keep-data": { type: "boolean" }, "keep-settings": { type: "boolean" }, repos: { type: "string", multiple: true } } }).values;
  } catch (e) {
    throw new AihubError(`${(e as Error).message}\n${USAGE}`);
  }
  const act = !!v.yes && !v["dry-run"];
  const repos = ((v.repos as string[] | undefined) ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  const found = scan({ env: ctx.env, cwd: ctx.cwd, repos, spawn: ctx.spawn ? (c, a, cwd, t) => ctx.spawn!(c, a, cwd, t) as Run : undefined });

  const skipped = (i: Item) => (v["keep-data"] && i.data) || (v["keep-settings"] && i.settings);
  const todo = found.items.filter((i) => !skipped(i));
  if (!found.items.length) ctx.out("aihub legacy remove: nothing of the old AI Context Hub was found.");
  else ctx.out(`aihub legacy remove: ${todo.length} thing(s) of the old AI Context Hub ${act ? "to remove" : "would be removed"}.`);
  for (const group of GROUPS) {
    const here = found.items.filter((i) => i.group === group);
    if (!here.length) continue;
    ctx.out(`${group}`);
    for (const i of collapse(here)) ctx.out(`  ${skipped(i) ? "keep  " : "remove"} ${i.client ? `[${i.client}] ` : ""}${i.what}\n         ${i.where}`);
  }
  if (found.kept.length) {
    ctx.out("Found but not provably Hub-owned (left alone)");
    for (const k of found.kept) ctx.out(`  ${k}`);
  }
  for (const n of found.notes) ctx.out(`note: ${n}`);
  if (!act) {
    if (todo.length) ctx.out(v["dry-run"] ? "dry-run: nothing was changed." : "Nothing was changed. Run again with --yes to remove the items marked remove.");
    return;
  }
  const result = apply(todo);
  sweep(ctx.env);
  ctx.out(`removed ${result.done.length} of ${todo.length}.`);
  if (result.done.some((i) => i.group === "Registry")) ctx.out("Open a new terminal: the user PATH change applies to new processes only.");
  if (result.done.some((i) => i.group === "VS Code extension")) ctx.out("Reload open VS Code windows (Developer: Reload Window).");
  if (result.failed.length) {
    for (const f of result.failed) ctx.err(`failed: ${f.item.what} (${f.item.where}): ${f.error}`);
    throw new AihubError(`${result.failed.length} item(s) could not be removed (see above); the rest was removed`);
  }
}
