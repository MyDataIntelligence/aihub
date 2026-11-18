#!/usr/bin/env node
// Lints the generic skill pack: front matter, "Use when", token budget, relative links,
// absolute paths, forbidden names and that the slash commands match the skills.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface LintOptions {
  /** Case-insensitive names that must never appear in the pack. */
  forbidden?: string[];
  /** Directory with the slash commands; default: <skillsDir>/../commands. */
  commandsDir?: string;
  maxTokens?: number;
  minTokens?: number;
}

export const DEFAULT_FORBIDDEN = ["iqbs", "mydataintelligence", "ferronhooi", "ferron hooi"];

export interface CommandSpec {
  name: string;
  skill: string;
  description: string;
  hint: string;
}

/** The slash commands, each loading one skill. Files must equal expectedCommand(). */
export const COMMANDS: CommandSpec[] = [
  { name: "pr", skill: "pr-create", description: "Create a pull request", hint: "optional story id or remarks" },
  { name: "commit", skill: "commit", description: "Commit the working changes", hint: "optional type and remarks" },
  { name: "pr-update", skill: "pr-update", description: "Update the open pull request", hint: "optional remarks" },
  { name: "cherry-pick", skill: "branch-sync", description: "Cherry-pick a PR to other branches", hint: "PR id and target branches" },
  { name: "story", skill: "story-create", description: "Create a story", hint: "what the story is about" },
  { name: "story-run", skill: "story-run", description: "Run a story end to end to a green PR", hint: "story id or link" },
  { name: "refine", skill: "story-refine", description: "Refine a story", hint: "story id" },
  { name: "review", skill: "review-process", description: "Process review comments", hint: "optional PR id" },
  { name: "watch", skill: "pr-watch", description: "Follow a PR and its pipeline", hint: "optional PR id or link" },
  { name: "test", skill: "test-run", description: "Run the Fabric or Robot tests for this branch", hint: "fabric or robot, optional item or suite" },
  { name: "start", skill: "story-start", description: "Start a story: branch, link, state", hint: "story id and optional repositories" },
  { name: "finish", skill: "story-finish", description: "Finish a story: clean up and close", hint: "story id" },
  { name: "review-pr", skill: "pr-review", description: "Review someone else's pull request", hint: "PR id or link" },
  { name: "explain", skill: "pr-explain", description: "Explain a pull request", hint: "PR id or link" },
  { name: "release", skill: "release", description: "Release stories or PRs to target branches", hint: "stories or PRs and target branches" },
  { name: "wiki", skill: "wiki", description: "Write or update a wiki page", hint: "page and subject" },
];

export function expectedCommand(kind: "opencode" | "copilot", c: CommandSpec): string {
  const load = `Load the \`${c.skill}\` skill and follow it exactly.`;
  if (kind === "opencode") {
    return `---\ndescription: ${c.description}\n---\n${load}\nArguments: $ARGUMENTS\n`;
  }
  return `---\nmode: agent\ndescription: ${c.description}\n---\n${load}\nInput: \${input:args:${c.hint}}\n`;
}

export function commandFileName(kind: "opencode" | "copilot", c: CommandSpec): string {
  return kind === "opencode" ? `${c.name}.md` : `${c.name}.prompt.md`;
}

export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

export const tokens = (s: string): number => Math.ceil(s.length / 4);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ABSOLUTE = /(?<![A-Za-z0-9])[A-Za-z]:\\|(?<![A-Za-z0-9])[A-Za-z]:\/(?!\/)|\/Users\/|\/home\/[a-z]|~\//;

export function checkText(file: string, text: string, forbidden: string[], errors: string[]): void {
  const lower = text.toLowerCase();
  for (const f of forbidden) if (f && lower.includes(f.toLowerCase())) errors.push(`${file}: forbidden name "${f}"`);
  if (ABSOLUTE.test(text)) errors.push(`${file}: absolute path`);
  const dir = path.dirname(file);
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(dir, target))) errors.push(`${file}: link does not resolve: ${m[1]}`);
  }
}

export function lintSkills(skillsDir: string, opts: LintOptions = {}): string[] {
  const errors: string[] = [];
  const forbidden = opts.forbidden ?? DEFAULT_FORBIDDEN;
  const max = opts.maxTokens ?? 500;
  const min = opts.minTokens ?? 200;
  const skillNames: string[] = [];

  for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const file = path.join(skillsDir, e.name, "SKILL.md");
    if (!fs.existsSync(file)) {
      errors.push(`${e.name}: SKILL.md missing`);
      continue;
    }
    skillNames.push(e.name);
    const text = fs.readFileSync(file, "utf8");
    // `npx skills add` copies each skill folder on its own: a link into _shared (or any underscore folder) would not exist there
    if (/\]\(\.\.\/_/.test(text)) errors.push(`${file}: links into an underscore folder (_shared); a skill must be self-contained`);
    const fm = parseFrontMatter(text);
    if (!fm) {
      errors.push(`${file}: front matter missing`);
      continue;
    }
    if (fm.data.name !== e.name) errors.push(`${file}: name "${fm.data.name}" must equal folder "${e.name}"`);
    if (!/^Use when /.test(fm.data.description ?? "")) errors.push(`${file}: description must start with "Use when "`);
    const n = tokens(fm.body);
    if (n > max) errors.push(`${file}: body is ~${n} tokens, max ${max}`);
    if (n < min) errors.push(`${file}: body is ~${n} tokens, min ${min}`);
    for (const h of ["## When", "## Steps", "## What the CLI fills", "## If it fails"]) {
      if (!fm.body.includes(h)) errors.push(`${file}: section "${h}" missing`);
    }
  }

  for (const file of walk(skillsDir)) {
    if (/\.(md|txt|ya?ml)$/.test(file)) checkText(file, fs.readFileSync(file, "utf8"), forbidden, errors);
  }

  const commandsDir = opts.commandsDir ?? path.resolve(skillsDir, "..", "commands");
  if (fs.existsSync(commandsDir)) {
    for (const kind of ["opencode", "copilot"] as const) {
      for (const c of COMMANDS) {
        if (!skillNames.includes(c.skill)) {
          errors.push(`command ${c.name}: skill "${c.skill}" does not exist`);
          continue;
        }
        const file = path.join(commandsDir, kind, commandFileName(kind, c));
        if (!fs.existsSync(file)) errors.push(`${file}: missing`);
        else if (fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== expectedCommand(kind, c)) {
          errors.push(`${file}: does not match the skill "${c.skill}" (expected generated content)`);
        }
      }
      const dir = path.join(commandsDir, kind);
      if (fs.existsSync(dir)) {
        const known = new Set(COMMANDS.map((c) => commandFileName(kind, c)));
        for (const f of fs.readdirSync(dir)) if (!known.has(f)) errors.push(`${path.join(dir, f)}: unknown command file`);
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          checkText(p, fs.readFileSync(p, "utf8"), forbidden, errors);
        }
      }
    }
  } else {
    errors.push(`${commandsDir}: commands directory missing`);
  }
  return errors;
}

/** Agent files: valid YAML front matter, the keys each client needs, a short body that is identical for both clients, no hard-coded paths or names. */
export const AGENT_MAX_LINES = 25;
export const AGENT_MAX_TOKENS = 400;

export function lintAgents(agentsDir: string, skillNames: string[], opts: { forbidden?: string[] } = {}): string[] {
  const errors: string[] = [];
  const forbidden = opts.forbidden ?? DEFAULT_FORBIDDEN;
  const bodies = new Map<string, Map<string, string>>();
  const sets: Array<{ kind: "opencode" | "copilot"; ext: string }> = [
    { kind: "opencode", ext: ".md" },
    { kind: "copilot", ext: ".agent.md" },
  ];
  for (const { kind, ext } of sets) {
    const dir = path.join(agentsDir, kind);
    if (!fs.existsSync(dir)) {
      errors.push(`${dir}: missing`);
      continue;
    }
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (!f.endsWith(ext)) {
        errors.push(`${file}: agent files for ${kind} must end in ${ext}`);
        continue;
      }
      const name = f.slice(0, -ext.length);
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      checkText(file, text, forbidden, errors);
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) {
        errors.push(`${file}: front matter missing`);
        continue;
      }
      let fm: Record<string, unknown>;
      try {
        fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
      } catch (e) {
        errors.push(`${file}: front matter is not valid YAML (${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      const body = m[2].trim();
      if (typeof fm.description !== "string" || !fm.description.trim()) errors.push(`${file}: description missing`);
      if (kind === "opencode") {
        if (fm.mode !== "primary" && fm.mode !== "subagent") errors.push(`${file}: mode must be primary or subagent`);
        const perms = fm.permissions;
        if (!Array.isArray(perms) || !perms.length) errors.push(`${file}: permissions must be a non-empty list`);
        else
          for (const [i, r] of perms.entries()) {
            const rule = r as Record<string, unknown>;
            if (typeof rule?.action !== "string" || typeof rule?.resource !== "string" || !["allow", "ask", "deny"].includes(rule?.effect as string)) {
              errors.push(`${file}: permissions[${i}] needs action, resource and effect allow|ask|deny`);
            }
          }
      } else {
        if (fm.name !== name) errors.push(`${file}: name "${String(fm.name)}" must equal the file name "${name}"`);
        if (!Array.isArray(fm.tools) || !fm.tools.length) errors.push(`${file}: tools must be a non-empty list`);
      }
      const lines = body.split("\n").filter((l) => l.trim()).length;
      if (lines > AGENT_MAX_LINES) errors.push(`${file}: body is ${lines} lines, max ${AGENT_MAX_LINES}`);
      if (tokens(body) > AGENT_MAX_TOKENS) errors.push(`${file}: body is ~${tokens(body)} tokens, max ${AGENT_MAX_TOKENS}`);
      // an agent points at skills and never repeats them: every skill it names must exist
      for (const s of body.matchAll(/(?:skill|skills) `([a-z-]+)`|`([a-z-]+)` skill/g)) {
        const n = s[1] ?? s[2];
        if (!skillNames.includes(n)) errors.push(`${file}: names the skill "${n}" which does not exist`);
      }
      if (!bodies.has(name)) bodies.set(name, new Map());
      bodies.get(name)!.set(kind, body);
    }
  }
  for (const [name, byKind] of bodies) {
    const [a, b] = [byKind.get("opencode"), byKind.get("copilot")];
    if (a === undefined || b === undefined) errors.push(`agent ${name}: needs both an opencode and a copilot file`);
    else if (a !== b) errors.push(`agent ${name}: opencode and copilot bodies differ (one text, two front matters)`);
  }
  return errors;
}

function main(): void {
  const args = process.argv.slice(2);
  let forbidden: string[] | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--forbidden") forbidden = (args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else rest.push(args[i]);
  }
  forbidden ??= process.env.AIHUB_FORBIDDEN_NAMES?.split(",").map((s) => s.trim()).filter(Boolean);
  const dir = path.resolve(rest[0] ?? "../skills");
  const errors = lintSkills(dir, { forbidden });
  const agentsDir = path.resolve(dir, "..", "agents");
  if (fs.existsSync(agentsDir)) {
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);
    errors.push(...lintAgents(agentsDir, names, { forbidden }));
  }
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`lint:skills failed with ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log("lint:skills ok");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
