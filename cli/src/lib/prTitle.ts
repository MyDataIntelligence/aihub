/** The pull request title from team.yaml `pullRequest.title`: {storyId} {storyTitle} {branch}. */
export const fillTitle = (pattern: string, v: { storyId?: number; storyTitle?: string; branch: string }): string =>
  pattern
    .replace(/\{storyId\}/g, v.storyId ? String(v.storyId) : "")
    .replace(/\{storyTitle\}/g, v.storyTitle ?? "")
    .replace(/\{branch\}/g, v.branch)
    .replace(/^[\s:\-–]+/, "")
    .trim();

/**
 * The title `aihub pr create` gives a new pull request: --title, else the team pattern, else "<id> <story title>",
 * else the first commit, else the branch. A pattern that names the story is only used when the story is known,
 * so a branch without a story never gets a title like ": ".
 */
export function prTitle(o: { given?: string; pattern?: string; storyId?: number; storyTitle?: string; branch: string; firstCommit?: string }): string {
  if (o.given) return o.given;
  const plain = o.storyId && o.storyTitle ? `${o.storyId} ${o.storyTitle}` : (o.firstCommit ?? o.branch);
  if (!o.pattern?.trim()) return plain;
  const namesStory = /\{story(Id|Title)\}/.test(o.pattern);
  if (namesStory && !(o.storyId && o.storyTitle)) return plain;
  return fillTitle(o.pattern, { storyId: o.storyId, storyTitle: o.storyTitle, branch: o.branch }) || plain;
}
