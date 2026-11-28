/**
 * The logging commands a step prints, read the way the Azure Pipelines agent reads them:
 * `##vso[task.setvariable variable=NAME;isOutput=true;issecret=true]VALUE`, `##vso[task.logissue type=error]text` and
 * `##vso[task.complete result=Failed]`. Properties may come in any order and any case.
 */
export interface SetVariable {
  name: string;
  value: string;
  secret: boolean;
  output: boolean;
}

export interface Issue {
  type: "error" | "warning";
  text: string;
}

export interface StepLog {
  variables: SetVariable[];
  issues: Issue[];
  /** task.complete result=Failed (or SucceededWithIssues) */
  result?: string;
}

const CMD = /##vso\[([A-Za-z.]+)((?:\s+[^\]]*)?)\](.*)$/;

function props(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.trim().split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

const yes = (v: string | undefined) => !!v && v.toLowerCase() === "true";

/** One output line; returns what it says (also adds it to `log`). */
export function readLine(line: string, log: StepLog): void {
  const m = CMD.exec(line.replace(/\r$/, ""));
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const p = props(m[2]);
  const body = m[3];
  if (cmd === "task.setvariable" && p.variable) log.variables.push({ name: p.variable, value: body, secret: yes(p.issecret), output: yes(p.isoutput) });
  else if (cmd === "task.logissue") log.issues.push({ type: (p.type ?? "").toLowerCase() === "warning" ? "warning" : "error", text: body.trim() });
  else if (cmd === "task.complete" && p.result) log.result = p.result;
}

export function readLog(text: string): StepLog {
  const log: StepLog = { variables: [], issues: [] };
  for (const l of text.split("\n")) readLine(l, log);
  return log;
}

/** Replaces every secret (longest first) by ***; secrets shorter than 3 characters are not masked (they would mask everything). */
export function masker(secrets: () => Iterable<string>): (s: string) => string {
  return (s: string) => {
    const list = [...new Set([...secrets()].filter((x) => x && x.length >= 3))].sort((a, b) => b.length - a.length);
    let t = s;
    for (const x of list) t = t.split(x).join("***");
    return t;
  };
}

/** A line a reader sees: logging commands that set a secret show *** as value. */
export function maskCommandLine(line: string): string {
  const m = CMD.exec(line);
  if (!m || m[1].toLowerCase() !== "task.setvariable" || !yes(props(m[2]).issecret)) return line;
  return line.slice(0, line.length - m[3].length) + "***";
}
