import { CliError } from "./cli";
import type { BarError, BarModel } from "./model";
import { count, span } from "./perf/probe";

export type Reason = "start" | "focus" | "git" | "timer" | "manual";

export type Result = { ok: true; model: BarModel } | { ok: false; error: BarError; last?: BarModel };

/**
 * Decides when the bar reads again. One read at a time; a trigger that arrives meanwhile is folded into the next one.
 * Triggers that are not manual are dropped while the window is not focused or when the last read is still fresh.
 */
export class Refresher {
  private inFlight: Promise<void> | undefined;
  private pending = false;
  private lastAt = 0;
  private last: BarModel | undefined;
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
    if (reason !== "manual" && reason !== "start") {
      if (!this.focused) return void count(`refresh.skip.${reason}.unfocused`);
      if (this.now() - this.lastAt < this.opts.minGapMs() / 2) return void count(`refresh.skip.${reason}.fresh`);
    }
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
    try {
      const model = await this.load();
      this.last = model;
      end(true);
      this.publish({ ok: true, model });
    } catch (e) {
      const kind = e instanceof CliError ? e.kind : "failed";
      end(false, { error: kind });
      this.publish({ ok: false, error: { kind, message: (e as Error).message }, last: this.last });
    } finally {
      this.lastAt = this.now();
    }
  }
}
