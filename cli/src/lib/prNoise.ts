import { AihubError } from "./errors.js";
import { VAGUE_ACTIONS_EXIT } from "./prActions.js";
import { codeKindOf, parseSections } from "./templates.js";

/** Exit code of a refused description: the text holds process noise a reviewer does not need. Same code as a vague section: fix the text, or pass --as-is. */
export class NoisyTextError extends AihubError {
  readonly exitCode = VAGUE_ACTIONS_EXIT;
  constructor(
    message: string,
    readonly lines: string[],
  ) {
    super(message);
    this.name = "NoisyTextError";
  }
}

/** Counts of unit tests, test-runner names and the like: how the author checked, not what the reviewer must know. */
const TEST_COUNT = [
  /\b\d+\s+(?:\w+\s+){0,2}tests?\s+(?:passed|pass|passing|green|ran|run|succeeded|executed|geslaagd|groen)\b/i,
  /\b\d+\s+(?:\w+\s+){0,2}(?:unit|focused|automated|vitest|pytest|jest)\s+tests?\b/i,
  /\b\d+\s*\/\s*\d+\s+tests?\b/i,
  /\b\d+\s+(?:passed|geslaagd)\b.*\b\d*\s*(?:failed|skipped|mislukt)\b/i,
  /\b(?:all\s+)?unit[- ]?tests?\s+(?:passed|pass|green|geslaagd|groen)\b/i,
  /\b(?:vitest|pytest|jest|npm test|dotnet test|pester)\b.*\b(?:passed|green|geslaagd|groen)\b/i,
];

/** Problems of the author's own machine or run: PATH, missing tools, hooks, isolation, runs that were started without an outcome. */
const ENVIRONMENT = [
  /\b(?:not|niet)\b[^.\n]{0,30}\b(?:on|in|op)\s+(?:the\s+|het\s+)?PATH\b/i,
  /\bPATH\b[^.\n]{0,30}\b(?:missing|not set|ontbreekt)\b/i,
  /\b(?:command not found|is not installed|was not installed|niet geinstalleerd|niet ge\u00efnstalleerd)\b/i,
  /\bcould(?: not|n't) (?:be )?run\b|\bkon niet (?:draaien|worden uitgevoerd)\b/i,
  /\bpre-?push\b[^.\n]{0,60}\b(?:run|hook|check)\b/i,
  /\b(?:git[- ])?environment (?:isolation )?(?:problems?|issues?)\b|\bisolation problems?\b|\bomgevingsproblem\w*/i,
  /\b(?:started|queued|triggered|gestart)\b[^.\n]{0,60}\b(?:result|outcome|uitkomst|resultaat)\b[^.\n]{0,30}\b(?:unknown|not (?:yet )?known|pending|onbekend)\b/i,
  /\b(?:coordinator|hand-?over|sub-?agents?|agent team|coordination)\b/i,
];

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

/** The offending lines of a text written by the author (the CLI's own sections, such as the commit list, are not checked). */
export function noisyLines(text: string): string[] {
  const parts = parseSections(text);
  const bodies = [parts.preamble, ...parts.sections.filter((s) => !codeKindOf(s.heading)).map((s) => s.body)];
  const out: string[] = [];
  for (const b of bodies)
    for (const raw of stripComments(b).split("\n")) {
      const l = raw.trim();
      if (l && [...TEST_COUNT, ...ENVIRONMENT].some((re) => re.test(l))) out.push(l);
    }
  return out;
}

/** Throws a NoisyTextError (short) when the text holds unit-test counts, environment problems or internal coordination. */
export function checkNoise(text: string, verb: "created" | "updated"): void {
  const bad = noisyLines(text);
  if (!bad.length) return;
  const shown = bad.slice(0, 3).map((l) => `"${l.length > 70 ? l.slice(0, 67) + "..." : l}"`);
  throw new NoisyTextError(
    `PR not ${verb}: ${bad.length} line(s) are process noise: ${shown.join("; ")}. A reviewer needs what changes and why, and the functional tests that were really done with their result (or "not run yet"); leave out unit-test counts, pre-push or environment problems, tools that could not run, runs without an outcome and internal coordination. Only when the user says so: --as-is`,
    bad,
  );
}
