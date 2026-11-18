/** Minimal glob: `**` any depth, `*` within a segment, `?` one character. Case-insensitive, `/` separators. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export const globMatch = (glob: string, path: string): boolean => globToRegExp(glob).test(path.replace(/\\/g, "/"));
export const anyGlob = (globs: string[], path: string): boolean => globs.some((g) => globMatch(g, path));
