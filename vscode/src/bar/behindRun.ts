import { existsSync } from "node:fs";
import { decide, behindMessage, FetchGate, headSha, inspect, refSha, setMessage, Told, undoUpdate, updateRepo, type BehindFacts, type BehindMode, type UpdateResult } from "./behind";
import { targetOf } from "./repoStatus";
import type { GitRaw, GitRun } from "./ownWindow";

export type CheckReason = "open" | "own" | "menu" | "focus";

/** Everything that is VS Code, as functions: the mode setting, focus, the messages. */
export interface BehindUi {
  mode(): BehindMode;
  /** "Always Update Automatically": the setting becomes auto */
  setAuto(): Promise<void>;
  focused(): boolean;
  repos(): { name: string; path: string; branch?: string; changes?: number }[];
  /** one message with buttons; the button that was clicked, else undefined (Later, closed) */
  ask(message: string, buttons: string[]): Promise<string | undefined>;
  /** a result line, with Undo for an update that was made by itself; `undo` runs it */
  said(line: string, undo?: { label: string; run: () => Promise<{ problem?: string }> }): void;
  /** the stand of the repositories changed (a fetch, an update) */
  changed(path?: string): void;
}

export interface BehindDeps {
  git: GitRun;
  raw: GitRaw;
  cli: (args: string[], cwd: string) => Promise<string>;
  ui: BehindUi;
  gate?: FetchGate;
  told?: Told;
  target?: (path: string, name: string) => string;
  /** commits behind the target, one git call remembered per repository (the same one the state uses) */
  count?: (path: string, name: string) => Promise<number | undefined>;
}

/**
 * Looks at the repositories of the window against their target branch and asks or updates, as the setting says. One run
 * at a time; never without focus; the repositories after each other.
 */
export class BehindManager {
  readonly gate: FetchGate;
  readonly told: Told;
  private running = false;
  /** what was found for a repository at a pair of commits (HEAD, origin/<target>): the same pair is not looked at again, no process */
  private seen = new Map<string, { key: string; facts?: BehindFacts }>();
  private target: (path: string, name: string) => string;
  constructor(private d: BehindDeps) {
    this.gate = d.gate ?? new FetchGate(d.git);
    this.told = d.told ?? new Told();
    this.target = d.target ?? targetOf;
  }

  /** What was shown and done, for the tests and the log. */
  async run(reason: CheckReason): Promise<{ messages: string[]; updated: UpdateResult[]; facts: BehindFacts[] }> {
    const out = { messages: [] as string[], updated: [] as UpdateResult[], facts: [] as BehindFacts[] };
    const { ui } = this.d;
    if (this.running || ui.mode() === "off" || !ui.focused()) return out;
    this.running = true;
    try {
      for (const r of ui.repos()) {
        const target = this.target(r.path, r.name);
        // a folder that is gone (a set with a missing worktree) is not looked at: no process, no failure to remember
        if (!r.branch || r.branch === target || !existsSync(r.path)) continue;
        if ((await this.gate.fetch(r.path, target, reason)) === "fetched") ui.changed(r.path);
        const key = `${r.branch}|${headSha(r.path)}|${refSha(r.path, `refs/remotes/origin/${target}`)}`;
        const known = this.seen.get(r.path.toLowerCase());
        const f = known && known.key === key && key.indexOf("undefined") === -1 ? known.facts : await inspect(this.d.git, this.d.raw, r, target, this.d.count);
        this.seen.set(r.path.toLowerCase(), { key, facts: f });
        if (f) out.facts.push(f);
      }
      const mode = ui.mode();
      const todo = out.facts.map((f) => ({ f, d: decide(mode, f) })).filter((x) => x.d !== "none");
      // by itself: no conflicts, no overlap (auto only); one line each, with Undo
      for (const { f } of todo.filter((x) => x.d === "auto")) {
        const res = await updateRepo(this.d.cli, this.d.git, f);
        out.updated.push(res);
        ui.changed(f.path);
        if (res.ok && res.before) {
          const before = res.before;
          ui.said(`${res.line} · Undo`, { label: `Update ${f.name} from ${f.target}`, run: () => undoUpdate(this.d.git, { name: f.name, path: f.path, branch: f.branch, before }) });
          out.messages.push(`${res.line} · Undo`);
        } else {
          ui.said(res.line);
          out.messages.push(res.line);
        }
      }
      // the question: once per new stand of a repository, one message for the set when several are behind
      const asked = todo.filter((x) => x.d !== "auto" && !this.told.has(x.f));
      const plain = asked.filter((x) => x.d === "ask").map((x) => x.f);
      const conflicting = asked.filter((x) => x.d === "ask-conflict").map((x) => x.f);
      for (const x of asked) this.told.add(x.f);
      const update = async (list: BehindFacts[]) => {
        for (const f of list) {
          const res = await updateRepo(this.d.cli, this.d.git, f);
          out.updated.push(res);
          ui.changed(f.path);
          ui.said(res.line);
          out.messages.push(res.line);
        }
      };
      if (plain.length >= 2) {
        const msg = `${setMessage([...plain, ...conflicting])}${conflicting.length ? ` · ${conflicting.length} would conflict` : ""}`;
        out.messages.push(msg);
        const pick = await ui.ask(msg, ["Update All", "Later"]);
        if (pick === "Update All") await update(plain);
      } else {
        for (const f of plain) {
          const msg = behindMessage(f);
          out.messages.push(msg);
          const pick = await ui.ask(msg, ["Update", "Always Update Automatically", "Later"]);
          if (pick === "Always Update Automatically") await ui.setAuto();
          if (pick === "Update" || pick === "Always Update Automatically") await update([f]);
        }
      }
      for (const f of conflicting) {
        // conflicts: never by itself
        if (plain.length >= 2) continue;
        const msg = behindMessage(f);
        out.messages.push(msg);
        const pick = await ui.ask(msg, ["Update and Resolve...", "Later"]);
        if (pick === "Update and Resolve...") await update([f]);
      }
    } finally {
      this.running = false;
    }
    return out;
  }
}
