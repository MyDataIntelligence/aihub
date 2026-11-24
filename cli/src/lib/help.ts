/**
 * `aihub <command> [<sub>] --help`: short usage for every command, so an agent that asks for help gets the one line it needs
 * (one agent step costs ~50k cached input tokens; a 7 KB help text on top of that is waste). Loaded only for --help and errors.
 *
 * A usage text is lines that start with "aihub <command>", with indented continuation lines; alternatives on one line are
 * separated by " | " (outside brackets). `formatHelp` turns that into a short answer: one subcommand's lines, or the list of
 * subcommands with an example. Commands with their own usage constant are read from their module; the rest live here.
 */

export const HELP_MAX_BYTES = 600;

interface Entry {
  /** the subcommands this line is for ("" when the command takes flags only) */
  subs: string[];
  line: string;
  more: string[];
}

const SUB_RE = /^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)*$/;

/** Splits at " | " outside (), [], <> and quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quote = !quote;
    else if (!quote && "([<".includes(c)) depth++;
    else if (!quote && ")]>".includes(c)) depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && s.startsWith(" | ", i)) {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The entries of a usage text for one command. */
export function entries(cmd: string, usage: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of usage.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/^usage:\s*/, "").replace(/^\s{4,}(?=aihub )/, "");
    if (!line.trim()) continue;
    if (!line.startsWith("aihub ")) {
      if (out.length) out[out.length - 1].more.push(line.trimEnd());
      continue;
    }
    for (const piece of splitTop(line)) {
      // "--from-run <b> | --from-robot <b>": alternatives of flags stay on the line of their subcommand
      if (piece.startsWith("-") && out.length) {
        out[out.length - 1].line += ` | ${piece}`;
        continue;
      }
      const full = piece.startsWith("aihub ") ? piece : piece.startsWith(`${cmd} `) ? `aihub ${piece}` : `aihub ${cmd} ${piece}`;
      const word = full.split(/\s+/)[2] ?? "";
      const bare = /^<([a-z|-]+)>$/.exec(word)?.[1] ?? word;
      out.push({ subs: SUB_RE.test(bare) ? bare.split("|") : [""], line: full, more: [] });
    }
  }
  return out;
}

export const subsOf = (cmd: string, usage: string): string[] => [...new Set(entries(cmd, usage).flatMap((e) => e.subs).filter(Boolean))];

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function cap(lines: string[], max = HELP_MAX_BYTES): string {
  const out: string[] = [];
  for (const l of lines) {
    if (bytes([...out, l].join("\n")) > max) break;
    out.push(l);
  }
  return (out.length ? out : [lines[0].slice(0, max)]).join("\n");
}

/**
 * The help for `aihub <cmd> [sub]`: the lines of that subcommand, or (without a sub) the whole usage when it is short,
 * else the subcommand names, the flag-only lines and the example. undefined: the sub is not in the usage.
 */
export function formatHelp(cmd: string, usage: string, o: { sub?: string; example?: string } = {}): string | undefined {
  const es = entries(cmd, usage);
  const ex = o.example ? [`example: ${o.example}`] : [];
  if (o.sub) {
    const hit = es.filter((e) => e.subs.includes(o.sub!));
    if (!hit.length) return undefined;
    const lines = hit.flatMap((e) => [e.line, ...(hit.length === 1 || e.subs.length === 1 ? e.more : [])]);
    const exSub = o.example && o.example.startsWith(`aihub ${cmd} ${o.sub}`) ? ex : [];
    return cap([...lines, ...exSub]);
  }
  const all = [...es.flatMap((e) => [e.line, ...e.more]), ...ex];
  if (bytes(all.join("\n")) <= HELP_MAX_BYTES) return all.join("\n");
  const lines = [...new Set(es.map((e) => e.line.replace(/ {3,}\S.*$/, "")))]; // without the explanations: still one call
  if (bytes([...lines, ...ex].join("\n")) <= HELP_MAX_BYTES) return [...lines, ...ex].join("\n");
  const subs = subsOf(cmd, usage);
  const flagOnly = es.filter((e) => e.subs[0] === "").map((e) => e.line);
  return cap([...(subs.length ? [`aihub ${cmd} <${subs.join("|")}> [flags]`] : []), ...flagOnly, ...ex, ...(subs.length ? [`flags of one: aihub ${cmd} <sub> --help`] : [])]);
}

/** The usage line of one subcommand, for a parse error ("Unknown option ..."): one line, not the whole text. */
export function usageLine(cmd: string, usage: string, sub?: string): string | undefined {
  const es = entries(cmd, usage);
  return (es.find((e) => sub !== undefined && e.subs.includes(sub)) ?? (es.length === 1 || es.every((e) => e.subs[0] === "") ? es[0] : undefined))?.line;
}

/** At most `max` names close to `word`: a prefix, a contained name or a small edit distance. */
export function suggest(word: string, candidates: string[], max = 3): string[] {
  const w = word.toLowerCase();
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  return candidates
    .map((c) => {
      const l = c.toLowerCase();
      const score = l.startsWith(w) || w.startsWith(l) ? 0 : l.includes(w) || w.includes(l) ? 1 : dist(w, l) <= Math.max(1, Math.floor(l.length / 3)) ? 2 + dist(w, l) : 99;
      return { c, score };
    })
    .filter((x) => x.score < 99)
    .sort((a, b) => a.score - b.score || a.c.localeCompare(b.c))
    .slice(0, max)
    .map((x) => x.c);
}

type Load = () => Promise<string>;
const join = (...parts: (string | string[])[]) => parts.map((p) => (Array.isArray(p) ? p.join("\n") : p)).join("\n");

/** The usage text per command (fabric prints its own help). */
export const USAGES: Record<string, Load> = {
  pr: async () =>
    join(
      (await import("../commands/pr.js")).PR_USAGE,
      (await import("../commands/pr-list.js")).PR_LIST_USAGE,
      (await import("../commands/pr-admin.js")).USAGE,
      "aihub pr checks|requeue --pr <n|url> [--policy build] [--json]",
      "aihub pr explain|complete --pr <n|url> [--json]",
    ),
  comments: async () =>
    'aihub comments get [--pr <url|N>] [--json]\naihub comments reply [--pr <url|N>] --reply "<threadId>:<status>:<text>" [--reply ...] | reply [--pr <url|N>] --replies-file replies.yaml\n    status: fixed|wontFix|closed|active; replies.yaml is a list of {threadId, text, status}.',
  init: async () => "aihub init [--repo .] [--no-pr] [--language nl|en] [--into-repo] [--no-instructions] [--no-agents-md]\n    No team.yaml yet: runs aihub team setup first. Then proposes the team pack as a pull request (--no-pr: only writes the files).",
  skills: async () => "aihub skills install|update|diff|uninstall [--client opencode|github-copilot|codex|claude|all] [--into-repo] [--no-agents]",
  doctor: async () => "aihub doctor [--json]   (sign-in, remote, team.yaml, templates, skills per client)\naihub doctor --perf [--json] [--paths a,b] | --perf --apply <id> [--elevate] [--dry-run] | --perf --undo <id>",
  dbt: async () => (await import("../commands/dbt.js")).DBT_USAGE,
  robot: async () => "aihub robot needed [--json] | run [--on <target>] [--no-merge] [--pipeline P] | targets\naihub robot local [--json] [--command --file f --test t --env e] | result [--since <epoch ms>] [--dir d] [--json]",
  "cherry-pick": async () => 'aihub cherry-pick --from <pr N|url|commit sha,...|story id> --to <branch> [--to <branch>...|--to-group <name>] [--summary-text "<1-2 sentences>"] [--no-pr|--direct]',
  branch: async () => "aihub branch update [--branch B] [--target T] [--rebase]",
  pipeline: async () =>
    join("aihub pipeline follow|status|runs [--name P] [--branch B] [--run N] [--json] | logs --run N [--failed] [--tail N] | run --name P [--branch B] [--params-file f] | retry --run N", (await import("../commands/pipeline-admin.js")).USAGE),
  batch: async () => 'aihub batch --select "<query>" --run "<aihub subcommand with {target}>" [--parallel N] [--json] | --retry-failed <id>',
  work: async () => "aihub work [--json]   (my open stories, PRs and runs in one view)",
  story: async () =>
    join(
      "aihub story show --id <n> [--json] | create --title \"<title>\" --body-file story.md [--type T] [--parent N] | refine --id <n> --body-file story.md | template",
      "aihub story start|link|finish --id <story> [--repos a,b] [--base <branch>] [--branch b] [--no-checkout] [--no-state] [--dry-run] [--json]",
      "aihub story context --id <n> [--repos a,b] [--top 15] [--json]",
      'aihub story recall --id <n> [--json] | search "<words>" [--json]',
      "aihub story branches [--id <story>] [--json]",
      "aihub story branches link --id <story> [--branch a,b] [--repo <name>] [--current]",
      "aihub story branches unlink --id <story> --branch <b> [--repo <name>]",
      "aihub story branches mark --branch <b> --status current|old|parked [--label <text>]",
      "aihub story branches remove --branch <b> [--delete-branch]",
      "aihub story branches place [--move all|<path>]",
      "aihub story open --id <story> [--mode worktree|switch] [--window new|this|none] [--json]",
    ),
  worktree: async () =>
    "aihub worktree create|list|remove --story <id> [--repos a,b] [--root <folder>] | open --group <name>|--repos a,b --branch <b> [--from <target>] [--mode worktree|switch] [--window new|this] | branches --group <name>|--repos a,b | groups list|save <name> --repos a,b|remove <name> | cleanup [--json] [--repos a,b] [--remove p1,p2 [--delete-branch]]",
  review: async () => "aihub review show|prepare --pr <n|url> [--json] | post --pr <n> [--pick 1,3,5] [--findings-file f] | post --pr <n> --comments-file <file.yaml>",
  wiki: async () => (await import("../commands/wiki.js")).USAGE,
  release: async () => "aihub release plan --stories a,b|--prs a,b --target <branch> | plan --from DEV --to ACC [--target <branch>] [--out plan.yaml] [--notes-out notes.md] [--json] | run --plan-file <file>",
  workitem: async () => join("aihub workitem state --id <n> --to <state> | create --type Bug|Task --title <t> --body-file <f> [--parent <n>]", (await import("../commands/workitem-admin.js")).USAGE),
  evidence: async () => "aihub evidence add --pr <n> --file <image> [--caption <text>]",
  port: async () => "aihub port --from-repo <A> --from <pr N|commit sha,...|story id> --to-repo <B> [--to-branch T] [--path-map 'src=>dst' | --map <name>] [--pr --body-file F]",
  crossrepo: async () => "aihub crossrepo status --story N | impact --from <pr|sha> | link-prs --story N [--pr repo!42] | test-resources --from-repo A --to-repo B --target BRANCH --paths GLOB [--message-file F] [--run-pipeline NAME]",
  note: async () => 'aihub note add "text" [--json] | add --file <file> | list [--json]   (private per-branch notes, never committed)',
  status: async () => "aihub status [--json] [--resume]   (where this branch stands and the next step; --resume: from the local journal, no network)",
  bar: async () => "aihub bar --json [--fabric] [--events N]   (everything the VS Code status bar shows, in one process)",
  token: async () => "aihub token refresh --resource <resource> --cache <file>   (started by aihub itself)",
  watch: async () =>
    "aihub watch --run <id|link> | --robot <build> | --fabric-job <ws/item/job> [--notify]\naihub watch --mine [--notify] [--interval 2m] [--at-logon] | --remove-at-logon | --pr <n>|--branch <b> [--until done|comment|vote] [--notify] [--timeout 2h]\naihub watch list | stop [--id X] | events [--limit N] [--since 2h] [--json] | config [--notify all|needed|off] | quiet --for 1h|--until 18:00|--off",
  update: async () => "aihub update [--check]   (newer CLI from npm, then the skills)",
  explain: async () => "aihub explain pr|comments|init|skills|...   (what one aihub command does underneath)",
  repos: async () => "aihub repos list [--filter text] [--root <folder>] [--json] | local [--root <folder>] [--json] | ado [--refresh] [--root <folder>] [--json] | clone --repos <project/name>[,...] [--root <folder>] [--json]",
  open: async () => "aihub open --event <id> | --last | --url aihub://open?event=<id> [--print]   (back to the session a watch event belongs to)",
  commit: async () => (await import("../commands/commit.js")).COMMIT_USAGE,
  boards: async () => (await import("../commands/boards.js")).USAGE,
  testplan: async () => "aihub testplan plans | suites --plan P | cases --plan P --suite S | points --plan P --suite S | outcome --plan P --suite S --point N --to passed|failed | runs [--build B] | results --run N | create-plan --name n | create-suite --plan P --name n [--parent S] | create-case --plan P --suite S --title t",
  artifacts: async () => "aihub artifacts feeds | packages --feed F [--type T] | versions --feed F --package P   (read only)",
  devops: async () => (await import("../commands/devops.js")).USAGE,
  search: async () => (await import("../commands/search.js")).USAGE,
  repo: async () => (await import("../commands/repo.js")).USAGE,
  policy: async () => (await import("../commands/policy.js")).USAGE,
  library: async () => (await import("../commands/library.js")).USAGE,
  test: async () => (await import("../commands/test.js")).TEST_USAGE,
  legacy: async () => "aihub legacy remove [--dry-run] [--yes] [--keep-data] [--keep-settings] [--repos <dir>[,<dir>...]]   (removes the old AI Context Hub)",
  fix: async () => 'aihub fix known [--run <id|link> | --error "<text>"] [--json] | remember --error "<error line>" --fix "<1-3 lines>"   (proposes a pull request)',
  team: async () => (await import("../commands/team.js")).TEAM_USAGE,
  probe: async () => (await import("../commands/probe.js")).PROBE_USAGE,
  research: async () => (await import("../commands/research.js")).RESEARCH_USAGE,
  learn: async () => (await import("../commands/learn.js")).LEARN_USAGE,
  standup: async () => "aihub standup [--since yesterday|today|<duration>] [--json]   (3-5 lines of what I did, read-only)",
  handoff: async () => "aihub handoff [--to <name>] [--clipboard] [--wiki [--wiki-page <path>]] [--json]   (my open work as a short note)",
};

/** One example per command: the call an agent most often needs. */
export const EXAMPLES: Record<string, string> = {
  pr: 'aihub pr create --summary-text "Adds the CSV export"',
  comments: "aihub comments get",
  init: "aihub init --language nl",
  skills: "aihub skills install --client opencode",
  doctor: "aihub doctor",
  dbt: "aihub dbt build --select orders+",
  robot: "aihub robot run --on feature",
  "cherry-pick": "aihub cherry-pick --from 42 --to release/1.3",
  branch: "aihub branch update",
  pipeline: "aihub pipeline logs --failed",
  batch: 'aihub batch --select "my prs" --run "pr checks --pr {target}"',
  work: "aihub work",
  story: 'aihub story create --title "Export orders to CSV" --body-file story.md',
  worktree: "aihub worktree open --repos a,b --branch feature/123-export",
  review: "aihub review prepare --pr 42",
  wiki: "aihub wiki read --page Onboarding",
  release: "aihub release plan --from DEV --to ACC",
  workitem: "aihub workitem state --id 123 --to Doing",
  evidence: "aihub evidence add --pr 42 --file screen.png",
  port: "aihub port --from-repo a --from 42 --to-repo b",
  crossrepo: "aihub crossrepo status --story 123",
  note: 'aihub note add "ask about the date format"',
  status: "aihub status",
  bar: "aihub bar --json",
  token: "aihub token refresh --resource <r> --cache <f>",
  watch: "aihub watch --pr 42 --notify",
  update: "aihub update",
  explain: "aihub explain pr",
  repos: "aihub repos ado",
  open: "aihub open --last",
  commit: 'aihub commit --type fix --subject "handle empty CSV" --push',
  boards: "aihub boards sprint items",
  testplan: "aihub testplan plans",
  artifacts: "aihub artifacts feeds",
  devops: "aihub devops projects",
  search: 'aihub search code --text "def load_orders"',
  repo: "aihub repo branch list",
  policy: "aihub policy list --branch main",
  library: "aihub library show --group shared",
  test: "aihub test changed --run",
  legacy: "aihub legacy remove --dry-run",
  fix: 'aihub fix known --error "ModuleNotFoundError: orders"',
  team: "aihub team set workItems.states.active Doing",
  probe: "aihub probe devops feature pipelines",
  research: "aihub research template",
  learn: "aihub learn change --json",
  standup: "aihub standup",
  handoff: "aihub handoff",
};

const PARSE_ERROR = /^(Unknown option|Option '[^']+' argument (missing|ambiguous)|Unexpected argument)/;

/**
 * A usage error made short: a parse error gets the one usage line of its subcommand (not node's advice about '--'),
 * a whole usage text becomes "did you mean" for an unknown subcommand, or the lines of the one it was for.
 */
export async function shortenUsageError(cmd: string, args: string[], message: string): Promise<string> {
  const load = USAGES[cmd];
  if (!load) return message;
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  if (PARSE_ERROR.test(message)) {
    const line = usageLine(cmd, await load(), sub);
    return `${message.replace(/\. To specify a positional argument[\s\S]*$/, "")}${line ? `\nusage: ${line}` : ""}`;
  }
  if (!/^usage:/.test(message)) return message;
  const usage = await load();
  const subs = subsOf(cmd, usage);
  if (sub && subs.length && !subs.includes(sub)) {
    const near = suggest(sub, subs);
    const line = near.length ? usageLine(cmd, usage, near[0]) : undefined;
    return `unknown subcommand '${sub}' of aihub ${cmd}${near.length ? `; did you mean: ${near.join(", ")}?` : `; subcommands: ${subs.join(", ")}`}${line ? `\nusage: ${line}` : ""}`;
  }
  return `usage: ${formatHelp(cmd, usage, { sub }) ?? formatHelp(cmd, usage)}`;
}

/** The help text for `aihub <cmd> [sub] --help`, or undefined when the command has none here. */
export async function helpFor(cmd: string, sub?: string): Promise<string | undefined> {
  const load = USAGES[cmd];
  if (!load) return undefined;
  const usage = await load();
  const s = sub && !sub.startsWith("-") ? sub : undefined;
  const text = formatHelp(cmd, usage, { sub: s, example: EXAMPLES[cmd] });
  if (text !== undefined) return text;
  const near = suggest(s!, subsOf(cmd, usage));
  return `aihub ${cmd}: no subcommand '${s}'${near.length ? `; did you mean: ${near.join(", ")}?` : ""}\n${formatHelp(cmd, usage, { example: EXAMPLES[cmd] })}`;
}
