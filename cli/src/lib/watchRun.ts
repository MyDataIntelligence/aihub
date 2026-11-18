import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { makeClient } from "../commands/fabric.js";
import { eventUrl, storeEvent } from "./open.js";
import { summarize, type Build } from "./robot.js";
import { loadTeam } from "./team.js";
import { logEvent, osNotify, type Notifier, type WatchSpec } from "./watch.js";
import { isProtected } from "./workitems.js";

/**
 * `aihub watch --run <id> | --robot <build> | --fabric-job <workspace/item/job>`: follow one long run in the background
 * (detached like `watch --mine`) and tell the user the result with a toast. A failed run on a feature branch gets the Fix
 * button (`/fix ...` in the chat with the aihub agent). The agent says "I follow it in the background" instead of blocking.
 */
export type RunTarget = { kind: "run" | "robot"; build: number } | { kind: "fabric"; workspace: string; item: string; job: string };

export const targetLabel = (t: RunTarget): string => (t.kind === "fabric" ? `Fabric job ${t.workspace}/${t.item}/${t.job}` : `${t.kind === "robot" ? "Robot build" : "run"} ${t.build}`);

export function sameTarget(a: RunTarget | undefined, b: RunTarget): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "fabric" ? JSON.stringify(a) === JSON.stringify(b) : a.build === (b as { build: number }).build;
}

/** `--fabric-job ws/item/job`: three parts, a name may not contain a slash. */
export function parseFabricJob(s: string): RunTarget {
  const parts = s.split("/").map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !p)) throw new AihubError("--fabric-job needs <workspace>/<item>/<job id> (the id that 'aihub fabric run' printed)");
  return { kind: "fabric", workspace: parts[0], item: parts[1], job: parts[2] };
}

export interface RunWatchDeps {
  notifier?: Notifier;
  /** Test hook: how a Fabric job is read (default: the Fabric REST client). */
  fabricJob?: (t: Extract<RunTarget, { kind: "fabric" }>) => Promise<{ status: string; failure?: string }>;
}

interface Outcome {
  message: string;
  failed: boolean;
  /** `/fix ...` prompt for the chat, when a fix makes sense. */
  fix?: string;
}

const FABRIC_DONE = /^(completed|failed|cancelled|canceled|deduped)$/i;

async function fabricStatus(ctx: Ctx, t: Extract<RunTarget, { kind: "fabric" }>): Promise<{ status: string; failure?: string }> {
  const client = makeClient(ctx);
  const ws = await client.workspaceId({ name: t.workspace, environment: "DEV" } as never);
  const item = await client.resolveItem(ws, t.item);
  const j = await client.jobStatus(ws, item.id, t.job);
  return { status: j.status, failure: j.failureReason?.message };
}

export async function runTargetWatch(ctx: Ctx, spec: WatchSpec, deps: RunWatchDeps = {}): Promise<{ reason: string; outcome?: string }> {
  const target = spec.target;
  if (!target) throw new AihubError("this watch has no run to follow");
  const { root, client } = repoClient(ctx);
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notifier = deps.notifier ?? osNotify;
  const team = loadTeam(root);
  const start = now();
  let failures = 0;
  const finish = async (o: Outcome) => {
    logEvent(root, now(), `run/${targetLabel(target).replace(/\s+/g, "-")}`, o.message);
    const id = `${spec.id}-done`;
    storeEvent(ctx.env, { id, repo: spec.repo ?? root, client: spec.client, session: spec.session, message: o.message, prompt: o.fix ?? `${o.message} — ga verder`, agent: o.fix ? "aihub" : undefined, at: now() });
    if (spec.notify && !(await notifier("aihub", o.message, { label: o.fix ? "Fix" : "Open", url: eventUrl(id) }))) ctx.out(`${o.message}\n  open it with: aihub open --event ${id}`);
    return { reason: o.failed ? "failed" : "done", outcome: o.message };
  };
  for (;;) {
    try {
      if (target.kind === "fabric") {
        const j = await (deps.fabricJob ?? ((t) => fabricStatus(ctx, t)))(target);
        if (FABRIC_DONE.test(j.status)) {
          const failed = /^(failed)$/i.test(j.status);
          const label = targetLabel(target);
          return await finish({ failed, message: `${label} ${j.status.toLowerCase()}${j.failure ? `: ${j.failure.replace(/\s+/g, " ").slice(0, 160)}` : ""}`, fix: failed ? `/fix fabric ${target.workspace}/${target.item}/${target.job}` : undefined });
        }
      } else {
        const b = await client.get<Build & { sourceBranch?: string; definition?: { name?: string } }>(`build/builds/${target.build}`);
        failures = 0;
        if (b.status === "completed") {
          const failed = b.result !== "succeeded";
          const branch = (b.sourceBranch ?? "").replace(/^refs\/heads\//, "");
          const url = b._links?.web?.href ?? `${client.remote.orgUrl}/${encodeURIComponent(client.remote.project)}/_build/results?buildId=${b.id}`;
          const head = `${targetLabel(target)} (${b.definition?.name ?? b.buildNumber ?? ""}) ${b.result ?? "completed"}${branch ? ` on ${branch}` : ""}`.replace("  ", " ");
          let message = head;
          if (target.kind === "robot") message = (await summarize(client, b).catch(() => head)).split("\n").slice(0, 4).join(" | ");
          // never a Fix for a protected branch, a PR merge build or a build that was only cancelled
          const fixable = failed && b.result !== "canceled" && !!branch && !b.sourceBranch?.startsWith("refs/pull/") && !isProtected(team, branch);
          return await finish({ failed, message, fix: fixable ? `/fix ${url}` : undefined });
        }
      }
      failures = 0;
    } catch (e) {
      if (++failures >= 5) return await finish({ failed: true, message: `watch of ${targetLabel(target)} stopped: ${(e as Error).message}` });
    }
    if (now() - start >= spec.timeoutMs) return await finish({ failed: false, message: `${targetLabel(target)} is still running after ${Math.round(spec.timeoutMs / 60000)} min; the watch stopped (start another with aihub watch ...)` }).then((r) => ({ ...r, reason: "timeout" }));
    await sleep(spec.intervalMs);
  }
}
