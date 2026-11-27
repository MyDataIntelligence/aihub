import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packRoot } from "./pack.js";

/**
 * The team schema (skills/_shared/references/team.schema.yaml) as a tree: every key with its one-line explanation (the
 * comment after it), whether it is required, and the kind of value its example shows. `<name>` keys in the schema are
 * placeholders: any key the team chooses fits there (`*` in a path). A list of objects is `repositories[]`.
 */

export type KeyKind = "string" | "boolean" | "integer" | "list" | "object" | "objectList";

export interface SchemaNode {
  key: string;
  /** the path of the key: `branches.feature`, `repositories[].name`, `cherryPick.groups.*` */
  path: string;
  explain: string;
  required: boolean;
  kind: KeyKind;
  children: SchemaNode[];
}

export const SCHEMA_FILE = ["skills", "_shared", "references", "team.schema.yaml"];

let cached: SchemaNode | undefined;

/** The schema of the installed CLI (read once per process). */
export function teamSchema(): SchemaNode {
  if (!cached) cached = parseSchema(readFileSync(join(packRoot(), ...SCHEMA_FILE), "utf8"));
  return cached;
}

const cleanExplain = (comment: string): string => {
  const t = comment
    .replace(/^#\s*/, "")
    .replace(/\s*\((required|optional)[^)]*\)\s*$/i, "")
    .replace(/^(optional|required):\s*/i, "")
    .replace(/^(integer|list|string|boolean),\s*/i, "")
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

const kindOfExample = (value: string, comment: string): KeyKind => {
  const v = value.trim();
  if (/^(true|false)$/.test(v)) return "boolean";
  if (/^\d+$/.test(v) || /^#\s*integer/.test(comment)) return "integer";
  if (v.startsWith("[") || /^#\s*list\b/.test(comment)) return "list";
  return "string";
};

/** Parses the documented example into a tree. Keys that appear twice (a second `pullRequest:` block) are merged. */
export function parseSchema(text: string): SchemaNode {
  const root: SchemaNode = { key: "", path: "", explain: "", required: true, kind: "object", children: [] };
  const stack: { indent: number; node: SchemaNode }[] = [{ indent: -1, node: root }];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    const body = item ? item[2] : line.trimStart();
    const indent = item ? item[1].length : line.length - line.trimStart().length;
    const keyIndent = item ? indent + 2 : indent;
    const m = /^(<[^>]+>|[A-Za-z][A-Za-z0-9]*):(.*)$/.exec(body);
    while (stack.length > 1 && stack[stack.length - 1].indent >= (item ? indent + 1 : keyIndent)) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (!m) {
      // `- main`: a list of plain values
      if (item && parent !== root && parent.kind !== "objectList") parent.kind = "list";
      continue;
    }
    if (item) parent.kind = "objectList";
    const key = m[1].startsWith("<") ? "*" : m[1];
    const rest = m[2];
    const hash = rest.indexOf(" #") >= 0 ? rest.indexOf(" #") : rest.trimStart().startsWith("#") ? rest.indexOf("#") : -1;
    const value = hash >= 0 ? rest.slice(0, hash) : rest;
    const comment = hash >= 0 ? rest.slice(hash).trim() : "";
    const sep = parent.kind === "objectList" ? "[]." : ".";
    const path = parent === root ? key : `${parent.path}${sep}${key}`;
    let node = parent.children.find((c) => c.key === key);
    if (!node) {
      node = { key, path, explain: cleanExplain(comment), required: /\(required\b/.test(comment), kind: value.trim() ? kindOfExample(value, comment) : "object", children: [] };
      parent.children.push(node);
    } else if (!node.explain && comment) node.explain = cleanExplain(comment);
    stack.push({ indent: keyIndent, node });
  }
  return root;
}

/** The node of a path (`robot.targets.feature.branch` finds `robot.targets.*.branch`; list indexes are ignored). */
export function nodeAt(root: SchemaNode, segs: string[]): SchemaNode | undefined {
  let n: SchemaNode | undefined = root;
  for (const s of segs) {
    if (!n) return undefined;
    if (/^\d+$/.test(s) || s === "[]") continue; // a list index stays on the list node
    n = n.children.find((c) => c.key === s) ?? n.children.find((c) => c.key === "*");
  }
  return n;
}

/** The explanation of a dotted key (`branches.feature`, `repositories[0].defaultTarget`), or "". */
export function explainOf(root: SchemaNode, key: string): string {
  return nodeAt(root, splitKey(key))?.explain ?? "";
}

/** `repositories[0].defaultTarget` -> ["repositories", "0", "defaultTarget"] */
export const splitKey = (key: string): string[] => key.replace(/\[(\d*)\]/g, (_m, i: string) => `.${i || "0"}`).split(".").filter(Boolean);

/** Every key of the schema, flat, for an editor's key help ("keys at this level") and a client-side check while typing. */
export function schemaKeys(root: SchemaNode): { key: string; explain: string; required: boolean; kind: KeyKind }[] {
  const out: { key: string; explain: string; required: boolean; kind: KeyKind }[] = [];
  const walk = (n: SchemaNode) => {
    for (const c of n.children) {
      out.push({ key: c.path, explain: c.explain, required: c.required, kind: c.kind });
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** Levenshtein distance, small strings only. */
export function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) d[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return d[x.length][y.length];
}

/** The closest known key at a level, when it is close enough to be a typo. */
export function closestKey(key: string, known: string[]): string | undefined {
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(key, k);
    if (!best || d < best.d) best = { k, d };
  }
  if (!best) return undefined;
  const limit = Math.max(1, Math.min(3, Math.floor(key.length / 3)));
  return best.d <= limit || best.k.toLowerCase().startsWith(key.toLowerCase()) ? best.k : undefined;
}
