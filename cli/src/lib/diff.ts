/** Small line diff (LCS) for review output; not a general diff tool. */
export interface DiffStat {
  added: number;
  removed: number;
  text: string;
}

const CONTEXT = 2;
const MAX_CELLS = 4_000_000;

export function diffLines(oldText: string, newText: string, maxLines = 150): DiffStat {
  const a = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");
  // trim common prefix/suffix to keep the table small
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) (ea--, eb--);
  const x = a.slice(s, ea);
  const y = b.slice(s, eb);
  const ops: { t: " " | "+" | "-"; line: string; n: number }[] = [];
  for (let i = 0; i < s; i++) ops.push({ t: " ", line: a[i], n: i + 1 });
  if (x.length * y.length > MAX_CELLS) {
    x.forEach((l, i) => ops.push({ t: "-", line: l, n: s + i + 1 }));
    y.forEach((l, i) => ops.push({ t: "+", line: l, n: s + i + 1 }));
  } else {
    const w = y.length + 1;
    const t = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) (ops.push({ t: " ", line: x[i], n: s + j + 1 }), i++, j++);
      else if (j < y.length && (i === x.length || t[i * w + j + 1] >= t[(i + 1) * w + j])) (ops.push({ t: "+", line: y[j], n: s + j + 1 }), j++);
      else (ops.push({ t: "-", line: x[i], n: s + i + 1 }), i++);
    }
  }
  for (let i = ea; i < a.length; i++) ops.push({ t: " ", line: a[i], n: i + 1 });
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push("  ...");
    gap = false;
    out.push(`${o.t} ${String(o.n).padStart(4)} ${o.line}`);
  });
  const shown = out.length > maxLines ? [...out.slice(0, maxLines), `  ... ${out.length - maxLines} more lines`] : out;
  return {
    added: ops.filter((o) => o.t === "+").length,
    removed: ops.filter((o) => o.t === "-").length,
    text: shown.join("\n"),
  };
}
