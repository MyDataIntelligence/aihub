import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { devopsClient, flags, need, requireFlag } from "../lib/devops.js";
import { posInt } from "../lib/cliargs.js";
import { cases, createCase, createPlan, createSuite, deletePlan, deleteSuite, outcome, plans, points, results, runs, suites } from "../lib/testplan.js";

export const USAGE =
  "aihub testplan plans | suites --plan P | cases --plan P --suite N | points --plan P --suite N [--outcome failed] | outcome --plan P --suite N --points a,b --outcome passed|failed|blocked|notApplicable|inconclusive|notExecuted | runs [--build N] | results --run N [--outcome Failed|Passed] | create-plan --name n [--area a --iteration i] | create-suite --plan P --name n [--parent id] | create-case --plan P --suite N --title t [--steps s] | delete-suite --plan P --suite N --yes | delete-plan --plan P --yes";

/** Azure Test Plans: plans, suites, cases, points and outcomes, test runs and results. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const s = need(sub, ["plans", "suites", "cases", "points", "outcome", "runs", "results", "create-plan", "create-suite", "create-case", "delete-suite", "delete-plan"], USAGE);
  const v = flags(rest, {
    plan: { type: "string" },
    suite: { type: "string" },
    points: { type: "string" },
    outcome: { type: "string" },
    build: { type: "string" },
    run: { type: "string" },
    name: { type: "string" },
    title: { type: "string" },
    steps: { type: "string" },
    parent: { type: "string" },
    area: { type: "string" },
    iteration: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
  });
  const { client } = devopsClient(ctx, v);
  const plan = () => requireFlag(v, "plan", "a test plan name or id");
  const suite = () => posInt(v.suite, "--suite");
  switch (s) {
    case "plans":
      return plans(client, ctx, v);
    case "suites":
      return suites(client, ctx, v, plan());
    case "cases":
      return cases(client, ctx, v, plan(), suite());
    case "points":
      return points(client, ctx, v, plan(), suite());
    case "outcome":
      return outcome(client, ctx, v, plan(), suite());
    case "runs":
      return runs(client, ctx, v);
    case "results":
      return results(client, ctx, v, posInt(v.run, "--run"));
    case "create-plan":
      return createPlan(client, ctx, v);
    case "create-suite":
      return createSuite(client, ctx, v, plan());
    case "create-case":
      return createCase(client, ctx, v, plan(), suite());
    case "delete-suite":
      return deleteSuite(client, ctx, v, plan(), suite());
    case "delete-plan":
      return deletePlan(client, ctx, v, plan());
  }
  throw new AihubError(`usage: ${USAGE}`);
}
