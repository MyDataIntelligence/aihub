import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdoClient } from "./ado.js";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { readUtf8, type TeamConfig } from "./team.js";

/** Where a work item template lives in a team repository, in this order (after the path named in team.yaml). */
export const TEMPLATE_ASSET_DIRS = [".agents/skills/_shared/assets", "skills/_shared/assets"];

export interface FoundTemplate {
  text: string;
  /** For the one result line: a repo path, Azure DevOps "<name>", or built-in with the reason. */
  source: string;
  kind: "file" | "devops" | "built-in";
}

/** (a) the path in team.yaml, (b) the standard files of the repository. Undefined when neither exists. */
export function localTemplate(root: string, configured: string | undefined, fileName: string): FoundTemplate | undefined {
  const candidates = [configured, ...TEMPLATE_ASSET_DIRS.map((d) => `${d}/${fileName}`)].filter(Boolean) as string[];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return { text: readUtf8(p), source: c, kind: "file" };
  }
  return undefined;
}

const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_FAILED_MS = 10 * 60 * 1000;

type Cached = { at: number; ok: boolean; text?: string; name?: string; note?: string };

const cacheFile = (root: string) => aihubDir(root, "cache", "devops-templates.json");

function readCache(root: string): Record<string, Cached> {
  try {
    return JSON.parse(readFileSync(cacheFile(root), "utf8")) as Record<string, Cached>;
  } catch {
    return {};
  }
}

function writeCache(root: string, key: string, v: Cached): void {
  try {
    const f = cacheFile(root);
    ensureDir(dirname(f));
    writeFileSync(f, JSON.stringify({ ...readCache(root), [key]: v }), "utf8");
  } catch {
    /* a cache that cannot be written only costs a later call */
  }
}

const htmlToMarkdown = (html: string): string =>
  html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const ACCEPTANCE = "Microsoft.VSTS.Common.AcceptanceCriteria";

/** The template's Description (and acceptance criteria) as markdown with `## ` sections; undefined without headings. */
export function devopsTemplateText(fields: Record<string, unknown>): string | undefined {
  const desc = htmlToMarkdown(String(fields["System.Description"] ?? ""));
  const ac = htmlToMarkdown(String(fields[ACCEPTANCE] ?? ""));
  const text = [desc, ac && !/^##\s+acceptance/im.test(desc) ? `## Acceptance criteria\n\n${ac}` : ""].filter(Boolean).join("\n\n");
  return /^##\s+\S/m.test(text) ? `${text}\n` : undefined;
}

/**
 * (c) the work item template of the team in Azure DevOps for this type. Called only when (a) and (b) found nothing,
 * once per day per type (a failure once per ten minutes); no access or no network is skipped without a message.
 * Several templates: the one whose name contains the type or "story"; otherwise none is chosen and `note` says why.
 */
export async function devopsTemplate(root: string, client: AdoClient, team: TeamConfig, type: string, now = Date.now()): Promise<{ text?: string; name?: string; note?: string }> {
  const teamName = String((team.azureDevOps as { team?: string } | undefined)?.team ?? `${client.remote.project} Team`);
  const key = `${client.remote.org}/${client.remote.project}/${teamName}/${type}`;
  const hit = readCache(root)[key];
  if (hit && now - hit.at < (hit.ok ? TTL_OK_MS : TTL_FAILED_MS)) return { text: hit.text, name: hit.name, note: hit.note };
  const tc = client.forTeam(teamName);
  let result: Cached;
  try {
    const list = (await tc.get<{ value?: { id: string; name: string }[] }>("wit/templates", { workitemtypename: type })).value ?? [];
    const want = (n: string) => n.toLowerCase().includes(type.toLowerCase()) || /story/i.test(n);
    const pick = list.length === 1 ? list[0] : list.filter((t) => want(t.name)).length === 1 ? list.find((t) => want(t.name)) : undefined;
    if (!pick) {
      result = { at: now, ok: true, note: list.length ? `Azure DevOps has ${list.length} templates for ${type} and none is clearly the one: ${list.map((t) => t.name).join(", ")}` : undefined };
    } else {
      const t = await tc.get<{ fields?: Record<string, unknown> }>(`wit/templates/${encodeURIComponent(pick.id)}`);
      const text = devopsTemplateText(t.fields ?? {});
      result = text ? { at: now, ok: true, text, name: pick.name } : { at: now, ok: true, note: `Azure DevOps template "${pick.name}" has no ## headings in its description` };
    }
  } catch {
    result = { at: now, ok: false };
  }
  writeCache(root, key, result);
  return { text: result.text, name: result.name, note: result.note };
}

export interface FindOpts {
  root: string;
  client?: AdoClient;
  team: TeamConfig;
  type: string;
  configured?: string;
  fileName: string;
  builtIn: string;
  now?: number;
}

/** The fixed order: (a) team.yaml path, (b) repository files, (c) the team's Azure DevOps template, (d) built-in. */
export async function findWorkItemTemplate(o: FindOpts): Promise<FoundTemplate> {
  const local = localTemplate(o.root, o.configured, o.fileName);
  if (local) return local;
  const d = o.client ? await devopsTemplate(o.root, o.client, o.team, o.type, o.now) : {};
  if (d.text) return { text: d.text, source: `Azure DevOps "${d.name}"`, kind: "devops" };
  const why = d.note ?? "no team template found";
  return { text: o.builtIn, source: `built-in (${why}; add ${TEMPLATE_ASSET_DIRS[0]}/${o.fileName} to use your own)`, kind: "built-in" };
}
