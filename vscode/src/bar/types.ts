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
  /** `{ repos?: string[] }` (clone folders, ticked already): New Set… / Open as Set… — pick repositories (Clone from Azure DevOps… too), a new branch for all or an existing one per repository, "Link to a story?"; a story with a set opens that set; else a new set (aihub worktree open --new-set) opens in a new window, with Undo */
  newSet: "aihub.bar.newSet",
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
  // every run command below also takes `project` (and `org`) instead of repoDir: the run is read from that project without a clone (a run tab opened from the pipeline browser)
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
  /**
   * `{ repos: [{ name, project?, remoteUrl?, branch?, newBranch?, from? }], story?, window?: "new"|"this", newBranch?, from?, noSet? }`:
   * several repositories as ONE set (Open as Set… in the repository browser, New Set… in the title bar). Not on this PC: cloned first
   * (Folders to Look In; Choose Folder… only without one). Then one `aihub worktree open --branch-for … [--from-for …] [--story N]`:
   * `branch` = an existing branch, `newBranch` = made from `from` (else the target branch); a repository without either gets the shared
   * `newBranch`. A story that has a set opens that set (`existingSet`). A worktree elsewhere asks the known question (move/reuse/recreate).
   * Answer `{ story?, folder?, workspace?, opened, existingSet?, repos: [{ repo, ok, branch, path?, cloned?, state?, error? }] }`; one
   * repository failing is one sentence in `error`, the others go on. `noSet: true` (Open in New Window…): exactly one repository, cloned when
   * needed, opened in a window of its own without a set file: the clone when it is on `branch`, the worktree that has it, else a new worktree;
   * `newBranch` makes a worktree from origin/`from` (else origin's default branch). Answer `{ opened, repos: [one row] }`. Failure of the whole call: `{ error: { kind: badInput|cancelled|failed|cliMissing|cliTooOld, message } }`.
   */
  openReposAsSet: "aihub.bar.openReposAsSet",
  // ---- Change with Agent (aihub browse change; docs/cli-json.md "Change with Agent"; a failure is { error: { kind, message } }) ----
  /**
   * `{ project, repo, branch?, paths?, selection?: { path, startLine, endLine }, prompt, mode: "remote"|"workingCopy",
   * where: "panel"|"newWindow"|"terminal", newBranch?, story?, remoteUrl?, org? }`. remote: an `aihub browse change` workspace (no
   * clone) -> `{ id, mode, where, dir, filesDir, branch, base, agent }`; watch `filesDir` (a FileSystemWatcher on that folder) and call
   * changeState after a debounce. workingCopy: a worktree on the new branch (cloned when needed) -> `{ mode, where, path, branch, cloned,
   * taskFile, agent }`. The agent is opencode: a terminal in this window (panel), a new window that starts it (newWindow) or Windows
   * Terminal (terminal). Nothing is pushed.
   */
  changeStart: "aihub.bar.changeStart",
  /** `{ id }` -> `aihub browse change diff`: files with status, additions, deletions and hunks; totals; summary; problems */
  changeState: "aihub.bar.changeState",
  /** `{ id, message?, pr?, target?, story?, prTitle?, draft?, rebase?, branch? }` -> `{ status: "pushed", ... }` or `{ status: "conflict", files }` */
  changePush: "aihub.bar.changePush",
  /** `{ id }` -> `{ id, discarded: true }` */
  changeDiscard: "aihub.bar.changeDiscard",
  /** `{ id, where?: "newWindow"|"terminal"|"panel"|"here", remoteUrl? }`: a worktree on the change's branch with the change in it -> `{ id, path, branch, cloned, applied, skipped }` */
  changeToWorkingCopy: "aihub.bar.changeToWorkingCopy",
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
  /** `{ project, repo, branch, target?, story?, prTitle?, draft? }` -> `aihub browse pr`: Create Pull Request after a push; `{ pr: { id, title, webUrl }, existing }` (an active PR of the branch is returned, not a second one) */
  browseCreatePr: "aihub.bar.browseCreatePr",
  browseRetryNow: "aihub.bar.browseRetryNow",
  // ---- pipeline browser (docs/cli-json.md "Pipeline browser"; the same error shape and failure memory as the repository browser; nothing polls) ----
  /** `{ project, org?, refresh? }` -> `aihub browse pipelines`: folders and pipelines (repo, YAML, default branch, isDraft, mine, latestRun); one call per project, kept 15 minutes */
  browsePipelines: "aihub.bar.browsePipelines",
  /** `{ project, pipeline, top?, refresh? }` -> `aihub browse pipeline`: the pipeline with its latest runs (message, branch or PR, who, duration) and `yaml` for browseFile */
  browsePipeline: "aihub.bar.browsePipeline",
  /** `{ project, pipeline, ref? }` -> `aihub browse run-plan`: the run form from the YAML on that ref (parameters, settable variables, stages) */
  browseRunPlan: "aihub.bar.browseRunPlan",
  /** `{ project, pipeline, branch? | tag?, commit?, parameters?, variables?, skipStages? }` (only what changed; a secret only when typed) -> `aihub browse run`: the new run */
  browseRun: "aihub.bar.browseRun",
  /** `{ project, run }` -> `aihub browse artifacts`: name, type, bytes */
  browseArtifacts: "aihub.bar.browseArtifacts",
  /** `{ project, run, artifact }` -> `aihub browse artifact-files`: the files in it (null with tooLarge over 100 MB) */
  browseArtifactFiles: "aihub.bar.browseArtifactFiles",
  /** `{ project, run, artifact, path?, maxBytes? }` -> `aihub browse artifact-open`: the file (or the zip) in a temporary folder; content for text, log and HTML */
  browseArtifactOpen: "aihub.bar.browseArtifactOpen",
  /** `{ project, repo, name, branch, fromPipeline? | empty: true }` -> `aihub browse draft-create`: draft-<name> in the folder Drafts on a new branch from the default branch */
  browseDraftCreate: "aihub.bar.browseDraftCreate",
  /** `{ project }` -> `aihub browse drafts`: the draft-* pipelines in the folder Drafts (runs, branchAhead, createdAt, mine) */
  browseDrafts: "aihub.bar.browseDrafts",
  /** `{ project, pipeline, keepBranch? }` -> `aihub browse draft-delete`: only your own draft-* in the folder Drafts; the pipeline and (unless keepBranch) its draft branch go */
  browseDraftDelete: "aihub.bar.browseDraftDelete",
  // ---- wiki browser (one `aihub wiki browse` process each, JSON as in docs/cli-json.md "Wiki browser"; failures as the
  // repository browser; a code wiki is edited with browsePush using the `code` of the wikiPage answer; nothing polls) ----
  /** `{ org?, refresh? }` -> `wiki browse wikis`: every project and code wiki, `projects` with their wiki count */
  wikiList: "aihub.bar.wikiList",
  /** `{ project, wiki, path?, refresh? }` -> `wiki browse tree`: one level of pages in the order of Azure DevOps */
  wikiTree: "aihub.bar.wikiTree",
  /** `{ project, wiki, path, version?, refresh? }` -> `wiki browse page`: markdown, etag, lastChange, attachments, `code` for a code wiki */
  wikiPage: "aihub.bar.wikiPage",
  /** `{}` -> `wiki browse templates`: empty, runbook, decision (no network) */
  wikiTemplates: "aihub.bar.wikiTemplates",
  /** `{ project, wiki, path, content, etag, comment?, force? }` -> `wiki browse publish`: `status: published` or `status: conflict` (force: Overwrite) */
  wikiPublish: "aihub.bar.wikiPublish",
  /** `{ project, wiki, parent?, name, template?, content?, comment? }` -> `wiki browse create`: `status: created`, or `status: push` for a code wiki */
  wikiCreate: "aihub.bar.wikiCreate",
  /** `{ project, wiki, path, to }` -> `wiki browse move-plan`: subpages and the links that would change (changes nothing) */
  wikiMovePlan: "aihub.bar.wikiMovePlan",
  /** `{ project, wiki, path, to, updateLinks?, order?, comment? }` -> `wiki browse move`: moved, linksUpdated, linkErrors */
  wikiMove: "aihub.bar.wikiMove",
  /** `{ project, wiki, path, top? }` -> `wiki browse history`: versions newest first with their parent */
  wikiHistory: "aihub.bar.wikiHistory",
  /** `{ project, wiki, path, to, from? }` -> `wiki browse diff`: hunks between two versions */
  wikiRevisionDiff: "aihub.bar.wikiRevisionDiff",
  /** `{ text, project?, wiki?, top?, skip? }` -> `wiki browse search`: pages with highlighted lines; `searchUnavailable` without search */
  wikiSearch: "aihub.bar.wikiSearch",
  /** `{ project, wiki, ref, pagePath? }` -> `wiki browse attachment`: `{ name, mime, bytes, file }` (a cached file for the preview) */
  wikiAttachment: "aihub.bar.wikiAttachment",
  /** `{ project, wiki, file, name? }` -> `wiki browse upload`: `{ name, ref, markdown }` (project wiki only) */
  wikiUpload: "aihub.bar.wikiUpload",
  /** `{ project, wiki, path, question? }`: puts "ask about this page" in the chat (the user presses Enter) */
  wikiAskAgent: "aihub.bar.wikiAskAgent",
  /** `{ project, wiki, path?, branch?, base? }`: puts "update the wiki from this branch" in the chat; the agent only writes drafts */
  wikiUpdateFromBranch: "aihub.bar.wikiUpdateFromBranch",
  /** forget the remembered failures (after az login or a CLI update) */
  wikiRetryNow: "aihub.bar.wikiRetryNow",
  // ---- story browser (one `aihub stories` process each, JSON as in docs/cli-json.md "Story browser"; a failure is
  // `{ error: { kind, message } }` (kinds of the repository browser plus needsSetting), a newer save in between is
  // `{ status: "conflict" }`, never a popup; nothing polls) ----
  /** `{ org? }` -> `aihub stories settings`: the saved project/team/area/iteration and the default types */
  storySettings: "aihub.bar.storySettings",
  /** `{ project, team?, areaPath?, iterationPath? }` -> saves the choice per organisation (config home), answers like storySettings */
  storySaveSettings: "aihub.bar.storySaveSettings",
  /** `{ org? }` -> `{ org, projects:[{id,name}] }` */
  storyProjects: "aihub.bar.storyProjects",
  /** `{ project }` -> `{ teams:[{id,name,isDefault}] }` */
  storyTeams: "aihub.bar.storyTeams",
  /** `{ project, team? }` -> `{ defaultArea, areas:[{path,includeChildren}], all:[path] }` */
  storyAreas: "aihub.bar.storyAreas",
  /** `{ project, team? }` -> `{ iterations:[{id,name,path,start,finish,timeFrame}], current? }` */
  storyIterations: "aihub.bar.storyIterations",
  /** `{ view: mine|sprint|backlog, types?, search?, top?, project?, team? }` -> `{ items:[ItemRow], iterationPath?, readAt, cached }` */
  storyList: "aihub.bar.storyList",
  /** `{ board?, types?, project?, team? }` -> `{ board, columns:[{name,states,category,isDone,wipLimit?,items:[ItemRow]}] }` */
  storyBoard: "aihub.bar.storyBoard",
  /** `{ id }` -> Item: sections per template, systemInfo (Bug), tasks, parentItem, related, children, development, comments, allowedStates */
  storyShow: "aihub.bar.storyShow",
  /** `{ id, rev, to? | column?, board? }` (a state, or a board column) -> `{ status:"saved", rev, state, column? }` | `{ status:"conflict", current, theirChanges }` */
  storyMove: "aihub.bar.storyMove",
  /** `{ id, rev, title?, state?, assign?, priority?, severity?, points?, tags?, iterationPath?, areaPath?, sections?:[{heading,markdown}], systemInfo? }` -> saved | conflict */
  storyEdit: "aihub.bar.storyEdit",
  /** `{ id, done, rev? }` -> the Completed (done) or Proposed state of the task; saved | conflict */
  storyTask: "aihub.bar.storyTask",
  /** `{ parent, title }` -> `{ id, rev, title, state, url }` */
  storyAddTask: "aihub.bar.storyAddTask",
  /** `{ id, markdown }` -> `{ id, comment:{id,date,markdown,html} }` */
  storyComment: "aihub.bar.storyComment",
  /** `{ id }` -> `{ prompt, proposalFile, gaps }`: put prompt in the chat; the agent writes proposalFile */
  storyRefineAsk: "aihub.bar.storyRefineAsk",
  /** `{ id }` -> `{ rev, parts:[{part,heading,current,proposed,changed}], tasks:{current,proposed,new} }` (reads only) */
  storyRefine: "aihub.bar.storyRefine",
  /** `{ id, rev, parts:[description|criteria|tasks|<heading>] }` -> writes only those parts; saved (applied, tasksCreated) | conflict */
  storyRefineApply: "aihub.bar.storyRefineApply",
  /** `{ id, repos?, base?, set?: reuse|none, assignToMe?, open?: new|this|none }` -> branches, state Active, assigned, the story's set */
  storyStart: "aihub.bar.storyStart",
  /** `{ type }` -> `{ type, sections:[{heading,field,hint}], systemInfo, severityValues?, priorityValues?, defaults }` */
  storyForm: "aihub.bar.storyForm",
  /** `{ type, title, sections?, systemInfo?, severity?, priority?, parent?, iterationPath?: current|path, areaPath?, assign?, tags? }` -> `{ id, rev, type, url }` */
  storyNew: "aihub.bar.storyNew",
  /** `{ type, title, notes? }` -> `{ prompt, draftFile }`: put prompt in the chat; the agent writes draftFile */
  storyDraftAsk: "aihub.bar.storyDraftAsk",
  /** `{ draftFile }` -> `{ sections:[{heading,markdown}] }` to fill the New form */
  storyDraft: "aihub.bar.storyDraft",
  /** `{ id, set? }` or `{ id, repo, branch }` -> `{ linked:[{repo,branch,added}], prs:[{repo,id,added}] }` */
  storyLink: "aihub.bar.storyLink",
  /** `{ id, repo?, base? }` -> bugfix/<id>-<slug> from the base, pushed and linked */
  storyFixBranch: "aihub.bar.storyFixBranch",
  /** forget the remembered failures (after az login or a CLI update) */
  storyRetryNow: "aihub.bar.storyRetryNow",
  // ---- team settings (docs/cli-json.md "Team settings"; the same error shape as the repository browser; nothing polls) ----
  /** `{ cwd?, repo?, refresh? }` -> `aihub team show --json --no-detect`: which team.yaml applies, keys per repository (`views`), overrides, templates, where aihub looked */
  teamShow: "aihub.bar.teamShow",
  /** `{}` -> `aihub team validate --schema`: every key with its explanation and an example block per top-level key (the editor's key help) */
  teamSchema: "aihub.bar.teamSchema",
  /** `{ cwd?, content? }` -> `aihub team validate --json`: `{ ok, errors, warnings, problems[] }` with line, message and fix */
  teamValidate: "aihub.bar.teamValidate",
  /** `{ cwd?, template: pr|story|bug|commit, repo? }` -> `aihub team preview --json`: the template filled with this branch's data, and where each value came from */
  teamPreview: "aihub.bar.teamPreview",
  /** `{ cwd?, template?, repo? }` -> where the file lives; with `{ content, branch, title?, baseCommit?, story? }`: a new branch and a pull request in the team repository (never main) */
  teamEdit: "aihub.bar.teamEdit",
  /** `{ cwd?, mode: "pack", repo? }` -> team.yaml from the team pack as a pull request; `{ mode: "teamRepo", teamRepo, everywhere? }` -> use that team repository */
  teamInit: "aihub.bar.teamInit",
  // ---- Run End to End and the agent actions per story (docs/cli-json.md "Run End to End"; failures as the story browser) ----
  /** `{ id, action, repos?, yolo?, window?: new|this, project? }` -> opens or reuses the story's set (starts the story when it has no branches) and starts the opencode tab there with `/<action> <id>`; another window gets a one-shot pending action: `{ id, action, command, folder, window, started }` */
  storyAction: "aihub.bar.storyAction",
  /** `{ id, action, project? }` -> `aihub prompt render <action> --id N --json`: `{ action, slash, title, source: story|team|default, file, summary, filled, unknown, text }` */
  storyPrompt: "aihub.bar.storyPrompt",
  /** `{ id, action, text }` -> Edit Prompt: kept for this story and action until reset */
  storyPromptSave: "aihub.bar.storyPromptSave",
  /** `{ id, action }` -> Reset to Generated: `{ reset }` */
  storyPromptReset: "aihub.bar.storyPromptReset",
  /** `{ project? }` -> `{ prompts:[{ action, title, slash, goal, reads, produces, source, file }] }` */
  storyPrompts: "aihub.bar.storyPrompts",
  /** `{ id }` -> `{ id, running, step, total, label, steps:[{label, state: done|running|queued}], updatedAt, stateFile }` (the badge; watch `stateFile` instead of asking again) */
  storyRunState: "aihub.bar.storyRunState",
  /** `{ id }` -> `{ id, total, proven, criteria:[{ n, text, how, proof, result: pass|fail|notrun, evidence?, reason?, at? }], stateFile }` */
  criteriaStatus: "aihub.bar.criteriaStatus",
  /** `{ id }` -> `{ id, rev, proposalFile, rows:[{ n, current?, proposed, how?, proof?, vague?, isNew, changed }] }` (written by /story-criteria) */
  criteriaProposal: "aihub.bar.criteriaProposal",
  /** `{ id, rev, take:[n] }` -> writes only the ticked criteria with their how-tested and proof lines: saved | conflict */
  criteriaApply: "aihub.bar.criteriaApply",
} as const;
