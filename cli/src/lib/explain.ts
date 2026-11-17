/** Short, step-by-step description per command. Keep these in sync when a command changes. */
export const EXPLAIN: Record<string, string[]> = {
  pr: [
    "aihub pr create --body-file pr.md",
    "1. git: current branch, merge-base with the target, commits since then (read only).",
    "2. Target = --target, else team.yaml defaultTarget, else the remote default branch.",
    "3. Reads the PR template from origin/<target> (.azuredevops, .vsts, docs, root), falls back to the working tree.",
    "4. Fills the template: your body file by heading, story link and commit list by code, empty sections get team.yaml emptySection.",
    "5. git push of the branch when origin is behind; REST POST .../pullrequests (or PATCH when an active PR exists).",
    "aihub pr update: edits sections of the existing description (PATCH); other sections stay intact.",
    "Use --dry-run to see the filled description and the calls without writing.",
  ],
  comments: ["aihub comments get: REST GET of the PR threads, shows open ones with the code around the line.", "aihub comments reply --replies-file f.yaml: REST POST of the replies and thread status changes you listed."],
  init: [
    "aihub init: reads the git remote (organization/project/repository) and the default branch.",
    "1. Proposes team.yaml, story and commit templates, and a PR template only when none exists where Azure DevOps looks.",
    "2. Never overwrites a file; existing ones are reported as skipped.",
    "3. Creates branch chore/aihub-team-pack, commits, pushes and opens a PR (REST POST). --no-pr only writes the files.",
    "Skills and slash commands are not written to the repository unless --into-repo.",
  ],
  skills: [
    "aihub skills install: copies the bundled skills and slash commands into each client's global folder (opencode, Codex, Copilot).",
    "Every file gets an 'aihub <version>' marker; checksums go in .aihub-manifest.json so edited files are never overwritten.",
    "aihub skills update: rewrites unchanged copies from the bundled pack. aihub skills diff: shows your edits. aihub skills uninstall: removes only our unchanged files.",
  ],
  doctor: ["aihub doctor: checks Node, git, remote, sign-in method, team.yaml against the schema, PR template, guideline files and the installed skills per client. Nothing is written."],
  update: [
    "aihub update: asks npm for the latest version (registry from your npm config / .npmrc).",
    "1. npm global install: runs npm i -g <package>@latest, then the new CLI shows the changelog and refreshes the skills of every client.",
    "2. Other install: prints the exact command to run.",
    "aihub update --check only reports versions; nothing changes.",
  ],
  story: ["aihub story show|create|refine: reads or writes work items through REST; story start|link|finish prepare the branches, link the PR and finish the story.", "Use --dry-run to see the planned git and REST calls."],
  branch: ["aihub branch update: merges (or rebases with --rebase) the target branch into the current branch, then pushes.", "git fetch, git merge/rebase, git push."],
  "cherry-pick": ["aihub cherry-pick: creates a branch per target from the release branch, cherry-picks the commits of the PR, pushes and opens a PR per target."],
  pipeline: ["aihub pipeline follow|status|runs|logs|run: reads builds through REST; run queues one. follow polls until it finishes."],
  batch: ["aihub batch: runs the same flow for several stories or pull requests one after the other and prints one result per item."],
  work: ["aihub work: the combined daily flow (story, branch, PR) in one command; see 'aihub explain story' and 'aihub explain pr'."],
  worktree: ["aihub worktree create|list|remove: git worktrees per story across the repositories of a set, so each story has its own folder."],
  review: ["aihub review show: reads a PR with its changes. aihub review post --comments-file f.yaml: posts your review comments (REST POST)."],
  wiki: ["aihub wiki update --page <path> --body-file f: writes a wiki page (REST PUT); --publish also publishes it."],
  release: ["aihub release plan: lists the pull requests of the given stories for a target branch. aihub release run --plan-file f: executes that plan."],
  workitem: ["aihub workitem state --id n --to state: changes the state of a work item (REST PATCH)."],
  evidence: ["aihub evidence add --pr n --file image: uploads the image as an attachment and adds it to the PR as a comment."],
  fabric: ["aihub fabric plan|run|status: plans and runs Fabric deployments for the workspaces in team.yaml."],
  robot: ["aihub robot needed|run|targets: decides which Robot suites are needed, merges the feature into the integration branch in a temporary worktree, pushes and queues the run."],
};

export function explain(name: string | undefined): string[] {
  if (!name) return [`Commands with an explanation: ${Object.keys(EXPLAIN).join(", ")}.`, "Run 'aihub explain <command>'."];
  const e = EXPLAIN[name];
  return e ?? [`no explanation for '${name}'. Commands: ${Object.keys(EXPLAIN).join(", ")}.`];
}