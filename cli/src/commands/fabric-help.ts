import { didYouMean } from "../lib/fabric.js";

/**
 * Help for `aihub fabric`: a short grouped overview (`fabric help`), one group in detail (`fabric help <group>`), and for a
 * wrong call only the one usage line that matters plus "did you mean" (an agent must not get the whole manual back).
 */

/** [group, command, usage after "aihub fabric "]. Every command takes --workspace <name|id> and --json; writes take --dry-run. */
const COMMANDS: [string, string, string][] = [
  ["look", "items", "items --workspace W [--type Notebook]   (what is in a workspace)"],
  ["look", "workspaces", "workspaces [--filter text]"],
  ["look", "item show", "item show --workspace W --item I"],
  ["look", "item definition", "item definition --workspace W --item I [--out dir]"],
  ["look", "jobs", "jobs --workspace W --item I [--top N]"],
  ["look", "schedules", "schedules --workspace W --item I"],
  ["look", "workspace", "workspace show|roles|create|assign-capacity|delete --workspace W"],
  ["look", "capacities", "capacities | connections | gateways"],
  ["run", "run", "run --workspace W --item I --wait [--params-file F]   (start, wait, end result; on failure the cause)"],
  ["run", "status", "status --workspace W --item I --job J [--wait]"],
  ["run", "job cancel", "job cancel --workspace W --item I --job J   (or: run --cancel J --item I)"],
  ["run", "job show", "job show --workspace W --item I --job J"],
  ["why", "failures", "failures --workspace W   (newest failed run: failed cell, exception, likely cause)"],
  ["why", "failures --since-green", "failures --workspace W --since-green [--item I]   (what was deployed since the last green run, suspects first)"],
  ["why", "deployed", "deployed --workspace W | --env ENV   (which commit runs in a CD-filled workspace, from which CD run)"],
  ["why", "logs", "logs --workspace W --item I --job J [--out file] [--search text] [--tail N]   (a short digest; the full log only with --out)"],
  ["why", "logs --since", "logs --workspace W [--since 24h] [--status failed] [--item I]   (runs of a workspace)"],
  ["why", "spark", "spark sessions|app|logs|stop --workspace W --item I [--job J]"],
  ["change", "item edit", "item edit --workspace W --item I (--set name=value | --replace old --with new | --replace-file F --with-file F) [--run --wait]"],
  ["change", "item create", "item create --workspace W --type T --name N [--definition-dir D]"],
  ["change", "item update", "item update --workspace W --item I --definition-dir D"],
  ["change", "item rename", "item rename --workspace W --item I --name N"],
  ["change", "item delete", "item delete --workspace W --item I --yes"],
  ["change", "plan", "plan [--check-workspace]   (changed <name>.<Type>/ folders -> create/update/run commands)"],
  ["change", "environment", "environment publish|libraries|upload-library --workspace W --item E"],
  ["git", "git status", "git status --workspace W"],
  ["git", "git commit", 'git commit --workspace W [--message "text" | --message-file F]   (says what was committed and whether the workspace is clean)'],
  ["git", "git update", "git update --workspace W   (pull the branch into the workspace)"],
  ["git", "deployment", "deployment list|stages|deploy --pipeline P [--from-stage S --to-stage T]"],
  ["data", "lakehouse", "lakehouse tables|files|load|maintenance --workspace W --lakehouse L [--path P] [--table T]"],
  ["data", "shortcuts", "shortcuts --workspace W --lakehouse L"],
  ["data", "sql", 'sql --workspace W --item WH --query "select ..."'],
  ["data", "onelake", "onelake list|read|write|mkdir|delete|move --workspace W --lakehouse L --path P"],
  ["data", "dax", 'dax|kql|graphql --workspace W --item I --query "..."'],
  ["data", "livy", "livy run --workspace W --lakehouse L --code text [--kind sql|pyspark]"],
  ["data", "udf", "udf invoke --workspace W --item U --function F [--args-file F]"],
  ["data", "dbt", "dbt detect|results|scaffold|run|upload|save-job|get-job"],
  ["admin", "auth", "auth status | auth sp add|list|remove|default|test"],
  ["admin", "connection", "connection create|update|delete --body-file F"],
  ["admin", "notebook-test", "notebook-test prepare|run|verify --workspace W --item 'AIHub E2E <name>'"],
  ["admin", "api", "api list [--filter x] | api <tool> --workspace W [--arg name=value]   (every other Fabric REST call)"],
];

const GROUPS: Record<string, string> = {
  look: "what is there",
  run: "run and wait",
  why: "why did it fail",
  change: "change items",
  git: "git and deployment",
  data: "data and code",
  admin: "auth, connections, raw API",
};

/** `aihub fabric help`: one screen, the common commands first. */
export function fabricHelp(group?: string): string {
  if (group) {
    const g = group.toLowerCase();
    const rows = COMMANDS.filter((c) => c[0] === g);
    if (!rows.length) return `unknown help group '${group}'; groups: ${Object.keys(GROUPS).join(", ")}`;
    return [`aihub fabric: ${GROUPS[g]}`, ...rows.map((c) => `  aihub fabric ${c[2]}`)].join("\n");
  }
  return [
    "aihub fabric <command> --workspace <name|id>   (plain text output; --dry-run before a write)",
    "  look:   items | workspaces | item show|definition | jobs",
    "  run:    run --item I --wait   (start, wait, result; on failure the cause)",
    "  why:    failures   |   logs --item I --job J   (digest; --out file for the full log)",
    "  change: item edit --item I --set name=value [--run --wait] | item create|update|rename|delete",
    '  git:    git status | git commit [--message "text"] | git update',
    "  data:   lakehouse | sql | onelake | dax | kql | livy | spark | dbt",
    `  more:   aihub fabric help <${Object.keys(GROUPS).join("|")}>`,
  ].join("\n");
}

/** The usage line(s) of one command, `sub` plus its first positional. */
export function usageOf(sub: string, pos0?: string): string | undefined {
  const exact = COMMANDS.filter((c) => c[1] === `${sub} ${pos0 ?? ""}`.trim() || c[1] === sub || c[1].startsWith(`${sub} `));
  const rows = exact.some((c) => c[1] === `${sub} ${pos0 ?? ""}`.trim()) ? exact.filter((c) => c[1] === `${sub} ${pos0 ?? ""}`.trim()) : exact;
  return rows.length ? rows.map((c) => `usage: aihub fabric ${c[2]}`).join("\n") : undefined;
}

/** For an unknown `sub` (or `sub pos0`): the usage of the closest commands, never the whole manual. */
export function unknownCommand(sub: string, pos0?: string): string {
  const words = COMMANDS.map((c) => c[1]);
  const asked = `${sub} ${pos0 ?? ""}`.trim();
  // "definition" means "item definition": a command whose last word is what was typed
  let near = words.filter((w) => w.split(" ").slice(1).includes(sub));
  if (!near.length && pos0) near = words.filter((w) => w.startsWith(`${sub} `) && w.split(" ")[1].startsWith(pos0.slice(0, 3)));
  if (!near.length) near = didYouMean(asked, words, 2);
  if (!near.length && words.some((w) => w.startsWith(`${sub} `))) near = words.filter((w) => w.startsWith(`${sub} `));
  const lines = [...new Set(near)].slice(0, 4).map((w) => `  aihub fabric ${COMMANDS.find((c) => c[1] === w)![2]}`);
  return lines.length ? `unknown fabric command '${asked}'; did you mean:\n${lines.join("\n")}` : `unknown fabric command '${asked}'; see: aihub fabric help`;
}
