/**
 * The contract between the engine (this extension) and the buttons in the title bar (the PyCharm Git extension):
 * `activate()` returns `{ bar: BarApi }`, and the commands below do the work. Plain data only, no vscode types.
 */
export type BarMode = "set" | "repo" | "empty";

export interface BarStoryBranch {
  name: string;
  status: "current" | "old" | "parked";
}

export interface BarRepo {
  name: string;
  path: string;
  branch: string;
  /** the branch is linked to the story in Azure DevOps (a set only; absent when not known) */
  linked?: boolean;
  /** changed files; absent when not known */
  dirty?: number;
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
}

export interface BarRepository {
  name: string;
  path: string;
  branch: string;
  /** other clones of the same remote (one line per remote in the menu) */
  otherClones?: number;
}

export interface BarState {
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
  /** OneDrive / network folders that were left out because they are not in "Folders to Look In" */
  scanSkipped?: string[];
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
  otherBranch: "aihub.bar.otherBranch",
  linkBranch: "aihub.bar.linkBranch",
  addRepository: "aihub.bar.addRepository",
  removeRepository: "aihub.bar.removeRepository",
  lookIn: "aihub.bar.lookIn",
  reopenLast: "aihub.bar.reopenLast",
  refresh: "aihub.bar.refresh",
} as const;
