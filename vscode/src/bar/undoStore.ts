import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { configHome } from "../../../cli/src/lib/configHome";
import { writeAtomic } from "../../../cli/src/lib/setFile";
import type { Snapshot, Stamp } from "./undo";

/**
 * The last undo of a set lives on disk (`<config home>/undo/<set>.json`, atomic), so every window on the set shows the same
 * "Undo: <label>" and there is never more than one. The entry holds the snapshot (the set files as bytes), the stamp of the
 * set right after the action and the branches the action made; Undo checks the stamp before it does anything. No vscode.
 */
interface Stored {
  schema: 1;
  label: string;
  savedAt: number;
  snapshot: {
    label: string;
    setFolder: string;
    files: { path: string; bytes?: string }[];
    repos: Snapshot["repos"];
    branches: [string, [string, string][]][];
    backups: [string, string[]][];
    sources?: string[];
    after?: Stamp;
    created?: [string, string[]][];
  };
}

const keyOf = (folder: string) => createHash("sha1").update(resolve(folder).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 20);
const fileOf = (env: NodeJS.ProcessEnv, folder: string) => join(configHome(env), "undo", `${keyOf(folder)}.json`);

export function saveUndo(env: NodeJS.ProcessEnv, label: string, s: Snapshot, now = Date.now()): void {
  if (!s.setFolder) return;
  const stored: Stored = {
    schema: 1,
    label,
    savedAt: now,
    snapshot: {
      label: s.label,
      setFolder: s.setFolder,
      files: s.files.map((f) => ({ path: f.path, ...(f.bytes ? { bytes: f.bytes.toString("base64") } : {}) })),
      repos: s.repos,
      branches: [...s.branches].map(([k, v]) => [k, [...v]]),
      backups: [...s.backups],
      ...(s.sources ? { sources: s.sources } : {}),
      ...(s.after ? { after: s.after } : {}),
      ...(s.created ? { created: [...s.created] } : {}),
    },
  };
  mkdirSync(join(configHome(env), "undo"), { recursive: true });
  // the one lock of the set writers is not needed: this file is the bar's own, one per set, replaced whole
  writeAtomic(fileOf(env, s.setFolder), JSON.stringify(stored));
}

export function loadUndo(env: NodeJS.ProcessEnv, setFolder: string): { label: string; snap: Snapshot; savedAt: number } | undefined {
  try {
    const f = fileOf(env, setFolder);
    if (!existsSync(f)) return undefined;
    const j = JSON.parse(readFileSync(f, "utf8")) as Stored;
    if (j.schema !== 1) return undefined;
    const s = j.snapshot;
    const snap: Snapshot = {
      label: s.label,
      setFolder: s.setFolder,
      files: s.files.map((x) => ({ path: x.path, ...(x.bytes !== undefined ? { bytes: Buffer.from(x.bytes, "base64") } : {}) })),
      repos: s.repos,
      branches: new Map(s.branches.map(([k, v]) => [k, new Map(v)])),
      backups: new Map(s.backups),
      ...(s.sources ? { sources: s.sources } : {}),
      ...(s.after ? { after: s.after } : {}),
      ...(s.created ? { created: new Map(s.created) } : {}),
    };
    return { label: j.label, snap, savedAt: j.savedAt };
  } catch {
    return undefined;
  }
}

export function clearUndo(env: NodeJS.ProcessEnv, setFolder: string): void {
  rmSync(fileOf(env, setFolder), { force: true });
}

/** The label every window shows for this set, from the file. */
export const undoLabelOf = (env: NodeJS.ProcessEnv, setFolder: string): string | undefined => loadUndo(env, setFolder)?.label;

