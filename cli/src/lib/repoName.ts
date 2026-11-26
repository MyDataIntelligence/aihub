/** The repository name of a remote url, as typed there (`.../_git/Repo%20One` is "Repo One", `host:org/repo-a.git` is "repo-a"); undefined when there is none. */
export function repoNameOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const last = url.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
