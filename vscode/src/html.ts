import { actionsFor } from "./actions";
import { ago, checksIcon, checksTone, fabricLabel, fabricTone, prLabel, short, type BarError, type BarModel, type Tone } from "./model";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const chip = (tone: Tone, icon: string, label: string, title: string, attrs = "") => `<span class="chip ${tone}" title="${esc(title)}"${attrs}><i class="codicon codicon-${icon}"></i>${esc(label)}</span>`;

const CSS = `
:root { --ok:#3fb950; --run:#4d8dff; --bad:#f85149; --warn:#d29922; }
body { margin:0; padding:6px 8px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-foreground); background:var(--vscode-panel-background); }
.row { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-bottom:6px; }
.chip { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 8px; border-radius:11px; border:1px solid var(--vscode-panel-border,#555); background:var(--vscode-editorWidget-background,transparent); white-space:nowrap; }
.chip.ok { color:var(--ok); border-color:var(--ok); } .chip.run { color:var(--run); border-color:var(--run); }
.chip.bad { color:var(--bad); border-color:var(--bad); } .chip.warn { color:var(--warn); border-color:var(--warn); }
.chip.muted { color:var(--vscode-descriptionForeground); }
.codicon { font-size:14px; }
.next { color:var(--vscode-descriptionForeground); margin:2px 0 8px; }
h4 { margin:8px 0 4px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--vscode-descriptionForeground); }
button { font:inherit; height:24px; padding:0 10px; border-radius:4px; cursor:pointer; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); border:1px solid transparent; }
button:hover { background:var(--vscode-button-secondaryHoverBackground); }
button.primary { color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
button.primary:hover { background:var(--vscode-button-hoverBackground); }
button.link { background:none; color:var(--vscode-textLink-foreground); padding:0 4px; }
table { border-collapse:collapse; width:100%; } td,th { text-align:left; padding:1px 8px 1px 0; font-size:12px; } th { color:var(--vscode-descriptionForeground); font-weight:normal; }
td.Failed { color:var(--bad); } td.Completed { color:var(--ok); } td.InProgress { color:var(--run); }
.err { border-left:3px solid var(--warn); padding:4px 8px; margin:4px 0; }
.muted { color:var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
const vs = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  vs.postMessage({ type: t.dataset.act, id: t.dataset.id });
});`;

export function renderError(err: BarError): string {
  const install = err.kind === "missing" || err.kind === "old";
  return `<div class="err">${esc(err.message)}</div><div class="row">${install ? `<button class="primary" data-act="installHelp">Show install command</button>` : ""}<button data-act="refresh">Try again</button><button class="link" data-act="openLog">Open log</button></div>`;
}

/** The body of the panel: chips, next step, actions, Fabric and events. Same data as the status bar, more room. */
export function renderBody(m: BarModel, now: number = Date.now()): string {
  const chips: string[] = [chip("muted", "git-branch", m.story ? `#${m.story.id} ${short(m.story.title, 40)}` : m.branch, `Branch ${m.branch}${m.story ? `, story state ${m.story.state}` : ""}`)];
  if (m.dirty) chips.push(chip("warn", "edit", "uncommitted", "There are uncommitted changes"));
  if (m.unpushed) chips.push(chip("warn", "cloud-upload", `${m.unpushed} to push`, "Commits not pushed yet"));
  if (m.pr) {
    chips.push(chip(m.pr.votes.rejected ? "bad" : m.pr.votes.approved ? "ok" : "muted", "git-pull-request", prLabel(m.pr), m.pr.title, ` data-act="openPr"`));
    chips.push(chip(checksTone(m.checks), checksIcon(m.checks).replace("~spin", ""), m.checks === "none" ? "no pipeline" : `pipeline ${m.checks}`, m.pipeline.map((p) => `${p.name}: ${p.state}`).join("\n") || "No pipeline run"));
    chips.push(chip(m.openThreads ? "warn" : "ok", "comment-discussion", `${m.openThreads} open thread${m.openThreads === 1 ? "" : "s"}`, "Open review threads"));
  }
  if (m.fabric) chips.push(chip(fabricTone(m.fabric), "database", `Fabric: ${fabricLabel(m.fabric)}`, `Workspace ${m.fabric.workspace}`));
  if (m.watching) chips.push(chip("muted", "eye", "watching", "aihub watch --mine is running"));

  const actions = actionsFor(m);
  const buttons = actions.map((a, i) => `<button class="${i === 0 ? "primary" : ""}" data-act="chat" data-id="${esc(a.id)}" title="Puts ${esc(a.text)} in your chat"><i class="codicon codicon-${a.icon}"></i> ${esc(a.label)}</button>`).join(" ");

  const fabric = m.fabric
    ? `<h4>Fabric: ${esc(m.fabric.workspace)}</h4>${m.fabric.cause ? `<div class="err">${esc(short(m.fabric.cause, 240))}</div>` : ""}${
        m.fabric.runs.length
          ? `<table><tr><th>item</th><th>status</th><th>duration</th><th>first error</th></tr>${m.fabric.runs
              .slice(0, 6)
              .map((r) => `<tr><td>${esc(r.item)}</td><td class="${esc(r.status)}">${esc(r.status)}</td><td>${esc(r.duration ?? "")}</td><td class="muted">${esc(short(r.error ?? "", 80))}</td></tr>`)
              .join("")}</table>`
          : `<div class="muted">No runs in the last 24 hours.</div>`
      }`
    : "";

  const events = m.events.length ? `<h4>Events (aihub watch --mine)</h4>${m.events.map((e) => `<div>${esc(short(e.message, 160))} <span class="muted">${ago(e.at, now)}</span></div>`).join("")}` : "";
  const warn = m.warnings.length ? `<div class="err">${m.warnings.map((w) => esc(short(w, 200))).join("<br>")}</div>` : "";

  return `<div class="row">${chips.join("")}</div>${m.next ? `<div class="next">Next: ${esc(m.next)}</div>` : ""}${warn}<div class="row">${buttons}</div>
<div class="row"><button class="link" data-act="refresh"><i class="codicon codicon-refresh"></i> Refresh</button>${m.pr ? `<button class="link" data-act="openPr">Open PR in browser</button>` : ""}<button class="link" data-act="openLog">Open log</button><span class="muted">updated ${ago(m.updatedAt, now)}</span></div>${fabric}${events}`;
}

export function renderPage(body: string, nonce: string, cspSource: string, codiconCss: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${codiconCss}"><style nonce="${nonce}">${CSS}</style></head><body><div id="app">${body}</div><script nonce="${nonce}">${SCRIPT}
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'render') document.getElementById('app').innerHTML = e.data.html; });
</script></body></html>`;
}
