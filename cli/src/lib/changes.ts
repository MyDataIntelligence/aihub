import { AihubError } from "./errors.js";
import { git, hasRef, originDefaultBranch } from "./git.js";
import type { TeamConfig } from "./team.js";

/** Files changed on `branch` (default HEAD) compared with the target branch (merge-base diff). */
export function changedFiles(
  cwd: string,
  team: TeamConfig,
  opts: { branch?: string; target?: string } = {},
): { files: string[]; target: string; branch: string } {
  const target = opts.target ?? team.repositories?.[0]?.defaultTarget ?? (originDefaultBranch(cwd) || "main");
  const branch = opts.branch ?? "HEAD";
  const tref = hasRef(cwd, `origin/${target}`) ? `origin/${target}` : target;
  if (!hasRef(cwd, tref)) throw new AihubError(`target branch '${target}' not found; fetch it or pass --target`);
  const bref = branch !== "HEAD" && !hasRef(cwd, branch) && hasRef(cwd, `origin/${branch}`) ? `origin/${branch}` : branch;
  const out = git(cwd, ["diff", "--name-only", `${tref}...${bref}`]);
  const label = branch === "HEAD" ? git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() || "HEAD" : branch;
  return { files: out.split("\n").map((s) => s.trim()).filter(Boolean), target, branch: label };
}
