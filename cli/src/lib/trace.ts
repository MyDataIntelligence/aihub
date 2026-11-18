/**
 * Transparency for every write: `--verbose` logs the real git and REST calls (to stderr), `--dry-run` prints what
 * would be done and skips every write. The two choke points are git() in git.ts (and its siblings) and
 * AdoClient.request in ado.ts; both ask this module.
 */
export interface TraceState {
  dryRun: boolean;
  verbose: boolean;
  /** Real calls (--verbose). */
  log: (line: string) => void;
  /** Planned writes (--dry-run). */
  plan: (line: string) => void;
}

export const trace: TraceState = { dryRun: false, verbose: false, log: () => {}, plan: () => {} };

export function setTrace(s: Partial<TraceState>): void {
  Object.assign(trace, { dryRun: false, verbose: false, log: () => {}, plan: () => {} }, s);
}

const READ_ONLY = new Set([
  "rev-parse", "symbolic-ref", "log", "show", "ls-remote", "merge-base", "diff", "diff-tree", "status", "rev-list",
  "for-each-ref", "ls-files", "cat-file", "describe", "blame", "fetch", "version", "--version",
]);

/** Subcommand of a git invocation, skipping leading `-c k=v` / `-C dir` options. */
function subcommand(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-c" || args[i] === "-C" ? 2 : 1;
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/** True when this git invocation can change a repository, a branch, a remote or the configuration. */
export function isGitWrite(args: string[]): boolean {
  const { sub, rest } = subcommand(args);
  if (READ_ONLY.has(sub)) return false;
  const plain = rest.filter((a) => !a.startsWith("-"));
  const has = (...f: string[]) => rest.some((a) => f.includes(a));
  switch (sub) {
    case "config":
      return !(has("--get", "--get-all", "--list", "-l", "--get-regexp") || plain.length < 2);
    case "remote":
      return !(plain.length === 0 || plain[0] === "get-url" || plain[0] === "show");
    case "branch":
      return !(has("--list", "-l", "--show-current", "-a", "-r", "--contains", "--merged", "--no-merged") || plain.length === 0);
    case "worktree":
      return plain[0] !== "list";
    case "tag":
      return !(has("--list", "-l") || plain.length === 0);
    default:
      return true;
  }
}

/** Called before running git. Returns true when the command must be skipped (dry-run write). */
export function gitGate(cwd: string, args: string[]): boolean {
  const write = isGitWrite(args);
  if (trace.dryRun && write) {
    trace.plan(`would run: git ${args.join(" ")}   (in ${cwd})`);
    return true;
  }
  if (trace.verbose) trace.log(`+ git ${args.join(" ")}   (in ${cwd})`);
  return false;
}

function summarizeValue(v: unknown): string {
  if (typeof v === "string") return `${v.length} chars`;
  if (Array.isArray(v)) return `${v.length} items`;
  if (v && typeof v === "object") return `{${Object.keys(v).join(", ")}}`;
  return JSON.stringify(v);
}

/** Short description of a request body: keys with sizes, or the operations of a JSON patch. */
export function summarizeBody(body: unknown): string {
  if (body === undefined) return "";
  if (Array.isArray(body)) {
    const ops = body.map((o) => (o && typeof o === "object" && "op" in o ? `${(o as any).op} ${(o as any).path ?? ""}` : summarizeValue(o)));
    return `[${ops.join("; ")}]`;
  }
  if (body && typeof body === "object") {
    return `{${Object.entries(body).map(([k, v]) => `${k}: ${summarizeValue(v)}`).join(", ")}}`;
  }
  return summarizeValue(body);
}

/** POST endpoints that only read (queries); they run even in a dry-run. */
const READ_POSTS = /wiql|workitemsbatch|(^|\/)search\/|pullrequestquery|\/queries|\/reporting|pagesbatch/i;

export function isRestWrite(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return !(method === "POST" && READ_POSTS.test(path));
}