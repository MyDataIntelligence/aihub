import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { wikiUpdate } from "./wiki.js";

/** The headings every feasibility report has, in order. */
export const REPORT_HEADINGS = ["Verdict", "Hoe", "Bewijs", "Waar hoort het: Fabric, DevOps/CI-CD of beide?", "Bronnen", "Grenzen en risico's", "Inschatting inspanning", "Open vragen"];

export const REPORT_TEMPLATE = `# <de vraag, een regel>

## Verdict
Ja / Nee / Deels, en de workaround in een zin.

## Hoe
Genummerde stappen of de API-calls. Alleen stappen.

## Bewijs
Probe-uitvoer (commando, YES/NO/UNKNOWN, status) en het PoC-resultaat. Schrijf "geen PoC" als die er niet is.

## Waar hoort het: Fabric, DevOps/CI-CD of beide?
### Fabric
Kan het daar (itemtype of feature, hoe, bewijs)? Moet het daar?
### Azure DevOps
Kan het daar (pipelines, CI/CD, repos, boards; hoe, bewijs)? Moet het daar?
### Samen
Hoe ze samenwerken (pipeline start Fabric-item, git integration en deployment pipelines of release, fabric-cicd, variable library of variable group, service principal). Sluit af met een regel: "Advies: doe X in Fabric / in DevOps / in beide, omdat ...".

## Bronnen
Link en datum per bron.

## Grenzen en risico's

## Inschatting inspanning

## Open vragen
`;

/** Headings of REPORT_HEADINGS that the text lacks (compared without case and punctuation spacing). */
export function missingHeadings(text: string): string[] {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const have = new Set([...text.matchAll(/^#{1,4}\s*\**(.+?)\**\s*$/gm)].map((m) => norm(m[1])));
  return REPORT_HEADINGS.filter((h) => !have.has(norm(h)));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "research";

/** The first `# heading` of the report, else the file name. */
export const titleOf = (text: string, file: string) => /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? basename(file).replace(/\.[^.]+$/, "");

/**
 * Keeps a feasibility report. Default: `<git common dir>/aihub/research/<date>-<slug>.md`, which is never committed.
 * With --wiki it is published as a wiki page, which the caller only does after the user said yes.
 */
export async function researchSave(ctx: Ctx, o: { file: string; wiki?: string; json?: boolean }): Promise<string> {
  if (!existsSync(o.file)) throw new AihubError(`report file not found: ${o.file}`);
  const text = readFileSync(o.file, "utf8");
  if (!text.trim()) throw new AihubError("the report file is empty");
  const missing = missingHeadings(text);
  if (missing.length) throw new AihubError(`the report lacks the heading(s): ${missing.map((h) => `"## ${h}"`).join(", ")}. Start from aihub research template, fill every section, then save again.`);
  const { root } = repoClient(ctx);
  const date = new Date((ctx.now ?? Date.now)()).toISOString().slice(0, 10);
  const dir = ensureDir(aihubDir(root, "research"));
  const target = join(dir, `${date}-${slug(titleOf(text, o.file))}.md`);
  copyFileSync(o.file, target);
  const out: Record<string, unknown> = { saved: target };
  if (o.wiki) out.wiki = await wikiUpdate(ctx, { page: o.wiki, bodyFile: o.file, publish: true, json: false });
  return o.json ? JSON.stringify(out) : [`saved ${target}`, ...(o.wiki ? [String(out.wiki)] : [])].join("\n");
}
