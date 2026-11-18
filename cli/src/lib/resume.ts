import type { Ctx } from "./context.js";
import { currentBranch, repoRoot, workItemFromBranch } from "./git.js";
import { hasWorkToCommit, unpushedCount } from "./gitx.js";
import { type JournalEntry, readJournal } from "./journal.js";
import { readNotes } from "./notes.js";
import { findSet } from "./setInfo.js";
import { isProtected, loadTeam } from "./team.js";

const LABELS = {
  nl: { last: "Vorige keer", plan: "Plan gedaan/rest", done: "gedaan", rest: "rest", next: "Volgende stap", none: "nog niets vastgelegd", note: "Notitie", set: "Set" },
  en: { last: "Last time", plan: "Plan done/left", done: "done", rest: "left", next: "Next step", none: "nothing recorded yet", note: "Note", set: "Set" },
};

/** The flow of a story, in order: a milestone counts as done when the journal of this branch has the matching successful command. */
const MILESTONES: { key: string; nl: string; en: string; match: RegExp; command: string }[] = [
  { key: "start", nl: "story gestart", en: "story started", match: /^aihub (story start|worktree create)/, command: "aihub story start --id N" },
  { key: "tests", nl: "tests (changed)", en: "changed tests run", match: /^aihub test changed/, command: "aihub test changed --run" },
  { key: "commit", nl: "gecommit", en: "committed", match: /^aihub commit/, command: "aihub commit --type <type> --subject \"...\" --push" },
  { key: "pr", nl: "PR aangemaakt", en: "PR created", match: /^aihub pr create/, command: "aihub pr create" },
  { key: "green", nl: "pipeline groen", en: "pipeline green", match: /^aihub pipeline follow/, command: "aihub pipeline follow" },
  { key: "review", nl: "review verwerkt", en: "review processed", match: /^aihub comments reply/, command: "aihub comments get (review-process)" },
];

function ago(at: string, nowMs: number, nl: boolean): string {
  const min = Math.max(0, Math.round((nowMs - Date.parse(at)) / 60000));
  if (min < 2) return nl ? "zojuist" : "just now";
  if (min < 90) return nl ? `${min} min geleden` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return nl ? `${h} uur geleden` : `${h} h ago`;
  const d = Math.round(h / 24);
  return nl ? `${d} dagen geleden` : `${d} days ago`;
}

export interface Resume {
  branch: string;
  story?: number;
  last?: JournalEntry;
  done: string[];
  rest: string[];
  next: string;
  dirty: boolean;
  unpushed: number;
  note?: string;
  text: string;
}

/** Local only, no network: after a compaction or in a new chat the agent needs this in one fast call. */
export function resume(ctx: Ctx): Resume {
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const nl = (team.language ?? "en") === "nl";
  const L = nl ? LABELS.nl : LABELS.en;
  const branch = currentBranch(root);
  const story = workItemFromBranch(branch);
  const nowMs = (ctx.now ?? Date.now)();
  const all = readJournal(root);
  // this branch's lines (the journal is per repository and records the branch); a story command that names the story counts too
  const mine = all.filter((e) => e.branch === branch || (story !== undefined && new RegExp(`(--id|--story|AB#|story-?)\\s*${story}\\b`).test(e.command)));
  const scope = mine.length ? mine : all.slice(-8);
  const ok = scope.filter((e) => e.status === "ok");
  const done = MILESTONES.filter((m) => ok.some((e) => m.match.test(e.command) && (m.key !== "green" || /green/.test(e.result)))).map((m) => (nl ? m.nl : m.en));
  const doneKeys = MILESTONES.filter((m) => ok.some((e) => m.match.test(e.command) && (m.key !== "green" || /green/.test(e.result))));
  const rest = MILESTONES.filter((m) => !doneKeys.includes(m)).map((m) => (nl ? m.nl : m.en));
  const dirty = hasWorkToCommit(root);
  const unpushed = unpushedCount(root);
  // a note is shown on its own line; it is not the last step
  const steps = scope.filter((e) => !/^aihub note /.test(e.command));
  const last = steps[steps.length - 1] ?? scope[scope.length - 1] ?? all[all.length - 1];
  const notes = readNotes(root, branch);
  const note = notes[notes.length - 1]?.text.replace(/\s+/g, " ");

  let next: string;
  if (isProtected(team, branch)) next = nl ? `je staat op '${branch}': start of kies een story (aihub story start --id N)` : `you are on '${branch}': start or pick a story (aihub story start --id N)`;
  else if (dirty) next = nl ? "er zijn niet-gecommitte wijzigingen: aihub commit --type <type> --subject \"...\" --push" : "there are uncommitted changes: aihub commit --type <type> --subject \"...\" --push";
  else if (unpushed > 0) next = nl ? `${unpushed} commit(s) niet gepusht: aihub commit --push of git push` : `${unpushed} unpushed commit(s): aihub commit --push or git push`;
  else if (last?.status === "failed") next = nl ? `de laatste stap mislukte (${last.command}): lees de fout, herstel, draai opnieuw` : `the last step failed (${last.command}): read the error, fix it, run it again`;
  else if (last && /^aihub (commit|pr update)/.test(last.command) && doneKeys.some((m) => m.key === "pr")) next = nl ? "aihub pipeline follow (de PR bestaat al)" : "aihub pipeline follow (the PR exists)";
  else if (last && doneKeys.length < MILESTONES.length && !/story finish/.test(last.command)) next = last.next;
  else next = last?.next ?? (nl ? "aihub status" : "aihub status");

  const lastText = last ? `${last.command} -> ${last.status === "ok" ? "" : "MISLUKT: "}${last.result} (${ago(last.at, nowMs, nl)})` : L.none;
  const set = findSet(root);
  const lines = [
    `${L.last}: ${lastText} · Plan ${L.done}: ${done.length ? done.join(", ") : "-"}; ${L.rest}: ${rest.length ? rest.join(", ") : "-"} · ${L.next}: ${next}`,
    `${branch}${story ? ` (story ${story})` : ""}${dirty ? ", uncommitted" : ""}${unpushed ? `, ${unpushed} unpushed` : ""}`,
  ];
  if (note) lines.push(`${L.note}: ${note.slice(0, 200)}`);
  if (set) lines.push(`${L.set}: story-${set.story}: ${set.repos.map((r) => r.name).join(", ")} (--all-repos)`);
  return { branch, story, last, done, rest, next, dirty, unpushed, note, text: lines.join("\n") };
}
