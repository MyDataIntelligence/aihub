import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { getPr } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { parsePrRef } from "./pr.js";
import { editSection, parseSections } from "./templates.js";

const IMAGE = /^\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_BYTES = 20 * 1024 * 1024;

export interface EvidenceOpts {
  pr: string;
  file: string;
  caption?: string;
  section?: string;
  json?: boolean;
}

/** The section that holds evidence: screenshots/evidence first, then tests; null when there is none. */
export function evidenceHeading(description: string): string | undefined {
  const heads = parseSections(description).sections.map((s) => s.heading);
  return heads.find((h) => /screenshot|evidence|bewijs/i.test(h)) ?? heads.find((h) => /^tests?\b|\btests?$|test/i.test(h));
}

export async function addEvidence(ctx: Ctx, o: EvidenceOpts): Promise<string> {
  const ext = extname(o.file);
  if (!IMAGE.test(ext)) throw new AihubError(`${basename(o.file)}: only image files (png, jpg, gif, webp, bmp) can be added as evidence`);
  let size: number;
  try {
    size = statSync(o.file).size;
  } catch {
    throw new AihubError(`file not found: ${o.file}`);
  }
  if (size > MAX_BYTES) throw new AihubError(`${basename(o.file)} is ${(size / 1048576).toFixed(1)} MB; the limit is 20 MB`);
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = await getPr(client, id);
  const name = basename(o.file).replace(/\s+/g, "-");
  const up = await client.sendBytes<{ url?: string }>("POST", `${client.repoPath()}/pullrequests/${id}/attachments/${encodeURIComponent(name)}`, readFileSync(o.file));
  if (!up.url) throw new AihubError("Azure DevOps did not return an attachment url");
  const caption = (o.caption ?? name.replace(ext, "")).replace(/[\[\]\n]/g, " ").trim();
  const line = `![${caption}](${up.url})`;
  const heading = o.section ?? evidenceHeading(pr.description ?? "") ?? "Evidence";
  const description = editSection(pr.description ?? "", heading, { append: line });
  await client.patch(`${client.repoPath()}/pullrequests/${id}`, { description });
  return o.json ? JSON.stringify({ pr: id, url: up.url, section: heading }) : `PR !${id}: ${name} attached and linked in '${heading}'`;
}
