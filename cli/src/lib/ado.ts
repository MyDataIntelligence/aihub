import { AihubError } from "./errors.js";
import { isRestWrite, summarizeBody, trace } from "./trace.js";

export type FetchFn = typeof fetch;

export interface AdoRemote {
  org: string;
  project: string;
  repo: string;
  /** e.g. https://dev.azure.com/ferron-org */
  orgUrl: string;
}

export function parseRemote(url: string): AdoRemote {
  const u = url.trim();
  const dec = (s: string) => decodeURIComponent(s);
  const make = (org: string, project: string, repo: string): AdoRemote => ({
    org: dec(org),
    project: dec(project),
    repo: dec(repo),
    orgUrl: `https://dev.azure.com/${encodeURIComponent(dec(org))}`,
  });
  let m: RegExpExecArray | null;
  // SSH: git@ssh.dev.azure.com:v3/org/project/repo  |  org@vs-ssh.visualstudio.com:v3/org/project/repo
  if ((m = /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:v3\/)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(u))) {
    return make(m[1], m[2], m[3]);
  }
  // HTTPS dev.azure.com/org/project/_git/repo (optional user@)
  if ((m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/.exec(u))) {
    return make(m[1], m[2], m[3]);
  }
  // HTTPS org.visualstudio.com/[DefaultCollection/]project/_git/repo
  if ((m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/.exec(u))) {
    return make(m[1], m[2], m[3]);
  }
  throw new AihubError(`remote '${u}' is not an Azure DevOps remote (dev.azure.com or visualstudio.com)`);
}

export const API_VERSION = "7.1";

export type AuthProvider = () => Promise<string>;
export type DevOpsService = "almsearch" | "feeds" | "vssps" | "vsrm" | "vsaex";
type Query = Record<string, string | number | boolean | undefined>;

export class AdoClient {
  constructor(
    readonly remote: AdoRemote,
    private readonly auth: AuthProvider,
    private readonly fetchFn: FetchFn = fetch,
    /** Other Azure DevOps hosts: https://<service>.dev.azure.com/<org>/... (search, feeds, identities). */
    private readonly service?: DevOpsService,
    /** A team of the project (work/ APIs live under <project>/<team>/_apis). */
    private readonly team?: string,
  ) {}

  /** The same client in the context of a team (iterations, capacity, boards, backlogs). */
  forTeam(team: string): AdoClient {
    return new AdoClient(this.remote, this.auth, this.fetchFn, this.service, team);
  }

  /** The same client against another Azure DevOps host (almsearch, feeds, vssps, ...). */
  forService(service: DevOpsService): AdoClient {
    return new AdoClient(this.remote, this.auth, this.fetchFn, service, this.team);
  }

  /** The same client for another repository of the project (--repo). */
  forRepo(repo: string): AdoClient {
    return new AdoClient({ ...this.remote, repo }, this.auth, this.fetchFn, this.service, this.team);
  }

  /** The same client for another project of the organisation (--project). */
  forProject(project: string): AdoClient {
    return new AdoClient({ ...this.remote, project }, this.auth, this.fetchFn, this.service, this.team);
  }

  repoPath(): string {
    return `git/repositories/${encodeURIComponent(this.remote.repo)}`;
  }

  prUrl(id: number): string {
    const r = this.remote;
    return `${r.orgUrl}/${encodeURIComponent(r.project)}/_git/${encodeURIComponent(r.repo)}/pullrequest/${id}`;
  }

  private url(path: string, query: Query = {}, orgLevel = false): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    if (!q.has("api-version")) q.set("api-version", API_VERSION); // preview endpoints pass their own, e.g. 7.1-preview.1
    const base = this.service ? this.remote.orgUrl.replace("https://dev.azure.com/", `https://${this.service}.dev.azure.com/`) : this.remote.orgUrl;
    return `${base}/${orgLevel ? "" : `${encodeURIComponent(this.remote.project)}/${this.team ? `${encodeURIComponent(this.team)}/` : ""}`}_apis/${path}?${q.toString()}`;
  }

  async request<T = any>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; raw?: boolean; orgLevel?: boolean; contentType?: string; rawBody?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const fullUrl = this.url(path, opts.query, opts.orgLevel);
    const bodyText = opts.rawBody !== undefined ? `${opts.rawBody.length} bytes` : summarizeBody(opts.body);
    if (trace.dryRun && isRestWrite(method, path)) {
      trace.plan(`would ${method} ${fullUrl}${bodyText ? `   body ${bodyText}` : ""}`);
      return { data: {} as T, headers: new Headers() };
    }
    if (trace.verbose) trace.log(`+ ${method} ${fullUrl}${bodyText ? `   body ${bodyText}` : ""}`);
    const res = await this.fetchFn(fullUrl, {
      method,
      headers: {
        Authorization: await this.auth(),
        Accept: opts.raw ? "text/plain" : "application/json",
        ...(opts.body !== undefined || opts.rawBody !== undefined
          ? { "Content-Type": opts.contentType ?? "application/json; charset=utf-8" }
          : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.rawBody !== undefined ? (opts.rawBody as unknown as BodyInit) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (trace.verbose) trace.log(`  -> ${res.status}`);
    const ctype = res.headers.get("content-type") ?? "";
    // Azure DevOps answers a bad/missing credential with 203 + an HTML sign-in page.
    if (res.status === 401 || res.status === 203 || (res.ok && !opts.raw && ctype.includes("text/html"))) {
      throw new AihubError("not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT");
    }
    if (!res.ok) throw new AihubError(httpMessage(res.status, text, method, path));
    if (opts.raw) return { data: text as unknown as T, headers: res.headers };
    return { data: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
  }

  get<T = any>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query }).then((r) => r.data);
  }

  /** GET an organization-level endpoint (not under the project), such as connectionData (a preview API). */
  getOrg<T = any>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query: { "api-version": "7.1-preview.1", ...query }, orgLevel: true }).then((r) => r.data);
  }

  /** GET a collection, following x-ms-continuationtoken. Returns all `value` items. */
  async list<T = any>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    let token: string | null = null;
    for (let i = 0; i < 100; i++) {
      const r: { data: { value?: T[] }; headers: Headers } = await this.request("GET", path, {
        query: { ...query, ...(token ? { continuationToken: token } : {}) },
      });
      out.push(...(r.data.value ?? []));
      token = r.headers.get("x-ms-continuationtoken");
      if (!token) break;
    }
    return out;
  }

  put<T = any>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, { body, query }).then((r) => r.data);
  }

  del<T = any>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { query }).then((r) => r.data);
  }

  post<T = any>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query }).then((r) => r.data);
  }

  patch<T = any>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, { body, query }).then((r) => r.data);
  }

  /** Work item writes need the JSON Patch media type. */
  jsonPatch<T = any>(method: "POST" | "PATCH", path: string, ops: unknown[], query?: Query): Promise<T> {
    return this.request<T>(method, path, { body: ops, query, contentType: "application/json-patch+json" }).then((r) => r.data);
  }

  workItemUrl(id: number): string {
    return `${this.remote.orgUrl}/${encodeURIComponent(this.remote.project)}/_workitems/edit/${id}`;
  }

  /** PUT/POST raw bytes (attachments). */
  sendBytes<T = any>(method: "PUT" | "POST", path: string, bytes: Uint8Array, query?: Query): Promise<T> {
    return this.request<T>(method, path, { rawBody: bytes, contentType: "application/octet-stream", query }).then((r) => r.data);
  }

  /** Download bytes from an absolute Azure DevOps URL (artifact zips); the same sign-in, capped at maxBytes. */
  async fetchBytes(fullUrl: string, maxBytes = 200 * 1024 * 1024): Promise<Uint8Array> {
    if (!/^https:\/\/([a-z0-9-]+\.)?(dev\.azure\.com|visualstudio\.com)\//i.test(fullUrl)) throw new AihubError(`refusing to download from ${fullUrl}: not an Azure DevOps address`);
    const res = await this.fetchFn(fullUrl, { headers: { Authorization: await this.auth() } });
    if (!res.ok) throw new AihubError(`download failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new AihubError(`the download is ${Math.round(buf.length / 1048576)} MB, more than the ${Math.round(maxBytes / 1048576)} MB limit`);
    return buf;
  }

  getText(path: string, query?: Query): Promise<string> {
    return this.request<string>("GET", path, { query, raw: true }).then((r) => r.data);
  }
}

function httpMessage(status: number, body: string, method: string, path: string): string {
  let detail = "";
  try {
    const j = JSON.parse(body) as { message?: string; customProperties?: { ValidationResults?: { result?: string; message?: string }[] } };
    detail = j.message ?? "";
    // e.g. queueing a build on a missing branch: the reason sits in customProperties, not in message.
    const why = (j.customProperties?.ValidationResults ?? []).map((v) => v.message).filter(Boolean).join("; ");
    if (why) detail = `${detail} ${why}`;
  } catch {
    detail = body.slice(0, 200);
  }
  detail = detail.replace(/\s+/g, " ").trim();
  const p = path.split("?")[0];
  if (status === 403) return `Azure DevOps denied access (403): your account needs access to this repository${detail ? ` (${detail})` : ""}`;
  if (status === 404) return `Azure DevOps: not found (404) for ${method} ${p}${detail ? `: ${detail}` : ""}`;
  return `Azure DevOps ${method} ${p} failed (${status})${detail ? `: ${detail}` : ""}`;
}

// ---- typed helpers -------------------------------------------------------

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit?: { commitId: string };
}

export const branchRef = (b: string) => (b.startsWith("refs/") ? b : `refs/heads/${b}`);
export const shortBranch = (r: string) => r.replace(/^refs\/heads\//, "");

export async function findActivePr(c: AdoClient, source: string, target?: string): Promise<PullRequest | undefined> {
  const prs = await c.list<PullRequest>(`${c.repoPath()}/pullrequests`, {
    "searchCriteria.sourceRefName": branchRef(source),
    "searchCriteria.status": "active",
    ...(target ? { "searchCriteria.targetRefName": branchRef(target) } : {}),
  });
  return prs[0];
}

export const getPr = (c: AdoClient, id: number) => c.get<PullRequest>(`${c.repoPath()}/pullrequests/${id}`);

export async function repoDefaultBranch(c: AdoClient): Promise<string | undefined> {
  const r = await c.get<{ defaultBranch?: string }>(c.repoPath());
  return r.defaultBranch ? shortBranch(r.defaultBranch) : undefined;
}

export async function getWorkItemTitle(c: AdoClient, id: number): Promise<string | undefined> {
  try {
    const r = await c.get<{ fields?: Record<string, string> }>(`wit/workitems/${id}`, { fields: "System.Title" });
    return r.fields?.["System.Title"];
  } catch {
    return undefined;
  }
}

/** PR ids linked to a work item through artifact links (vstfs:///Git/PullRequestId/<project>%2F<repo>%2F<id>). */
export async function getWorkItemPrIds(c: AdoClient, id: number): Promise<number[]> {
  try {
    const r = await c.get<{ relations?: { rel: string; url: string }[] }>(`wit/workitems/${id}`, { $expand: "relations" });
    const ids: number[] = [];
    for (const rel of r.relations ?? []) {
      if (rel.rel !== "ArtifactLink") continue;
      const m = /PullRequestId\/.*?(\d+)$/i.exec(decodeURIComponent(rel.url));
      if (m) ids.push(Number(m[1]));
    }
    return ids;
  } catch {
    return [];
  }
}
