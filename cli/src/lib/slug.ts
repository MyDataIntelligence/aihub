// The slug of a story title for branch and folder names: the one rule for the CLI and the VS Code extension. No imports.

export function slugify(title: string, max = 40): string {
  const s = title
    // letters NFKD does not split: ß is "ss" (Straße -> strasse), not a dash
    .replace(/ß/g, "ss")
    .replace(/ẞ/g, "SS")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/g, "") || "story";
}
