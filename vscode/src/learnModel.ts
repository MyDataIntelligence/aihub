/** Learn in the extension: the lesson as JSON from `aihub learn show --json`, rendered as one page, and the tour steps. No vscode here. */

export interface LessonMeta {
  id: string;
  title: string;
  savedAt: string;
  repo: string;
  source: { pr?: number; branch?: string; range?: string };
  concepts: number;
  quiz: number;
}

export interface HunkReason {
  path: string;
  line: number;
  reason: string;
  before?: string;
  how?: string;
  withoutIt?: string;
  pattern?: string;
  whenToUse?: string;
  watchOut?: string;
  analogy?: string;
  askYourself?: { question: string; answer: string };
  findings?: { severity: string; text: string; suggestion?: string }[];
}

export interface Explanation {
  oneSentence: string;
  before: string;
  after: string;
  diagram: { before: string; after: string };
  diagrams?: { title: string; kind: string; mermaid: string }[];
  designChoices?: { choice: string; alternatives: { option: string; whyNot: string }[] }[];
  tellAColleague?: string[];
  risks?: string[];
  quiz?: { question: string; options: string[]; answerIndex: number; explanation: string }[];
  concepts?: { name: string; eli5: string; exampleFromThisChange: string }[];
  hunkReasons?: HunkReason[];
}

export interface Lesson {
  meta: LessonMeta;
  explanation: Explanation;
  facts?: { files?: { path: string; additions: number; deletions: number; status: string }[]; impact?: { callers?: { symbol: string; file: string; line: number }[]; tests?: { file: string }[] } };
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const repoPath = (p: string) => p.replace(/^[\\/]+/, "").replace(/\\/g, "/");

const list = (items: string[] | undefined) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

/** A Mermaid diagram: the source stays in the page as text, the bundled mermaid draws it. */
const diagram = (title: string, src: string) => `<figure><figcaption>${esc(title)}</figcaption><pre class="mermaid">${esc(src)}</pre></figure>`;

/** The body of the explanation page: pictures first, then what changed, who is affected, risks, quiz, concepts. */
export function lessonBody(l: Lesson): string {
  const e = l.explanation;
  const out: string[] = [];
  out.push(`<h1>${esc(e.oneSentence)}</h1><p class="muted">${esc(l.meta.repo)}${l.meta.source.pr ? ` · PR !${l.meta.source.pr}` : ""}${l.meta.source.branch ? ` · ${esc(l.meta.source.branch)}` : ""} · ${esc(l.meta.savedAt.slice(0, 10))}</p>`);
  out.push(`<div class="pair"><section><h2>Before</h2><p>${esc(e.before)}</p>${diagram("How it worked", e.diagram.before)}</section><section><h2>After</h2><p>${esc(e.after)}</p>${diagram("How it works now", e.diagram.after)}</section></div>`);
  for (const d of e.diagrams ?? []) out.push(`<section>${diagram(`${d.title} (${d.kind})`, d.mermaid)}</section>`);
  if (e.hunkReasons?.length) {
    out.push(`<section><h2>What changed, and why</h2><ol class="steps">${e.hunkReasons
      .map((h, i) => `<li><a href="#" data-open="${esc(repoPath(h.path))}" data-line="${h.line}" title="Open the file">${esc(repoPath(h.path))}${h.line ? `:${h.line}` : ""}</a> ${esc(h.reason)}${h.how ? `<div class="detail">${esc(h.how)}</div>` : ""}${(h.findings ?? []).map((f) => `<div class="finding ${esc(f.severity)}">${esc(f.severity)}: ${esc(f.text)}</div>`).join("")}</li>`)
      .join("")}</ol><button data-tour="1">Start the guided tour</button></section>`);
  }
  const callers = l.facts?.impact?.callers ?? [];
  if (callers.length || l.facts?.impact?.tests?.length) {
    out.push(`<section><h2>Who is affected</h2>${callers.length ? `<ul>${callers.slice(0, 10).map((c) => `<li><a href="#" data-open="${esc(c.file)}" data-line="${c.line}">${esc(c.file)}:${c.line}</a> uses <code>${esc(c.symbol)}</code></li>`).join("")}</ul>` : ""}${l.facts?.impact?.tests?.length ? `<p>${l.facts.impact.tests.length} test reference(s).</p>` : ""}</section>`);
  }
  if (e.designChoices?.length) out.push(`<section><h2>Design choices</h2>${e.designChoices.map((c) => `<p><b>${esc(c.choice)}</b></p><ul>${c.alternatives.map((a) => `<li>${esc(a.option)}: not chosen, ${esc(a.whyNot)}</li>`).join("")}</ul>`).join("")}</section>`);
  if (e.tellAColleague?.length) out.push(`<section><h2>Tell a colleague</h2>${list(e.tellAColleague)}</section>`);
  if (e.risks?.length) out.push(`<section><h2>Risks</h2>${list(e.risks)}</section>`);
  if (e.quiz?.length) {
    out.push(`<section><h2>Check yourself</h2>${e.quiz
      .map((q, qi) => `<div class="q" data-answer="${q.answerIndex}"><p><b>${qi + 1}. ${esc(q.question)}</b></p>${q.options.map((o, oi) => `<button class="opt" data-q="${qi}" data-o="${oi}">${esc(o)}</button>`).join("")}<div class="why" hidden>${esc(q.explanation)}</div></div>`)
      .join("")}<p class="score muted"></p></section>`);
  }
  if (e.concepts?.length) out.push(`<section><h2>Concepts</h2>${e.concepts.map((c) => `<p><b>${esc(c.name)}</b>: ${esc(c.eli5)}<br><span class="muted">In this change: ${esc(c.exampleFromThisChange)}</span> <button class="link" data-learned="${esc(c.name)}">I know this</button></p>`).join("")}</section>`);
  return out.join("");
}

const CSS = `
body { font-family:var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:12px 24px; max-width:1100px; line-height:1.45; }
h1 { font-size:1.5em; margin:.2em 0; } h2 { font-size:1.1em; margin:1.2em 0 .4em; border-bottom:1px solid var(--vscode-panel-border); padding-bottom:3px; }
.muted { color:var(--vscode-descriptionForeground); } .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; } @media (max-width:800px) { .pair { grid-template-columns:1fr; } }
figure { margin:6px 0; padding:8px; border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-editorWidget-background); } figcaption { font-size:.85em; color:var(--vscode-descriptionForeground); }
.node.changed rect, .node.changed polygon { stroke:#d39e00 !important; } .node.changed .nodeLabel, .node.changed text, .node.changed span { fill:#1e1f22 !important; color:#1e1f22 !important; }
pre.mermaid { background:transparent; margin:0; text-align:center; }
.steps li { margin:6px 0; } .detail { color:var(--vscode-descriptionForeground); font-size:.92em; }
.finding { margin:2px 0; padding:2px 6px; border-left:3px solid var(--vscode-editorWarning-foreground); } .finding.blocker, .finding.major { border-color:var(--vscode-editorError-foreground); }
a { color:var(--vscode-textLink-foreground); } code { font-family:var(--vscode-editor-font-family); }
button { font:inherit; padding:3px 10px; margin:2px 4px 2px 0; border-radius:4px; cursor:pointer; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); border:1px solid transparent; }
button:hover { background:var(--vscode-button-secondaryHoverBackground); } button.link { background:none; color:var(--vscode-textLink-foreground); }
button.right { border-color:#3fb950; } button.wrong { border-color:#f85149; } .why { margin:4px 0 12px; color:var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
const vs = acquireVsCodeApi();
const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict', flowchart: { useMaxWidth: true, htmlLabels: false }, fontFamily: css('--vscode-font-family') || 'sans-serif',
  themeVariables: { darkMode: dark, background: css('--vscode-editor-background'), primaryColor: dark ? '#2b3a55' : '#dbe7ff', primaryTextColor: css('--vscode-foreground'), primaryBorderColor: '#4d8dff', secondaryColor: dark ? '#33415c' : '#e8eefc', tertiaryColor: css('--vscode-editorWidget-background'), lineColor: css('--vscode-foreground'), textColor: css('--vscode-foreground'), edgeLabelBackground: css('--vscode-editor-background'), nodeBorder: '#4d8dff', clusterBkg: css('--vscode-editorWidget-background') } });
mermaid.run({ querySelector: 'pre.mermaid' }).catch((e) => { document.querySelectorAll('pre.mermaid:not([data-processed])').forEach((p) => { p.insertAdjacentHTML('afterend', '<p class="muted">This picture could not be drawn (' + String(e && e.message || e).slice(0, 80) + ').</p>'); }); });
let right = 0, answered = 0; const total = document.querySelectorAll('.q').length;
document.addEventListener('click', (e) => {
  const t = e.target.closest('button,a'); if (!t) return;
  if (t.dataset.open) { e.preventDefault(); vs.postMessage({ type: 'open', path: t.dataset.open, line: Number(t.dataset.line) || 0 }); }
  if (t.dataset.tour) vs.postMessage({ type: 'tour' });
  if (t.dataset.learned) { vs.postMessage({ type: 'learned', name: t.dataset.learned }); t.textContent = 'Marked'; t.disabled = true; }
  if (t.classList.contains('opt')) {
    const q = t.closest('.q'); if (q.dataset.done) return; q.dataset.done = '1';
    const ok = Number(t.dataset.o) === Number(q.dataset.answer);
    t.classList.add(ok ? 'right' : 'wrong');
    if (!ok) q.querySelectorAll('.opt')[Number(q.dataset.answer)].classList.add('right');
    q.querySelector('.why').hidden = false; answered++; if (ok) right++;
    if (answered === total) { document.querySelector('.score').textContent = 'Score: ' + right + '/' + total; vs.postMessage({ type: 'score', correct: right, of: total }); }
  }
});`;

export function lessonPage(l: Lesson, nonce: string, cspSource: string, mermaidUri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src ${cspSource} 'nonce-${nonce}'; img-src ${cspSource} data:;"><style>${CSS}</style></head><body>${lessonBody(l)}<script src="${mermaidUri}"></script><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

// ---- the tour ------------------------------------------------------------------------------------

export interface TourStep {
  path: string;
  line: number;
  title: string;
  detail: string;
}

/** One stop per changed piece, in the order the explanation gives them. Pieces without a line stop at the top of the file. */
export function tourSteps(l: Lesson): TourStep[] {
  return (l.explanation.hunkReasons ?? []).map((h) => ({
    path: repoPath(h.path),
    line: Math.max(1, h.line || 1),
    title: h.reason,
    detail: [h.before && `Before: ${h.before}`, h.how && `How: ${h.how}`, h.withoutIt && `Without it: ${h.withoutIt}`, h.watchOut && `Watch out: ${h.watchOut}`, h.askYourself && `Ask yourself: ${h.askYourself.question}`].filter(Boolean).join("  "),
  }));
}

export const lessonLabel = (m: LessonMeta) => (m.source.pr ? `PR !${m.source.pr}` : (m.source.branch ?? m.id));
