import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdoClient } from "./ado.js";
import { aihubDir, ensureDir } from "./aihubDir.js";

export const DESCRIPTION = "System.Description";
export const REPRO_FIELD = "Microsoft.VSTS.TCM.ReproSteps";
export const ACCEPTANCE_FIELD = "Microsoft.VSTS.Common.AcceptanceCriteria";

/** Where the text of one work item type lives: the main text field and the field for acceptance criteria. */
export interface FieldLayout {
  /** The field that holds the text a user sees: System.Description, or ReproSteps for a Bug that has no Description. */
  primary: string;
  /** The acceptance criteria field; the main field when the type has none. */
  acceptance: string;
}

export const DEFAULT_LAYOUT: FieldLayout = { primary: DESCRIPTION, acceptance: ACCEPTANCE_FIELD };

/**
 * The one rule: a type whose form has no System.Description but has Microsoft.VSTS.TCM.ReproSteps (a Bug) keeps its text in
 * ReproSteps. `typeFields` are the reference names of the type's fields; without them (API unavailable) a Bug is assumed to be
 * such a type, and acceptance criteria stay in the main text because the field may not exist.
 */
export function layoutFor(type: string, typeFields: string[] | undefined): FieldLayout {
  if (typeFields) {
    const has = (f: string) => typeFields.some((x) => x.toLowerCase() === f.toLowerCase());
    const primary = !has(DESCRIPTION) && has(REPRO_FIELD) ? REPRO_FIELD : DESCRIPTION;
    return { primary, acceptance: has(ACCEPTANCE_FIELD) ? ACCEPTANCE_FIELD : primary };
  }
  return /^bug$/i.test(type) ? { primary: REPRO_FIELD, acceptance: REPRO_FIELD } : DEFAULT_LAYOUT;
}

const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_FAILED_MS = 10 * 60 * 1000;
type Cached = { at: number; ok: boolean; fields?: string[] };
const cacheFile = (root: string) => aihubDir(root, "cache", "type-fields.json");

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

/** The field layout of a work item type, from the fields of the type in Azure DevOps (once per day per type; a failure once per ten minutes). */
export async function typeLayout(root: string, client: AdoClient | undefined, type: string, now = Date.now()): Promise<FieldLayout> {
  if (!client) return layoutFor(type, undefined);
  const key = `${client.remote.org}/${client.remote.project}/${type.toLowerCase()}`;
  const hit = readCache(root)[key];
  if (hit && now - hit.at < (hit.ok ? TTL_OK_MS : TTL_FAILED_MS)) return layoutFor(type, hit.ok ? hit.fields : undefined);
  let result: Cached;
  try {
    const r = await client.get<{ value?: { referenceName?: string }[] }>(`wit/workitemtypes/${encodeURIComponent(type)}/fields`);
    const fields = (r.value ?? []).map((f) => f.referenceName ?? "").filter(Boolean);
    result = fields.length ? { at: now, ok: true, fields } : { at: now, ok: false };
  } catch {
    result = { at: now, ok: false };
  }
  writeCache(root, key, result);
  return layoutFor(type, result.ok ? result.fields : undefined);
}
