import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { confirmDelete, devopsClient, flags, requireFlag } from "../lib/devops.js";
import { posInt } from "../lib/cliargs.js";
import { approvalsDecide, approvalsList, artifacts, cancel, connections, defCreate, defDelete, defList, defShow, defUpdate, envChecks, envCreate, envDelete, envDeployments, envList, envShow, secureFiles, validate } from "../lib/pipelineAdmin.js";

export const PIPELINE_ADMIN_SUBS = ["def", "validate", "cancel", "artifacts", "env", "approvals", "securefiles", "connections"];

export const USAGE =
  "aihub pipeline def list|show|create|update|delete [--pipeline P] | validate --pipeline P [--file f.yml] [--branch b] [--show-yaml] | cancel --run N | artifacts list|download --run N [--artifact a --out dir] | env list|show|create|delete|deployments|checks [--env E] | approvals list|approve|reject [--approval id] | securefiles list | connections list|show [--name N]";

/** Pipeline administration: definitions, YAML validation, cancel, artifacts, environments, approvals, secure files, service connections. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  const grouped = ["def", "artifacts", "env", "approvals", "securefiles", "connections"].includes(sub);
  const action = grouped ? r1[0] : undefined;
  const rest = grouped ? r1.slice(1) : r1;
  if (grouped && !action) throw new AihubError(`usage: ${USAGE}`);
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
      return validate(client, ctx, v, requireFlag(v, "pipeline", "a pipeline name or id"));
    case "cancel":
      return cancel(client, ctx, v, posInt(v.run, "--run"));
    case "artifacts":
      if (action === "list" || action === "download") return artifacts(client, ctx, v, action, posInt(v.run, "--run"));
      break;
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
