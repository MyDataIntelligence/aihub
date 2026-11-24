/** Just enough markdown for the performance report in a webview: headings, paragraphs, tables, lists, quotes, bold and code. */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
const cells = (row: string) =>
  row
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (l.startsWith("|") && /^\|[-:| ]+\|$/.test(lines[i + 1] ?? "")) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") && !c.startsWith(":") ? "right" : c.startsWith(":") && c.endsWith(":") ? "center" : "left"));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      out.push(
        `<table><thead><tr>${head.map((c, k) => `<th style="text-align:${align[k] ?? "left"}">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c, k) => `<td style="text-align:${align[k] ?? "left"}">${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^- /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      i--;
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (l.startsWith("> ")) {
      out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
      continue;
    }
    out.push(`<p>${inline(l)}</p>`);
  }
  return out.join("\n");
}
