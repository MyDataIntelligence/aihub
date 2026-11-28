import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import type { Lang } from "./e2e/criteria.js";
import { checkActionSections } from "./prActions.js";
import { checkNoise } from "./prNoise.js";
import type { TeamConfig } from "./team.js";
import { compose, emptyFor, parseSections, type CodeValues, type ResolvedTemplate } from "./templates.js";

/**
 * The one rule for a pull request description, for `aihub pr create` and for a pull request made without a clone (Change
 * with Agent): the team template, the author's text (a summary goes into the first section), the values only code knows
 * (story link, commits, linked PRs), honest fallbacks for Changes and Tests, no technical noise, the action sections checked,
 * and for a story its acceptance criteria with their test status. Whether unproven criteria stop the PR is the caller's call.
 */
export interface DescribeInput {
  tpl: ResolvedTemplate | undefined;
  /** markdown with `##` sections written by the author (or the agent) */
  given: string;
  /** short prose for the first section of the template */
  summaryText?: string;
  code: CodeValues;
  fallback: { changes?: string; tests?: string };
  /** keep sections that are not in the template and skip the checks */
  asIs?: boolean;
  /** the story: its criteria table goes in */
  storyId?: number;
  /** without a template: what follows the body */
  plainExtra?: string;
  /** the text checked for technical noise (default: given with the summary); pr create checks the author's text, not woven notes */
  noiseText?: string;
}

export interface Described {
  description: string;
  filled: { heading: string; by: string }[];
  dropped: string[];
  emptyText: string;
  criteria?: { status: import("./e2e/workitem.js").CriteriaStatus; lang: Lang };
}

export async function describePr(ctx: Ctx, client: AdoClient, team: TeamConfig, o: DescribeInput): Promise<Described> {
  const headings = o.tpl ? parseSections(o.tpl.content).sections.map((s) => s.heading) : [];
  let given = o.given;
  if (o.summaryText?.trim()) {
    const first = headings[0];
    given = first ? `## ${first}\n${o.summaryText.trim()}\n\n${given}` : `${o.summaryText.trim()}\n\n${given}`;
  }
  const emptyText = emptyFor(team);
  let description: string;
  let filled: Described["filled"] = [];
  let dropped: string[] = [];
  if (o.tpl) {
    const c = compose({ template: o.tpl.content, body: given, code: o.code, emptyText, fallback: o.fallback, dropExtra: !o.asIs });
    description = c.text;
    filled = c.filled;
    dropped = c.dropped;
  } else {
    description = [given.trim(), o.plainExtra ?? ""].filter(Boolean).join("\n\n") + "\n";
  }
  if (!o.asIs) checkNoise(o.noiseText ?? given, "created");
  if (!o.asIs) checkActionSections({ description, configured: team.pullRequest?.actionSections, emptyText, template: o.tpl?.content, verb: "created" });
  let criteria: Described["criteria"];
  if (o.storyId) {
    const ps = await import("./e2e/prSection.js");
    criteria = await ps.prCriteria(ctx, client, o.storyId, team.language as string | undefined).catch(() => undefined);
    if (criteria) description = ps.withCriteria(description, criteria.status, criteria.lang);
  }
  return { description, filled, dropped, emptyText, ...(criteria ? { criteria } : {}) };
}

/** "Not run yet." in the team language. */
export const notRunYet = (team: TeamConfig) => (String(team.language ?? "").toLowerCase() === "nl" ? "Nog niet uitgevoerd." : "Not run yet.");
