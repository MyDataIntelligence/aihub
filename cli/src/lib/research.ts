import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { wikiUpdate } from "./wiki.js";

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
  const { root } = repoClient(ctx);
  const date = new Date((ctx.now ?? Date.now)()).toISOString().slice(0, 10);
  const dir = ensureDir(aihubDir(root, "research"));
  const target = join(dir, `${date}-${slug(titleOf(text, o.file))}.md`);
  copyFileSync(o.file, target);
  const out: Record<string, unknown> = { saved: target };
  if (o.wiki) out.wiki = await wikiUpdate(ctx, { page: o.wiki, bodyFile: o.file, publish: true, json: false });
  return o.json ? JSON.stringify(out) : [`saved ${target}`, ...(o.wiki ? [String(out.wiki)] : [])].join("\n");
}
