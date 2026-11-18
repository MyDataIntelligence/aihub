import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, table, top, type Flags } from "./devops.js";

/** Azure Artifacts lives on feeds.dev.azure.com. Reads only: publishing is part of the pipeline that builds a package. */
const PREVIEW = { "api-version": "7.1-preview.1" };

interface Feed {
  id: string;
  name: string;
  description?: string;
  project?: { name?: string };
  upstreamEnabled?: boolean;
}

async function feedList(c: AdoClient, v: Flags): Promise<Feed[]> {
  const f = c.forService("feeds");
  const project = await f.list<Feed>("packaging/feeds", PREVIEW);
  if (!v["org-feeds"]) return project;
  const org = await f.request<{ value?: Feed[] }>("GET", "packaging/feeds", { orgLevel: true, query: PREVIEW }).then((r) => r.data.value ?? []);
  return [...project, ...org.filter((o) => !project.some((p) => p.id === o.id))];
}

async function pick(c: AdoClient, v: Flags, ref: string): Promise<Feed> {
  const all = await feedList(c, { ...v, "org-feeds": true });
  const hit = all.find((x) => x.name.toLowerCase() === ref.toLowerCase() || x.id === ref);
  if (!hit) throw new AihubError(`feed '${ref}' not found; feeds: ${all.map((x) => x.name).join(", ") || "none"}`);
  return hit;
}

/** Project feeds live under the project, organisation feeds directly under the organisation. */
function feedGet<T>(c: AdoClient, fd: Feed, path: string, query: Record<string, string | number>): Promise<T> {
  return c.forService("feeds").request<T>("GET", path, { query, orgLevel: !fd.project }).then((r) => r.data);
}

export async function feeds(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await feedList(c, v);
  emit(ctx, v, all.map((x) => ({ id: x.id, name: x.name, scope: x.project?.name ?? "organisation", upstream: !!x.upstreamEnabled })), all.length ? table([["feed", "scope", "upstream", "description"], ...all.map((x) => [x.name, x.project?.name ?? "organisation", x.upstreamEnabled ? "yes" : "", cut(x.description, 50)])]) : "no feeds");
}

interface Pkg {
  id: string;
  name: string;
  protocolType?: string;
  versions?: { version?: string; isLatest?: boolean; publishDate?: string }[];
}

export async function packages(c: AdoClient, ctx: Ctx, v: Flags, feed: string): Promise<void> {
  const fd = await pick(c, v, feed);
  const q: Record<string, string | number> = { ...PREVIEW, $top: top(v, 50), includeAllVersions: "false" };
  if (typeof v.type === "string") q.protocolType = v.type;
  if (typeof v.filter === "string") q.packageNameQuery = v.filter;
  const r = await feedGet<{ value?: Pkg[] }>(c, fd, `packaging/feeds/${encode(fd.id)}/packages`, q);
  const rows = (r.value ?? []).map((p) => ({ id: p.id, name: p.name, type: p.protocolType, latest: p.versions?.find((x) => x.isLatest)?.version ?? p.versions?.[0]?.version, date: day(p.versions?.[0]?.publishDate) }));
  emit(ctx, v, rows, rows.length ? table([["package", "type", "latest", "published"], ...rows.map((p) => [p.name, p.type ?? "", p.latest ?? "", p.date])]) : `feed '${fd.name}' has no packages that match`);
}

export async function versions(c: AdoClient, ctx: Ctx, v: Flags, feed: string, name: string): Promise<void> {
  const fd = await pick(c, v, feed);
  const found = await feedGet<{ value?: Pkg[] }>(c, fd, `packaging/feeds/${encode(fd.id)}/packages`, { ...PREVIEW, packageNameQuery: name, $top: 20 });
  const pkg = (found.value ?? []).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!pkg) throw new AihubError(`package '${name}' not found in feed '${fd.name}'; see: aihub artifacts packages --feed ${fd.name}`);
  const r = await feedGet<{ value?: { version?: string; isLatest?: boolean; isListed?: boolean; publishDate?: string; views?: { name?: string }[] }[] }>(c, fd, `packaging/feeds/${encode(fd.id)}/packages/${encode(pkg.id)}/versions`, PREVIEW);
  const rows = (r.value ?? []).slice(0, top(v, 50)).map((x) => ({ version: x.version, latest: !!x.isLatest, listed: x.isListed !== false, date: day(x.publishDate), views: (x.views ?? []).map((w) => w.name).join(",") }));
  emit(ctx, v, rows, rows.length ? table([["version", "published", "views", ""], ...rows.map((x) => [x.version ?? "", x.date, x.views, [x.latest ? "latest" : "", x.listed ? "" : "unlisted"].filter(Boolean).join(" ")])]) : `no versions of ${name}`);
}
