import { getPr, type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { checkDescriptionLength, fallbackKindOf, editSection, parseSections } from "./templates.js";
import { resolvePr } from "./pr.js";
import { loadTeam, readUtf8 } from "./team.js";

/**
 * The "gold standard" PR helpers: a detail comment as a CLOSED thread linked from a section (`aihub pr comment`), and an honest
 * row in the PR test table from a real run (`aihub pr tests add`).
 */

// ---- pr comment --------------------------------------------------------------------------------------------------------

export interface CommentOpts {
  pr?: string;
  title?: string;
  text?: string;
  bodyFile?: string;
  closed?: boolean;
  linkSection?: string;
  json?: boolean;
}

export const threadUrl = (prUrl: string, threadId: number): string => `${prUrl}?_a=overview&discussionId=${threadId}`;

export async function prComment(ctx: Ctx, o: CommentOpts): Promise<string> {
  if (!o.title?.trim()) throw new AihubError('aihub pr comment needs --title "<what the detail is about>"');
  const body = o.bodyFile ? readUtf8(o.bodyFile) : (o.text ?? "");
  if (!body.trim()) throw new AihubError("aihub pr comment needs --text <markdown> or --body-file <file>");
  const { root, client } = repoClient(ctx);
  const pr = await resolvePr(ctx, client, root, o.pr);
  const id = pr.pullRequestId;
  const thread = await client.post<{ id: number }>(`${client.repoPath()}/pullrequests/${id}/threads`, {
    comments: [{ parentCommentId: 0, content: `**${o.title.trim()}**\n\n${body.trim()}`, commentType: 1 }],
    status: o.closed ? "closed" : "active",
  });
  const url = threadUrl(client.prUrl(id), thread.id);
  let linked: string | undefined;
  if (o.linkSection) {
    const description = editSection(pr.description ?? "", o.linkSection, { append: `Details: [${o.title.trim()}](${url})` });
    await client.patch(`${client.repoPath()}/pullrequests/${id}`, { description });
    linked = o.linkSection;
  }
  return o.json
    ? JSON.stringify({ pr: id, threadId: thread.id, status: o.closed ? "closed" : "active", url, linkedSection: linked })
    : `PR !${id}: ${o.closed ? "closed " : ""}thread ${thread.id} posted: ${url}${linked ? `\nlinked from the '${linked}' section` : ""}`;
}

// ---- pr tests add ---------------------------------------------------------------------------------------------------------

export type Outcome = "pass" | "fail" | "partial";

export interface Evidence {
  name: string;
  result: Outcome;
  link: string;
  durationMs?: number;
  /** short extra, e.g. "12/12 tests" */
  detail?: string;
}

const WORDS: Record<string, Record<Outcome, string>> = {
  en: { pass: "pass", fail: "fail", partial: "partial" },
  nl: { pass: "geslaagd", fail: "mislukt", partial: "deels geslaagd" },
};

export function duration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
const rowCells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
const isSeparator = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
const isPlaceholderRow = (cells: string[]): boolean => cells.every((c) => c === "" || /^-+$/.test(c) || /^<[^>]*>$/.test(c));

/** Which column of a header holds what; unknown headers are filled with "-". */
function columnRole(h: string): "name" | "result" | "link" | "duration" | "other" {
  const t = h.toLowerCase();
  if (/duur|duration|tijd|time/.test(t)) return "duration";
  if (/link|bewijs|evidence|url|run/.test(t)) return "link";
  if (/result|resultaat|status|uitkomst|outcome/.test(t)) return "result";
  if (/test|naam|name|scenario|check/.test(t)) return "name";
  return "other";
}

const NOT_RUN = /^(not run( yet)?|nog niet uitgevoerd)\.?$/i;

/** Adds (or refreshes, matched by link) one evidence row in the test table of the description; creates the table when there is none. */
export function addTestRow(description: string, ev: Evidence, lang: string | undefined): { description: string; heading: string; replaced: boolean } {
  const w = WORDS[lang === "nl" ? "nl" : "en"];
  const nl = lang === "nl";
  const parsed = parseSections(description);
  // "Tests", "Testen", "Functionele tests", "Validatie": the first section about testing
  const sec = parsed.sections.find((s) => fallbackKindOf(s.heading) === "tests") ?? parsed.sections.find((s) => /test|validatie|verification|verificatie/i.test(s.heading));
  const heading = sec?.heading ?? "Tests";
  const result = `${w[ev.result]}${ev.detail ? ` (${ev.detail})` : ""}`;
  const body = sec?.body ?? "";
  const lines = body.split("\n");
  const first = lines.findIndex((line, index) => {
    if (!line.trim().startsWith("|") || !isSeparator(lines[index + 1] ?? "")) return false;
    const roles = rowCells(line).map(columnRole);
    return roles.includes("result") && (roles.includes("name") || roles.includes("link"));
  });
  const linkText = `[${cell(ev.name)}](${ev.link})`;

  if (first < 0) {
    const kept = body.replace(/^\s*(?:not run(?: yet)?|nog niet uitgevoerd)\.?\s*$/i, "").trimEnd();
    const table = [`| Test | ${nl ? "Resultaat" : "Result"} | ${nl ? "Duur" : "Duration"} |`, "|---|---|---|", `| ${linkText} | ${cell(result)} | ${duration(ev.durationMs)} |`];
    return { description: editSection(description, heading, { replace: [...(kept ? [kept, ""] : []), ...table].join("\n") }), heading, replaced: false };
  }
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].trim().startsWith("|")) last++;
  const tableLines = lines.slice(first, last + 1);
  const header = rowCells(tableLines[0]);
  const roles = header.map(columnRole);
  const hasLinkCol = roles.includes("link");
  const make = (): string => {
    const cells = roles.map((r) => (r === "name" ? (hasLinkCol ? cell(ev.name) : linkText) : r === "result" ? cell(result) : r === "link" ? `[run](${ev.link})` : r === "duration" ? duration(ev.durationMs) : "-"));
    if (!roles.includes("name")) cells[0] = linkText;
    return `| ${cells.join(" | ")} |`;
  };
  const body2 = tableLines.slice(isSeparator(tableLines[1] ?? "") ? 2 : 1);
  let replaced = false;
  const out = [tableLines[0], ...(isSeparator(tableLines[1] ?? "") ? [tableLines[1]] : [`|${header.map(() => "---").join("|")}|`])];
  for (const l of body2) {
    const cells = rowCells(l);
    if (isPlaceholderRow(cells)) continue; // the template's "<test that was really run>" row or a bare "-" row
    if (l.includes(`](${ev.link})`)) {
      out.push(make());
      replaced = true;
    } else out.push(l);
  }
  if (!replaced) out.push(make());
  const before = lines.slice(0, first).filter((l) => !NOT_RUN.test(l.trim()));
  const after = lines.slice(last + 1);
  return { description: editSection(description, heading, { replace: [...before, ...out, ...after].join("\n").trim() }), heading, replaced };
}

// ---- evidence sources --------------------------------------------------------------------------------------------------------

export async function evidenceFromBuild(client: AdoClient, id: number, label: string): Promise<Evidence> {
  const b = await client.get<{ id: number; buildNumber?: string; status?: string; result?: string; startTime?: string; finishTime?: string; definition?: { name?: string }; _links?: { web?: { href?: string } } }>(`build/builds/${id}`);
  if (b.status !== "completed") throw new AihubError(`run ${id} is still ${b.status ?? "unknown"}: only a finished run can be recorded as a test result (aihub pipeline follow --run ${id})`);
  const result: Outcome = b.result === "succeeded" ? "pass" : b.result === "partiallySucceeded" ? "partial" : "fail";
  const url = b._links?.web?.href ?? `${client.remote.orgUrl}/${encodeURIComponent(client.remote.project)}/_build/results?buildId=${id}`;
  const ms = b.startTime && b.finishTime ? Date.parse(b.finishTime) - Date.parse(b.startTime) : undefined;
  let detail: string | undefined;
  try {
    const runs = await client.get<{ value?: { totalTests?: number; passedTests?: number }[] }>("test/runs", { buildUri: `vstfs:///Build/Build/${id}` });
    const total = (runs.value ?? []).reduce((a, r) => a + (r.totalTests ?? 0), 0);
    const passed = (runs.value ?? []).reduce((a, r) => a + (r.passedTests ?? 0), 0);
    if (total > 0) detail = `${passed}/${total} tests`;
  } catch {
    /* no test run data: the build result stands alone */
  }
  return { name: `${label ? `${label} ` : ""}${b.definition?.name ?? "pipeline"} #${b.buildNumber ?? id}`.trim(), result, link: url, durationMs: ms, detail };
}

export async function evidenceFromFabricJob(ctx: Ctx, ref: string): Promise<Evidence> {
  const [wsName, itemName, jobId] = ref.split("/");
  if (!wsName || !itemName || !jobId) throw new AihubError("--from-fabric-job takes <workspace>/<item>/<job id>");
  const { makeClient } = await import("../commands/fabric.js");
  const client = makeClient(ctx, {});
  const ws = (await client.workspaces()).find((w) => w.displayName.toLowerCase() === wsName.toLowerCase() || w.id.toLowerCase() === wsName.toLowerCase());
  if (!ws) throw new AihubError(`workspace '${wsName}' not found`);
  const item = await client.resolveItem(ws.id, itemName);
  const job = await client.jobStatus(ws.id, item.id, jobId);
  const st = String(job.status ?? "").toLowerCase();
  if (!["completed", "failed", "cancelled", "deduped"].includes(st)) throw new AihubError(`job ${jobId} is still ${job.status ?? "unknown"}: only a finished job can be recorded as a test result`);
  const ms = job.startTimeUtc && job.endTimeUtc ? Date.parse(`${job.endTimeUtc.replace(/Z?$/, "Z")}`) - Date.parse(`${job.startTimeUtc.replace(/Z?$/, "Z")}`) : undefined;
  return {
    name: `Fabric ${item.type ?? "job"} ${item.displayName}`,
    result: st === "completed" ? "pass" : "fail",
    link: `https://app.fabric.microsoft.com/groups/${ws.id}/list?experience=data-engineering`,
    durationMs: ms,
    detail: `${ws.displayName}, job ${jobId.slice(0, 8)}${st !== "completed" ? `, ${job.failureReason?.errorCode ?? st}` : ""}`,
  };
}

export interface TestsAddOpts {
  pr?: string;
  fromRun?: string;
  fromRobot?: string;
  fromFabricJob?: string;
  name?: string;
  json?: boolean;
}

export async function prTestsAdd(ctx: Ctx, o: TestsAddOpts): Promise<string> {
  const given = [o.fromRun, o.fromRobot, o.fromFabricJob].filter(Boolean);
  if (given.length !== 1) throw new AihubError("pass exactly one of --from-run <build id>, --from-robot <build id> or --from-fabric-job <workspace>/<item>/<job>");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const pr = await resolvePr(ctx, client, root, o.pr);
  let ev: Evidence;
  if (o.fromFabricJob) ev = await evidenceFromFabricJob(ctx, o.fromFabricJob);
  else {
    const id = Number(o.fromRun ?? o.fromRobot);
    if (!Number.isInteger(id) || id <= 0) throw new AihubError("the run id must be a number (see aihub pipeline runs)");
    ev = await evidenceFromBuild(client, id, o.fromRobot ? "Robot" : "");
  }
  if (o.name) ev.name = o.name;
  const full = await getPr(client, pr.pullRequestId);
  const out = addTestRow(full.description ?? "", ev, (team as { language?: string }).language);
  checkDescriptionLength(out.description);
  await client.patch(`${client.repoPath()}/pullrequests/${pr.pullRequestId}`, { description: out.description });
  return o.json
    ? JSON.stringify({ pr: pr.pullRequestId, section: out.heading, replaced: out.replaced, evidence: ev })
    : `PR !${pr.pullRequestId}: test row ${out.replaced ? "refreshed" : "added"} in '${out.heading}': ${ev.name}: ${ev.result}${ev.detail ? ` (${ev.detail})` : ""}, ${duration(ev.durationMs)}, ${ev.link}`;
}
