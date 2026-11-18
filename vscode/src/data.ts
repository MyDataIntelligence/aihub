import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, readJson, type Runner } from "./cli";
import { TtlCache } from "./cache";
import { buildModel, toFabric, type BarEvent, type BarModel, type FabricModel, type PrChecksJson, type StatusJson } from "./model";

export interface LoadOptions {
  cwd: string;
  fabric: boolean;
  /** How long a Fabric result stays valid; Fabric calls are the slow ones. */
  fabricTtlMs: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const FABRIC_NONE = Symbol("no fabric workspace");

/** The events `aihub watch --mine` stored (one JSON file each), newest first. Reading them is the only thing not done through a command. */
export function readEvents(env: NodeJS.ProcessEnv = process.env, limit = 5, readdir = readdirSync): BarEvent[] {
  const dir = join(env.AIHUB_HOME || join(homedir(), ".aihub"), "events");
  if (!existsSync(dir)) return [];
  const rows: BarEvent[] = [];
  for (const f of readdir(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { id?: string; message?: string; at?: number; repo?: string };
      if (j.message) rows.push({ id: String(j.id ?? f), message: j.message, at: typeof j.at === "number" ? j.at : statSync(join(dir, f)).mtimeMs, repo: j.repo });
    } catch {
      // a half-written file: the next refresh sees it whole
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Reads the whole bar. Each call is one aihub JSON read; the Fabric ones are cached longer. */
export class BarLoader {
  private cache: TtlCache<unknown>;
  constructor(
    private run: Runner,
    private opts: LoadOptions,
  ) {
    this.cache = new TtlCache(opts.now);
  }

  invalidate(): void {
    this.cache.clear();
  }

  async load(): Promise<BarModel> {
    const { cwd } = this.opts;
    const status = await readJson<StatusJson>(this.run, ["status"], cwd);
    const active = status.pr && status.pr.status === "active" ? status.pr : null;
    const [checks, fabric, watching] = await Promise.all([
      active ? this.soft(() => readJson<PrChecksJson>(this.run, ["pr", "checks", "--pr", String(active.id)], cwd)) : undefined,
      this.opts.fabric ? this.fabric(status.branch ?? "") : null,
      this.soft(async () => (await readJson<{ mine?: boolean }[]>(this.run, ["watch", "list"], cwd)).some((w) => w.mine)),
    ]);
    const events = (await this.soft(() => this.cliEvents())) ?? readEvents(this.opts.env);
    return buildModel({ status, checks: checks ?? undefined, fabric, watching: !!watching, events, now: (this.opts.now ?? Date.now)() });
  }

  /** `aihub watch events` (CLI 1.0.3+); an older CLI fails and the caller falls back to reading the event files. */
  private async cliEvents(): Promise<BarEvent[]> {
    const rows = await readJson<{ id: string; message: string; epoch?: number; at?: string; repo?: string }[]>(this.run, ["watch", "events", "--limit", "5"], this.opts.cwd);
    return rows.map((r) => ({ id: r.id, message: r.message, at: typeof r.epoch === "number" ? r.epoch : Date.parse(r.at ?? "") || 0, repo: r.repo }));
  }

  /** A failed side read must not take the whole bar down. */
  private async soft<T>(f: () => Promise<T>): Promise<T | undefined> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof CliError && e.kind === "missing") throw e;
      return undefined;
    }
  }

  private async fabric(branch: string): Promise<FabricModel | null> {
    const key = `fabric:${branch}`;
    const hit = this.cache.get(key, this.opts.fabricTtlMs) as FabricModel | typeof FABRIC_NONE | undefined;
    if (hit !== undefined) return hit === FABRIC_NONE ? null : hit;
    try {
      const failures = await readJson<unknown>(this.run, ["fabric", "failures"], this.opts.cwd);
      const logs = await this.soft(() => readJson<unknown>(this.run, ["fabric", "logs", "--since", "24h", "--top", "8"], this.opts.cwd));
      const model = toFabric(failures, logs);
      this.cache.set(key, model ?? FABRIC_NONE);
      return model;
    } catch (e) {
      if (e instanceof CliError && e.kind === "missing") throw e;
      // no workspace for this branch, not signed in to Fabric, or too slow: hide the section for one TTL, the rest of the bar is unaffected
      this.cache.set(key, FABRIC_NONE);
      return null;
    }
  }
}
