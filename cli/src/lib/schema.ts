/**
 * The team schema file is a documented YAML example: every key carries a comment ending in "(required)" or "(optional)".
 * This reads those comments to find the required key paths (lists are written `repositories[].name`).
 */
export function requiredPaths(schemaText: string): string[] {
  const stack: { indent: number; key: string; isList: boolean }[] = [];
  const out: string[] = [];
  for (const line of schemaText.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^(\s*)(-\s+)?([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const keyIndent = m[1].length + (m[2]?.length ?? 0);
    while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    if (m[2] && stack.length) stack[stack.length - 1].isList = true;
    stack.push({ indent: keyIndent, key: m[3], isList: false });
    const comment = m[4].includes("#") ? m[4].slice(m[4].indexOf("#")) : "";
    if (/\(required\b/.test(comment)) out.push(stack.map((s) => s.key + (s.isList ? "[]" : "")).join("."));
  }
  return out;
}

const get = (value: unknown, seg: string): unknown[] => {
  const isList = seg.endsWith("[]");
  const key = isList ? seg.slice(0, -2) : seg;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const v = (value as Record<string, unknown>)[key];
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return [];
  return isList ? (Array.isArray(v) ? v : []) : [v];
};

/** Human-readable problems of a parsed team file against the required paths; empty when valid. */
export function validateTeam(data: unknown, required: string[]): string[] {
  const problems: string[] = [];
  for (const path of required) {
    const segs = path.split(".");
    let level: unknown[] = [data];
    let missing = false;
    for (const s of segs) {
      const next = level.flatMap((v) => get(v, s));
      if (s.endsWith("[]") ? !next.length : next.length < level.length || !next.length) missing = true;
      level = next;
      if (missing) break;
    }
    if (missing) problems.push(`missing ${path}`);
  }
  const v = (data as Record<string, unknown> | null)?.version;
  if (v !== undefined && !Number.isInteger(v)) problems.push("version must be an integer");
  return problems;
}
