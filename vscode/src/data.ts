import { CliError, readJson, type Runner } from "./cli";
import { TtlCache } from "./cache";
import { buildModel, toFabric, unwrap, type BarEvent, type BarModel, type FabricModel, type PrChecksJson, type StatusJson } from "./model";

export interface LoadOptions {
  cwd: string;
  /** read the Fabric part too (a function: asked at each read, so a team.yaml that appears later counts) */
  fabric: boolean | (() => boolean);
  /** How long a Fabric result stays valid; Fabric calls are the slow ones. */
  fabricTtlMs: number;
  /**
   * Read the whole bar with one `aihub bar --json` (one process instead of four or five). "auto" tries it and falls
   * back to the separate reads for a CLI that has no `bar` yet. Off by default (the separate reads).
   */
  combined?: boolean | "auto";
  now?: () => number;
}

const FABRIC_NONE = Symbol("no fabric workspace");
type FabricHit = FabricModel | typeof FABRIC_NONE;

/** Fabric answers that stay true until the branch or the settings change (no workspace, not signed in): asked once per branch. */
export function fabricStickyError(message: string): boolean {
  return /no single workspace|no workspace|branchWorkspacePrefixes|not signed in|az login|AIHUB_FABRIC_TOKEN/i.test(message);
}

interface BarJson {
  status: StatusJson & { error?: string };
  checks: (PrChecksJson & { error?: string }) | null;
  fabric: { failures: unknown; logs?: unknown } | { error: string; kind: string } | null;
  watching: boolean | null;
  events: EventRow[];
}
type EventRow = { id: string; message: string; epoch?: number; at?: string; repo?: string };
const toEvents = (rows: EventRow[]): BarEvent[] => (Array.isArray(rows) ? rows : []).map((r) => ({ id: r.id, message: r.message, at: typeof r.epoch === "number" ? r.epoch : Date.parse(r.at ?? "") || 0, repo: r.repo }));

/** Reads the whole bar. Each call is one aihub JSON read; the Fabric ones are cached longer. */
export class BarLoader {
  private cache: TtlCache<unknown>;
  private combined: boolean | "auto";
  private lastBranch: string | undefined;
  constructor(
    private run: Runner,
    private opts: LoadOptions,
  ) {
    this.cache = new TtlCache(opts.now);
    this.combined = opts.combined ?? false;
  }

  /** Forgets every cached answer (manual refresh, branch change); a new loader is made when the settings change. */
  invalidate(): void {
    this.cache.clear();
  }

  async load(): Promise<BarModel> {
    if (this.combined !== false) {
      try {
        return await this.loadCombined();
      } catch (e) {
        if (!(this.combined === "auto" && e instanceof CliError && e.kind === "failed" && /unknown command/i.test(e.message))) throw e;
        this.combined = false; // an older CLI: the separate reads from now on
      }
    }
    return this.loadSeparately();
  }

  private async loadCombined(): Promise<BarModel> {
    const { cwd } = this.opts;
    const known = this.lastBranch !== undefined ? this.cachedFabric(this.lastBranch) : undefined;
    const wantFabric = typeof this.opts.fabric === "function" ? this.opts.fabric() : this.opts.fabric;
    const askFabric = wantFabric && known === undefined;
    const bar = await readJson<BarJson>(this.run, ["bar", ...(askFabric ? ["--fabric"] : [])], cwd);
    if (bar.status?.error) throw new CliError("failed", bar.status.error);
    const status = bar.status;
    const branch = status.branch ?? "";
    let fabric: FabricModel | null = null;
    if (wantFabric) {
      if (askFabric && bar.fabric) fabric = this.keepFabric(branch, bar.fabric);
      else if (branch === this.lastBranch && known !== undefined) fabric = known === FABRIC_NONE ? null : known;
      else fabric = await this.fabric(branch); // the branch changed under us: one separate read
    }
    this.lastBranch = branch;
    const checks = bar.checks && !bar.checks.error ? bar.checks : undefined;
    return buildModel({ status, checks, fabric, watching: !!bar.watching, events: toEvents(bar.events), now: (this.opts.now ?? Date.now)() });
  }

  private async loadSeparately(): Promise<BarModel> {
    const { cwd } = this.opts;
    const status = await readJson<StatusJson>(this.run, ["status"], cwd);
    const active = status.pr && status.pr.status === "active" ? status.pr : null;
    const [checks, fabric, watching] = await Promise.all([
      active ? this.soft(() => readJson<PrChecksJson>(this.run, ["pr", "checks", "--pr", String(active.id)], cwd)) : undefined,
      (typeof this.opts.fabric === "function" ? this.opts.fabric() : this.opts.fabric) ? this.fabric(status.branch ?? "") : null,
      this.soft(async () => (await readJson<{ mine?: boolean }[]>(this.run, ["watch", "list"], cwd)).some((w) => w.mine)),
    ]);
    const events = (await this.soft(() => this.cliEvents())) ?? [];
    this.lastBranch = status.branch ?? "";
    return buildModel({ status, checks: checks ?? undefined, fabric, watching: !!watching, events, now: (this.opts.now ?? Date.now)() });
  }

  /** `aihub watch events` (CLI 1.0.3+). An older CLI has no such command: no events then. */
  private async cliEvents(): Promise<BarEvent[]> {
    return toEvents(await readJson<EventRow[]>(this.run, ["watch", "events", "--limit", "5"], this.opts.cwd));
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

  /** The cached Fabric answer of a branch: a sticky "none" (no workspace, not signed in) or a result younger than the TTL. */
  private cachedFabric(branch: string): FabricHit | undefined {
    return (this.cache.get(`fabric-sticky:${branch}`, Infinity) ?? this.cache.get(`fabric:${branch}`, this.opts.fabricTtlMs)) as FabricHit | undefined;
  }

  private keepFabric(branch: string, r: NonNullable<BarJson["fabric"]>): FabricModel | null {
    if ("error" in r) {
      // no workspace or not signed in: true until the branch or the settings change, so do not ask again every few minutes
      this.cache.set(fabricStickyError(r.error) ? `fabric-sticky:${branch}` : `fabric:${branch}`, FABRIC_NONE);
      return null;
    }
    const model = toFabric(r.failures, r.logs);
    this.cache.set(`fabric:${branch}`, model ?? FABRIC_NONE);
    return model;
  }

  private async fabric(branch: string): Promise<FabricModel | null> {
    const hit = this.cachedFabric(branch);
    if (hit !== undefined) return hit === FABRIC_NONE ? null : hit;
    try {
      const failures = await readJson<unknown>(this.run, ["fabric", "failures"], this.opts.cwd);
      // `fabric logs` does not derive the branch workspace by itself (only `failures` does): pass the one `failures` found
      const ws = (unwrap<{ workspace?: string }>(failures) ?? {}).workspace;
      const logs = ws ? await this.soft(() => readJson<unknown>(this.run, ["fabric", "logs", "--workspace", ws, "--since", "24h", "--top", "8"], this.opts.cwd)) : undefined;
      return this.keepFabric(branch, { failures, logs });
    } catch (e) {
      if (e instanceof CliError && e.kind === "missing") throw e;
      // no workspace for this branch, not signed in to Fabric, or too slow: hide the section, the rest of the bar is unaffected
      return this.keepFabric(branch, { error: (e as Error).message, kind: "failed" });
    }
  }
}
