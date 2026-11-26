import { CliError } from "./cli";
import type { BarError, BarModel } from "./model";
import { count, span } from "./perf/probe";

export type Reason = "start" | "focus" | "git" | "timer" | "manual";

/** The window gets focus back: read again only when the last read is older than this (or something changed while it had no focus). */
export const FOCUS_STALE_MS = 5 * 60_000;
/** A failed read is remembered this long: no automatic trigger tries again before. */
export const FAILED_MEMORY_MS = 5 * 60_000;

export type Result = { ok: true; model: BarModel } | { ok: false; error: BarError; last?: BarModel };

/**
 * Decides when the bar reads again. One read at a time; a trigger that arrives meanwhile is folded into the next one.
 * Triggers that are not manual are dropped while the window is not focused or when the last read is still fresh.
 * After a slow read, automatic triggers back off: they wait up to 10x the read's duration (capped at 10 minutes).
 */
export class Refresher {
  private inFlight: Promise<void> | undefined;
  private pending = false;
  private lastAt = 0;
  private lastDurationMs = 0;
  private last: BarModel | undefined;
  private failedAt = 0;
  /** something changed (the branch) while the window had no focus: the next focus reads, however young the last read is */
  dirty = false;
  focused = true;

  constructor(
    private load: () => Promise<BarModel>,
    private publish: (r: Result) => void,
    private opts: { minGapMs: () => number; now?: () => number },
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** Resolves when the read this call caused (or joined) is done. */
  async request(reason: Reason): Promise<void> {
    if (reason !== "manual") {
      // never without focus: what changed meanwhile is read when the focus is back
      if (!this.focused) {
        if (reason === "git" || reason === "start") this.dirty = true;
        return void count(`refresh.skip.${reason}.unfocused`);
      }
      // a read that failed is not tried again by itself for 5 minutes
      if (reason !== "git" && this.failedAt && this.now() - this.failedAt < FAILED_MEMORY_MS && !this.dirty) return void count(`refresh.skip.${reason}.failed`);
      if (reason === "focus" || reason === "timer") {
        const half = reason === "focus" ? FOCUS_STALE_MS : this.opts.minGapMs() / 2;
        // Back off after a slow read: wait up to 10x its duration, capped at 10 minutes.
        const gap = Math.max(half, Math.min(10 * this.lastDurationMs, 600_000));
        if (!this.dirty && this.now() - this.lastAt < gap) {
          return void count(this.now() - this.lastAt < half ? `refresh.skip.${reason}.fresh` : `refresh.skip.${reason}.backoff`);
        }
      }
    }
    this.dirty = false;
    if (this.inFlight) {
      this.pending = true;
      count(`refresh.skip.${reason}.joined`);
      return this.inFlight;
    }
    this.inFlight = this.run(reason).finally(() => {
      this.inFlight = undefined;
      if (this.pending) {
        this.pending = false;
        void this.request("manual");
      }
    });
    return this.inFlight;
  }

  private async run(reason: Reason): Promise<void> {
    const end = span("refresh", "status", { reason });
    const started = this.now();
    try {
      const model = await this.load();
      this.last = model;
      end(true);
      this.failedAt = 0;
      this.publish({ ok: true, model });
    } catch (e) {
      const kind = e instanceof CliError ? e.kind : "failed";
      end(false, { error: kind });
      this.failedAt = this.now();
      this.publish({ ok: false, error: { kind, message: (e as Error).message }, last: this.last });
    } finally {
      const finished = this.now();
      this.lastDurationMs = finished - started;
      this.lastAt = finished;
    }
  }
}
