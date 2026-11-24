/** Pure parts of "Run Robot Test": the test cases for the CodeLens (0-based lines) and the result message. */

export function robotTestLines(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  let inTests = false;
  text.split(/\r?\n/).forEach((l, i) => {
    const section = /^\*{3}\s*(.+?)\s*\*{3}/.exec(l);
    if (section) return void (inTests = /^(test cases?|tasks?)$/i.test(section[1]));
    if (!inTests || !l.trim() || /^\s/.test(l) || l.startsWith("#") || l.startsWith("...")) return;
    out.push({ name: l.split(/\s{2,}|\t/)[0].trim(), line: i });
  });
  return out;
}

export interface RobotResult {
  status: "PASS" | "FAIL";
  pass: number;
  fail: number;
  skip: number;
  failed: { name: string; message: string }[];
  log?: string;
  report?: string;
}

export function resultMessage(r: RobotResult | null, exitCode: number | undefined): string {
  if (!r) return `Robot run ended with exit code ${exitCode ?? "?"} and wrote no output.xml.`;
  const counts = [`${r.pass} passed`, r.fail ? `${r.fail} failed` : "", r.skip ? `${r.skip} skipped` : ""].filter(Boolean).join(", ");
  const failed = r.failed.slice(0, 3).map((f) => `${f.name}${f.message ? ` (${f.message.slice(0, 80)})` : ""}`).join("; ");
  return `Robot ${r.status}: ${counts}.${failed ? ` Failed: ${failed}` : ""}`;
}
