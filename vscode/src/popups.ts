import { actionsFor } from "./actions";
import { ago, short, type BarModel } from "./model";

/** What a chip opens: a native pick list. Detail lives here, not in the bar. Pure, so it can be tested. */

export type Run = { kind: "chat"; id: string } | { kind: "command"; id: string } | { kind: "none" };

export interface PopupItem {
  label: string;
  description?: string;
  detail?: string;
  run: Run;
  separator?: boolean;
}

export interface Popup {
  title: string;
  items: PopupItem[];
}

const info = (label: string, description?: string, detail?: string): PopupItem => ({ label, description, detail, run: { kind: "none" } });
const chat = (id: string, label: string, description?: string): PopupItem => ({ label, description, run: { kind: "chat", id } });
const cmd = (id: string, label: string, description?: string): PopupItem => ({ label, description, run: { kind: "command", id } });

const VOTE: Record<number, string> = { 10: "approved", 5: "approved with suggestions", 0: "no vote", [-5]: "waiting for the author", [-10]: "rejected" };

export function popupFor(chip: string, m: BarModel, now: number = Date.now()): Popup {
  switch (chip) {
    case "story": {
      const items: PopupItem[] = [info(m.story ? `#${m.story.id} ${m.story.title}` : "No story on this branch", m.story?.state), info(`Branch ${m.branch}`, m.dirty ? "uncommitted changes" : undefined, m.unpushed ? `${m.unpushed} commit(s) not pushed` : undefined)];
      if (m.next) items.push(info(`Next: ${m.next}`));
      return { title: "Story and branch", items };
    }
    case "pr": {
      const pr = m.pr;
      if (!pr) return { title: "Pull request", items: [info("No pull request for this branch")] };
      const items: PopupItem[] = [info(`!${pr.id} ${pr.title}`, pr.draft ? "draft" : pr.status)];
      if (pr.reviewers.length) for (const r of pr.reviewers) items.push(info(r.name, VOTE[r.vote] ?? `vote ${r.vote}`, r.required ? "required reviewer" : undefined));
      else items.push(info(`Votes: ${pr.votes.summary}`));
      for (const b of pr.blockers) items.push(info(`Blocks completion: ${short(b, 120)}`));
      if (pr.url) items.push(cmd("aihub.openPr", "Open in the browser"));
      items.push(chat("watch", "Watch the pull request (chat)", "/watch"));
      return { title: `Pull request !${pr.id}`, items };
    }
    case "pipeline": {
      const items = m.pipeline.length ? m.pipeline.map((p) => info(p.name, p.state)) : [info("No pipeline run found for this PR")];
      if (m.checks === "red") items.push(chat("pipeline-fix", "Fix the failing pipeline (chat)"));
      return { title: "Pipeline", items };
    }
    case "threads":
      return { title: "Review threads", items: [info(`${m.openThreads} open thread(s)`), chat("review", "Process the review comments (chat)", "/review")] };
    case "fabric": {
      const f = m.fabric;
      if (!f) return { title: "Fabric", items: [info("This branch has no Fabric workspace")] };
      const items: PopupItem[] = [info(`Workspace ${f.workspace}`, `${f.failed.length} failed, ${f.active} running`)];
      if (f.cause) items.push(info(`Root cause: ${short(f.cause, 140)}`));
      for (const r of f.runs.slice(0, 8)) items.push(info(`${r.item}  ${r.status}`, r.duration, r.error ? short(r.error, 120) : undefined));
      if (f.failed.length) items.push(chat("fabric-failures", "Explain the Fabric failures (chat)"));
      return { title: "Fabric runs (last 24 h)", items };
    }
    case "events":
      return { title: "Events (aihub watch --mine)", items: m.events.length ? m.events.map((e) => info(short(e.message, 110), ago(e.at, now))) : [info("No events")] };
    case "warnings":
      return { title: "Warnings", items: m.warnings.map((w) => info(short(w, 160))) };
    default: {
      const items: PopupItem[] = actionsFor(m).map((a) => chat(a.id, a.label, a.text.length > 36 ? "" : a.text));
      items.push({ label: "", run: { kind: "none" }, separator: true });
      items.push(cmd("aihub.refresh", "Refresh"));
      if (m.pr?.url) items.push(cmd("aihub.openPr", "Open the pull request in the browser"));
      items.push(cmd("aihub.openLog", "Open the log"));
      items.push(cmd("workbench.action.openSettings", "Settings"));
      return { title: "AI Context Hub", items };
    }
  }
}
