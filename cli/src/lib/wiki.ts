import { AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { diffLines } from "./diff.js";
import { AihubError } from "./errors.js";
import { readUtf8 } from "./team.js";

interface Wiki {
  id: string;
  name: string;
  type?: string;
}

export async function pickWiki(c: AdoClient, name?: string): Promise<Wiki> {
  const wikis = await c.list<Wiki>("wiki/wikis");
  if (!wikis.length) throw new AihubError("this project has no wiki");
  if (name) {
    const w = wikis.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name);
    if (!w) throw new AihubError(`wiki '${name}' not found; available: ${wikis.map((x) => x.name).join(", ")}`);
    return w;
  }
  return wikis.find((w) => w.type === "projectWiki") ?? wikis[0];
}

const normPath = (p: string) => "/" + p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");

export interface WikiUpdateOpts {
  page: string;
  bodyFile: string;
  wiki?: string;
  publish?: boolean;
  json?: boolean;
}

export async function wikiUpdate(ctx: Ctx, o: WikiUpdateOpts): Promise<string> {
  const content = readUtf8(o.bodyFile);
  if (!content.trim()) throw new AihubError("the body file is empty");
  const { client } = repoClient(ctx);
  const wiki = await pickWiki(client, o.wiki);
  const path = normPath(o.page);
  const base = `wiki/wikis/${encodeURIComponent(wiki.id)}/pages`;
  let old: string | undefined;
  let etag: string | undefined;
  try {
    const r = await client.request<{ content?: string }>("GET", base, { query: { path, includeContent: true } });
    old = (r.data.content ?? "").replace(/\r\n/g, "\n");
    etag = r.headers.get("etag") ?? undefined;
  } catch (e) {
    if (!(e instanceof AihubError) || !/\(404\)/.test(e.message)) throw e;
  }
  const d = diffLines(old ?? "", content, 200);
  const head = `${wiki.name}${path}: ${old === undefined ? "new page" : `+${d.added} -${d.removed}`}`;
  if (old !== undefined && d.added === 0 && d.removed === 0) return `${head} (no change)`;
  if (!o.publish) {
    return o.json ? JSON.stringify({ wiki: wiki.name, path, published: false, added: d.added, removed: d.removed, diff: d.text }) : `${head} (not published, pass --publish)\n${d.text}`;
  }
  await client.request("PUT", base, { query: { path }, body: { content }, headers: etag ? { "If-Match": etag } : {} });
  return o.json ? JSON.stringify({ wiki: wiki.name, path, published: true, added: d.added, removed: d.removed }) : `${head} published`;
}
