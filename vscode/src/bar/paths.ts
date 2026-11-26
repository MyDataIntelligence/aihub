/**
 * A path as the bar says it in a message: the separators of the platform (backslashes on Windows, never both kinds in one path)
 * and, when it is longer than `max`, shortened in the middle so the start and the end are still visible. No vscode here.
 */
export function plainPath(p: string, max = 60, windows = process.platform === "win32"): string {
  const sep = windows ? "\\" : "/";
  const full = p.replace(/[\\/]+/g, sep);
  if (full.length <= max) return full;
  const room = max - 1;
  let head = full.slice(0, Math.ceil(room * 0.4));
  let tail = full.slice(full.length - Math.floor(room * 0.6));
  // cut at a separator where there is one, so no folder name is half there
  const h = head.lastIndexOf(sep);
  if (h > 0) head = head.slice(0, h + 1);
  const t = tail.indexOf(sep);
  if (t >= 0) tail = tail.slice(t);
  return `${head}…${tail}`;
}

/** The absolute paths inside a sentence, each said with plainPath (drive paths and long POSIX paths). */
export function plainPathsIn(text: string, max = 60, windows = process.platform === "win32"): string {
  return text.replace(/[A-Za-z]:[\\/][^\s"'<>|?*]*[^\s"'<>|?*,.;:)]|(?<![\w.])\/(?:[\w.@+-]+\/){2,}[\w.@+-]+/g, (m) => plainPath(m, max, windows));
}
