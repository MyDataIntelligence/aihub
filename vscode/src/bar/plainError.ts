/**
 * A failure of git or of the CLI in plain words: what happened and what to do, no flags, no `fatal:`, no usage text. The original
 * text is kept for "Show Details". No vscode here.
 */
export function plainError(raw: string): { text: string; details: string } {
  const details = raw.trim();
  const first = details.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const rules: [RegExp, string][] = [
    [/not a git repository/i, "its source clone is not where it was (moved or deleted); use Locate the Clone in the repository menu"],
    [/uncommitted changes|local changes|would be overwritten/i, "you have changes that are not committed; commit them or use Smart Checkout, then try again"],
    [/conflict/i, "the changes conflict; nothing was changed"],
    [/Authentication failed|could not read (Username|Password)|TF40\d+|not signed in|Authorization failed|401|403/i, "you are not signed in to Azure DevOps (or have no access); sign in and try again"],
    [/Could not resolve host|unable to access|timed out|timeout|network|ENOTFOUND|ECONNRESET|offline/i, "there is no connection to the server right now; try again when you are online"],
    [/index\.lock|another git process/i, "another git command is running in that repository; try again in a moment"],
    [/ENOENT|not found next to|is not installed|command not found/i, "a tool or folder that is needed was not found"],
    [/^usage:|unknown (option|flag|command)/i, "that did not work as asked"],
    [/not a fast-forward|non-fast-forward|rejected/i, "the remote has changes you do not have yet; update first, then push"],
  ];
  const missing = /can't find the clone of '([^']+)'/.exec(details);
  if (missing) return { text: `the clone of ${missing[1]} was not found; choose its folder when asked, or run: aihub repos prefer "${missing[1]}" <folder>`, details };
  const hit = rules.find(([re]) => re.test(details));
  if (hit) return { text: hit[1], details };
  // an unknown failure: the first line, without the prefixes and flags nobody can type here
  const clean = first.replace(/^(aihub|fatal|error):\s*/i, "").replace(/\s--[a-z][\w-]*(\s+\S+)?/g, "").trim();
  return { text: clean.length > 140 ? `${clean.slice(0, 137)}...` : clean || "something went wrong", details };
}
