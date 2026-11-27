import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, remoteOf, setOfStory } from "../../../cli/src/lib/machineScan";
import { repoNameOfUrl } from "../../../cli/src/lib/repoName";
import type { OpenResultJson } from "../repoSetModel";
import { answerExisting, showOpened } from "../repoSetUi";
import { browseErrorOf } from "./browse";
import { cloneParent, cloneWithProgress, folderName } from "./cloneRepo";
import { cli } from "./runner";
import type { StoryHooks } from "./storyUi";
import { BAR_COMMANDS } from "./types";
import { withUndo } from "./undoUi";
import { windowChoice } from "./window";
import { cliNameOf, cloneOf, openArgs, parseOpenRepos, remoteKey, resultOf, type OpenReposError, type OpenReposResult, type OpenReposRow, type SetRepoArg } from "./openReposAsSet";

const fail = (kind: OpenReposError["error"]["kind"], message: string): OpenReposError => ({ error: { kind, message } });

/**
 * aihub.bar.openReposAsSet: clone what is not on this PC (the folder of the clone search: the first of Folders to Look In,
 * else next to the most recently used clone; Choose Folder… only when there is neither), then one `aihub worktree open` for
 * all of them, the window, and Undo. A story that has a set opens that set. A worktree that exists elsewhere asks the known
 * question. A repository that fails is one sentence in the answer; the others go on. Nothing runs until the command is called.
 */
export function registerOpenReposAsSet(h: Pick<StoryHooks, "engine" | "log" | "changed" | "reg" | "afterGit">): void {
  h.reg(BAR_COMMANDS.openReposAsSet, async (raw?: unknown): Promise<OpenReposResult | OpenReposError> => {
    const arg = parseOpenRepos(raw);
    if ("problem" in arg) return fail("badInput", arg.problem);
    const window = arg.window ?? windowChoice();

    // one story is one set: when it has one, that set opens and nothing is made
    if (arg.story) {
      const have = setOfStory(h.engine.scan({ refresh: true }), arg.story);
      if (have && have.repos.some((r) => r.exists)) {
        h.log(`open repos as set: story ${arg.story} has the set ${have.id}; that one opens`);
        await vscode.commands.executeCommand(BAR_COMMANDS.openSet, { id: have.id });
        return { story: arg.story, folder: have.folder, opened: true, existingSet: { id: have.id, folder: have.folder }, repos: have.repos.map((r) => ({ repo: r.name, ok: r.exists, branch: r.branch, path: r.path, state: "existing" })) };
      }
    }

    const locals = (await h.engine.repositories()).map((r) => ({ name: r.name, path: r.path, remote: r.remote }));
    const present: { name: string; cliName: string; path: string }[] = [];
    const failed: OpenReposRow[] = [];
    const toClone: SetRepoArg[] = [];
    for (const r of arg.repos) {
      const local = cloneOf(r, locals);
      if (local) present.push({ name: r.name, cliName: cliNameOf(local.path, local.remote, repoNameOfUrl), path: local.path });
      else if (r.remoteUrl) toClone.push(r);
      else failed.push({ repo: r.name, ok: false, branch: r.newBranch ?? r.branch ?? arg.newBranch ?? "", error: `${r.name} is not on this PC and no remote url was given to clone it` });
    }

    // the clones that are missing, in one notification with Cancel; a clone that fails is one row
    const cloned: string[] = [];
    if (toClone.length) {
      let parent = cloneParent(h.engine.folders(), h.engine.scan().repos.map((r) => r.path));
      if (!parent) {
        const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Clone into this folder", title: `Where do the clones of ${toClone.map((r) => r.name).join(", ")} go?` });
        if (!dirs?.[0]) return fail("cancelled", "no folder was chosen for the clones; nothing was changed");
        parent = dirs[0].fsPath;
      }
      const into = parent;
      const stopped = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Cloning", cancellable: true }, async (progress, token) => {
        for (const [i, r] of toClone.entries()) {
          if (token.isCancellationRequested) return true;
          const dir = join(into, folderName(r.name));
          const branch = r.newBranch ?? r.branch ?? arg.newBranch ?? "";
          if (existsSync(dir)) {
            // a folder of that name: used when it is a clone of this repository, never overwritten
            const same = existsSync(join(dir, ".git")) && remoteKey(remoteOf(join(dir, ".git"))) === remoteKey(r.remoteUrl);
            if (same) present.push({ name: r.name, cliName: cliNameOf(dir, r.remoteUrl, repoNameOfUrl), path: dir });
            else failed.push({ repo: r.name, ok: false, branch, error: `${dir} exists already and is not a clone of ${r.name}; nothing was overwritten` });
            continue;
          }
          let last = 0;
          progress.report({ message: `${r.name} (${i + 1} of ${toClone.length}) · connecting…` });
          const res = await cloneWithProgress({
            url: r.remoteUrl!,
            dir,
            onProgress: (pct) => {
              progress.report({ increment: (pct - last) / toClone.length, message: `${r.name} (${i + 1} of ${toClone.length}) · ${pct} %` });
              last = pct;
            },
            onCancel: (stop) => token.onCancellationRequested(stop),
          });
          if (res.ok) {
            cloned.push(r.name);
            present.push({ name: r.name, cliName: cliNameOf(dir, r.remoteUrl, repoNameOfUrl), path: dir });
            h.log(`open repos as set: cloned ${r.name} to ${dir}`);
          } else if (res.cancelled) return true;
          else failed.push({ repo: r.name, ok: false, branch, error: `${r.name} could not be cloned: ${res.error}` });
        }
        return false;
      });
      if (cloned.length) {
        forgetScan(process.env);
        h.changed();
      }
      if (stopped) return fail("cancelled", `the clone was cancelled; the half clone was removed${cloned.length ? ` (cloned before: ${cloned.join(", ")})` : ""}`);
    }
    if (!present.length) return resultOf(undefined, { opened: false, cloned, failed });

    // one set, with Undo while nothing was changed in it (clones made above stay)
    const args = openArgs(arg, present);
    const cwd = present[0].path;
    try {
      const res = await withUndo(
        h,
        `Open ${present.length === 1 ? present[0].name : `${present.length} repositories`} as a set`,
        "",
        async () => {
          const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${present.map((p) => p.name).join(", ")}...` }, () => cli(args, cwd));
          const out = await answerExisting(first, (extra) => cli([...args, ...extra], cwd), { ownWindow: true });
          if (out === undefined) return undefined;
          const json = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
          forgetScan(process.env);
          h.afterGit?.();
          const opened = json.repos.some((r) => r.ok) ? await showOpened(json, window, h.log) : false;
          h.changed();
          return { json, opened };
        },
        { sources: present.map((p) => p.path), created: (r) => r?.json.folder, message: (r) => (r?.opened ? `The set is open${failed.length ? `; ${failed.length} repositor${failed.length === 1 ? "y" : "ies"} could not be added` : ""}` : "") },
      );
      if (!res) return fail("cancelled", "the question about the existing worktree was closed; nothing was changed");
      return resultOf(res.json, { opened: res.opened, cloned, failed });
    } catch (e) {
      const err = browseErrorOf(e).error;
      if (/Unknown option .--(from-for|new-set)/i.test(err.message)) return fail("cliTooOld", "This needs a newer aihub CLI (worktree open --from-for). Update it with: npm i -g @ferronhooi/aihub@next");
      return fail(err.kind === "cliMissing" || err.kind === "cliTooOld" ? err.kind : "failed", err.message);
    }
  });
}
