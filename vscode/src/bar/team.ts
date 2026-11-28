import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Team settings: the aihub.bar.team* commands. Each one is one `aihub team ...` process that answers with the CLI's
 * JSON, or `{ error: { kind, message } }` (never a popup: the caller shows it), like the repository browser. The page
 * reads once when it opens and on Refresh; nothing polls. JSON shapes: docs/cli-json.md ("Team settings").
 */

export type TemplateKind = "pr" | "story" | "bug" | "commit";
const KINDS: TemplateKind[] = ["pr", "story", "bug", "commit"];

export interface TeamCommon {
  /** the folder the CLI runs in (a repository or a set); default: this window's first folder */
  cwd?: string;
}
export interface TeamShowArg extends TeamCommon {
  /** the repository shown first */
  repo?: string;
  refresh?: boolean;
}
export interface TeamValidateArg extends TeamCommon {
  /** the text being edited; without it: the team.yaml that applies here */
  content?: string;
}
export interface TeamPreviewArg extends TeamCommon {
  template: TemplateKind;
  repo?: string;
}
export interface TeamEditArg extends TeamCommon {
  template?: TemplateKind;
  repo?: string;
  /** with content: save to `branch` with a pull request (never main) */
  content?: string;
  branch?: string;
  title?: string;
  baseCommit?: string;
  story?: number;
}
export interface TeamInitArg extends TeamCommon {
  /** "pack": team.yaml and templates from the team pack, as a pull request in `repo`; "teamRepo": use `teamRepo` for the set */
  mode: "pack" | "teamRepo";
  repo?: string;
  /** `<project>/<repo>`, `<org>/<project>/<repo>` or a local folder */
  teamRepo?: string;
  /** the team repository for every repository on this PC, not only this set */
  everywhere?: boolean;
}

const s = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const kind = (v: unknown, what: string): TemplateKind => {
  if (!KINDS.includes(v as TemplateKind)) throw new Error(`${what} needs template: ${KINDS.join(" | ")}`);
  return v as TemplateKind;
};

/** A private temp file for text that can be long (never in the process list); the caller removes the folder. */
function privateFile(name: string, text: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aihub-team-"));
  const file = join(dir, name);
  writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  return { file, dir };
}

export const teamArgs = {
  show: (a: TeamShowArg = {}) => {
    const out = ["team", "show", "--json", "--no-detect"];
    if (s(a.repo)) out.push("--repo", a.repo);
    if (a.refresh) out.push("--refresh");
    return { args: out };
  },
  schema: () => ({ args: ["team", "validate", "--schema"] }),
  validate: (a: TeamValidateArg = {}) => {
    if (typeof a.content !== "string") return { args: ["team", "validate", "--json"] };
    const f = privateFile("team.yaml", a.content);
    return { args: ["team", "validate", "--json", "--file", f.file], dir: f.dir };
  },
  preview: (a: TeamPreviewArg) => {
    const out = ["team", "preview", "--json", "--template", kind(a?.template, "teamPreview")];
    if (s(a.repo)) out.push("--repo", a.repo);
    return { args: out };
  },
  edit: (a: TeamEditArg = {}) => {
    const out = ["team", "edit", "--json"];
    if (a.template) out.push("--template", kind(a.template, "teamEdit"));
    if (s(a.repo)) out.push("--repo", a.repo);
    if (typeof a.content !== "string") return { args: out };
    if (!s(a.branch)) throw new Error("teamEdit needs a branch to save to (a new feature branch)");
    const f = privateFile("content", a.content);
    out.push("--content-file", f.file, "--branch", a.branch);
    if (s(a.title)) out.push("--title", a.title);
    if (s(a.baseCommit)) out.push("--base-commit", a.baseCommit);
    if (typeof a.story === "number" && a.story > 0) out.push("--story", String(a.story));
    return { args: out, dir: f.dir };
  },
  init: (a: TeamInitArg) => {
    if (a?.mode === "pack") {
      const out = ["team", "init", "--json", "--from-pack"];
      if (s(a.repo)) out.push("--repo", a.repo);
      return { args: out };
    }
    if (a?.mode === "teamRepo") {
      if (!s(a.teamRepo)) throw new Error("teamInit needs teamRepo: <project>/<repository>");
      const out = ["team", "init", "--json", "--team-repo", a.teamRepo];
      if (a.everywhere) out.push("--everywhere");
      return { args: out };
    }
    throw new Error("teamInit needs mode: pack | teamRepo");
  },
};
