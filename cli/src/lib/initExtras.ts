import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

/**
 * Two optional extras of `aihub init`, each proposed only when missing:
 *  - `.github/instructions/<area>.instructions.md` skeletons with `applyTo:` front matter (empty rule bullets, no invented rules)
 *  - a short marked aihub block in AGENTS.md
 */
export type Lang = "nl" | "en";

export interface Area {
  key: string;
  title: string;
  applyTo: string;
  exts: string[];
}

export const AREAS: Area[] = [
  { key: "python", title: "Python", applyTo: "**/*.py", exts: [".py"] },
  { key: "sql", title: "SQL", applyTo: "**/*.sql", exts: [".sql"] },
  { key: "typescript", title: "TypeScript and JavaScript", applyTo: "**/*.{ts,tsx,js,jsx}", exts: [".ts", ".tsx", ".js", ".jsx"] },
  { key: "terraform", title: "Terraform", applyTo: "**/*.tf", exts: [".tf"] },
  { key: "csharp", title: "C#", applyTo: "**/*.cs", exts: [".cs"] },
  { key: "java", title: "Java", applyTo: "**/*.java", exts: [".java"] },
];

const GENERAL: Area = { key: "general", title: "General", applyTo: "**", exts: [] };

/** The file types the repository really has: up to three areas, most files first (an area needs at least 2 files); `general` when none. */
export function detectAreas(files: string[]): Area[] {
  const counts = AREAS.map((a) => ({ a, n: files.filter((f) => a.exts.some((e) => f.toLowerCase().endsWith(e))).length }));
  const picked = counts.filter((c) => c.n >= 2).sort((x, y) => y.n - x.n).slice(0, 3).map((c) => c.a);
  return picked.length ? picked : [GENERAL];
}

export const INSTRUCTIONS_DIR = ".github/instructions";

export function instructionFile(area: Area, lang: Lang): { path: string; content: string } {
  const nl = lang === "nl";
  const note = nl
    ? "Regels voor het team om in te vullen; aihub verzint geen regels. GitHub Copilot laadt dit bestand voor de bestanden die bij `applyTo` passen (`.github/instructions/*.instructions.md`); opencode laadt het via `instructions` in `opencode.json`. Verwijder deze opmerking zodra er regels staan."
    : "Rules for the team to fill in; aihub does not invent rules. GitHub Copilot loads this file for the files matching `applyTo` (`.github/instructions/*.instructions.md`); opencode loads it through `instructions` in `opencode.json`. Delete this comment when you add rules.";
  return {
    path: `${INSTRUCTIONS_DIR}/${area.key}.instructions.md`,
    content: `---\napplyTo: "${area.applyTo}"\n---\n# ${area.title}${nl ? "-regels" : " rules"}\n\n<!-- ${note} -->\n\n- \n- \n- \n`,
  };
}

export function instructionsReadme(lang: Lang): { path: string; content: string } {
  const nl = lang === "nl";
  return {
    path: `${INSTRUCTIONS_DIR}/README.md`,
    content: nl
      ? "# Instructies per bestandstype\n\nEen bestand `<gebied>.instructions.md` met `applyTo:` in de front matter bevat de regels voor die bestanden. GitHub Copilot laadt ze automatisch; opencode laadt ze met `\"instructions\": [\".github/instructions/*.instructions.md\"]` in `opencode.json`. De regels zijn van het team: vul de lege opsommingstekens in.\n"
      : "# Instructions per file type\n\nA file `<area>.instructions.md` with `applyTo:` in its front matter holds the rules for those files. GitHub Copilot loads them automatically; opencode loads them with `\"instructions\": [\".github/instructions/*.instructions.md\"]` in `opencode.json`. The rules belong to the team: fill in the empty bullets.\n",
  };
}

export const AGENTS_BEGIN = "<!-- aihub:begin -->";
export const AGENTS_END = "<!-- aihub:end -->";

export function agentsBlock(lang: Lang, o: { prTemplate: string; teamFile: string; instructions: boolean }): string {
  const nl = lang === "nl";
  const lines = nl
    ? [
        "## Werken met aihub",
        "",
        "- Werk via de aihub-skills (per gebruiker geïnstalleerd: `npm i -g @ferronhooi/aihub`, daarna `aihub skills install`).",
        `- Teamkennis: \`${o.teamFile}\`; pull request-sjabloon: \`${o.prTemplate}\`.`,
        ...(o.instructions ? ["- Regels per bestandstype: `.github/instructions/*.instructions.md` (`applyTo` in de front matter)."] : []),
      ]
    : [
        "## Working with aihub",
        "",
        "- Work via the aihub skills (installed per user: `npm i -g @ferronhooi/aihub`, then `aihub skills install`).",
        `- Team knowledge: \`${o.teamFile}\`; pull request template: \`${o.prTemplate}\`.`,
        ...(o.instructions ? ["- Rules per file type: `.github/instructions/*.instructions.md` (`applyTo` in the front matter)."] : []),
      ];
  return `${AGENTS_BEGIN}\n${lines.join("\n")}\n${AGENTS_END}\n`;
}

/** New AGENTS.md content, or why nothing is proposed. A file that already mentions aihub anywhere is left alone. */
export function planAgentsMd(root: string, block: string): { content: string; append: boolean } | { skip: string } {
  const f = join(root, "AGENTS.md");
  if (!existsSync(f)) return { content: `# AGENTS.md\n\n${block}`, append: false };
  const text = readFileSync(f, "utf8").replace(/^﻿/, "");
  if (/aihub/i.test(text)) return { skip: "it already mentions aihub" };
  return { content: `${text.replace(/\s*$/, "")}\n\n${block}`, append: true };
}

export function trackedFiles(root: string): string[] {
  return git(root, ["ls-files"], { allowFail: true }).split("\n").filter(Boolean);
}
