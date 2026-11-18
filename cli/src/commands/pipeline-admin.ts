import { repoClient, type Ctx } from "../lib/context.js";
import { parse as parseYaml } from "yaml";
import { join } from "node:path";
import { readUtf8, TEAM_FILE, type TeamConfig } from "../lib/team.js";
import { authorize, compare, coverage, scheduleList, tests, timeline, triggerShow, vars } from "../lib/pipelineInsight.js";
import { AihubError } from "../lib/errors.js";
import { confirmDelete, devopsClient, flags, requireFlag } from "../lib/devops.js";
import { posInt } from "../lib/cliargs.js";
import { approvalsDecide, approvalsList, artifacts, cancel, connections, defCreate, defDelete, defList, defShow, defUpdate, envChecks, envCreate, envDelete, envDeployments, envList, envShow, pipelineForFile, secureFiles, validate } from "../lib/pipelineAdmin.js";

export const PIPELINE_ADMIN_SUBS = ["def", "validate", "expand", "cancel", "artifacts", "env", "approvals", "securefiles", "connections", "timeline", "tests", "coverage", "vars", "compare", "schedule", "trigger", "authorize"];

export const USAGE =
  "aihub pipeline def list|show|create|update|delete [--pipeline P] | validate|expand [--pipeline P] [--file f.yml] [--branch b] [--show-yaml] | timeline --run N [--tasks|--failed] | tests --run N [--history 5] | coverage --run N | vars --run N | compare --run A --with B | schedule list | trigger show --pipeline P | authorize --pipeline P --resource environment:dev|variablegroup:vg|endpoint:n|securefile:f [--revoke] | cancel --run N | artifacts list|download --run N [--artifact a --out dir] | env list|show|create|delete|deployments|checks [--env E] | approvals list|approve|reject [--approval id] | securefiles list | connections list|show [--name N]";

/** Pipeline administration: definitions, YAML validation, cancel, artifacts, environments, approvals, secure files, service connections. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  const grouped = ["def", "artifacts", "env", "approvals", "securefiles", "connections", "schedule", "trigger"].includes(sub);
  // artifacts may be written without an action: `pipeline artifacts --run N [--download name]`
  const noAction = sub === "artifacts" && (r1[0] === undefined || r1[0].startsWith("--"));
  const action = grouped && !noAction ? r1[0] : undefined;
  const rest = grouped && !noAction ? r1.slice(1) : r1;
  if (grouped && !noAction && !action) throw new AihubError(`usage: ${USAGE}`);
  const v = flags(rest, {
    pipeline: { type: "string" },
    name: { type: "string" },
    folder: { type: "string" },
    yaml: { type: "string" },
    status: { type: "string" },
    file: { type: "string" },
    branch: { type: "string" },
    "show-yaml": { type: "boolean" },
    run: { type: "string" },
    artifact: { type: "string" },
    out: { type: "string" },
    env: { type: "string" },
    description: { type: "string" },
    approval: { type: "string" },
    state: { type: "string" },
    comment: { type: "string" },
    download: { type: "string" },
    with: { type: "string" },
    tasks: { type: "boolean" },
    failed: { type: "boolean" },
    warnings: { type: "boolean" },
    history: { type: "string" },
    resource: { type: "string" },
    revoke: { type: "boolean" },
  });
  const { client } = devopsClient(ctx, v);
  const pipelineRef = () => requireFlag(v, "pipeline", "a pipeline name or id");
  const envRef = () => requireFlag(v, "env", "an environment name or id");
  switch (sub) {
    case "def":
      if (action === "list") return defList(client, ctx, v);
      if (action === "show") return defShow(client, ctx, v, pipelineRef());
      if (action === "create") return defCreate(client, ctx, v);
      if (action === "update") return defUpdate(client, ctx, v, pipelineRef());
      if (action === "delete") {
        confirmDelete(v, `pipeline '${v.pipeline ?? ""}'`);
        return defDelete(client, ctx, v, pipelineRef());
      }
      break;
    case "validate":
    case "expand": {
      if (sub === "expand") v["show-yaml"] = true;
      const { root } = repoClient(ctx);
      const ref = typeof v.pipeline === "string" && v.pipeline ? v.pipeline : await pipelineForFile(client, root, typeof v.file === "string" ? v.file : undefined);
      let conventions: { name?: string; requiredTemplates?: string[] }[] = [];
      try {
        const team = parseYaml(readUtf8(join(root, TEAM_FILE))) as TeamConfig; // only the conventions are read here, a team file that fails other checks must not stop a validation
        conventions = team.pipelines ?? [];
      } catch {
        conventions = [];
      }
      return validate(client, ctx, v, ref, conventions);
    }
    case "timeline":
      return timeline(client, ctx, v, posInt(v.run, "--run"));
    case "tests":
      return tests(client, ctx, v, posInt(v.run, "--run"));
    case "coverage":
      return coverage(client, ctx, v, posInt(v.run, "--run"));
    case "vars":
      return vars(client, ctx, v, posInt(v.run, "--run"));
    case "compare":
      return compare(client, ctx, v, posInt(v.run, "--run"), posInt(v.with, "--with"));
    case "authorize":
      return authorize(client, ctx, v);
    case "schedule":
      if (action === "list") return scheduleList(client, ctx, v);
      break;
    case "trigger":
      if (action === "show") return triggerShow(client, ctx, v, requireFlag(v, "pipeline", "a pipeline name or id"));
      break;
    case "cancel":
      return cancel(client, ctx, v, posInt(v.run, "--run"));
    case "artifacts":
      return artifacts(client, ctx, v, action ?? (typeof v.download === "string" ? "download" : "list"), posInt(v.run, "--run"));
    case "env":
      if (action === "list") return envList(client, ctx, v);
      if (action === "create") return envCreate(client, ctx, v);
      if (action === "show") return envShow(client, ctx, v, envRef());
      if (action === "delete") return envDelete(client, ctx, v, envRef());
      if (action === "deployments") return envDeployments(client, ctx, v, envRef());
      if (action === "checks") return envChecks(client, ctx, v, envRef());
      break;
    case "approvals":
      if (action === "list") return approvalsList(client, ctx, v);
      if (action === "approve" || action === "reject") return approvalsDecide(client, ctx, v, requireFlag(v, "approval", "an approval id from: aihub pipeline approvals list"), action === "approve");
      break;
    case "securefiles":
      if (action === "list") return secureFiles(client, ctx, v);
      break;
    case "connections":
      if (action === "list") return connections(client, ctx, v);
      if (action === "show") return connections(client, ctx, v, requireFlag(v, "name", "a service connection name"));
      break;
  }
  throw new AihubError(`usage: ${USAGE}`);
}
