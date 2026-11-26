import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../../../cli/src/lib/configHome";
import { writeAtomic } from "../../../cli/src/lib/setFile";
import { remoteKey } from "../worktrees/clones";
import type { BarRemote, BarRemoteRepository } from "./types";

/**
 * The repositories in Azure DevOps the user can see, for the search of the left menu. Read only when the search asks (the
 * first two typed characters), at most once a day, kept with its time in `<config home>/bar-remote-repos.json` (written
 * atomically); a failed read is remembered 5 minutes (in the same file, so every window knows), and nothing is read while
 * the window has no focus. Filtering per keystroke is the bar's work, on this list in memory. No vscode.
 */
export const REMOTE_TTL_MS = 24 * 3_600_000;
export const REMOTE_FAILURE_MS = 5 * 60_000;
const FILE = "bar-remote-repos.json";

interface RemoteFile {
  schema: 1;
  at?: number;
  repos?: BarRemoteRepository[];
  failedAt?: number;
  error?: string;
  signedOut?: boolean;
}

export interface RemoteDeps {
  env: NodeJS.ProcessEnv;
  /** one read of the list (the CLI: `aihub repos ado --json`); throws with the reason */
  read: (o: { refresh: boolean }) => Promise<BarRemoteRepository[]>;
  /** the window has focus */
  focused: () => boolean;
  /** the state changed (loading, ready, failed) */
  changed: () => void;
  now?: () => number;
}

/** "not signed in" in any of the words the CLI, az or Azure DevOps use for it. */
export const isSignInError = (msg: string): boolean => /not signed in|az login|AIHUB_ADO_PAT|\b401\b|\b203\b|unauthori[sz]ed|sign[- ]?in/i.test(msg);

/** The repositories of `all` that have no clone on this PC: the same remote, however its url is written (case, user part, .git, %20). */
export function notOnThisPc(all: BarRemoteRepository[], localRemotes: (string | undefined)[]): BarRemoteRepository[] {
  const here = new Set(localRemotes.map((u) => (u ? remoteKey(u) : undefined)).filter((k): k is string => !!k));
  return all.filter((r) => {
    const k = remoteKey(r.remoteUrl);
    return !k || !here.has(k);
  });
}

export class RemoteRepos {
  private loading = false;
  constructor(private deps: RemoteDeps) {}

  private now = () => (this.deps.now ?? Date.now)();
  private file = () => join(configHome(this.deps.env), FILE);

  private readFile(): RemoteFile {
    try {
      const j = JSON.parse(readFileSync(this.file(), "utf8")) as RemoteFile;
      return j && j.schema === 1 ? j : { schema: 1 };
    } catch {
      return { schema: 1 };
    }
  }

  private writeFile(f: RemoteFile): void {
    try {
      mkdirSync(configHome(this.deps.env), { recursive: true });
      writeAtomic(this.file(), JSON.stringify(f));
    } catch {
      /* an unwritable file only costs the next read */
    }
  }

  /** What the state shows: the list without what is on this PC; `localRemotes` are the origin urls of every clone the scan found. */
  get(localRemotes: (string | undefined)[]): BarRemote {
    const f = this.readFile();
    const failed = f.failedAt !== undefined && this.now() - f.failedAt < REMOTE_FAILURE_MS;
    if (this.loading) return { status: "loading", repos: f.repos ? notOnThisPc(f.repos, localRemotes) : [] };
    if (failed && f.signedOut) return { status: "signedOut", repos: [] };
    if (f.repos && f.at !== undefined) return { status: "ready", repos: notOnThisPc(f.repos, localRemotes), at: f.at };
    if (failed) return { status: "failed", repos: [], error: f.error ?? "Azure DevOps could not be read" };
    return { status: "idle", repos: [] };
  }

  /** True when a read would happen now (no fresh list, no remembered failure, focus): what load() would do, without doing it. */
  due(o: { force?: boolean } = {}): boolean {
    if (this.loading || !this.deps.focused()) return false;
    if (o.force) return true;
    const f = this.readFile();
    if (f.failedAt !== undefined && this.now() - f.failedAt < REMOTE_FAILURE_MS) return false;
    return !(f.at !== undefined && f.repos && this.now() - f.at < REMOTE_TTL_MS);
  }

  /** Reads the list when it is due (see due()); `force`: the user asked (Refresh, after signing in). */
  async load(o: { force?: boolean } = {}): Promise<void> {
    if (!this.due(o)) return;
    this.loading = true;
    this.deps.changed();
    const old = this.readFile();
    try {
      const repos = await this.deps.read({ refresh: o.force === true });
      this.writeFile({ schema: 1, at: this.now(), repos });
    } catch (e) {
      const error = ((e as Error).message || "Azure DevOps could not be read").split(/\r?\n/)[0];
      // an older list stays usable; the failure is remembered so the next keystroke does not ask again
      this.writeFile({ ...old, schema: 1, failedAt: this.now(), error, signedOut: isSignInError(error) });
    } finally {
      this.loading = false;
      this.deps.changed();
    }
  }
}
