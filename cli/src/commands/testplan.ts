import { AihubError } from "../lib/errors.js";
import type { Ctx } from "../lib/context.js";
import { devopsClient, flags } from "../lib/devops.js";
import { TESTPLAN_USAGE, cases, createCase, createPlan, createSuite, outcome, plans, points, results, runs, suites } from "../lib/testplanAdmin.js";

/** aihub testplan plans|suites|cases|points|outcome|runs|results|create-plan|create-suite|create-case */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = flags(rest, {
    plan: { type: "string" },
    suite: { type: "string" },
    point: { type: "string" },
    to: { type: "string" },
    build: { type: "string" },
    run: { type: "string" },
    all: { type: "boolean" },
    name: { type: "string" },
    area: { type: "string" },
    iteration: { type: "string" },
    parent: { type: "string" },
    title: { type: "string" },
  });
  const { client } = devopsClient(ctx, v);
  switch (sub) {
    case "plans":
      return plans(client, ctx, v);
    case "suites":
      return suites(client, ctx, v);
    case "cases":
      return cases(client, ctx, v);
    case "points":
      return points(client, ctx, v);
    case "outcome":
      return outcome(client, ctx, v);
    case "runs":
      return runs(client, ctx, v);
    case "results":
      return results(client, ctx, v);
    case "create-plan":
      return createPlan(client, ctx, v);
    case "create-suite":
      return createSuite(client, ctx, v);
    case "create-case":
      return createCase(client, ctx, v);
  }
  throw new AihubError(`usage: ${TESTPLAN_USAGE}`);
}
