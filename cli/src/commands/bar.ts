import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { memoGitReads } from "../lib/git.js";

/**
 * aihub bar --json [--fabric] [--events N]: everything the VS Code status bar shows, in one process: status, the checks
 * of the active PR, (with --fabric) the failures and logs of the branch's Fabric workspace, whether a watch of mine runs,
 * and the newest watch events. Each part is the JSON of its own command; a part that fails carries `{ error, kind }`
 * and the rest still arrives.
 */

type Part = { ok: true; json: any } | { ok: false; error: string };

/** Fabric answers that stay true until the branch or the configuration changes: the caller may stop asking. */
export function fabricErrorKind(message: string): "no-workspace" | "not-signed-in" | "failed" {
  if (/no single workspace|no workspace|branchWorkspacePrefixes|not a Fabric/i.test(message)) return "no-workspace";
  if (/not signed in|az login|AIHUB_FABRIC_TOKEN/i.test(message)) return "not-signed-in";
  return "failed";
}

async function read(args: string[], ctx: Ctx): Promise<Part> {
  const { main } = await import("../router.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, "--json"], { ...ctx, out: (l) => out.push(l), err: (l) => err.push(l) });
  if (code !== 0) return { ok: false, error: err.join(" ").replace(/^aihub: /, "").trim() || `aihub ${args.join(" ")} exited with ${code}` };
  const text = out.join("\n").trim();
  const start = text.search(/[[{]/);
  try {
    return { ok: true, json: JSON.parse(start > 0 ? text.slice(start) : text) };
  } catch {
    return { ok: false, error: `aihub ${args.join(" ")} did not print JSON` };
  }
}

const value = (p: Part) => (p.ok ? p.json : { error: p.error });

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  // bar changes nothing: its parts share one answer per git read (root, branch, remote) instead of asking git again each
  memoGitReads(true);
  try {
    await readBar(argv, ctx);
  } finally {
    memoGitReads(false);
  }
}

async function readBar(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { json: { type: "boolean" }, fabric: { type: "boolean" }, events: { type: "string" } }).values;
  const status = await read(["status"], ctx);
  if (!status.ok) {
    ctx.out(JSON.stringify({ status: { error: status.error } }));
    return;
  }
  const s = status.json as { signedIn?: boolean; branch?: string; pr?: { id: number; status: string } | null };
  const active = s.signedIn !== false && s.pr && s.pr.status === "active" ? s.pr : null;
  const fabric = async () => {
    const failures = await read(["fabric", "failures"], ctx);
    if (!failures.ok) return { error: failures.error, kind: fabricErrorKind(failures.error) };
    const ws = (failures.json?.workspace ?? failures.json?.data?.workspace) as string | undefined;
    const logs = ws ? await read(["fabric", "logs", "--workspace", ws, "--since", "24h", "--top", "8"], ctx) : undefined;
    return { failures: failures.json, logs: logs?.ok ? logs.json : undefined };
  };
  const [checks, fab, watch, events] = await Promise.all([
    active ? read(["pr", "checks", "--pr", String(active.id)], ctx).then(value) : null,
    v.fabric ? fabric() : null,
    read(["watch", "list"], ctx),
    read(["watch", "events", "--limit", String(Number(v.events) || 5)], ctx),
  ]);
  ctx.out(
    JSON.stringify({
      status: s,
      checks,
      fabric: fab,
      watching: watch.ok ? (watch.json as { mine?: boolean }[]).some((w) => w.mine) : null,
      events: events.ok ? events.json : [],
    }),
  );
}
