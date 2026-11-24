import * as vscode from "vscode";
import { readJson, type Runner } from "./cli";
import { addRecentRepos, repoRows, selectionOf, type AdoRepoJson, type LocalRepoJson, type RecentRepo, type RepoPick, type RepoRow, type Selection } from "./repoPickerModel";
import type { GroupJson } from "./repoSetModel";

/**
 * Step 1 of New Worktree Set and of "Repositories on a branch": pick any repositories, local or in Azure DevOps.
 * The local clones show at once (`aihub repos local`: read from their files, no network); the Azure DevOps list
 * (`aihub repos ado`, cached a few hours by the CLI) is added when it is there. Nothing runs before the picker opens.
 * A repository that is not cloned yet is cloned into the repos root first, with its real error when that fails.
 */

const RECENT_KEY = "aihub.recentRepos";
const cfgRoot = () => String(vscode.workspace.getConfiguration("aihub").get("reposRoot", "") || "");
const rootArgs = () => (cfgRoot() ? ["--root", cfgRoot()] : []);

type Row = vscode.QuickPickItem & { row: RepoRow };

export interface PickedRepos extends Selection {
  /** what the user ticked, for the title of the next steps */
  label: string;
}

export async function pickRepos(o: { run: Runner; cwd: string; state: vscode.Memento; groups: () => Promise<GroupJson[]>; title: string; log: (l: string) => void }): Promise<PickedRepos | undefined> {
  const recent = (o.state.get<RecentRepo[]>(RECENT_KEY) ?? []).filter((r) => r && typeof r.path === "string");
  const localP = readJson<{ root?: string; repos: LocalRepoJson[] }>(o.run, ["repos", "local", ...rootArgs()], o.cwd).catch((e: Error) => (o.log(`repos local: ${e.message}`), { repos: [] as LocalRepoJson[] }));
  const adoP = readJson<{ repos: AdoRepoJson[] }>(o.run, ["repos", "ado", ...rootArgs()], o.cwd);
  const groupsP = o.groups().catch(() => [] as GroupJson[]);

  const picks = await new Promise<RepoPick[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<Row>();
    let done = false;
    const finish = (v: RepoPick[] | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.hide();
      qp.dispose();
    };
    // (a QuickPick says canSelectMany; canPickMany is only for showQuickPick and is silently ignored here)
    qp.canSelectMany = true;
    qp.title = o.title;
    qp.placeholder = "Tick repositories or a group (type to search); Enter goes on. Not cloned ↓ is cloned first";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;
    qp.busy = true;
    const show = (rows: RepoRow[]) => {
      const ticked = new Set(qp.selectedItems.map((i) => i.row.id));
      const items: Row[] = rows.map((r) => (r.separator ? ({ label: r.label, kind: vscode.QuickPickItemKind.Separator, row: r } as Row) : { label: r.label, description: r.description, detail: r.detail, row: r }));
      qp.items = items;
      qp.selectedItems = items.filter((i) => i.row.id && ticked.has(i.row.id));
    };
    qp.onDidAccept(() => finish(qp.selectedItems.map((i) => i.row.value).filter((v): v is RepoPick => !!v)));
    qp.onDidHide(() => finish(undefined));
    qp.show();
    void Promise.all([localP, groupsP]).then(([local, groups]) => {
      if (done) return;
      show(repoRows({ groups, recent, local: local.repos }));
      void adoP.then(
        (a) => !done && (show(repoRows({ groups, recent, local: local.repos, ado: a.repos })), (qp.busy = false)),
        (e: Error) => {
          o.log(`repos ado: ${e.message}`);
          if (!done) (show(repoRows({ groups, recent, local: local.repos, adoError: e.message.split("\n")[0] })), (qp.busy = false));
        },
      );
    });
  });
  if (!picks?.length) return undefined;
  const sel = selectionOf(picks);
  if (sel.clone.length) {
    const cloned = await cloneFirst(o.run, o.cwd, sel.clone, o.log);
    if (!cloned) return undefined;
    sel.paths.push(...cloned);
  }
  if (!sel.paths.length) return undefined;
  await o.state.update(RECENT_KEY, addRecentRepos(recent, sel.paths.map((p, i) => ({ path: p, name: sel.names[i] ?? p })), Date.now()));
  return { ...sel, label: sel.group ?? sel.names.join(", ") };
}

/** Clones with progress in one notification; a failure shows git's own words and stops. */
async function cloneFirst(run: Runner, cwd: string, specs: string[], log: (l: string) => void): Promise<string[] | undefined> {
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${specs.length === 1 ? specs[0] : `${specs.length} repositories`}...` }, () =>
    readJson<{ repo: string; project: string; path: string; status: string; error?: string }[]>(run, ["repos", "clone", "--repos", specs.join(","), ...rootArgs()], cwd).catch((e: Error) => {
      log(`repos clone: ${e.message}`);
      return [{ repo: specs.join(", "), project: "", path: "", status: "failed", error: e.message }];
    }),
  );
  const bad = res.filter((r) => r.status === "failed");
  if (bad.length) {
    void vscode.window.showErrorMessage(`AI Context Hub: could not clone ${bad.map((b) => `${b.project ? `${b.project}/` : ""}${b.repo}: ${b.error}`).join("; ")}`, { modal: true });
    return undefined;
  }
  return res.map((r) => r.path);
}

/** "Save as group...": personal, or for the whole team in team.yaml (the user commits it). */
export async function offerSaveGroup(run: Runner, cwd: string, picked: PickedRepos): Promise<string | undefined> {
  // undefined = cancelled; "" = go on without a group; else the group to open by name
  if (picked.group || picked.paths.length < 2) return picked.group ?? "";
  const how = await vscode.window.showQuickPick(
    [
      { label: "$(arrow-right) Continue", value: "" },
      { label: "$(star-empty) Save as group...", description: "personal: one click next time", value: "user" },
      { label: "$(organization) Save as group for the team...", description: "in team.yaml (commit it)", value: "team" },
    ],
    { title: `${picked.label}`, placeHolder: "Enter goes on; or save these repositories as a group first" },
  );
  if (!how) return undefined;
  if (!how.value) return "";
  const name = await vscode.window.showInputBox({ title: "Name of the group", validateInput: (v) => (/^[\w.-]+$/.test(v.trim()) ? undefined : "Letters, digits, . - _ only") });
  if (!name) return "";
  await run(["worktree", "groups", "save", name.trim(), "--repos", picked.paths.join(","), ...(how.value === "team" ? ["--team"] : []), "--json"], cwd);
  void vscode.window.showInformationMessage(`Group ${name.trim()} saved${how.value === "team" ? " in team.yaml (commit it so the team has it)" : ""}.`);
  return name.trim();
}
