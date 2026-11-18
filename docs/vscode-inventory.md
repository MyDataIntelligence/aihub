# Inventory of the frozen extension (2.x) and what replaces it in 3.x

Source: `archive/ai-context-hub-v2/vscode/ai-context-hub-vscode/package.json` on `MyDataIntelligence/extensions` main, plus its `docs/vscode-extension/context-menus.md` and the standalone Worktree Maker extension (`vscode/worktree-maker-vscode`), whose git-only code is the base for the worktree-set rows.

Categories: **(a)** an `aihub` CLI read the extension runs directly with `--json` (or a user-typed reply written to a file); **(b)** done in the extension with plain git or the VS Code API (destructive ones behind a confirm dialog); **(c)** text put in the user's chat with the `aihub` agent selected (slash command or one sentence naming the skill); **(d)** needs a new CLI command; **(e)** dropped, with the reason. Priority: **P1** = general branch actions and worktree sets (built first, same menu placement as before), P1b = small base items, P2/P3 = Hub-specific, built after P1.

## Counts

| Category | Commands |
|---|---|
| (a) aihub CLI read, run directly | 31 |
| (b) extension: git / VS Code API | 41 |
| (c) text put in chat with the aihub agent | 77 |
| (d) needs a new aihub CLI command | 4 |
| (e) dropped | 106 |
| **Total commands** | **259** |

P1 rows: 39. Other contributions (menus, submenus, keybindings, views, settings, chat skills, tools) are listed below the command table.

## (d) New aihub CLI commands needed

1. `aihub pr list [--mine|--reviewer|--branch X] [--status active|all] --json`: one row per PR (id, title, status, draft, source/target branch, author, url). Used by the select/find/followed PR pickers and "review someone else's PR".
2. `votes` in `aihub status --json` (`pr.votes: [{name, vote}]`) or `aihub pr show --pr N --json` with reviewers and votes: the bar derives votes from the reviewers policy today.
3. `aihub watch events [--limit N] --json`: the bar reads `~/.aihub/events/*.json` directly today; a command keeps the extension free of file formats.
4. Optional: `aihub worktree status|sync|push|cleanup --story N --json`, if worktree-set operations should also work from the CLI/agent. The extension does not need it (it uses git).

## Commands

| # | Command | Title | Where it appeared | What it did | New | Prio |
|---|---|---|---|---|---|---|
| 1 | `start` | Start Hub core | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 2 | `stop` | Stop Hub core | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 3 | `restart` | Restart Hub core | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 4 | `showLog` | Show log | palette | Opened the extension log | (b) output channel (exists) | P2 |
| 5 | `showNotices` | Show Hub notifications | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 6 | `showCoreLog` | Show Hub core log (hub.log) | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 7 | `refresh` | Refresh | view/title@navigation@9 | Refreshed the Hub view | (b) aihub.refresh (exists) | P2 |
| 8 | `hubOptions` | Options | view/title@navigation@2 | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 9 | `toggleHubPanel` | Toggle AI Context Hub tool window | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 10 | `openHubPanelInEditor` | Open AI Context Hub in an editor tab | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 11 | `copyBatchFiles` | Copy prepared files | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 12 | `openPanel` | Open Hub panel | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 13 | `runTool` | Run Hub tool… | view/title@navigation@1 | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 14 | `openTool` | Open tool form | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 15 | `runOption` | Run option | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 16 | `openDialogSpec` | Open Hub dialog form | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 17 | `runPhaseAction` | Run phase action | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 18 | `workflowNext` | And now? (next step) | view/title@navigation@1 | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 19 | `menu` | Hub menu | view/title@navigation@2 | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 20 | `searchActions` | Search AI Context Hub actions… | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 21 | `docs.search` | Search documentation… | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 22 | `bar.workOn` | Work on… (story, PR or branch) | palette | Quick pick to work on a story, PR or branch | (c) chat: /start (opens the aihub agent with the command) | P2 |
| 23 | `hubMenu` | Hub menu: what do you want to do? | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 24 | `bar.switchMode` | Switch bar mode (agent / Microsoft Copilot) | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 25 | `focusApprovals` | Show approvals | palette | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 26 | `showApproval` | Approval details | commandPalette | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 27 | `approve` | Approve | commandPalette, view/item/context@inline@1 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 28 | `reject` | Reject | commandPalette, view/item/context@inline@2 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 29 | `activity.undo` | Undo | commandPalette, view/item/context@inline@1 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 30 | `addToContext` | Add to Hub context | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 31 | `removeFromContext` | Remove from Hub context | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 32 | `showContextPack` | Show context pack | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 33 | `startStory` | Start story… | palette | Started a story or hotfix | (c) chat: /start | P2 |
| 34 | `addNote` | Add note… | view/title@navigation@1 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 35 | `explainChange` | Explain this branch's change | view/title@navigation@1 | Explained the branch change | (c) chat: /explain | P2 |
| 36 | `openLearn` | Open explanation | commandPalette | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 37 | `editSetting` | Hub settings… | view/title@navigation@1 | Edited Hub settings (also with Microsoft Copilot) | (c) chat: team-settings skill edits team.yaml | P2 |
| 38 | `editSettingQuick` | Change one Hub setting… | palette | Edited Hub settings (also with Microsoft Copilot) | (c) chat: team-settings skill edits team.yaml | P2 |
| 39 | `setAzurePat` | Set Azure DevOps PAT… | palette | Stored the Azure DevOps PAT | (b) VS Code SecretStorage; passed to spawned aihub as AIHUB_ADO_PAT | P2 |
| 40 | `clearAzurePat` | Clear stored PAT | palette | Cleared the stored PAT | (b) SecretStorage delete | P2 |
| 41 | `testAzureCredential` | Test credential | palette | Tested the credential | (a) aihub doctor --json (sign-in line) | P2 |
| 42 | `signInAzureCli` | Sign in with Azure CLI… | palette | Signed in with Azure CLI | (b) terminal: az login | P2 |
| 43 | `copyClaudeMcp` | Copy Claude Code MCP command | palette | Copied the Claude Code MCP command | (e) dropped: MCP is gone | - |
| 44 | `templates.edit` | Edit template… | palette | Edited a story/PR template and its history | (b) open the template file (.agents/skills/_shared/assets) in the editor; history = git log of that file | P3 |
| 45 | `templates.history` | Template history… | palette | Edited a story/PR template and its history | (b) open the template file (.agents/skills/_shared/assets) in the editor; history = git log of that file | P3 |
| 46 | `guidelines.move` | Move guidelines into the guidelines folder… | palette | Moved guidelines / created the guideline structure | (c) chat: team-settings skill | P3 |
| 47 | `installSkills` | Install Hub skills for agents | palette | Installed Hub skills for agents | (a) aihub skills install in the integrated terminal (visible) | P2 |
| 48 | `updateSharedSkills` | Update the shared Hub skills text (draft PR) | palette | Updated the shared Hub skills text as a draft PR | (c) chat: aihub init / team-settings skill | P3 |
| 49 | `installSkillsGlobal` | Install Hub skills globally (Copilot CLI, opencode) | palette | Installed Hub skills for agents | (a) aihub skills install in the integrated terminal (visible) | P2 |
| 50 | `whatsNew` | What's New | palette | Get-started walkthrough, What's New page | (e) dropped: replaced by the extension README; no Hub tour | - |
| 51 | `verifySetup` | Verify setup | palette | Verified the setup, fix a setup problem | (a) aihub doctor --json shown in the panel | P2 |
| 52 | `healthMenu` | Fix setup problem | palette | Verified the setup, fix a setup problem | (a) aihub doctor --json shown in the panel | P2 |
| 53 | `checkForUpdates` | Check for updates | palette | Checked for updates / updated the CLI package | (a) aihub update --check / aihub update in the terminal | P2 |
| 54 | `updateCli` | Update the Hub CLI package | palette | Checked for updates / updated the CLI package | (a) aihub update --check / aihub update in the terminal | P2 |
| 55 | `verifyStandalone` | Verify standalone engine | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 56 | `downloadJavaRuntime` | Get a Java runtime for the Hub core | commandPalette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 57 | `removeLegacyRuntime` | Remove legacy runtime (1.x IDE download) | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 58 | `chat.open` | Open Copilot Chat with a Hub prompt | commandPalette | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 59 | `askAboutStory` | Ask Copilot about this story | palette | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 60 | `startInAgentsWindow` | Start in Agents window | palette | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 61 | `walkthrough.checkCore` | Check that a Hub core can run here | palette | Started, stopped or checked the Java Hub core | (e) dropped: the Java core is gone; the CLI has no daemon | - |
| 62 | `openWalkthrough` | Get started with the AI Context Hub | palette | Get-started walkthrough, What's New page | (e) dropped: replaced by the extension README; no Hub tour | - |
| 63 | `showBar` | Show workflow bar | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 64 | `toggleBar` | Show/Hide Hub bar | view/title@navigation@9 | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 65 | `showHub` | Show AI Context Hub panel | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 66 | `fixWithCopilot` | Fix with Copilot (Hub) | commandPalette | Fix pipeline/diagnostic problems with Copilot | (c) chat: pipeline-fix skill (/review for threads) | P2 |
| 67 | `showRepairContext` | Ask the Hub for the repair context | commandPalette | Fix pipeline/diagnostic problems with Copilot | (c) chat: pipeline-fix skill (/review for threads) | P2 |
| 68 | `refreshProblems` | Refresh pipeline problems | palette | Fix pipeline/diagnostic problems with Copilot | (c) chat: pipeline-fix skill (/review for threads) | P2 |
| 69 | `robotFixWithCopilot` | Fix with Copilot | commandPalette, testing/item/context@aiContextHub@1, testing/message/context@inline | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 70 | `robot.editAndRun` | Robot: Edit and Run… | palette | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 71 | `robot.configureRun` | Robot: Run Robot Tests options… | palette | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 72 | `robot.generateTests` | Robot: Generate Robot tests… | palette | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 73 | `robot.runIntegration` | Robot: Run Robot Integration Test… | palette | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 74 | `pipeline.run` | Run pipeline… | palette | Ran a pipeline | (c) chat: aihub pipeline run (needs confirmation in the agent) | P2 |
| 75 | `pipeline.status` | Pipeline status… | palette | Showed pipeline status | (a) aihub pipeline status --json (panel/quick pick) | P1b |
| 76 | `fabric.showFailure` | Fabric run error… | palette | Showed a Fabric run error | (a) aihub fabric failures\|logs --json (in the base PR) | done |
| 77 | `diagnose` | Diagnose… | palette | Fix pipeline/diagnostic problems with Copilot | (c) chat: pipeline-fix skill (/review for threads) | P2 |
| 78 | `refreshFiles` | Send updated context… | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 79 | `skillsOffer` | Offer Hub skills for this repository… | palette | Installed Hub skills for agents | (a) aihub skills install in the integrated terminal (visible) | P2 |
| 80 | `readReviewExplanation` | Read review explanation | palette | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 81 | `dependencies` | Dependencies… | palette | Dependency analysis / diagram | (c) chat prompt | P3 |
| 82 | `dependencies.diagram` | Dependency diagram… | palette | Dependency analysis / diagram | (c) chat prompt | P3 |
| 83 | `preflight` | Large selection preflight… | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 84 | `cherryPickAcross` | Cherry-Pick to Other Repositories… | palette | Cherry-picked to other repositories | (c) chat: /cherry-pick | P2 |
| 85 | `pr.refreshThreads` | Show PR review threads in the editor | palette | Showed PR review threads in the editor | (a) aihub comments get --json -> VS Code Comments API | P2 |
| 86 | `pr.reply` | Reply | commandPalette, comments/commentThread/context@inline@1 | Replied to review threads | (a) aihub comments reply --replies-file (file written by the extension, text typed by the user) | P2 |
| 87 | `pr.resolve` | Resolve | commandPalette, comments/commentThread/title@navigation@2 | Resolved, won't-fix or reactivated a thread | (a) aihub comments reply with status fixed\|wontFix\|active | P2 |
| 88 | `pr.wontFix` | Won't fix | commandPalette, comments/commentThread/title@navigation@3 | Resolved, won't-fix or reactivated a thread | (a) aihub comments reply with status fixed\|wontFix\|active | P2 |
| 89 | `pr.reactivate` | Reactivate | commandPalette, comments/commentThread/title@navigation@1 | Resolved, won't-fix or reactivated a thread | (a) aihub comments reply with status fixed\|wontFix\|active | P2 |
| 90 | `pr.fixWithCopilot` | Fix with Copilot | commandPalette, comments/commentThread/title@navigation@1 | Fixed the PR from review feedback with Copilot | (c) chat: /review | P2 |
| 91 | `pr.selectOther` | Select another pull request… | palette | Selected, found or listed PRs (mine, followed, someone else's) | (d) NEW aihub pr list [--mine\|--reviewer\|--branch X] [--status active\|all] --json, shown in a quick pick | P2 |
| 92 | `pr.findManually` | Find PR manually… | palette | Selected, found or listed PRs (mine, followed, someone else's) | (d) NEW aihub pr list [--mine\|--reviewer\|--branch X] [--status active\|all] --json, shown in a quick pick | P2 |
| 93 | `pr.noPrYet` | Write PR description or find an existing PR… | palette | Found the existing PR / chose the user story | (a) aihub status --json (PR of this branch) and aihub work --json (my stories) | P2 |
| 94 | `pr.reviewSomeones` | Review someone else's PR… | palette | Reviewed someone else's PR / own PR | (c) chat: /review-pr | P2 |
| 95 | `pr.reviewWorktree` | Review PR in a worktree… | palette | Reviewed a PR in a worktree | (c) chat: /review-pr (the agent runs aihub worktree) | P2 |
| 96 | `pr.reviewFewerFiles` | Review fewer files… | palette | Reviewed someone else's PR / own PR | (c) chat: /review-pr | P2 |
| 97 | `pr.suggestedComments` | Suggested review comments… | palette | Reviewed someone else's PR / own PR | (c) chat: /review-pr | P2 |
| 98 | `pr.create` | Create Pull Request… | palette | Created or updated the PR | (c) chat: /pr or /pr-update | P1b |
| 99 | `pr.document` | Document PR… | palette | Created or updated the PR | (c) chat: /pr or /pr-update | P1b |
| 100 | `pr.followed` | Followed pull requests… | palette | Selected, found or listed PRs (mine, followed, someone else's) | (d) NEW aihub pr list [--mine\|--reviewer\|--branch X] [--status active\|all] --json, shown in a quick pick | P2 |
| 101 | `pr.chooseStory` | Choose User Story… | commandPalette | Found the existing PR / chose the user story | (a) aihub status --json (PR of this branch) and aihub work --json (my stories) | P2 |
| 102 | `pr.useBranchChanges` | Use my branch changes as context… | palette | Used the branch changes as Hub context | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 103 | `pr.postReplies` | Post replies to review comments… | palette | Replied to review threads | (a) aihub comments reply --replies-file (file written by the extension, text typed by the user) | P2 |
| 104 | `release.start` | Create release… | palette | Created a release | (c) chat: /release | P2 |
| 105 | `wiki.updateGuide` | Update the wiki… | palette | Wiki update, create, link | (c) chat: /wiki | P3 |
| 106 | `wiki.projectWiki` | Project wiki… | palette | Wiki update, create, link | (c) chat: /wiki | P3 |
| 107 | `wiki.importAnswer` | Import wiki answer (functional-wiki-update)… | palette | Wiki update, create, link | (c) chat: /wiki | P3 |
| 108 | `wiki.pickPage` | Pick a wiki page… | commandPalette | Wiki update, create, link | (c) chat: /wiki | P3 |
| 109 | `wiki.createWiki` | Create a project wiki… | palette | Wiki update, create, link | (c) chat: /wiki | P3 |
| 110 | `scm.suggestCommitMessage` | Commit message from the Hub | scm/title@navigation@1 | Suggested a commit message in the SCM box | (c) chat: /commit | P2 |
| 111 | `scm.leftBehind` | Left-behind files… (before a commit or push) | palette | Warned about left-behind files before commit/push | (b) git status check in the extension | P2 |
| 112 | `pr.explanationStatus` | PR explanation status… | palette | Explained the branch change | (c) chat: /explain | P2 |
| 113 | `openStoryWorkspace` | Open story as workspace | palette | Opened the story as a workspace / window | (b) open the worktree set workspace file (P1 worktree sets) | P1 |
| 114 | `startStoryInWorktrees` | Start story in worktrees… | palette | Started a story in worktrees / added repositories | (b) worktree set: create / add repositories (P1) | P1 |
| 115 | `newStory` | Start a new story | palette | Started a story or hotfix | (c) chat: /start | P2 |
| 116 | `switchStory` | Switch story / worktree… | palette | Recent stories, switch story/worktree | (a) aihub work --json quick pick + open the story's worktree set (b) | P2 |
| 117 | `switchBranch` | Switch branch in this repo… | palette | Switched branch in this repo | (b) git: quick pick of local/remote branches + checkout (P1) | P1 |
| 118 | `setMenu` | Worktree set: repositories and branches… | palette | Worktree set menu / open set window | (b) worktree set actions quick pick, open workspace file (P1) | P1 |
| 119 | `openSetWindow` | Open worktree set window | commandPalette | Worktree set menu / open set window | (b) worktree set actions quick pick, open workspace file (P1) | P1 |
| 120 | `finishStory` | Finish story… | palette | Finished the story | (c) chat: /finish | P2 |
| 121 | `recentStories` | Recent stories… | palette | Recent stories, switch story/worktree | (a) aihub work --json quick pick + open the story's worktree set (b) | P2 |
| 122 | `addRepositoryToStory` | Add repository to story… | palette | Started a story in worktrees / added repositories | (b) worktree set: create / add repositories (P1) | P1 |
| 123 | `removeRepositoryFromStory` | Remove repository from story… | palette | Removed a repository from the story | (b) worktree set: remove from set (P1) | P1 |
| 124 | `storyStatus` | Status of story repos | palette | Status of the story's repos | (b) worktree set: per-repo status (P1) | P1 |
| 125 | `storyPushAll` | Push all story repos | palette | Pushed all story repos | (b) worktree set: Push Set (P1) | P1 |
| 126 | `storyUpdateAll` | Update all story repos from target | palette | Updated all story repos from target | (b) worktree set: Sync Set (P1) | P1 |
| 127 | `startHotfix` | Start hotfix… | palette | Started a story or hotfix | (c) chat: /start | P2 |
| 128 | `openStoryInAgents` | Open story in Agents window | palette | Opened the story as a workspace / window | (b) open the worktree set workspace file (P1 worktree sets) | P1 |
| 129 | `openStoryWindow` | Open story window… | palette | Opened the story as a workspace / window | (b) open the worktree set workspace file (P1 worktree sets) | P1 |
| 130 | `openStoryProposal` | Open last proposal | palette | Recent stories, switch story/worktree | (a) aihub work --json quick pick + open the story's worktree set (b) | P2 |
| 131 | `refineStory` | Refine story… | palette | Refined a story | (c) chat: /refine | P2 |
| 132 | `refineLanes` | Refine lanes… | palette | Refined a story | (c) chat: /refine | P2 |
| 133 | `writeStory` | Write story from idea… | palette | Wrote a story from an idea | (c) chat: /story | P2 |
| 134 | `attachRepository` | Attach Repository… | palette | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 135 | `detachRepository` | Detach Repository… | palette | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 136 | `openRepositories` | Open Repositories… | view/title@9_aiContextHub@1 | Listed Hub repositories and opened one | (a) aihub repos list --json + open folder (VS Code) | P2 |
| 137 | `saveRepositoriesWorkspace` | Save Repositories as Workspace… | view/title@9_aiContextHub@2 | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 138 | `bar.openRepository` | Open Repository in VS Code | commandPalette | Listed Hub repositories and opened one | (a) aihub repos list --json + open folder (VS Code) | P2 |
| 139 | `repo.attachFolder` | Attach to Hub (add repository) | commandPalette, cm.ProjectViewGroup@0_repositories@1 | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 140 | `repo.detachFolder` | Detach from Hub | commandPalette, cm.ProjectViewGroup@0_repositories@2 | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 141 | `repo.addFolderToStory` | Add to story… | commandPalette, cm.ProjectViewGroup@0_repositories@3 | Started a story in worktrees / added repositories | (b) worktree set: create / add repositories (P1) | P1 |
| 142 | `repo.startStoryWithFolders` | Start story with these repositories… | commandPalette, cm.ProjectViewGroup@0_repositories@4 | Started a story in worktrees / added repositories | (b) worktree set: create / add repositories (P1) | P1 |
| 143 | `prompt.editPrepared` | Edit prepared prompt | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 144 | `yolo.approveAll` | Approve all agent writes this session (YOLO) | commandPalette, view/title@9_yolo@1 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 145 | `yolo.set` | Approve all agent writes this session (YOLO) | commandPalette | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 146 | `yolo.untilPr` | Werk door tot de PR af is (YOLO) | palette | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 147 | `yolo.setHours` | Turn auto-approve off after (hours)… | palette | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 148 | `storyRun` | Story run: stop or show where it stands | palette | Story run: stop or show where it stands | (c) chat: /story-run | P2 |
| 149 | `exportText` | Export text to a file… | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 150 | `guidelines.createStructure` | Create guideline structure | commandPalette | Moved guidelines / created the guideline structure | (c) chat: team-settings skill | P3 |
| 151 | `gitRootOf` | Git root of a path | commandPalette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 152 | `configEdit` | Edit with Microsoft Copilot | commandPalette | Edited Hub settings (also with Microsoft Copilot) | (c) chat: team-settings skill edits team.yaml | P2 |
| 153 | `searchRepositories` | Search Code and Docs Across Repositories… | palette | Attached or detached folders to the Hub repository registry; cross-repo search | (e) dropped: no registry: VS Code workspace folders are the repositories; the agent searches with its own tools | - |
| 154 | `showChanges` | Show changes | view/item/context@inline@0 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 155 | `approveChanges` | Approve proposed changes | commandPalette, editor/title@navigation@1 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 156 | `approveFiles` | Approve selected changes… | commandPalette, editor/title@navigation@2 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 157 | `rejectChanges` | Reject proposed changes | commandPalette, editor/title@navigation@3 | Approved, rejected or undid agent writes; auto-approve | (e) dropped: the Hub approval gate is gone; the aihub agent files carry the permissions | - |
| 158 | `notes.addClipboard` | Add the clipboard (text or image) as a note | view/title@navigation@0 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 159 | `notes.pasteImage` | Paste a screenshot as a note… | view/title@1_add@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 160 | `notes.screenshot` | Take screenshot as a note… | view/title@1_add@2a | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 161 | `notes.captureEvidence` | Capture evidence… | view/title@navigation@1a | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 162 | `notes.addFile` | File or image… | view/title@1_add@3 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 163 | `notes.toggleInclude` | Include in PR / leave out | view/title@2_more@1 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 164 | `notes.edit` | Edit… | commandPalette, view/item/context@inline@1 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 165 | `notes.delete` | Delete | view/item/context@inline@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 166 | `notes.open` | Open note | commandPalette | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 167 | `notes.cleanUp` | Clean up… | view/title@2_more@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 168 | `notes.documentPr` | Document this PR… | view/title@navigation@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 169 | `notes.updatePrDescription` | Update PR description… | view/title@2_pr@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 170 | `notes.addSelection` | Add clipboard to branch notes | palette | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 171 | `learn.tour` | Walk through the change | view/title@navigation@0, view/item/context@inline@1 | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 172 | `learn.openDiagram` | Open diagram | commandPalette | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 173 | `learn.openConcept` | Open source explanation | commandPalette, view/item/context@1_concept@1 | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 174 | `learn.goToChange` | Go to this change | commandPalette, view/item/context@inline@0, view/item/context@1_concept@2 | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 175 | `learn.findConcept` | Find a concept | view/title@navigation@2 | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 176 | `learn.forget` | Forget | commandPalette, view/item/context@inline@1 | Learn panel: tour, diagrams, concepts of a change | (e) dropped: Hub-rendered learn views are gone; explaining a change is /explain in chat | - |
| 177 | `cm.ChatWithContextApi` | Chat with Context API | cm.ProjectViewGroup@1_copilot@1, cm.EditorPopupGroup@1_copilot@1 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 178 | `cm.TalkToCopilot` | Talk to Copilot | cm.ProjectViewGroup@1_copilot@2, cm.EditorPopupGroup@1_copilot@2 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 179 | `cm.DbtOnFabric` | dbt on Fabric… | cm.ProjectViewGroup@1_copilot@4, cm.EditorPopupGroup@1_copilot@4 | dbt on Fabric prompt | (c) chat: fabric skill prompt | P3 |
| 180 | `cm.CopilotPrompts` | Copilot Prompts… | cm.ProjectViewGroup@1_copilot@3, cm.EditorPopupGroup@1_copilot@3 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 181 | `cm.Add` | Add to chat | cm.ProjectViewGroup@2_add@1 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 182 | `cm.AddOptions` | Add to chat with options… | cm.ProjectViewGroup@2_add@2 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 183 | `cm.AddToNextBatch` | Add to next batch | cm.ProjectViewGroup@2_add@3 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 184 | `cm.QuickAddInNewSession` | Start new chat with selection | cm.ProjectViewGroup@2_add@4 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 185 | `cm.ReviewChanges` | Review changes… | cm.ProjectViewGroup@3_work@1 | Reviewed changes of selected files | (c) chat: /review | P2 |
| 186 | `cm.ResetToRef` | Reset to Branch or Commit… | cm.ProjectBranchGroup@1_branch@1, cm.GitBranchHealth@1_branch@1 | Reset selected files to a branch or commit | (b) git checkout <ref> -- <paths> after a confirm dialog listing the files | P1 |
| 187 | `cm.CheckMergeConflicts` | Check for Merge Conflicts… | cm.ProjectBranchGroup@1_branch@2, cm.GitBranchHealth@1_branch@2 | Checked for merge conflicts with the target | (b) git merge-tree against origin/<target>; lists conflicting files | P1 |
| 188 | `cm.CleanUpUnrelatedChanges` | Clean Up Unrelated Changes… | cm.ProjectBranchGroup@1_branch@3, cm.GitBranchHealth@1_branch@3 | Reset files changed on the branch that are not related to the story | (b) git diff --name-only <target>...HEAD pick list + confirm, then reset those files to <target> | P1 |
| 189 | `cm.SquashCommits` | Squash Branch Commits… | cm.ProjectBranchGroup@1_branch@4, cm.GitBranchHealth@1_branch@4 | Squashed the branch commits into one | (b) git reset --soft <merge-base> + commit after confirm; offers push (force-with-lease) / /pr | P1 |
| 190 | `cm.SearchPossibleFix` | Suggest fix… | cm.ProjectViewGroup@3_work@3 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 191 | `cm.ConfigureSelectedFileContext` | Set references… | cm.ProjectViewGroup@3_work@4 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 192 | `cm.ExcludeSelectedFilesForBatch` | This batch | cm.ExclusionGroup@1_exclude@1 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 193 | `cm.ExcludeSelectedFilesForSession` | This chat | cm.ExclusionGroup@1_exclude@2 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 194 | `cm.ToggleSelectedFilesProjectExclusion` | Exclude from project | cm.ExclusionGroup@1_exclude@3 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 195 | `cm.IncludeSelectedFilesInProject` | Include in project again | cm.ExclusionGroup@1_exclude@3 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 196 | `cm.RunRobotTests` | Run Robot tests… | cm.RobotTestsGroup@1_run@1, cm.BranchPrGroup@4_robot@2 | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 197 | `cm.ExcludeFromRobotTests` | Exclude from robot tests | cm.RobotTestsGroup@2_scope@1 | Excluded files from Robot test selection | (e) dropped: Hub setting project.robotTestExcludes is gone | - |
| 198 | `cm.IncludeInRobotTests` | Include in robot tests again | cm.RobotTestsGroup@2_scope@2 | Excluded files from Robot test selection | (e) dropped: Hub setting project.robotTestExcludes is gone | - |
| 199 | `cm.GenerateRobotTests` | Generate Robot tests… | cm.ProjectViewGroup@3_work@7, cm.BranchPrGroup@4_robot@1 | Edited, ran, generated or fixed Robot tests | (c) chat: /test (aihub robot needed\|run\|targets inside the agent) | P2 |
| 200 | `cm.WriteUserStory` | Write story from idea… | cm.ProjectStoryGroup@1_write@1, cm.BranchStoryGroup@1_write@1 | Wrote a story from an idea | (c) chat: /story | P2 |
| 201 | `cm.PrepareRefinementQuestions` | Prepare refinement questions… | cm.ProjectStoryGroup@2_refine@1, cm.BranchStoryGroup@2_refine@1 | Refined a story | (c) chat: /refine | P2 |
| 202 | `cm.RefineUserStory` | Refine story… | cm.ProjectStoryGroup@2_refine@2, cm.BranchStoryGroup@2_refine@2 | Refined a story | (c) chat: /refine | P2 |
| 203 | `cm.StartStory` | Start story… | cm.ProjectStoryGroup@3_start@1, cm.BranchStoryGroup@3_start@1 | Started a story or hotfix | (c) chat: /start | P2 |
| 204 | `cm.CreateFunctionalWikiPages` | Create new wiki pages… | cm.FunctionalWikiGroup@1_wiki@1 | Wiki update, create, link | (c) chat: /wiki | P3 |
| 205 | `cm.LinkFunctionalWikiPages` | Link existing wiki pages… | cm.FunctionalWikiGroup@1_wiki@2 | Wiki update, create, link | (c) chat: /wiki | P3 |
| 206 | `cm.FunctionalWiki` | Update linked wiki pages… | cm.FunctionalWikiGroup@1_wiki@3 | Wiki update, create, link | (c) chat: /wiki | P3 |
| 207 | `cm.MonitorFromHere` | Monitor from here | cm.ProjectPrGroup@1_pr@1, cm.BranchPrGroup@1_follow@1 | Followed the PR until merged / monitored from here | (c) chat: /watch | P2 |
| 208 | `cm.FollowPullRequest` | Follow this PR until merged | cm.ProjectPrGroup@1_pr@2, cm.BranchPrGroup@1_follow@2 | Followed the PR until merged / monitored from here | (c) chat: /watch | P2 |
| 209 | `cm.FollowedPullRequests` | Followed pull requests… | cm.BranchPrGroup@1_follow@3 | Selected, found or listed PRs (mine, followed, someone else's) | (d) NEW aihub pr list [--mine\|--reviewer\|--branch X] [--status active\|all] --json, shown in a quick pick | P2 |
| 210 | `cm.PrNotes` | 1 · Write PR notes… | cm.ProjectPrGroup@1_pr@3, cm.BranchPrGroup@2_pr@1 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 211 | `cm.DocumentThisPr` | 2 · Create or update PR… | cm.ProjectPrGroup@1_pr@4, cm.BranchPrGroup@2_pr@2 | Created or updated the PR | (c) chat: /pr or /pr-update | P1b |
| 212 | `cm.PreparePrForCopilot` | 3 · Review my PR… | cm.ProjectPrGroup@1_pr@5, cm.BranchPrGroup@2_pr@3 | Reviewed someone else's PR / own PR | (c) chat: /review-pr | P2 |
| 213 | `cm.FixMyPr` | 4 · Fix my PR from review feedback… | cm.ProjectPrGroup@1_pr@6, cm.BranchPrGroup@2_pr@4 | Fixed the PR from review feedback with Copilot | (c) chat: /review | P2 |
| 214 | `cm.ReplyToReviewComments` | 5 · Post replies to review comments… | cm.ProjectPrGroup@1_pr@7, cm.BranchPrGroup@2_pr@5 | Replied to review threads | (a) aihub comments reply --replies-file (file written by the extension, text typed by the user) | P2 |
| 215 | `cm.ReleaseFlow` | 6 · Create release… | cm.ProjectPrGroup@1_pr@8, cm.BranchPrGroup@2_pr@6 | Created a release | (c) chat: /release | P2 |
| 216 | `cm.CrossRepoCherryPick` | Cherry-Pick to Other Repositories… | timeline/item/context@9_aiContextHub@1, webview/context@9_aiContextHub@1, cm.ProjectPrGroup@1_pr@9, cm.BranchPrGroup@2_pr@7 | Cherry-picked to other repositories | (c) chat: /cherry-pick | P2 |
| 217 | `cm.ReviewSomeonesPr` | Review someone else's PR… | cm.ProjectPrGroup@2_other@1, cm.BranchPrGroup@3_other@1 | Reviewed someone else's PR / own PR | (c) chat: /review-pr | P2 |
| 218 | `cm.ReviewPrInWorktree` | Review PR in a worktree… | cm.ProjectPrGroup@2_other@2, cm.BranchPrGroup@3_other@2 | Reviewed a PR in a worktree | (c) chat: /review-pr (the agent runs aihub worktree) | P2 |
| 219 | `cm.PrepareBranchChanges` | Use my branch changes as context… | cm.ProjectPrGroup@2_other@3, cm.BranchPrGroup@3_other@3 | Used the branch changes as Hub context | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 220 | `cm.ExplainThisChange` | Explain this change… | cm.BranchPrGroup@3_other@4 | Explained the branch change | (c) chat: /explain | P2 |
| 221 | `cm.ReplaceCurrentSession` | Replace chat with selection | cm.SessionGroup@1_chat@1 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 222 | `cm.Remove` | Remove from chat | cm.SessionGroup@1_chat@2 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 223 | `cm.ViewDependencies` | Dependencies… | cm.AnalyzeGroup@1_analyze@1 | Dependency analysis / diagram | (c) chat prompt | P3 |
| 224 | `cm.Open` | Open AI Context Hub | cm.ProjectViewGroup@5_open@1 | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 225 | `cm.EditorAskQuestion` | Ask question… | cm.EditorPopupGroup@2_selection@1 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 226 | `cm.EditorSuggestFix` | Suggest fix for selection… | cm.EditorPopupGroup@2_selection@2 | Opened Copilot Chat with a Hub prompt (story, selection, prompt catalogue) | (c) put the text in chat with the aihub agent (selection becomes the context) | P2 |
| 227 | `cm.MonitorPipelines` | Pipeline status… | cm.BranchPipelineGroup@1_pipeline@1 | Showed pipeline status | (a) aihub pipeline status --json (panel/quick pick) | P1b |
| 228 | `cm.KnownChatOpen` | Open… | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 229 | `cm.BranchNotesInclude` | Include in PR | commandPalette, view/item/context@1_note@1 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 230 | `cm.BranchNotesEdit` | Edit… | commandPalette, view/item/context@1_note@2 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 231 | `cm.BranchNotesDelete` | Delete | commandPalette, view/item/context@1_note@3 | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 232 | `cm.AddCurrentFile` | Add current file to AI Context Hub chat | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 233 | `cm.AddSelectedFiles` | Add selected files to AI Context Hub chat | palette | Hub file context: add/remove files, batches, exclusions, preflight | (e) dropped: no Hub context pack in the CLI design; the chat adds its own context | - |
| 234 | `cm.AddBranchClipboard` | Add clipboard to branch notes | palette | Branch notes: add, edit, delete, include in PR, screenshots, evidence | (e) dropped: user decision: branch notes and branch-changes-as-context are not wanted | - |
| 235 | `cm.WorkflowSearch` | Search AI Context Hub actions… | palette | Hub panel, bar toggles, tool catalogue and forms | (e) dropped: the Hub tool catalogue / panel forms are gone; the agent calls aihub directly | - |
| 236 | `pipelineRuns.refresh` | Refresh pipeline runs | view/title@navigation@1 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 237 | `pipelineRuns.openLogs` | Open logs… | commandPalette, view/item/context@inline@1, view/item/context@1_logs@1 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 238 | `pipelineRuns.copyLogs` | Copy logs | commandPalette, view/item/context@1_logs@2 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 239 | `pipelineRuns.openInAzure` | Open in Azure DevOps ↗ | commandPalette, view/item/context@inline@3, view/item/context@2_run@2 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 240 | `pipelineRuns.fixWithCopilot` | Fix with Copilot | commandPalette, view/item/context@inline@2, view/item/context@2_run@1 | Fix a failed run with Copilot | (c) chat: pipeline-fix skill | P2 |
| 241 | `pipelineRuns.openTest` | Open test | commandPalette, view/item/context@inline@1, view/item/context@1_test@1 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 242 | `pipelineRuns.showTrace` | Show trace | commandPalette, view/item/context@inline@2, view/item/context@1_test@2 | Pipeline runs tree: refresh, logs, copy, open in Azure, test, trace | (a) aihub pipeline runs\|logs --json; open URL in browser | P2 |
| 243 | `robot.showConsole` | Show Robot console | palette | Showed the Robot console panel | (e) dropped: agent output in the chat/terminal | - |
| 244 | `worktrees.create` | Create worktrees… | view/title@navigation@1 | Create a worktree set for several repos | (b) port of Worktree Maker create flow (git worktree add per repo, .worktree-set.json, .code-workspace) | P1 |
| 245 | `worktrees.openSet` | Open Set in New Window | view/item/context@inline@1, view/item/context@1_open@1 | Opened a set in a new/this window, revealed its folder | (b) vscode.openFolder / revealFileInOS | P1 |
| 246 | `worktrees.openSetHere` | Open Set in This Window | view/item/context@1_open@2 | Opened a set in a new/this window, revealed its folder | (b) vscode.openFolder / revealFileInOS | P1 |
| 247 | `worktrees.addRepos` | Add Repositories to Set… | view/item/context@3_set@1 | Added repositories to a set | (b) git worktree add for the extra repos + update set file | P1 |
| 248 | `worktrees.syncSet` | Sync Set (fetch + fast-forward) | view/item/context@inline@2, view/item/context@2_git@1 | Synced the set (fetch + fast-forward) | (b) git fetch + merge --ff-only per worktree | P1 |
| 249 | `worktrees.pushSet` | Push Set… | view/item/context@2_git@2 | Pushed the set | (b) git push -u per worktree after a confirm | P1 |
| 250 | `worktrees.createPullRequests` | Create Pull Requests… | view/item/context@2_git@3 | Created pull requests for the set | (c) chat: /pr per repository (aihub pr create runs in each worktree) | P1 |
| 251 | `worktrees.removeSet` | Remove Set… | view/item/context@inline@3, view/item/context@3_set@2 | Removed a set or one repo from it | (b) git worktree remove after a confirm that shows dirty/unpushed state | P1 |
| 252 | `worktrees.removeRepoFromSet` | Remove from Set… | view/item/context@inline@1, view/item/context@3_set@1 | Removed a set or one repo from it | (b) git worktree remove after a confirm that shows dirty/unpushed state | P1 |
| 253 | `worktrees.cleanup` | Clean Up Merged Worktrees… | view/title@navigation@2 | Cleaned up merged worktrees | (b) branches merged into the base (git branch --merged) -> confirm -> remove worktree + branch | P1 |
| 254 | `worktrees.revealSet` | Reveal Set Folder | view/item/context@1_open@3 | Opened a set in a new/this window, revealed its folder | (b) vscode.openFolder / revealFileInOS | P1 |
| 255 | `worktrees.openInNewWindow` | Open in New Window | commandPalette, view/item/context@1_open@1 | Opened a set in a new/this window, revealed its folder | (b) vscode.openFolder / revealFileInOS | P1 |
| 256 | `worktrees.saveGroup` | Save Repo Group… | view/title@1_groups@1 | Saved or deleted a repo group | (b) globalState list of repo groups | P1 |
| 257 | `worktrees.deleteGroup` | Delete Repo Group… | view/title@1_groups@2 | Saved or deleted a repo group | (b) globalState list of repo groups | P1 |
| 258 | `worktrees.setActions` | Set Actions… | palette | Worktree set menu / open set window | (b) worktree set actions quick pick, open workspace file (P1) | P1 |
| 259 | `worktrees.refresh` | Refresh Worktree Sets | view/title@navigation@3 | Refreshed the set list | (b) refresh the tree view | P1 |

## Menus

| Old placement | New |
|---|---|
| `commandPalette` (52 entries) | command palette (category AI Context Hub), only the commands kept above |
| `view/title` (29 entries) | titles of the kept views (Worktree Sets, bar panel) |
| `view/item/context` (39 entries) | Worktree Sets tree rows (set and repo actions); pipeline run rows later (P2) |
| `explorer/context` (1 entries) | explorer right-click: AI Context Hub submenu with the Branch group (P1) and the kept chat actions (P2) |
| `editor/context` (1 entries) | editor right-click: Ask / Suggest fix as chat text (P2) |
| `comments/commentThread/title` (4 entries) | PR thread buttons: resolve, won't fix, reactivate, fix with Copilot (P2) |
| `comments/commentThread/context` (1 entries) | PR thread reply (P2) |
| `scm/title` (5 entries) | Source Control title: Branch submenu (P1); commit message to chat (P2) |
| `testing/item/context` (1 entries) | dropped (Robot test explorer goes through chat, P2) |
| `testing/message/context` (1 entries) | dropped (same) |
| `editor/title` (3 entries) | dropped with the approval gate |
| `scm/resourceState/context` (1 entries) | Source Control change right-click: Branch submenu (P1) |
| `scm/resourceGroup/context` (1 entries) | Source Control group right-click: Branch submenu (P1) |
| `pycharmGit.commit.gitMenu` (1 entries) | dropped: depends on the separate PyCharm-style Git extension; the Branch group is on the explorer and SCM menus instead |
| `timeline/item/context` (1 entries) | timeline commit right-click: Cherry-Pick to Other Repositories as chat text (P2) |
| `webview/context` (4 entries) | dropped (webview of the old panel) |

| Submenu | Label | New |
|---|---|---|
| `aiContextHub.cm.ProjectViewGroup` | AI Context Hub | kept as the container of the explorer submenus |
| `aiContextHub.cm.ProjectBranchGroup` | Branch | kept, P1: Reset to Branch or Commit, Check for Merge Conflicts, Clean Up Unrelated Changes, Squash Branch Commits |
| `aiContextHub.cm.ExclusionGroup` | Exclude | dropped (Hub context) |
| `aiContextHub.cm.RobotTestsGroup` | Robot tests | chat /test, P2 (exclude/include dropped) |
| `aiContextHub.cm.ProjectStoryGroup` | DevOps | kept as chat actions, P2 |
| `aiContextHub.cm.FunctionalWikiGroup` | Project wiki | chat /wiki, P3 |
| `aiContextHub.cm.ProjectPrGroup` | Pull request | kept as chat actions, P2 |
| `aiContextHub.cm.SessionGroup` | Chat | dropped (Hub context) |
| `aiContextHub.cm.AnalyzeGroup` | Analyze | chat prompt, P3 |
| `aiContextHub.cm.EditorPopupGroup` | AI Context Hub | kept as chat actions, P2 |
| `aiContextHub.cm.GitBranchHealth` | Branch | kept, P1: the same four on the SCM menus |
| `aiContextHub.cm.BranchStoryGroup` | AI Context Hub · DevOps | kept as chat actions, P2 |
| `aiContextHub.cm.BranchPipelineGroup` | AI Context Hub · Pipeline | kept, P1b: pipeline status |
| `aiContextHub.cm.BranchPrGroup` | AI Context Hub · Pull request | kept as chat actions, P2 |

## Keybindings

| Key | Old command | New |
|---|---|---|
| `ctrl+alt+h` | `aiContextHub.menu` | dropped (Hub menu) |
| `space` | `aiContextHub.notes.toggleInclude` | dropped (notes) |
| `delete` | `aiContextHub.notes.delete` | dropped (notes) |
| `enter` | `aiContextHub.notes.open` | dropped (notes) |
| `ctrl+v` | `aiContextHub.notes.addClipboard` | dropped (notes) |
| `ctrl+alt+shift+a` | `aiContextHub.cm.Add` | dropped (Hub context) |
| `ctrl+alt+shift+f` | `aiContextHub.cm.WorkflowSearch` | dropped (Hub tool catalogue) |
| `ctrl+alt+shift+n` | `aiContextHub.addNote` | dropped (notes) |

## Views

| Old view | New |
|---|---|
| `aiContextHub.hub` (-) | dropped (Hub tool window) |
| `aiContextHub.workflow` (Workflow) | replaced by the panel "AI Context Hub" (base PR) |
| `aiContextHub.approvals` (Approvals) | dropped (approval gate) |
| `aiContextHub.tools` (Hub tools) | dropped (tool catalogue) |
| `aiContextHub.activity` (Activity) | dropped (activity/undo) |
| `aiContextHub.notes` (Branch notes) | dropped (user decision) |
| `aiContextHub.learn` (Learn) | dropped (learn views) |
| `aiContextHub.pipelineRuns` (Pipeline runs) | P2: pipeline runs tree from `aihub pipeline runs --json` |
| `aiContextHub.bar` (Workflow bar) | replaced by the status bar + panel (base PR) |
| `aiContextHub.worktreeSets` (Worktree Sets) | P1: Worktree Sets tree in the Explorer (port of Worktree Maker) |

## Walkthrough, welcome views, chat contributions, tools, MCP

- Walkthrough (7 steps: connect, core, approval, skills, story, repositories, MCP): dropped; the README replaces it.
- `viewsWelcome` (2): dropped with the old views; the new panel shows one message when the CLI is missing or the folder has no repo.
- `chatSkills` (25), `chatInstructions`, `chatAgents` (1): replaced by the aihub skill pack and the `aihub` agent files that `aihub skills install` writes. The extension does not contribute them.
- `languageModelTools` (22, `hub_*`): dropped; the agent calls the `aihub` CLI (MCP and the Hub API are gone).
- `mcpServerDefinitionProviders` (1): dropped (no MCP).
- `icons` (10): the new extension uses codicons and one panel icon.

## Settings (46 in 2.x)

All `aiContextHub.*` settings are dropped. The Java core settings (engine, javaHome, javaRuntime, coreJvmArgs, core, ideHome, runtime, port, autoStart, coreMaxHeapMb, coreIdleMinutes, maxCores, coreTrimPlugins, startTimeoutSeconds, forbidJetBrains), PyCharm settings sharing, MCP, agents, approval/notification/problems/bar-layout settings and the language-model tools toggle have no equivalent. The new settings are `aihub.chatTarget`, `aihub.refreshIntervalSeconds`, `aihub.fabric.enabled`, `aihub.cliPath`, `aihub.timeoutSeconds`, `aihub.chatAgentMode`, `aihub.chatAgentName`, and for worktree sets `aihub.worktrees.*` (P1).
