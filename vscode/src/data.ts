import { CliError, readJson, type Runner } from "./cli";
import { TtlCache } from "./cache";
import { buildModel, toFabric, type BarEvent, type BarModel, type FabricModel, type PrChecksJson, type StatusJson } from "./model";

export interface LoadOptions {
  cwd: string;
  fabric: boolean;
  /** How long a Fabric result stays valid; Fabric calls are the slow ones. */
  fabricTtlMs: number;
  now?: () => number;
}

const FABRIC_NONE = Symbol("no fabric workspace");

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
    const events = (await this.soft(() => this.cliEvents())) ?? [];
    return buildModel({ status, checks: checks ?? undefined, fabric, watching: !!watching, events, now: (this.opts.now ?? Date.now)() });
  }

  /** `aihub watch events` (CLI 1.0.3+). An older CLI has no such command: no events then. */
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
