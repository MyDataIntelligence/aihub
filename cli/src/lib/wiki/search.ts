import { BrowseError, guarded, type Browse } from "../browse/core.js";
import { gitPathToPage, type WikiKind } from "./core.js";

/** Search over every wiki of the organisation (Azure DevOps Search, almsearch): pages with the matching lines marked. */

export interface HitLine {
  line: number | null;
  text: string;
  highlights: { start: number; length: number }[];
}

export interface WikiSearchResult {
  text: string;
  count: number;
  results: { project: string; wiki: { id: string; name: string; kind: WikiKind }; path: string; title: string; hits: HitLine[] }[];
  facets: { projects: { name: string; count: number }[]; wikis: { name: string; count: number }[] };
  tookMs: number;
}

interface RawHit {
  fileName?: string;
  path: string;
  project?: { name?: string };
  wiki?: { id?: string; name?: string; mappedPath?: string; version?: string };
  hits?: { fieldReferenceName?: string; highlights?: string[] }[];
}

interface RawSearch {
  count?: number;
  results?: RawHit[];
  facets?: { Project?: { name: string; resultCount: number }[]; Wiki?: { name: string; resultCount: number }[] };
}

/** `a <highlighthit>b</highlighthit> c` (one or more lines) -> the lines that hold a hit, with the hit ranges. */
export function hitLines(snippet: string): HitLine[] {
  const out: HitLine[] = [];
  for (const raw of snippet.split(/\r?\n/)) {
    if (!/<highlighthit>/i.test(raw)) continue;
    let text = "";
    const highlights: HitLine["highlights"] = [];
    const re = /<highlighthit>([\s\S]*?)<\/highlighthit>/gi;
    let last = 0;
    for (const m of raw.matchAll(re)) {
      text += raw.slice(last, m.index);
      highlights.push({ start: text.length, length: m[1].length });
      text += m[1];
      last = (m.index ?? 0) + m[0].length;
    }
    text += raw.slice(last);
    out.push({ line: null, text: text.trim() === text ? text : text.replace(/\s+$/, ""), highlights });
  }
  return out;
}

export function mapSearch(raw: RawSearch, text: string, took: number): WikiSearchResult {
  const results = (raw.results ?? []).map((r) => {
    const fields = r.hits ?? [];
    const content = fields.filter((h) => h.fieldReferenceName === "content").flatMap((h) => h.highlights ?? []);
    const pattern = content.length ? [] : fields.filter((h) => h.fieldReferenceName === "content.pattern").flatMap((h) => h.highlights ?? []);
    const seen = new Set<string>();
    const hits = [...content, ...pattern].flatMap(hitLines).filter((h) => (seen.has(h.text) ? false : (seen.add(h.text), true)));
    const mapped = r.wiki?.mappedPath && r.wiki.mappedPath !== "/" ? r.wiki.mappedPath.replace(/\/+$/, "") : "";
    const rel = mapped && r.path.toLowerCase().startsWith(mapped.toLowerCase()) ? r.path.slice(mapped.length) : r.path;
    const path = gitPathToPage(rel.replace(/\.md$/i, ""));
    const kind: WikiKind = !r.wiki?.version || r.wiki.version === "wikiMaster" ? "project" : "code";
    return { project: r.project?.name ?? "", wiki: { id: r.wiki?.id ?? "", name: r.wiki?.name ?? "", kind }, path, title: path.split("/").filter(Boolean).join(" / "), hits };
  });
  return {
    text,
    count: raw.count ?? results.length,
    results,
    facets: {
      projects: (raw.facets?.Project ?? []).map((f) => ({ name: f.name, count: f.resultCount })),
      wikis: (raw.facets?.Wiki ?? []).map((f) => ({ name: f.name, count: f.resultCount })),
    },
    tookMs: took,
  };
}

export async function wikiSearch(b: Browse, o: { text: string; project?: string; wiki?: string; top?: number; skip?: number }): Promise<WikiSearchResult> {
  const text = (o.text ?? "").trim();
  if (!text) throw new BrowseError("badInput", "what to search? pass --text <words>");
  const filters: Record<string, string[]> = {};
  if (o.project) filters.Project = [o.project];
  if (o.wiki) filters.Wiki = [o.wiki];
  const body = { searchText: text, $top: Math.min(Math.max(o.top ?? 50, 1), 200), $skip: Math.max(o.skip ?? 0, 0), includeFacets: true, ...(Object.keys(filters).length ? { filters } : {}) };
  return guarded(b, "wiki-search", async () => {
    const t0 = b.now();
    try {
      const r = await b.client.forService("almsearch").request<RawSearch>("POST", "search/wikisearchresults", { body, orgLevel: true, query: { "api-version": "7.1" } });
      return mapSearch(r.data, text, b.now() - t0);
    } catch (e) {
      const m = (e as Error).message;
      if (/\(404\)|not installed|SearchServiceNotAvailable|extension.*search|is not enabled/i.test(m)) throw new BrowseError("searchUnavailable", "Wiki search is not available in this Azure DevOps organisation");
      throw e;
    }
  });
}
