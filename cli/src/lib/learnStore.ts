import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { repoRoot } from "./git.js";
import { AihubError } from "./errors.js";
import type { Ctx } from "./context.js";
import type { ChangeFacts } from "./learn.js";
import { validateExplanation } from "./learnSchema.js";

/**
 * The personal Learn store: `~/.config/aihub/learn` (AIHUB_LEARN_HOME or XDG_CONFIG_HOME move it). Per user only:
 * nothing is written into a repository and nothing is shared with the team.
 */
export const learnHome = (env: NodeJS.ProcessEnv) => env.AIHUB_LEARN_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "aihub", "learn");

export interface LessonMeta {
  id: string;
  title: string;
  savedAt: string;
  repo: string;
  /** Stable key of the repository (hash of the origin URL or path), so two clones of one repo share their lessons. */
  repoKey: string;
  source: { pr?: number; branch?: string; range?: string };
  concepts: number;
  quiz: number;
}

export interface Lesson {
  meta: LessonMeta;
  explanation: Record<string, unknown> & { oneSentence?: string; concepts?: { name: string; eli5: string; exampleFromThisChange: string }[]; quiz?: QuizItem[] };
  facts?: ChangeFacts;
}

export interface QuizItem {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "lesson";

function repoIdentity(ctx: Ctx): { name: string; key: string } {
  let root = ctx.cwd;
  try {
    root = repoRoot(ctx.cwd);
  } catch {
    /* not a git folder: the folder itself is the identity */
  }
  return { name: basename(root), key: createHash("sha1").update(root.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 10) };
}

const dirOf = (ctx: Ctx) => join(learnHome(ctx.env), "lessons");
const readLesson = (file: string): Lesson | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Lesson;
  } catch {
    return undefined;
  }
};

/** Validates and stores an explanation. The id is <date>-<what>; saving the same change again replaces it. */
export function learnSave(ctx: Ctx, o: { file: string; facts?: string }): Lesson {
  if (!existsSync(o.file)) throw new AihubError(`explanation file not found: ${o.file}`);
  let explanation: Lesson["explanation"];
  try {
    explanation = JSON.parse(readFileSync(o.file, "utf8"));
  } catch (e) {
    throw new AihubError(`${o.file} is not valid JSON: ${(e as Error).message}`);
  }
  const facts = o.facts && existsSync(o.facts) ? (JSON.parse(readFileSync(o.facts, "utf8")) as ChangeFacts) : undefined;
  const v = validateExplanation(explanation, facts);
  if (!v.ok) throw new AihubError(`the explanation is not valid, nothing was saved:\n${v.errors.map((e) => `  ${e}`).join("\n")}`);
  const { name, key } = repoIdentity(ctx);
  const src = facts?.source;
  const what = src?.pr ? `pr-${src.pr}` : slug(src?.branch ?? String(explanation.oneSentence ?? "lesson"));
  const date = new Date((ctx.now ?? Date.now)()).toISOString().slice(0, 10);
  const id = `${key}-${what}`;
  const meta: LessonMeta = {
    id,
    title: String(explanation.oneSentence ?? what),
    savedAt: `${date}T${new Date((ctx.now ?? Date.now)()).toISOString().slice(11, 19)}Z`,
    repo: name,
    repoKey: key,
    source: { ...(src?.pr ? { pr: src.pr } : {}), ...(src?.branch ? { branch: src.branch } : {}), ...(src?.range ? { range: src.range } : {}) },
    concepts: Array.isArray(explanation.concepts) ? explanation.concepts.length : 0,
    quiz: Array.isArray(explanation.quiz) ? explanation.quiz.length : 0,
  };
  const lesson: Lesson = { meta, explanation, ...(facts ? { facts } : {}) };
  const dir = dirOf(ctx);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(lesson, null, 2), "utf8");
  return lesson;
}

/** Newest first. `all` also lists the lessons of other repositories. */
export function learnList(ctx: Ctx, o: { all?: boolean } = {}): LessonMeta[] {
  const dir = dirOf(ctx);
  if (!existsSync(dir)) return [];
  const { key } = repoIdentity(ctx);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readLesson(join(dir, f))?.meta)
    .filter((m): m is LessonMeta => !!m && (o.all || m.repoKey === key))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function learnShow(ctx: Ctx, id: string): Lesson {
  const f = join(dirOf(ctx), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  const l = existsSync(f) ? readLesson(f) : undefined;
  if (!l) throw new AihubError(`no saved lesson '${id}' (see aihub learn list)`);
  return l;
}

export function learnForget(ctx: Ctx, id: string): void {
  learnShow(ctx, id);
  rmSync(join(dirOf(ctx), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`));
}

// ---- concepts and quiz --------------------------------------------------------------------------

const progressFile = (ctx: Ctx) => join(learnHome(ctx.env), "progress.json");

interface Progress {
  learned: Record<string, string>;
  scores: { id: string; at: string; correct: number; of: number }[];
}

const readProgress = (ctx: Ctx): Progress => {
  try {
    return { learned: {}, scores: [], ...(JSON.parse(readFileSync(progressFile(ctx), "utf8")) as Partial<Progress>) };
  } catch {
    return { learned: {}, scores: [] };
  }
};

const writeProgress = (ctx: Ctx, p: Progress) => {
  mkdirSync(learnHome(ctx.env), { recursive: true });
  writeFileSync(progressFile(ctx), JSON.stringify(p, null, 2), "utf8");
};

export interface ConceptRow {
  name: string;
  eli5: string;
  example: string;
  lessons: string[];
  learned: boolean;
}

/** Every concept of the saved lessons once, with where it came up and whether you marked it as learned. */
export function learnConcepts(ctx: Ctx, o: { all?: boolean } = {}): ConceptRow[] {
  const progress = readProgress(ctx);
  const rows = new Map<string, ConceptRow>();
  for (const m of learnList(ctx, o)) {
    for (const c of learnShow(ctx, m.id).explanation.concepts ?? []) {
      const k = c.name.toLowerCase();
      const r = rows.get(k) ?? { name: c.name, eli5: c.eli5, example: c.exampleFromThisChange, lessons: [], learned: !!progress.learned[k] };
      r.lessons.push(m.id);
      rows.set(k, r);
    }
  }
  return [...rows.values()].sort((a, b) => Number(a.learned) - Number(b.learned) || a.name.localeCompare(b.name));
}

export function learnMark(ctx: Ctx, concept: string, learned: boolean): void {
  const p = readProgress(ctx);
  const k = concept.toLowerCase();
  if (learned) p.learned[k] = new Date((ctx.now ?? Date.now)()).toISOString();
  else delete p.learned[k];
  writeProgress(ctx, p);
}

/** The questions of one lesson, or the newest questions across the saved lessons. */
export function learnQuiz(ctx: Ctx, o: { id?: string; max?: number }): { id: string; item: QuizItem }[] {
  const ids = o.id ? [o.id] : learnList(ctx).map((m) => m.id);
  const out: { id: string; item: QuizItem }[] = [];
  for (const id of ids) for (const item of learnShow(ctx, id).explanation.quiz ?? []) out.push({ id, item });
  return out.slice(0, o.max ?? 20);
}

export function learnScore(ctx: Ctx, id: string, correct: number, of: number): void {
  const p = readProgress(ctx);
  p.scores.push({ id, at: new Date((ctx.now ?? Date.now)()).toISOString(), correct, of });
  writeProgress(ctx, p);
}
