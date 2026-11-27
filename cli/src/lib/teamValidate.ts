import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { closestKey, nodeAt, teamSchema, type SchemaNode } from "./teamSchema.js";

/**
 * `aihub team validate`: the problems of a team.yaml text, each with its line, a plain explanation and, when there is one
 * obvious repair, the fix (rename a key, use true/false). YAML errors, unknown keys and wrong types are errors; a template
 * path that points to a missing file and a missing required key are warnings (a warning never blocks a save).
 */

export interface Problem {
  severity: "error" | "warning";
  /** yaml | unknownKey | type | missingFile | missingKey */
  code: string;
  /** 1-based */
  line: number;
  col: number;
  /** the dotted key the problem is about (`robot.targets.feature.mergeMyBranchFirst`) */
  key?: string;
  message: string;
  /** one obvious repair */
  fix?: { label: string; replace?: { line: number; from: string; to: string }; createFromPack?: string };
  /** unknown key: the keys allowed at this level, for the key help */
  known?: string[];
  closest?: string;
}

export interface ValidateResult {
  ok: boolean;
  errors: number;
  warnings: number;
  problems: Problem[];
}

const YES = /^(ja|yes|y|on|waar|true|1)$/i;
const NO = /^(nee|no|n|off|onwaar|false|0)$/i;

const keyName = (n: unknown): string => (isScalar(n) ? String(n.value) : String(n));

export const isTemplateKey = (dotted: string): boolean => dotted === "pullRequest.template" || dotted === "workItems.storyTemplate" || /^workItems\.templates\.[^.]+$/.test(dotted);

export interface ValidateOpts {
  schema?: SchemaNode;
  /** false when a template file is known to be missing; undefined when it cannot be told (offline) */
  fileExists?: (path: string) => boolean | undefined;
  /** the team pack has this file: the warning offers "Create from the team pack" */
  packHas?: (path: string) => boolean;
}

export function validateTeamText(text: string, o: ValidateOpts = {}): ValidateResult {
  const schema = o.schema ?? teamSchema();
  const lc = new LineCounter();
  const doc = parseDocument(text.replace(/\r\n/g, "\n"), { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  const problems: Problem[] = [];
  const pos = (offset: number | undefined) => {
    const p = lc.linePos(offset ?? 0);
    return { line: p.line, col: p.col };
  };
  for (const e of doc.errors) problems.push({ severity: "error", code: "yaml", ...pos(e.pos?.[0]), message: e.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "") });

  const walk = (node: Node | null | undefined, schemaNode: SchemaNode | undefined, path: string[]) => {
    if (!node || !schemaNode) return;
    if (isSeq(node)) {
      if (schemaNode.kind === "objectList") for (const it of node.items) walk(it as Node, schemaNode, path);
      return;
    }
    if (!isMap(node)) return;
    const known = schemaNode.children.filter((c) => c.key !== "*").map((c) => c.key);
    const wildcard = schemaNode.children.find((c) => c.key === "*");
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const k = keyName(pair.key);
      const at = pos((pair.key as Node | null)?.range?.[0]);
      const child = schemaNode.children.find((c) => c.key === k) ?? wildcard;
      const dotted = [...path, k].join(".");
      if (!child) {
        const closest = closestKey(k, known);
        problems.push({
          severity: "error",
          code: "unknownKey",
          ...at,
          key: dotted,
          message: closest ? `Unknown key "${k}". Did you mean "${closest}"?` : `Unknown key "${k}": the keys at this level are ${known.join(", ")}`,
          closest,
          known,
          ...(closest ? { fix: { label: "Rename", replace: { line: at.line, from: `${k}:`, to: `${closest}:` } } } : {}),
        });
        continue;
      }
      const v = pair.value as Node | null;
      if (child.kind === "boolean" && isScalar(v) && typeof v.value !== "boolean" && v.value !== null) {
        const raw = String(v.value);
        const to = YES.test(raw) ? "true" : NO.test(raw) ? "false" : undefined;
        const vp = pos(v.range?.[0]);
        problems.push({
          severity: "error",
          code: "type",
          ...vp,
          key: dotted,
          message: `${k} must be true or false, found "${raw}"`,
          ...(to ? { fix: { label: `Use ${to}`, replace: { line: vp.line, from: raw, to } } } : {}),
        });
      } else if (child.kind === "integer" && isScalar(v) && !Number.isInteger(v.value)) {
        problems.push({ severity: "error", code: "type", ...pos(v.range?.[0]), key: dotted, message: `${k} must be a whole number, found "${String(v.value)}"` });
      } else if (isTemplateKey(dotted) && isScalar(v) && typeof v.value === "string" && v.value.trim() && o.fileExists?.(v.value.trim()) === false) {
        const file = v.value.trim();
        problems.push({
          severity: "warning",
          code: "missingFile",
          ...pos(v.range?.[0]),
          key: dotted,
          message: `${dotted} points to a file that is not in the team repository: ${file}`,
          ...(o.packHas?.(file) ? { fix: { label: "Create from the team pack", createFromPack: file } } : {}),
        });
      }
      walk(v, child, [...path, k]);
    }
  };
  if (!doc.errors.length) walk(doc.contents as Node, schema, []);

  // required top-level keys: warnings (an older file still works with the defaults)
  if (!doc.errors.length && isMap(doc.contents)) {
    const top = new Set(doc.contents.items.map((p) => keyName((p as { key: unknown }).key)));
    for (const c of schema.children) if (c.required && !top.has(c.key)) problems.push({ severity: "warning", code: "missingKey", line: 1, col: 1, key: c.key, message: `${c.key} is missing: ${c.explain || "required by the schema"}` });
  }
  problems.sort((a, b) => a.line - b.line || a.col - b.col);
  const errors = problems.filter((p) => p.severity === "error").length;
  return { ok: errors === 0, errors, warnings: problems.length - errors, problems };
}

/** The keys allowed at the level of a dotted key, for the key help of an editor. */
export function keysAtLevel(dotted: string, schema: SchemaNode = teamSchema()): string[] {
  const n = nodeAt(schema, dotted.split(".").slice(0, -1));
  return (n?.children ?? []).filter((c) => c.key !== "*").map((c) => c.key);
}

export function formatProblems(r: ValidateResult, file: string): string[] {
  if (!r.problems.length) return [`${file}: valid`];
  return [
    ...r.problems.map((p) => `${file}:${p.line}:${p.col} ${p.severity}: ${p.message}${p.fix ? ` (fix: ${p.fix.label})` : ""}`),
    `${r.errors} error(s), ${r.warnings} warning(s)${r.errors ? "; fix the errors before saving" : ""}`,
  ];
}
