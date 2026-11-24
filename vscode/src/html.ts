import { actionsFor } from "./actions";
import { setChip } from "./repoSetModel";
import { checksIcon, checksTone, fabricLabel, fabricTone, short, type BarError, type BarModel, type Tone } from "./model";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The bar is one thin strip like the old Workflow bar (30 px, 22 px chips): a main button with its menu, the state
 * chips, then refresh and "...". Detail (reviewers, Fabric runs, events, all actions) opens in a native pick list.
 */

const style: Record<Tone, string> = { ok: "success", run: "running", bad: "failure", warn: "gold", muted: "neutral" };

interface ChipOpts {
  tone: Tone;
  icon: string;
  label?: string;
  title: string;
  id: string;
  badge?: number;
  /** An icon-only square chip. */
  square?: boolean;
  /** A chip whose label may be longer (the set chip names the group and the branch). */
  wide?: boolean;
}

const chip = (o: ChipOpts) =>
  `<span class="bar-chip style-${style[o.tone]}${o.square ? " square" : ""}${o.wide ? " wide" : ""}" tabindex="0" role="button" data-act="chip" data-id="${o.id}" title="${esc(o.title)}"><i class="codicon codicon-${o.icon}"></i>${o.label ? `<span class="lbl">${esc(o.label)}</span>` : ""}${o.badge ? `<span class="bar-badge">${o.badge}</span>` : ""}</span>`;

const sep = `<span class="bar-separator"></span>`;

/** The first chip: a local action, so it is there even when the status cannot be read (no Azure DevOps remote, not a repository). */
const reposetChip = () =>
  chip({ tone: "run", icon: "repo-forked", label: "Open Repo Set", title: "Open several repositories on the same branch in one window (worktrees or switch)", id: "reposet" }) +
  `<span class="bar-zone" tabindex="0" role="button" data-act="chip" data-id="reposet" title="Open repositories on a branch"><i class="codicon codicon-chevron-down"></i></span>`;

const CSS = `
:root { --bar-text:#dfe1e5; --bar-muted:#9da0a8; --bar-line:#4e5157; --bar-hover:rgba(255,255,255,.063); --bar-accent:#3574f0;
  --gold-fg:#f2c55c; --gold-bg:#3a321f; --gold-line:#5c4d27; --run-fg:#548af7; --run-bg:#25324d; --run-line:#35538f;
  --ok-fg:#5fad65; --ok-bg:#253627; --ok-line:#375239; --bad-fg:#e55765; --bad-bg:#402929; --bad-line:#5e3838; }
body.vscode-light { --bar-text:#1e1f22; --bar-muted:#6c707e; --bar-line:#c9ccd6; --bar-hover:rgba(0,0,0,.055); --gold-fg:#8a6100; --gold-bg:#fff4d6; --gold-line:#f0d58c;
  --run-fg:#3574f0; --run-bg:#edf3ff; --run-line:#b7cdf9; --ok-fg:#208a3c; --ok-bg:#edf8ef; --ok-line:#b4ddbd; --bad-fg:#c7253a; --bad-bg:#fff0f1; --bad-line:#f5c2c8; }
html, body { margin:0; padding:0; background:var(--vscode-panel-background); }
.bar-row { display:flex; align-items:center; height:30px; padding:0 4px; overflow:hidden; white-space:nowrap; font-family:var(--vscode-font-family,'Segoe UI',sans-serif);
  font-size:13px; color:var(--bar-text); }
.bar-separator { width:1px; height:16px; margin:0 5px; background:var(--bar-line); flex:none; }
.bar-chip { position:relative; display:inline-flex; align-items:center; gap:5px; flex:none; height:22px; margin:0 2px; padding:0 7px; box-sizing:border-box;
  border:1px solid transparent; border-radius:4px; cursor:pointer; user-select:none; color:var(--bar-text); }
.bar-chip:hover { background-image:linear-gradient(var(--bar-hover),var(--bar-hover)); }
.bar-chip:focus-visible { outline:2px solid var(--vscode-focusBorder,var(--bar-accent)); outline-offset:1px; }
.bar-chip.square { width:26px; padding:0; justify-content:center; }
.bar-chip .lbl { overflow:hidden; text-overflow:ellipsis; max-width:190px; }
.bar-chip.wide .lbl { max-width:340px; }
.bar-chip .codicon { font-size:14px; }
.style-neutral { border-color:var(--bar-line); }
.style-gold { color:var(--gold-fg); background-color:var(--gold-bg); border-color:var(--gold-line); }
.style-running { color:var(--run-fg); background-color:var(--run-bg); border-color:var(--run-line); }
.style-success { color:var(--ok-fg); background-color:var(--ok-bg); border-color:var(--ok-line); }
.style-failure { color:var(--bad-fg); background-color:var(--bad-bg); border-color:var(--bad-line); }
.style-hand { color:#fff; background-color:var(--bar-accent); border-color:var(--bar-accent); font-weight:600; border-radius:4px 0 0 4px; margin-right:0; }
.bar-zone { display:inline-flex; align-items:center; justify-content:center; flex:none; height:22px; width:18px; margin:0 6px 0 0; box-sizing:border-box;
  background:var(--bar-accent); color:#fff; border-radius:0 4px 4px 0; border-left:1px solid rgba(255,255,255,.35); cursor:pointer; }
.bar-zone:hover { filter:brightness(1.12); }
.bar-zone .codicon { font-size:12px; }
.bar-badge { position:absolute; top:-3px; right:-3px; min-width:13px; height:13px; padding:0 3px; border-radius:7px; background:var(--bar-accent); color:#fff;
  font-size:9px; line-height:13px; text-align:center; font-weight:700; box-sizing:border-box; }
.grow { flex:1 1 auto; min-width:4px; }
.bar-msg { color:var(--gold-fg); overflow:hidden; text-overflow:ellipsis; margin:0 6px; }
`;

const SCRIPT = `
const vs = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const r = t.getBoundingClientRect();
  vs.postMessage({ type: t.dataset.act, id: t.dataset.id });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { const t = e.target.closest('[data-act]'); if (t) { e.preventDefault(); t.click(); } } });`;

const tail = `<span class="grow"></span>${chip({ tone: "muted", icon: "refresh", title: "Refresh the status", id: "refresh", square: true }).replace("style-neutral", "style-plain")}${chip({ tone: "muted", icon: "ellipsis", title: "More: all actions, open the PR, log, settings", id: "menu", square: true }).replace("style-neutral", "style-plain")}`;

export function renderError(err: BarError): string {
  const fix = err.kind === "missing" || err.kind === "old";
  return `<div class="bar-row">${reposetChip()}${sep}<span class="bar-chip style-gold" title="${esc(err.message)}"><i class="codicon codicon-warning"></i><span class="lbl">${esc(short(err.message, 90))}</span></span>${fix ? chip({ tone: "run", icon: "copy", label: "Install command", title: "Copy: npm i -g @ferronhooi/aihub", id: "installHelp" }) : ""}${tail}</div>`;
}

/** The whole strip. */
export function renderBody(m: BarModel, _now: number = Date.now()): string {
  const actions = actionsFor(m);
  const main = actions[0];
  const out: string[] = [];
  // the first chip: several repositories on one branch at once (a local action, not a chat action)
  out.push(reposetChip());
  out.push(sep);
  out.push(`<span class="bar-chip style-hand" tabindex="0" role="button" data-act="chat" data-id="${esc(main.id)}" title="${esc(`${main.label}: puts ${main.text.length > 40 ? "a prompt" : main.text} in your chat with the aihub agent`)}"><i class="codicon codicon-${main.icon}"></i><span class="lbl">${esc(main.short)}</span></span><span class="bar-zone" tabindex="0" role="button" data-act="menu" title="All actions"><i class="codicon codicon-chevron-down"></i></span>`);
  out.push(sep);
  out.push(chip({ tone: "muted", icon: "git-branch", label: m.story ? `#${m.story.id} ${short(m.story.title, 22)}` : short(m.branch, 28), title: `${m.story ? `Story #${m.story.id} (${m.story.state}): ${m.story.title}\n` : ""}Branch ${m.branch}${m.next ? `\nNext: ${m.next}` : ""}`, id: "story" }));
  const sc = setChip(m.set);
  if (sc) out.push(chip({ tone: "ok", icon: "repo-forked", label: sc.label, title: sc.title, id: "set", wide: true }));
  if (m.dirty) out.push(chip({ tone: "warn", icon: "edit", title: "Uncommitted changes", id: "story", square: true }));
  if (m.unpushed) out.push(chip({ tone: "warn", icon: "cloud-upload", label: String(m.unpushed), title: `${m.unpushed} commit(s) not pushed`, id: "story" }));
  if (m.pr) {
    const v = m.pr.votes;
    const vt: Tone = v.rejected ? "bad" : v.approved ? "ok" : v.waiting ? "warn" : "muted";
    const vlabel = [v.approved ? `${v.approved}✓` : "", v.waiting ? `${v.waiting}⏳` : "", v.rejected ? `${v.rejected}✗` : ""].filter(Boolean).join(" ");
    out.push(chip({ tone: vt, icon: "git-pull-request", label: `!${m.pr.id}${m.pr.draft ? " draft" : m.pr.status !== "active" ? ` ${m.pr.status}` : ""}${vlabel ? ` ${vlabel}` : ""}`, title: `PR !${m.pr.id}: ${m.pr.title}\nVotes: ${v.summary}`, id: "pr" }));
    out.push(chip({ tone: checksTone(m.checks), icon: checksIcon(m.checks).replace("~spin", ""), label: m.checks === "none" ? undefined : m.checks, title: m.pipeline.map((p) => `${p.name}: ${p.state}`).join("\n") || "No pipeline run for this PR", id: "pipeline", square: m.checks === "none" }));
    if (m.openThreads) out.push(chip({ tone: "warn", icon: "comment-discussion", label: String(m.openThreads), title: `${m.openThreads} open review thread(s)`, id: "threads" }));
  }
  if (m.fabric) out.push(chip({ tone: fabricTone(m.fabric), icon: "database", label: fabricLabel(m.fabric), title: `Fabric workspace ${m.fabric.workspace}`, id: "fabric" }));
  if (m.events.length) out.push(chip({ tone: "muted", icon: "bell", badge: m.events.length, title: m.events.slice(0, 3).map((e) => e.message).join("\n"), id: "events", square: true }));
  if (m.warnings.length) out.push(chip({ tone: "warn", icon: "warning", title: m.warnings.join("\n"), id: "warnings", square: true }));
  return `<div class="bar-row">${out.join("")}${tail}</div>`;
}

export function renderPage(body: string, nonce: string, cspSource: string, codiconCss: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${codiconCss}"><style nonce="${nonce}">${CSS}</style></head><body><div id="app">${body}</div><script nonce="${nonce}">${SCRIPT}
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'render') document.getElementById('app').innerHTML = e.data.html; });
</script></body></html>`;
}
