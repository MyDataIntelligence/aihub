import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { repoRoot } from "./git.js";
import { tryGit } from "./gitx.js";

/**
 * One line per aihub command in `<git common dir>/aihub/journal.md`: local memory that is never committed, shared by all
 * worktrees of a repository. Format: `- <iso time> | <branch> | <command> | ok|failed | <result> | next: <hint>`.
 */
export const journalFile = (root: string): string => aihubDir(root, "journal.md");

export interface JournalEntry {
  at: string;
  branch: string;
  command: string;
  status: "ok" | "failed";
  result: string;
  next: string;
}

/** Commands that only read: they would drown the journal in noise. */
const READ_ONLY = new Set(["status", "doctor", "watch", "update", "skills", "search", "repos", "open", "explain", "work", "probe", "research", "standup", "handoff", "library", "policy", "repo", "browse"]);

export function isJournaled(name: string, args: string[]): boolean {
  if (args.includes("--help") || args.includes("--dry-run")) return false;
  if (READ_ONLY.has(name)) return false;
  const sub = args[0];
  if (name === "note") return sub === "add";
  if (name === "story") return !["recall", "search", "template", "show", "context"].includes(sub ?? "");
  if (name === "pr") return ["create", "update", "complete", "requeue", "abandon", "reopen"].includes(sub ?? "");
  if (name === "pipeline") return ["follow", "run", "rerun", "retry"].includes(sub ?? "");
  if (name === "comments") return sub === "reply";
  if (name === "test") return args.includes("--run");
  if (name === "preflight") return sub !== "steps";
  if (name === "worktree") return sub !== "list";
  return true;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").replace(/ \| /g, " / ").trim();

/** What to do after a command, as far as the command alone tells (no network): the journal must stay cheap. */
export function nextHint(name: string, args: string[], ok: boolean, result: string): string {
  const sub = args[0] ?? "";
  const key = name === "story" || name === "pr" || name === "pipeline" || name === "comments" || name === "worktree" || name === "note" ? `${name} ${sub}` : name;
  if (!ok) return "read the error above, fix the cause, run the same command again";
  switch (key) {
    case "story start":
    case "worktree create":
      return "implement the story, then aihub test changed --run and aihub commit";
    case "story create":
      return "refine it (story-refine) or start it: aihub story start --id N";
    case "commit":
      return /pushed/.test(result) ? "aihub pr create (or aihub pr update when the PR exists)" : "aihub commit --push, or aihub pr create";
    case "pr create":
      return "aihub pipeline follow";
    case "pr update":
      return "aihub pipeline follow";
    case "pipeline follow":
      return /green/.test(result) ? "aihub comments get (open review threads?), then report" : /failed|red/.test(result) ? "pipeline-fix: aihub pipeline logs --failed" : "aihub pipeline follow again";
    case "comments reply":
      return "aihub pipeline follow";
    case "cherry-pick":
      return "aihub pipeline follow on the cherry-pick PR";
    case "story finish":
      return "done";
    default:
      return "aihub status";
  }
}

export function appendJournal(cwd: string, name: string, args: string[], ok: boolean, outLines: string[], err: string, nowMs: number): void {
  try {
    const root = repoRoot(cwd);
    const first = ok ? (outLines.find((l) => l.trim()) ?? "") : err; // pipeline follow passes its lines reversed: the verdict is the last line
    const result = clip(oneLine(first), 160);
    const command = clip(oneLine(`aihub ${name} ${args.join(" ")}`), 200);
    const at = new Date(nowMs).toISOString().replace(/\.\d+Z$/, "Z");
    const branch = oneLine(tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out) || "-";
    const f = journalFile(root);
    ensureDir(dirname(f));
    appendFileSync(f, `- ${at} | ${branch} | ${command} | ${ok ? "ok" : "failed"} | ${result || "(no output)"} | next: ${nextHint(name, args, ok, result)}\n`, "utf8");
  } catch {
    /* not in a repository, or the folder is read-only: the journal is a convenience, never a failure */
  }
}

export function readJournal(root: string): JournalEntry[] {
  let f: string;
  try {
    f = journalFile(root);
  } catch {
    return [];
  }
  if (!existsSync(f)) return [];
  const out: JournalEntry[] = [];
  for (const l of readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n")) {
    const m = /^- (\S+) \| (.*?) \| (.*?) \| (ok|failed) \| (.*?) \| next: (.*)$/.exec(l);
    if (m) out.push({ at: m[1], branch: m[2], command: m[3], status: m[4] as "ok" | "failed", result: m[5], next: m[6] });
  }
  return out;
}
