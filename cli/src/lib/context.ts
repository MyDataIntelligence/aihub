import { AdoClient, parseRemote, type FetchFn } from "./ado.js";
import { makeAuth, type Exec } from "./auth.js";
import { remoteUrl, repoRoot } from "./git.js";

/** Everything a command needs from its environment; injectable for tests. */
export interface Ctx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fetch: FetchFn;
  exec?: Exec;
  /** Token cache file override (tests). */
  tokenCache?: string;
  /** Test hooks for polling commands. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RepoClient {
  root: string;
  client: AdoClient;
}

export function repoClient(ctx: Ctx): RepoClient {
  const root = repoRoot(ctx.cwd);
  const remote = parseRemote(remoteUrl(root));
  const auth = makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache });
  return { root, client: new AdoClient(remote, auth, ctx.fetch) };
}
