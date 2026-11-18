import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, requireFlag, table, top, type Flags } from "./devops.js";

/** `aihub artifacts feeds|packages|versions`: Azure Artifacts feeds, read only (publishing belongs to the pipeline that builds the package). */
export const ARTIFACTS_USAGE = "aihub artifacts feeds | packages --feed F [--filter text] [--type npm|nuget|pypi|maven|upack] | versions --feed F --package NAME [--type T]";

interface Feed {
  id: string;
  name: string;
  project?: { name?: string };
  upstreamEnabled?: boolean;
}

/** Feeds live on feeds.dev.azure.com; project feeds under the project, organisation feeds without it. */
const host = (c: AdoClient) => c.forService("feeds");

async function allFeeds(c: AdoClient): Promise<{ org: Feed[]; project: Feed[] }> {
  const org = await host(c).request<{ value?: Feed[] }>("GET", "packaging/feeds", { orgLevel: true }).then((r) => r.data.value ?? []);
  const project = await host(c).list<Feed>("packaging/feeds").catch(() => [] as Feed[]);
  return { org, project };
}

export async function feeds(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const { org, project } = await allFeeds(c);
  const byId = new Map<string, Feed>();
  [...org, ...project].forEach((f) => byId.set(f.id, f));
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = [...byId.values()].filter((x) => !f || x.name.toLowerCase().includes(f)).slice(0, top(v, 50));
  emit(
    ctx,
    v,
    rows.map((x) => ({ id: x.id, name: x.name, scope: x.project?.name ? "project" : "organisation", upstream: !!x.upstreamEnabled })),
    rows.length ? table([["feed", "scope", "upstream", "id"], ...rows.map((x) => [x.name, x.project?.name ? "project" : "organisation", x.upstreamEnabled ? "yes" : "", x.id])]) : "no feeds",
  );
}

interface Pkg {
  id: string;
  name: string;
  protocolType?: string;
  versions?: { version?: string; isLatest?: boolean }[];
}

async function feedRef(c: AdoClient, v: Flags): Promise<{ id: string; name: string; org: boolean }> {
  const ref = requireFlag(v, "feed", "feed name or id");
  const { org, project } = await allFeeds(c);
  const hit = [...project, ...org].find((f) => f.id === ref || f.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new AihubError(`feed '${ref}' not found (aihub artifacts feeds)`);
  return { id: hit.id, name: hit.name, org: !project.some((p) => p.id === hit.id) };
}

export async function packages(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const feed = await feedRef(c, v);
  const query: Record<string, string | number | boolean> = { includeAllVersions: false, $top: top(v, 50) };
  if (typeof v.filter === "string") query.packageNameQuery = v.filter;
  if (typeof v.type === "string") query.protocolType = v.type;
  const r = await host(c).request<{ value?: Pkg[] }>("GET", `packaging/feeds/${encode(feed.id)}/packages`, { query, orgLevel: feed.org });
  const rows = (r.data.value ?? []).map((p) => ({ id: p.id, name: p.name, type: p.protocolType ?? "", latest: p.versions?.find((x) => x.isLatest)?.version ?? p.versions?.[0]?.version ?? "" }));
  emit(ctx, v, { feed: feed.name, packages: rows }, rows.length ? table([["package", "type", "latest"], ...rows.map((p) => [cut(p.name, 60), p.type, p.latest])]) : `feed ${feed.name} has no matching packages`);
}

export async function versions(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const feed = await feedRef(c, v);
  const name = requireFlag(v, "package", "package name");
  const find = await host(c).request<{ value?: Pkg[] }>("GET", `packaging/feeds/${encode(feed.id)}/packages`, { query: { packageNameQuery: name, ...(typeof v.type === "string" ? { protocolType: v.type } : {}) }, orgLevel: feed.org });
  const pkg = (find.data.value ?? []).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!pkg) throw new AihubError(`package '${name}' not found in feed ${feed.name}`);
  const r = await host(c).request<{ value?: { version?: string; isLatest?: boolean; isListed?: boolean; publishDate?: string; views?: { name?: string }[] }[] }>("GET", `packaging/Feeds/${encode(feed.id)}/Packages/${encode(pkg.id)}/versions`, { orgLevel: feed.org });
  const rows = (r.data.value ?? []).map((x) => ({ version: x.version ?? "", latest: !!x.isLatest, listed: x.isListed !== false, published: day(x.publishDate), views: (x.views ?? []).map((w) => w.name).filter(Boolean) as string[] }));
  emit(ctx, v, { feed: feed.name, package: pkg.name, versions: rows }, rows.length ? table([["version", "published", "views", ""], ...rows.slice(0, top(v, 30)).map((x) => [x.version, x.published, x.views.join(","), x.latest ? "latest" : x.listed ? "" : "unlisted"])]) : `${pkg.name} has no versions`);
}
