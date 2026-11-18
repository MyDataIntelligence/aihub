/**
 * The bar's data. Everything here is a pure function of the JSON the aihub CLI printed: no vscode, no I/O.
 * Unknown or missing fields never throw; the bar shows what it has.
 */

export type Checks = "none" | "running" | "green" | "red";
export type Tone = "ok" | "run" | "bad" | "warn" | "muted";

export interface StatusJson {
  repo?: string;
  branch?: string;
  story?: { id: number; title: string; state: string } | null;
  pr?: { id: number; title: string; status: string; draft: boolean; url: string; votes?: unknown; reviewers?: unknown } | null;
  pipeline?: { name: string; state: string }[];
  checks?: Checks;
  openThreads?: number;
  dirty?: boolean;
  unpushed?: number;
  notes?: number;
  done?: string[];
  next?: string;
  warnings?: string[];
}

export interface PolicyJson {
  name: string;
  kind: string;
  status: string;
  blocks?: boolean;
}

export interface PrChecksJson {
  pr: number;
  status: string;
  draft: boolean;
  conflicts?: boolean;
  openThreads?: number;
  policies?: PolicyJson[];
  blockers?: string[];
  canComplete?: boolean;
}

export interface FabricRun {
  item: string;
  type?: string;
  status: string;
  duration?: string;
  jobId?: string;
  error?: string;
  start?: string;
}

export interface FabricModel {
  workspace: string;
  failed: { item: string; job?: string }[];
  active: number;
  runs: FabricRun[];
  cause?: string;
}

export interface BarEvent {
  id: string;
  message: string;
  at: number;
  repo?: string;
}

export interface Vote {
  name: string;
  vote: number;
}

export interface PrModel {
  id: number;
  title: string;
  status: string;
  draft: boolean;
  url: string;
  /** Votes of the reviewers: from the CLI when it prints them, else the reviewers policy. */
  votes: { approved: number; waiting: number; rejected: number; summary: string };
  reviewers: { name: string; vote: number; voteName?: string; required?: boolean }[];
  blockers: string[];
  canComplete?: boolean;
}

export interface BarModel {
  repo: string;
  branch: string;
  story: { id: number; title: string; state: string } | null;
  pr: PrModel | null;
  checks: Checks;
  pipeline: { name: string; state: string }[];
  openThreads: number;
  dirty: boolean;
  unpushed: number;
  next: string;
  warnings: string[];
  fabric: FabricModel | null;
  events: BarEvent[];
  watching: boolean;
  updatedAt: number;
}

export interface BarError {
  kind: "missing" | "old" | "timeout" | "failed" | "no-repo";
  message: string;
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const text = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** The CLI wraps some reads as `{ identity, result }`. */
export function unwrap<T>(json: unknown): T {
  if (json && typeof json === "object" && "result" in json) return (json as { result: T }).result;
  return json as T;
}

/** Votes from a list of `{ name, vote }` (Azure DevOps numbers: 10 approved, 5 with suggestions, -5 waiting, -10 rejected). */
export function countVotes(list: unknown): PrModel["votes"] {
  const v = asArray<Vote>(list).filter((x) => x && typeof x.vote === "number");
  const approved = v.filter((x) => x.vote >= 5).length;
  const waiting = v.filter((x) => x.vote === -5).length;
  const rejected = v.filter((x) => x.vote === -10).length;
  const parts = [approved ? `${approved} approved` : "", waiting ? `${waiting} waiting` : "", rejected ? `${rejected} rejected` : ""].filter(Boolean);
  return { approved, waiting, rejected, summary: parts.join(", ") || "no votes" };
}

/** Falls back to the reviewers policy of `aihub pr checks` when the status has no vote list. */
export function votesFromPolicies(policies: PolicyJson[] | undefined): PrModel["votes"] | undefined {
  const rev = (policies ?? []).find((p) => p.kind === "reviewers");
  if (!rev) return undefined;
  const ok = rev.status === "approved" || rev.status === "notApplicable";
  const rejected = rev.status === "rejected" ? 1 : 0;
  return { approved: ok ? 1 : 0, waiting: 0, rejected, summary: ok ? "approved" : rejected ? "rejected" : "needs approval" };
}

export function toPr(status: StatusJson, checks?: PrChecksJson): PrModel | null {
  const p = status.pr;
  if (!p) return null;
  // CLI 1.0.3 lists the reviewers with their votes; older CLIs do not, then the reviewers policy is the fallback.
  const list = p.reviewers ?? p.votes;
  const own = list !== undefined ? countVotes(list) : undefined;
  return {
    id: p.id,
    title: text(p.title),
    status: text(p.status, "active"),
    draft: !!p.draft,
    url: text(p.url),
    votes: own ?? votesFromPolicies(checks?.policies) ?? { approved: 0, waiting: 0, rejected: 0, summary: "no votes" },
    reviewers: asArray<PrModel["reviewers"][number]>(list).filter((r) => r && typeof r.vote === "number"),
    blockers: asArray<string>(checks?.blockers),
    canComplete: checks?.canComplete,
  };
}

export function toFabric(failures: unknown, logs: unknown): FabricModel | null {
  const f = unwrap<{ workspace?: string; failed?: { item: string; job?: string }[]; active?: number; chain?: { error?: string }[] } | undefined>(failures);
  if (!f || typeof f !== "object") return null;
  const l = unwrap<{ rows?: FabricRun[] } | undefined>(logs);
  const runs = asArray<FabricRun>(l?.rows)
    .slice(0, 8)
    .map((r) => ({ item: text(r.item), type: r.type, status: text(r.status), duration: r.duration, jobId: r.jobId, error: r.error, start: r.start }));
  const deepest = [...asArray<{ error?: string }>(f.chain)].reverse().find((c) => c.error);
  return {
    workspace: text(f.workspace, "(workspace)"),
    failed: asArray<{ item: string; job?: string }>(f.failed).map((x) => ({ item: text(x.item), job: x.job })),
    active: typeof f.active === "number" ? f.active : 0,
    runs,
    cause: deepest?.error,
  };
}

/** An error text that means "this branch has no Fabric workspace": not a failure, the section just stays hidden. */
export const isNoFabricWorkspace = (message: string) => /no single workspace|no workspace|not configured|branchWorkspacePrefixes|needs --workspace|fabric is not/i.test(message);

export function buildModel(input: {
  status: StatusJson;
  checks?: PrChecksJson;
  fabric?: FabricModel | null;
  events?: BarEvent[];
  watching?: boolean;
  now?: number;
}): BarModel {
  const s = input.status;
  return {
    repo: text(s.repo),
    branch: text(s.branch, "(no branch)"),
    story: s.story ?? null,
    pr: toPr(s, input.checks),
    checks: (s.checks as Checks) ?? "none",
    pipeline: asArray(s.pipeline),
    openThreads: typeof s.openThreads === "number" ? s.openThreads : 0,
    dirty: !!s.dirty,
    unpushed: typeof s.unpushed === "number" ? s.unpushed : 0,
    next: text(s.next),
    warnings: asArray<string>(s.warnings),
    fabric: input.fabric ?? null,
    events: input.events ?? [],
    watching: !!input.watching,
    updatedAt: input.now ?? Date.now(),
  };
}

// ---- display ----------------------------------------------------------------------------------

export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function checksTone(c: Checks): Tone {
  return c === "green" ? "ok" : c === "red" ? "bad" : c === "running" ? "run" : "muted";
}

export const checksIcon = (c: Checks) => (c === "green" ? "check" : c === "red" ? "error" : c === "running" ? "sync~spin" : "circle-outline");

export function prLabel(pr: PrModel): string {
  const state = pr.status === "active" ? (pr.draft ? " draft" : "") : ` ${pr.status}`;
  const v = pr.votes;
  const votes = [v.approved ? `${v.approved}✓` : "", v.waiting ? `${v.waiting}⏳` : "", v.rejected ? `${v.rejected}✗` : ""].filter(Boolean).join(" ");
  return `!${pr.id}${state}${votes ? ` ${votes}` : ""}`;
}

export function fabricTone(f: FabricModel): Tone {
  return f.failed.length ? "bad" : f.active ? "run" : "ok";
}

export function fabricLabel(f: FabricModel): string {
  if (f.failed.length) return `${f.failed.length} failed${f.active ? `, ${f.active} running` : ""}`;
  return f.active ? `${f.active} running` : "no failures";
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export interface StatusItem {
  id: "story" | "pr" | "pipeline" | "threads" | "fabric" | "events";
  text: string;
  tooltip: string;
  tone: Tone;
  command: string;
}

/** What the status bar shows. Items with nothing to say are left out, so a quiet repository is a short bar. */
export function statusItems(m: BarModel): StatusItem[] {
  const items: StatusItem[] = [];
  items.push({
    id: "story",
    text: `$(git-branch) ${m.story ? `#${m.story.id} ${short(m.story.title, 28)}` : short(m.branch, 36)}`,
    tooltip: [m.story ? `Story #${m.story.id} (${m.story.state}): ${m.story.title}` : "No story on this branch", `Branch: ${m.branch}`, m.dirty ? "Uncommitted changes" : "", m.unpushed ? `${m.unpushed} commit(s) not pushed` : "", m.next ? `Next: ${m.next}` : ""]
      .filter(Boolean)
      .join("\n"),
    tone: "muted",
    command: "aihub.showBar",
  });
  if (m.pr) {
    items.push({
      id: "pr",
      text: `$(git-pull-request) ${prLabel(m.pr)}`,
      tooltip: [`PR !${m.pr.id}: ${m.pr.title}`, `Votes: ${m.pr.votes.summary}`, ...m.pr.blockers.map((b) => `Blocks: ${b}`)].join("\n"),
      tone: m.pr.votes.rejected ? "bad" : m.pr.votes.approved ? "ok" : "muted",
      command: "aihub.showBar",
    });
    items.push({
      id: "pipeline",
      text: `$(${checksIcon(m.checks)}) ${m.checks === "none" ? "no pipeline" : m.checks}`,
      tooltip: m.pipeline.length ? m.pipeline.map((p) => `${p.name}: ${p.state}`).join("\n") : "No pipeline run found for this PR",
      tone: checksTone(m.checks),
      command: "aihub.showBar",
    });
    if (m.openThreads > 0) {
      items.push({ id: "threads", text: `$(comment-discussion) ${m.openThreads}`, tooltip: `${m.openThreads} open review thread(s). Open the bar and send /review to chat.`, tone: "warn", command: "aihub.showBar" });
    }
  }
  if (m.fabric) {
    items.push({
      id: "fabric",
      text: `$(database) ${fabricLabel(m.fabric)}`,
      tooltip: `Fabric workspace ${m.fabric.workspace}\n${m.fabric.runs.slice(0, 5).map((r) => `${r.item}: ${r.status}`).join("\n")}`.trim(),
      tone: fabricTone(m.fabric),
      command: "aihub.showBar",
    });
  }
  if (m.events.length) {
    items.push({ id: "events", text: `$(bell) ${m.events.length}`, tooltip: m.events.slice(0, 5).map((e) => e.message).join("\n"), tone: "warn", command: "aihub.showBar" });
  }
  return items;
}
