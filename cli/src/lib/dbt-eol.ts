import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * dbt's state:modified compares file checksums. A checkout with core.autocrlf=true has CRLF, a git blob has LF, an editor may
 * leave trailing spaces: the same model then looks modified. Both sides of the comparison are therefore parsed from copies whose
 * text files have LF line endings and no trailing whitespace.
 */
const TEXT = /\.(sql|ya?ml|csv|md|py|txt|json)$/i;
const SKIP_COPY = /(^|[\\/])(\.git|target|logs|node_modules|\.venv|venv|\.venv-dbt|__pycache__)([\\/]|$)/;
const SKIP_NORMALIZE = /(^|[\\/])dbt_packages([\\/]|$)/;

export const normalizeText = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");

export function normalizedCopy(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true, filter: (p) => !SKIP_COPY.test(relative(src, p)) });
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_NORMALIZE.test(relative(dst, p))) walk(p);
      } else if (TEXT.test(e.name)) {
        const t = readFileSync(p, "utf8");
        const n = normalizeText(t);
        if (n !== t) writeFileSync(p, n);
      }
    }
  };
  walk(dst);
}
