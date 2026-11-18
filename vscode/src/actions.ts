import type { BarModel } from "./model";

/**
 * Actions never run from the extension. Each one is a text for the user's chat: a slash command of the aihub pack
 * (commands/copilot/*.prompt.md, commands/opencode/*.md) or one plain sentence naming the skill.
 */
export interface ChatAction {
  id: string;
  label: string;
  /** What is put in the chat input. */
  text: string;
  icon: string;
  /** The label on the bar's main button. */
  short: string;
}

export const ACTIONS: ChatAction[] = [
  { id: "story-run", short: "Run story", label: "Run the story", text: "/story-run", icon: "play" },
  { id: "start", short: "Start story", label: "Start a story", text: "/start", icon: "rocket" },
  { id: "commit", short: "Commit", label: "Commit", text: "/commit", icon: "git-commit" },
  { id: "pr", short: "Create PR", label: "Create pull request", text: "/pr", icon: "git-pull-request-create" },
  { id: "pr-update", short: "Update PR", label: "Update pull request", text: "/pr-update", icon: "git-pull-request" },
  { id: "review", short: "Review", label: "Process review comments", text: "/review", icon: "comment-discussion" },
  { id: "pipeline-fix", short: "Fix pipeline", label: "Fix the failing pipeline", text: "Use the pipeline-fix skill: follow the pipeline of this branch's pull request, find the failed step and fix it.", icon: "error" },
  { id: "watch", short: "Watch", label: "Watch the pull request", text: "/watch", icon: "eye" },
  { id: "fabric-failures", short: "Fabric failures", label: "Explain the Fabric failures", text: "Use the fabric skill: run aihub fabric failures for this branch and explain the root cause of the newest failed run.", icon: "database" },
  { id: "explain", short: "Explain", label: "Explain this change", text: "/explain", icon: "info" },
  { id: "finish", short: "Finish", label: "Finish the story", text: "/finish", icon: "check-all" },
];

export const actionById = (id: string): ChatAction | undefined => ACTIONS.find((a) => a.id === id);

/** The one action the current state asks for, first match wins. */
export function primaryActionId(m: BarModel): string {
  if (m.fabric && m.fabric.failed.length) return "fabric-failures";
  if (m.pr && m.pr.status === "completed") return "finish";
  if (m.pr && m.checks === "red") return "pipeline-fix";
  if (m.pr && m.openThreads > 0) return "review";
  if (m.dirty) return "commit";
  if (!m.story) return "start";
  if (!m.pr) return "pr";
  if (m.unpushed > 0) return "pr-update";
  return "watch";
}

/** All actions that make sense now, the primary one first. */
export function actionsFor(m: BarModel): ChatAction[] {
  const primary = primaryActionId(m);
  const applies = (a: ChatAction): boolean => {
    switch (a.id) {
      case "pr":
        return !m.pr;
      case "pr-update":
      case "watch":
      case "explain":
        return !!m.pr;
      case "review":
        return !!m.pr && m.openThreads > 0;
      case "pipeline-fix":
        return !!m.pr && m.checks === "red";
      case "fabric-failures":
        return !!m.fabric && m.fabric.failed.length > 0;
      case "finish":
        return !!m.pr;
      case "start":
        return !m.story;
      case "commit":
        return m.dirty;
      default:
        return true;
    }
  };
  const list = ACTIONS.filter((a) => a.id === primary || applies(a));
  return [...list.filter((a) => a.id === primary), ...list.filter((a) => a.id !== primary)];
}

export type ChatTarget = "copilot" | "opencode";
export type ChatSetting = "auto" | ChatTarget;

/** auto: a running opencode terminal wins (the user is in it), else Copilot Chat. */
export function pickTarget(setting: ChatSetting, hasOpencodeTerminal: boolean): ChatTarget {
  if (setting === "copilot" || setting === "opencode") return setting;
  return hasOpencodeTerminal ? "opencode" : "copilot";
}

/** Terminals whose name says they run opencode. */
export const isOpencodeTerminalName = (name: string) => /opencode/i.test(name);
