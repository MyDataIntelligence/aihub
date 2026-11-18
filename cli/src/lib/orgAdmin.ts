import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, table, top, type Flags } from "./devops.js";

/** Organisation-level reads: projects, teams, dashboards, notification subscriptions, agent pools, permissions. Nothing here writes. */
async function orgList<T = any>(c: AdoClient, path: string, query: Record<string, string | number> = {}): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  for (let i = 0; i < 20; i++) {
    const r: { data: { value?: T[] }; headers: Headers } = await c.request("GET", path, { orgLevel: true, query: { "api-version": "7.1", ...query, ...(token ? { continuationToken: token } : {}) } });
    out.push(...(r.data.value ?? []));
    token = r.headers.get("x-ms-continuationtoken");
    if (!token) break;
  }
  return out;
}

export async function projects(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await orgList<{ id: string; name: string; state?: string; description?: string }>(c, "projects", { $top: top(v, 100) });
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = all.filter((p) => !f || p.name.toLowerCase().includes(f));
  emit(ctx, v, rows, rows.length ? table([["project", "state", "description"], ...rows.map((p) => [p.name, p.state ?? "", cut(p.description, 60)])]) : "no projects match");
}

export async function teams(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await orgList<{ id: string; name: string; description?: string }>(c, `projects/${encode(c.remote.project)}/teams`, { $top: top(v, 100) });
  if (typeof v.members === "string") {
    const t = all.find((x) => x.name.toLowerCase() === String(v.members).toLowerCase() || x.id === v.members);
    if (!t) throw new AihubError(`team '${v.members}' not found; teams: ${all.map((x) => x.name).join(", ")}`);
    const m = await orgList<{ identity?: { displayName?: string; uniqueName?: string }; isTeamAdmin?: boolean }>(c, `projects/${encode(c.remote.project)}/teams/${t.id}/members`);
    const rows = m.map((x) => ({ name: x.identity?.displayName, user: x.identity?.uniqueName, admin: !!x.isTeamAdmin }));
    return emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.name} <${x.user}>${x.admin ? " (admin)" : ""}`).join("\n") : `team '${t.name}' has no members`);
  }
  emit(ctx, v, all, all.length ? table([["team", "description"], ...all.map((t) => [t.name, cut(t.description, 70)])]) : "no teams");
}

export async function dashboards(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.request<{ dashboardEntries?: any[]; value?: any[] }>("GET", `dashboard/dashboards`, { query: { "api-version": "7.1-preview.3" } }).catch(() => undefined);
  const list = r?.data.dashboardEntries ?? r?.data.value ?? [];
  if (v.show && typeof v.show === "string") {
    const d = list.find((x) => x.name?.toLowerCase() === String(v.show).toLowerCase() || x.id === v.show);
    if (!d) throw new AihubError(`dashboard '${v.show}' not found; dashboards: ${list.map((x) => x.name).join(", ")}`);
    const full = await c.get<any>(`dashboard/dashboards/${d.id}`, { "api-version": "7.1-preview.3" });
    const widgets = (full.widgets ?? []).map((w: any) => ({ name: w.name, type: w.contributionId }));
    return emit(ctx, v, { name: d.name, widgets }, [`${d.name} (${widgets.length} widget(s))`, ...widgets.map((w: { name: string; type: string }) => `  ${w.name} [${w.type}]`)].join("\n"));
  }
  emit(ctx, v, list.map((d) => ({ id: d.id, name: d.name, widgets: d.widgets?.length })), list.length ? list.map((d) => `${d.name}${d.widgets ? ` (${d.widgets.length} widgets)` : ""}`).join("\n") : "no dashboards");
}

export async function subscriptions(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const me = (await c.getOrg<{ authenticatedUser?: { id?: string } }>("connectionData")).authenticatedUser?.id;
  const all = await orgList<{ id: string; description?: string; status?: string; subscriber?: { displayName?: string }; channel?: { type?: string } }>(c, "notification/subscriptions", { ...(me && !v.all ? { targetId: me } : {}), $top: top(v, 100) });
  const rows = all.map((s) => ({ id: s.id, description: s.description, status: s.status, channel: s.channel?.type, subscriber: s.subscriber?.displayName }));
  emit(ctx, v, rows, rows.length ? table([["description", "status", "channel", "subscriber"], ...rows.map((s) => [cut(s.description, 60), s.status ?? "", s.channel ?? "", s.subscriber ?? ""])]) : "no notification subscriptions");
}

export async function pools(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await orgList<{ id: number; name: string; isHosted?: boolean; size?: number; poolType?: string }>(c, "distributedtask/pools");
  if (typeof v.agents === "string") {
    const p = all.find((x) => x.name.toLowerCase() === String(v.agents).toLowerCase() || String(x.id) === v.agents);
    if (!p) throw new AihubError(`agent pool '${v.agents}' not found; pools: ${all.map((x) => x.name).join(", ")}`);
    const a = await orgList<{ name: string; status?: string; enabled?: boolean; version?: string; osDescription?: string }>(c, `distributedtask/pools/${p.id}/agents`);
    return emit(ctx, v, a, a.length ? table([["agent", "status", "enabled", "version", "os"], ...a.map((x) => [x.name, x.status ?? "", x.enabled === false ? "no" : "yes", x.version ?? "", cut(x.osDescription, 30)])]) : `pool '${p.name}' has no agents`);
  }
  emit(ctx, v, all, table([["id", "pool", "hosted", "agents"], ...all.map((p) => [String(p.id), p.name, p.isHosted ? "yes" : "", p.size === undefined ? "" : String(p.size)])]));
}

interface Namespace {
  namespaceId: string;
  name: string;
  displayName?: string;
  actions?: { name: string; bit: number; displayName?: string }[];
}

export async function permissions(c: AdoClient, ctx: Ctx, v: Flags, action: string): Promise<void> {
  const all = await orgList<Namespace>(c, "securitynamespaces");
  if (action === "namespaces") {
    const rows = all.map((n) => ({ name: n.name, id: n.namespaceId, actions: n.actions?.length ?? 0 }));
    return emit(ctx, v, rows, table([["namespace", "actions", "id"], ...rows.map((n) => [n.name, String(n.actions), n.id])]));
  }
  const nsName = typeof v.namespace === "string" ? v.namespace : "";
  const ns = all.find((n) => n.name.toLowerCase() === nsName.toLowerCase() || n.namespaceId === nsName);
  if (!ns) throw new AihubError(`--namespace <name> is required; see: aihub devops permissions namespaces`);
  if (action === "actions") return emit(ctx, v, ns.actions ?? [], (ns.actions ?? []).map((a) => `${String(a.bit).padEnd(8)} ${a.name}${a.displayName ? ` (${a.displayName})` : ""}`).join("\n"));
  // check: what the signed-in user may do on one token, e.g. --namespace Git --token repoV2/<projectId>/<repoId> --actions GenericContribute,PullRequestContribute
  const token = typeof v.token === "string" ? v.token : "";
  const wanted = typeof v.actions === "string" ? v.actions.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (!token || !wanted.length) throw new AihubError("aihub devops permissions check needs --namespace, --token and --actions a,b (see: permissions actions --namespace N)");
  const bits = wanted.map((w) => {
    const a = (ns.actions ?? []).find((x) => x.name.toLowerCase() === w.toLowerCase());
    if (!a) throw new AihubError(`namespace ${ns.name} has no action '${w}'; see: aihub devops permissions actions --namespace ${ns.name}`);
    return a;
  });
  const out: { action: string; allowed: boolean }[] = [];
  for (const a of bits) {
    const r = await c.request<{ value?: boolean[] }>("GET", `permissions/${ns.namespaceId}/${a.bit}`, { orgLevel: true, query: { "api-version": "7.1", tokens: token } });
    out.push({ action: a.name, allowed: !!r.data.value?.[0] });
  }
  emit(ctx, v, { namespace: ns.name, token, results: out }, out.map((x) => `${x.allowed ? "allowed" : "DENIED "} ${x.action}`).join("\n"));
}

export { day };
