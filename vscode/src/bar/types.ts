/**
 * The contract between the engine (this extension) and the buttons in the title bar (the PyCharm Git extension):
 * `activate()` returns `{ bar: BarApi }`, and the commands below do the work. Plain data only, no vscode types.
 */
export type BarMode = "set" | "repo" | "empty";

export interface BarStoryBranch {
  name: string;
  status: "current" | "old" | "parked";
}

/** The pull request of a repository's branch. approved: required reviewers approved; failed: rejected, waiting for the author, or the merge check failed. */
export interface BarPr {
  id: number;
  status: "active" | "approved" | "failed" | "merged";
  url: string;
  /** the build policy of an active pull request; only known after the overview menu or Create Pull Requests asked for it (one policy read per active pull request) */
  build?: "succeeded" | "failed" | "running";
  /** review threads of an active pull request: open ones, and of those the ones with a comment of someone else the user has not seen; absent until read or with aiContextHub.prComments off */
  comments?: { open: number; unread: number };
}

/** One open review thread for the overview ("Open comments"). */
export interface BarOpenComment {
  repo: string;
  pr: number;
  /** repository path ("notebooks/orders.py"); absent: a general comment on the pull request */
  file?: string;
  /** 1-based line in the latest iteration */
  line?: number;
  /** who started the thread */
  author: string;
  /** the first sentence of the first comment, plain text */
  firstLine: string;
  /** ISO time of the newest comment */
  when?: string;
  unread: boolean;
  threadId: number;
}

export interface BarRepo {
  name: string;
  path: string;
  branch: string;
  /** the source clone this worktree belongs to is gone (moved or deleted): the worktree cannot be used by git until it is found again. Choose with aihub.bar.locateClone, aihub.bar.useAnotherClone or aihub.bar.removeRepository */
  sourceMissing?: true;
  /** the branch is linked to the story in Azure DevOps (a set only; absent when not known) */
  linked?: boolean;
  /** changed files; absent when not known */
  dirty?: number;
  /** changed files (the same number as dirty, from the git extension of VS Code); absent when not known */
  changes?: number;
  /** commits to push; absent when not known */
  ahead?: number;
  /** commits the target branch has that this branch does not (from the refs already there, no fetch); absent when not known */
  behindTarget?: number;
  /** the target branch behindTarget is counted against ("staging"): team.yaml, the set file, the branch this one was cut from, else staging/origin HEAD/main; absent when not known */
  target?: string;
  /** the pull request of this branch; absent when there is none or it is not known yet */
  pr?: BarPr;
  /** this branch belongs to the story (linked, or the story number first in its name); false in a set without a story */
  storyBranch: boolean;
  /** the branches of the story in this repository */
  storyBranches?: BarStoryBranch[];
}

export interface BarRecent {
  kind: "set" | "repo";
  id: string;
  label: string;
  detail?: string;
  /** ISO time */
  lastUsed: string;
}

export interface BarSet {
  id: string;
  story?: number;
  label: string;
  repos: number;
  /** this window shows it */
  open: boolean;
  /** the story is closed (as last seen); the menu offers Remove */
  done?: boolean;
  /** no work in it (nothing uncommitted or unpushed); only worked out for done sets */
  clean?: boolean;
  /** disk the set holds (bytes); measured in the background at most once a day (or when the user asks), kept in a file, so absent at first */
  sizeBytes?: number;
  /** the measurement stopped at its time limit: the set holds at least sizeBytes (show "≥ x GB") */
  sizeLowerBound?: boolean;
  /** when sizeBytes was measured (epoch ms) */
  sizeAt?: number;
  /** every repository of the set has a merged pull request (from the pull request list only, no git); absent when the list is not known; clean/allMerged say whether nothing would be lost */
  prsMerged?: boolean;
  /** every repository has a merged pull request and nothing in the set would be lost (no uncommitted work, nothing unpushed) */
  allMerged?: boolean;
}

export interface BarRepository {
  name: string;
  path: string;
  branch: string;
  /** other clones of the same remote (one line per remote in the menu: "· 2 other clones") */
  otherClones?: number;
  /** every clone of the repository on this PC when there is more than one (the one in use is `chosen`); the name is the repository's (its remote), the path the clone. Choose with aihub.bar.useClone, take out of the list with aihub.bar.removeClone */
  clones?: { path: string; branch: string; chosen: boolean }[];
}

/**
 * A place on this PC where a branch is checked out now, read from files (HEAD of every clone and every worktree): the
 * search of the left menu lists one row per place. where: "set" a worktree of a story set, "own" a worktree outside every
 * set, "clone" the main folder of a clone.
 */
export interface BarCheckout {
  repo: string;
  branch: string;
  path: string;
  where: "set" | "own" | "clone";
  /** the set it is in (BarSet.id), only for where "set" */
  setId?: string;
  /** "#4698 Klantnummer valideren", only for where "set" */
  setLabel?: string;
}

/** The branches a clone knows (local and origin, from its ref files and packed-refs; at most 300): the search offers a branch that is checked out nowhere. */
export interface BarBranchRefs {
  repo: string;
  /** the clone */
  path: string;
  branches: string[];
}

/** A repository in Azure DevOps that is not on this PC (no clone with the same remote, however its url is written). */
export interface BarRemoteRepository {
  name: string;
  project: string;
  remoteUrl: string;
}

/**
 * The repositories in Azure DevOps the user can see and that are not on this PC. Nothing is read until the search asks
 * (aihub.bar.loadRemoteRepositories, on the first two typed characters); the list is read at most once a day and kept in a
 * file, a failed read is remembered 5 minutes, and nothing is read while the window has no focus.
 * idle: not asked yet; loading: reading now ("Searching Azure DevOps…"); ready: repos is the list; signedOut: not signed in
 * ("Sign in to Azure DevOps to search your repositories", aihub.bar.signInAzureDevOps); failed: error says why.
 */
export interface BarRemote {
  status: "idle" | "loading" | "ready" | "signedOut" | "failed";
  repos: BarRemoteRepository[];
  /** when the list was read (epoch ms) */
  at?: number;
  error?: string;
}

export interface BarState {
  /**
   * The hub is the one that tells the user a branch is behind its target (one question per stand, conflict check, auto, Undo, one
   * message for the set). Another extension (PyCharm Git) shows no message of its own about it while this is true.
   */
  handlesBehindTarget: true;
  /** the set file of this window cannot be read right now (e.g. "not valid JSON"): the set shown is the last good one; absent when the file is fine. A state event goes out when it is readable again. */
  setFileProblem?: string;
  mode: BarMode;
  story?: { id: number; title: string; state?: string };
  setFolder?: string;
  /** set: the repositories of the set; repo: the one open repository; empty: none */
  repos: BarRepo[];
  recents: BarRecent[];
  sets: BarSet[];
  repositories: BarRepository[];
  lookIn: string[];
  /** the scan stopped early (too many folders): the menu says "Not everything was scanned: narrow Folders to Look In..." */
  scanTruncated?: boolean;
  /** the last action that changed a set and can still be undone: the menu shows "Undo: <label>" until the next action */
  undo?: { label: string };
  /** the sizes of all sets whose size is known, added up */
  totalSizeBytes?: number;
  /** at least one of the sets is a lower bound: the total is at least this (show "≥ x GB") */
  totalSizeLowerBound?: boolean;
  /** OneDrive / network folders that were left out because they are not in "Folders to Look In" */
  scanSkipped?: string[];
  /** every place where a branch is checked out now (from the scan, no git process) */
  checkouts?: BarCheckout[];
  /** the branches each clone knows (from the scan, no git process) */
  branchRefs?: BarBranchRefs[];
  /** the repositories in Azure DevOps that are not on this PC */
  remote?: BarRemote;
  /** the open review threads of the pull requests of this window, newest first, at most 50; absent until read or with aiContextHub.prComments off */
  openComments?: BarOpenComment[];
}

export interface BarApi {
  getState(): Promise<BarState>;
  onDidChangeState: (listener: () => unknown) => { dispose(): unknown };
}

/** Every command of the contract (the buttons call these). */
export const BAR_COMMANDS = {
  openStory: "aihub.bar.openStory",
  openRepository: "aihub.bar.openRepository",
  openRecent: "aihub.bar.openRecent",
  openSet: "aihub.bar.openSet",
  removeSet: "aihub.bar.removeSet",
  switchBranch: "aihub.bar.switchBranch",
  newStoryBranch: "aihub.bar.newStoryBranch",
  /** one repository of a set in a window of its own: `{ repo, path, branch? }`; the set never changes */
  openInOwnWindow: "aihub.bar.openInOwnWindow",
  otherBranch: "aihub.bar.otherBranch",
  linkBranch: "aihub.bar.linkBranch",
  addRepository: "aihub.bar.addRepository",
  removeRepository: "aihub.bar.removeRepository",
  lookIn: "aihub.bar.lookIn",
  reopenLast: "aihub.bar.reopenLast",
  refresh: "aihub.bar.refresh",
  /** read the pull requests of the set again (the overview menu calls it when it opens) */
  refreshStatus: "aihub.bar.refreshStatus",
  /**
   * start measuring the sets in the background (the left menu calls it when it opens); the state gets sizeBytes as they come in.
   * A set is measured at most once a day and only while the window has focus; `{ force: true }` (the user asked, "Measure now")
   * measures every set again. A walk stops after 20 s and leaves sizeLowerBound.
   */
  measureSets: "aihub.bar.measureSets",
  /** looks at the uncommitted work of the other sets that can be removed (at most 8 worktrees, git status each, remembered 5 minutes); the clean-up dialog calls it when it opens, the state gets clean and allMerged as they come in */
  checkClean: "aihub.bar.checkClean",
  /** `{ name, path }`: use this clone of the repository from now on (the same preference as `aihub repos prefer`); the list and every action follow */
  useClone: "aihub.bar.useClone",
  /** `{ path }` (the worktree whose source clone is missing): pick the folder of the clone; accepted only when its remote is the repository's; the worktree is repaired and the set file points at it */
  locateClone: "aihub.bar.locateClone",
  /** `{ path }`: the same with another clone of the repository that is on this PC (the pick lists them) */
  useAnotherClone: "aihub.bar.useAnotherClone",
  /** `{ path }`: take this clone out of the list ("Remove from List"); the folder stays where it is */
  removeClone: "aihub.bar.removeClone",
  /** puts the set back as it was before the last action (branches, folders, set file, workspace file), or says in one sentence why not and does nothing */
  undoLast: "aihub.bar.undoLast",
  /** pull (fast-forward) in every repository of the set; one result line per repository */
  updateAll: "aihub.bar.updateAll",
  /** push every repository of the set (a branch without a remote branch gets one) */
  pushAll: "aihub.bar.pushAll",
  /** `{ message, repos: [{ name, files? }], push? }`: one message, one `aihub commit` per NAMED repository (never one that is not named; without `files` every change of it, with `files` exactly those); a failing hook in one repository does not stop the others. Without `repos` the user ticks them in a pick */
  commitAll: "aihub.bar.commitAll",
  /** a pick with ticks (story branches without a pull request); one `aihub pr create` per ticked repository, linked to the story and to each other */
  createPullRequests: "aihub.bar.createPullRequests",
  /** the search typed its first two characters: read the Azure DevOps list if it is not known (once a day, failure remembered 5 minutes, never without focus); the state gets remote */
  loadRemoteRepositories: "aihub.bar.loadRemoteRepositories",
  /** read the Azure DevOps list again now */
  refreshRemoteRepositories: "aihub.bar.refreshRemoteRepositories",
  /** the "Sign in to Azure DevOps" row: starts `az login` in a terminal, then reads the list again */
  signInAzureDevOps: "aihub.bar.signInAzureDevOps",
  /** `{ name, project, remoteUrl }`: a pick (Clone and Open, Clone and Add to the set of this window, Choose Another Folder…), then git clone with progress, Cancel and Undo */
  cloneRepository: "aihub.bar.cloneRepository",
  /** `{ repo, branch, path, where, setId? }` (a BarCheckout), or `{ repo, branch, path, where: "none" }` for a branch checked out nowhere (path: the clone): a pick, then the folder (or the whole set) opens in a new window; the set never changes */
  openCheckout: "aihub.bar.openCheckout",
  /** `{ repo, threadId }` (from openComments): opens the file on the line and unfolds the thread (counts as read); a general comment shows its text with Open Pull Request */
  showComment: "aihub.bar.showComment",
  /** read the review threads of the pull requests again now (one aihub process for all of them) */
  refreshComments: "aihub.bar.refreshComments",
  // ---- pipelines in the bar (one aihub process each, JSON as in docs/cli-json.md "Pipelines in the bar"; a failure is
  // `{ error: { kind: "signedOut"|"cliMissing"|"cliTooOld"|"notARepository"|"failed", message } }`, never a popup; the
  // lasting kinds are remembered 5 minutes per folder; the bar does the timing, nothing polls by itself) ----
  /**
   * `{ repoDirs?, mine? (default true), today?, status?, branch?, top?, rowsRepoDir? }` -> `aihub pipeline list` (default repoDirs: the
   * repositories of this window). `today` counts all runs read of all repoDirs, whatever branch/status/rowsRepoDir say; a red row
   * carries failedStage, failedStep and tests. The menu of one repository: `{ branch, top: 3, rowsRepoDir: <its path> }`.
   */
  pipelineRuns: "aihub.bar.pipelineRuns",
  /** `{ run, repoDir? }` -> `aihub pipeline show`: tree, trigger, parameters, variables, summary */
  pipelineRun: "aihub.bar.pipelineRun",
  /** `{ run, repoDir?, step?, tail?, fromLine? }` -> `aihub pipeline log` (default step: the failed one) */
  pipelineLog: "aihub.bar.pipelineLog",
  /** `{ run, repoDir? }` -> `aihub pipeline poll`: the cheap read for the bar's 15 s timer while a run of mine runs */
  pipelineStatus: "aihub.bar.pipelineStatus",
  /** `{ run, repoDir? }` -> `aihub pipeline run-again --plan`: the rerun dialog (types, values, settable variables, skippable stages, newer commit) */
  pipelineRerunPlan: "aihub.bar.pipelineRerunPlan",
  /** `{ run, repoDir?, commit?: "same"|"latest", parameters?, variables?, skipStages? }` (only what changed; a secret only when typed) -> the new run */
  pipelineRerun: "aihub.bar.pipelineRerun",
  /** `{ run, repoDir?, stage? }` -> `aihub pipeline retry`: the failed stages of the same run again ("Rerun Failed Jobs") */
  pipelineRerunFailed: "aihub.bar.pipelineRerunFailed",
  /** `{ run, repoDir? }` -> `aihub pipeline cancel`: `{ run, cancelled }` (false: already finished) */
  pipelineCancel: "aihub.bar.pipelineCancel",
  /** `{ run, pipeline?, branch? }`: puts the pipeline-fix text in the chat (the user presses Enter) */
  pipelineFix: "aihub.bar.pipelineFix",
  /** forget the remembered failures (after az login or a CLI update) */
  pipelineRetryNow: "aihub.bar.pipelineRetryNow",
  // ---- repository browser (one aihub process each, JSON as in docs/cli-json.md "Repository browser"; a failure is
  // `{ error: { kind, message } }`, kind signedOut|noAccess|notFound|searchUnavailable|protectedBranch|branchExists|offline|badInput|
  // failed|cliMissing|cliTooOld, never a popup; the lasting kinds are remembered 5 minutes; nothing polls) ----
  /** `{ org?, refresh? }` -> `aihub browse projects`: every project and repository you can read, with the clone on this PC */
  browseProjects: "aihub.bar.browseProjects",
  /** `{ project, days?, org?, refresh? }` -> `aihub browse project`: repositories with language and last activity, recent files, active authors */
  browseProject: "aihub.bar.browseProject",
  /** `{ project, repo, ref?, org?, refresh? }` -> `aihub browse repo`: README, root with last commits, branches, open PRs, commits, pipelines; `errors[]` per failed part */
  browseRepo: "aihub.bar.browseRepo",
  /** `{ project, repo, path?, ref?, lastCommit? }` -> `aihub browse items`: one folder level; `ref.commit` is the stable key */
  browseItems: "aihub.bar.browseItems",
  /** `{ project, repo, path, ref?, maxBytes? }` -> `aihub browse file`: content (null when binary or too large), objectId, lastCommit, webUrl */
  browseFile: "aihub.bar.browseFile",
  /** `{ project, repo, filter?, top? }` -> `aihub browse branches`: default, mine, the rest; tags */
  browseBranches: "aihub.bar.browseBranches",
  /** `{ project, repo, path?, ref?, top?, skip? }` -> `aihub browse history`: commits newest first, `more` */
  browseHistory: "aihub.bar.browseHistory",
  /** `{ project, repo, commit, path }` -> `aihub browse diff`: before, after and hunks of one file in one commit */
  browseDiff: "aihub.bar.browseDiff",
  /** `{ project, repo, path, ref? }` -> `aihub browse blame`: per line its commit (only for a clone on this PC; otherwise `available: false`) */
  browseBlame: "aihub.bar.browseBlame",
  /** `{ query, top?, repos? }` -> `aihub browse find` (Ctrl+P): file names over all repositories, `route` codeSearch or treeCache */
  browseFind: "aihub.bar.browseFind",
  /** `{ text, project?, repo?, path?, ext?, top? }` -> `aihub browse search`: matching lines per file; `searchUnavailable` without Code Search */
  browseSearch: "aihub.bar.browseSearch",
  /** `{ story?, path, title? }` -> `aihub browse suggest-branch`: `{ branch }` (no network) */
  browseSuggestBranch: "aihub.bar.browseSuggestBranch",
  /** `{ project, repo, path, baseCommit, baseBranch, content, branch, message, pr?, target?, story?, prTitle?, draft?, rebase? }` -> `aihub browse push`: `status: pushed` or `status: conflict` (rebase: true = Rebase my change); protectedBranch and branchExists are errors */
  browsePush: "aihub.bar.browsePush",
  /** forget the remembered failures (after az login or a CLI update) */
  browseRetryNow: "aihub.bar.browseRetryNow",
} as const;
