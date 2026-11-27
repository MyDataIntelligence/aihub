import { readFileSync } from "node:fs";
import { num as numOrThrow, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { BrowseError, errorJson, resolveOrg } from "../lib/browse/core.js";

export const STORIES_USAGE = `usage: aihub stories <sub> [--org O] [--project P] [--team T] [--refresh]   (always JSON; a failure is {"error":{"kind","message"}} and exit 1)
  settings [--save --project P --team T [--area A] [--iteration I]]   the saved choice
  projects | teams | areas | iterations                              what can be chosen
  list --view mine|sprint|backlog [--types a,b] [--search 123|text] [--top 200]
  board [--board Stories] [--types a,b]
  show --id N
  move --id N (--to <state> | --column C [--board B]) --rev R          edit --id N --rev R [--title t] [--state s] [--assign me|<email>|none] [--priority n] [--severity s] [--points n] [--tags a;b] [--iteration p] [--area p] [--sections-file f] [--system-info-file f]
  task --id <task> --done|--undone [--rev R]   add-task --parent N --title t   comment --id N --text-file f
  refine-ask --id N | refine --id N | refine-apply --id N --rev R --parts description,criteria,tasks
  start --id N [--repos a,b] [--base B] [--set reuse|none] [--no-assign] [--open new|this|none]
  form --type T | new --type T --title t [--sections-file f] [--system-info-file f] [--severity s] [--priority n] [--parent N] [--iteration current|path] [--area p] [--assign me]
  draft-ask --type T --title t [--notes-file f] | draft --draft-file f
  link --id N (--set <folder> | --repo R --branch B)   fix-branch --id N [--repo R] [--base B]
  (a changed item someone else saved in between: {"status":"conflict","current":...}, exit 0)`;

const SUBS = ["settings", "projects", "teams", "areas", "iterations", "list", "board", "show", "move", "edit", "task", "add-task", "comment", "refine-ask", "refine", "refine-apply", "start", "form", "new", "draft-ask", "draft", "link", "fix-branch"];

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || !SUBS.includes(sub)) throw new AihubError(STORIES_USAGE);
  let v: V;
  try {
    v = flagsOf(rest);
    ctx.out(JSON.stringify(await answer(sub, v, ctx)));
  } catch (e) {
    ctx.out(JSON.stringify(errorJson(e)));
    throw e instanceof AihubError ? e : new AihubError((e as Error).message);
  }
}

/** A wrong flag or value is badInput, also in the JSON. */
function flagsOf(rest: string[]): V {
  try {
    return parseFlags(rest);
  } catch (e) {
    throw new BrowseError("badInput", (e as Error).message.replace(/^aihub:\s*/, ""));
  }
}

const num = (x: unknown, flag: string): number | undefined => {
  try {
    return numOrThrow(x, flag);
  } catch (e) {
    throw new BrowseError("badInput", (e as Error).message);
  }
};

function parseFlags(rest: string[]): V {
  return parse(rest, {
    org: { type: "string" },
    project: { type: "string" },
    team: { type: "string" },
    refresh: { type: "boolean" },
    save: { type: "boolean" },
    area: { type: "string" },
    iteration: { type: "string" },
    view: { type: "string" },
    types: { type: "string" },
    search: { type: "string" },
    top: { type: "string" },
    board: { type: "string" },
    id: { type: "string" },
    to: { type: "string" },
    column: { type: "string" },
    rev: { type: "string" },
    title: { type: "string" },
    state: { type: "string" },
    assign: { type: "string" },
    priority: { type: "string" },
    severity: { type: "string" },
    points: { type: "string" },
    tags: { type: "string" },
    "sections-file": { type: "string" },
    "system-info-file": { type: "string" },
    done: { type: "boolean" },
    undone: { type: "boolean" },
    parent: { type: "string" },
    "text-file": { type: "string" },
    parts: { type: "string" },
    repos: { type: "string" },
    base: { type: "string" },
    set: { type: "string" },
    "no-assign": { type: "boolean" },
    open: { type: "string" },
    type: { type: "string" },
    "notes-file": { type: "string" },
    "draft-file": { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    json: { type: "boolean" },
  }).values as V;
}

type V = Record<string, string | boolean | undefined>;

const str = (v: V, flag: string) => (typeof v[flag] === "string" && (v[flag] as string).trim() ? (v[flag] as string) : undefined);
const need = (v: V, flag: string): string => {
  const x = str(v, flag);
  if (!x) throw new BrowseError("badInput", `aihub stories needs --${flag} (aihub stories --help)`);
  return x;
};
const id = (v: V, flag = "id") => num(need(v, flag), `--${flag}`)!;
const list = (s: string | undefined, sep = ",") => (s ? s.split(sep).map((x) => x.trim()).filter(Boolean) : undefined);
const text = (v: V, flag: string) => {
  const f = str(v, flag);
  return f ? readFileSync(f, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n") : undefined;
};

async function answer(sub: string, v: V, ctx: Ctx): Promise<unknown> {
  const core = await import("../lib/stories/core.js");
  const o = { org: str(v, "org"), project: str(v, "project"), team: str(v, "team"), refresh: !!v.refresh };
  if (sub === "draft") return (await import("../lib/stories/start.js")).storyDraft(need(v, "draft-file"));
  if (sub === "settings") {
    const org = resolveOrg(ctx, o.org);
    if (v.save) core.saveSettings(ctx.env, org, { project: need(v, "project"), team: str(v, "team"), areaPath: str(v, "area"), iterationPath: str(v, "iteration") });
    const saved = core.readSettings(ctx.env, org);
    let types: string[] = [];
    let team = saved.team;
    if (saved.project) {
      const s = core.storiesOf(ctx, { org, project: saved.project, team: saved.team, refresh: o.refresh });
      team = s.team;
      types = await core.defaultTypes(s).catch(() => []);
    }
    return { org, ...saved, ...(team ? { team } : {}), types };
  }
  if (sub === "projects") return (await import("../lib/stories/read.js")).storyProjects({ b: (await import("../lib/browse/core.js")).browseOf(ctx, o) });
  const s = core.storiesOf(ctx, o);
  const r = await import("../lib/stories/read.js");
  switch (sub) {
    case "teams":
      return r.storyTeams(s);
    case "areas":
      return r.storyAreas(s);
    case "iterations":
      return r.storyIterations(s);
    case "list":
      return r.storyList(s, { view: need(v, "view") as never, types: list(str(v, "types")), search: str(v, "search"), top: num(str(v, "top"), "--top") });
    case "board":
      return r.storyBoard(s, { board: str(v, "board"), types: list(str(v, "types")) });
    case "show":
      return r.storyShow(s, id(v));
  }
  const w = await import("../lib/stories/write.js");
  switch (sub) {
    case "move":
      return w.storyMove(s, { id: id(v), to: str(v, "to"), column: str(v, "column"), board: str(v, "board"), rev: id(v, "rev") });
    case "edit":
      return w.storyEdit(s, {
        id: id(v),
        rev: id(v, "rev"),
        title: typeof v.title === "string" ? v.title : undefined,
        state: str(v, "state"),
        assign: str(v, "assign"),
        priority: num(str(v, "priority"), "--priority"),
        severity: str(v, "severity"),
        points: str(v, "points") !== undefined ? Number(str(v, "points")) : undefined,
        tags: typeof v.tags === "string" ? list(v.tags, ";") ?? [] : undefined,
        iterationPath: str(v, "iteration"),
        areaPath: str(v, "area"),
        sections: text(v, "sections-file"),
        systemInfo: text(v, "system-info-file"),
      });
    case "task":
      if (!v.done === !v.undone) throw new BrowseError("badInput", "pass --done or --undone");
      return w.storyTask(s, { id: id(v), done: !!v.done, rev: num(str(v, "rev"), "--rev") });
    case "add-task":
      return w.storyAddTask(s, { parent: id(v, "parent"), title: need(v, "title") });
    case "comment":
      return w.storyComment(s, { id: id(v), markdown: text(v, "text-file") ?? "" });
    case "form":
      return w.storyForm(s, { type: str(v, "type") });
    case "new":
      return w.storyNew(s, {
        type: str(v, "type"),
        title: need(v, "title"),
        sections: text(v, "sections-file"),
        systemInfo: text(v, "system-info-file"),
        severity: str(v, "severity"),
        priority: num(str(v, "priority"), "--priority"),
        parent: num(str(v, "parent"), "--parent"),
        iterationPath: str(v, "iteration"),
        areaPath: str(v, "area"),
        assign: str(v, "assign"),
        tags: list(str(v, "tags"), ";"),
      });
  }
  if (sub.startsWith("refine")) {
    const rf = await import("../lib/stories/refine.js");
    if (sub === "refine-ask") return rf.refineAsk(s, id(v));
    if (sub === "refine") return rf.refineRead(s, id(v));
    return rf.refineApply(s, { id: id(v), rev: id(v, "rev"), parts: list(need(v, "parts")) ?? [] });
  }
  const st = await import("../lib/stories/start.js");
  switch (sub) {
    case "start": {
      const set = str(v, "set") ?? "reuse";
      if (!["reuse", "none"].includes(set)) throw new BrowseError("badInput", "--set is reuse or none");
      const open = str(v, "open") ?? "none";
      if (!["new", "this", "none"].includes(open)) throw new BrowseError("badInput", "--open is new, this or none");
      return st.storyStart(s, { id: id(v), repos: list(str(v, "repos")), base: str(v, "base"), set: set as never, assignToMe: !v["no-assign"], open: open as never });
    }
    case "draft-ask":
      return st.storyDraftAsk(s, { type: await core.resolveTypeName(s, need(v, "type")), title: need(v, "title"), notes: text(v, "notes-file") });
    case "link":
      return st.storyLink(s, { id: id(v), set: str(v, "set"), repo: str(v, "repo"), branch: str(v, "branch") });
    case "fix-branch":
      return st.storyFixBranch(s, { id: id(v), repo: str(v, "repo"), base: str(v, "base") });
  }
  throw new AihubError(STORIES_USAGE);
}
