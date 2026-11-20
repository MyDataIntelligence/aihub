import { promises as fs } from "node:fs";
import { join } from "node:path";
import { Scrubber } from "./scrub";

/**
 * The local performance log: JSON lines in `<dir>/aihub-perf-<yyyy-mm-dd>.jsonl`, one file per day, at most
 * `maxBytesPerDay` per file, `keepDays` days kept. `write` only pushes to a buffer; a timer (unref'd) scrubs and
 * appends the buffer asynchronously, so nothing on the hot path touches the disk.
 */

export interface PerfEvent {
  /** epoch ms */
  t: number;
  type: string;
  [k: string]: unknown;
}

export interface PerfLogOptions {
  dir: string;
  maxBytesPerDay?: number;
  keepDays?: number;
  flushMs?: number;
  /** Events kept in memory before a flush is started early. */
  flushAt?: number;
  /** Events kept at most while the disk is slow; newer ones are dropped and counted. */
  maxBuffer?: number;
  scrubber?: Scrubber;
  now?: () => number;
}

export const FILE_PREFIX = "aihub-perf-";
export const fileDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const fileFor = (dir: string, t: number) => join(dir, `${FILE_PREFIX}${fileDay(t)}.jsonl`);

export class PerfLog {
  readonly dir: string;
  readonly scrubber: Scrubber;
  private buf: PerfEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private day = "";
  private bytes = 0;
  private capped = false;
  private ready: Promise<void> | undefined;
  private o: Required<Omit<PerfLogOptions, "scrubber" | "dir">>;
  /** Events not written: buffer full or the day's file at its size limit. */
  dropped = 0;
  written = 0;

  constructor(opts: PerfLogOptions) {
    this.dir = opts.dir;
    this.scrubber = opts.scrubber ?? new Scrubber();
    this.o = { maxBytesPerDay: 10 * 1024 * 1024, keepDays: 7, flushMs: 5000, flushAt: 500, maxBuffer: 5000, now: Date.now, ...stripUndefined(opts) } as typeof this.o;
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref?.();
  }

  now(): number {
    return this.o.now();
  }

  write(type: string, fields: Record<string, unknown> = {}): void {
    if (this.buf.length >= this.o.maxBuffer) {
      this.dropped++;
      return;
    }
    this.buf.push({ t: this.o.now(), type, ...fields });
    if (this.buf.length === this.o.flushAt) void this.flush();
  }

  /** Writes what is buffered. Calls are queued, so lines never interleave. */
  flush(): Promise<void> {
    if (!this.buf.length) return this.chain;
    const batch = this.buf;
    this.buf = [];
    this.chain = this.chain.then(() => this.append(batch)).catch(() => undefined);
    return this.chain;
  }

  private async append(batch: PerfEvent[]) {
    this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => this.prune());
    await this.ready;
    // a batch can cross midnight: group by day
    const byDay = new Map<string, string[]>();
    for (const e of batch) {
      const d = fileDay(e.t);
      let line: string;
      try {
        line = JSON.stringify(this.scrubber.value(e));
      } catch {
        continue;
      }
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(line);
    }
    for (const [d, lines] of byDay) await this.appendDay(d, lines);
  }

  private async appendDay(d: string, lines: string[]) {
    const file = join(this.dir, `${FILE_PREFIX}${d}.jsonl`);
    if (d !== this.day) {
      if (this.day) await this.prune();
      this.day = d;
      this.capped = false;
      this.bytes = await fs.stat(file).then((s) => s.size, () => 0);
    }
    if (this.capped) return void (this.dropped += lines.length);
    let chunk = "";
    let n = 0;
    for (const l of lines) {
      if (this.bytes + chunk.length + l.length + 1 > this.o.maxBytesPerDay) break;
      chunk += l + "\n";
      n++;
    }
    if (n < lines.length) {
      this.capped = true;
      this.dropped += lines.length - n;
      chunk += JSON.stringify({ t: this.o.now(), type: "log.cap", maxBytes: this.o.maxBytesPerDay, note: "day limit reached; later events of today are not written" }) + "\n";
    }
    if (!chunk) return;
    await fs.appendFile(file, chunk, "utf8");
    this.bytes += Buffer.byteLength(chunk);
    this.written += n;
  }

  /** Deletes day files older than keepDays. */
  async prune(): Promise<void> {
    const oldest = fileDay(this.o.now() - (this.o.keepDays - 1) * 86_400_000);
    const names = await fs.readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(".jsonl") && n.slice(FILE_PREFIX.length, -6) < oldest)
        .map((n) => fs.unlink(join(this.dir, n)).catch(() => undefined)),
    );
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}

/** The log files of the last `days` days, oldest first. */
export async function logFiles(dir: string, now = Date.now(), days = 7): Promise<string[]> {
  const oldest = fileDay(now - (days - 1) * 86_400_000);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(".jsonl") && n.slice(FILE_PREFIX.length, -6) >= oldest)
    .sort()
    .map((n) => join(dir, n));
}

/** The events since `since` (epoch ms), from the day files. A broken line is skipped. */
export async function readEvents(dir: string, since: number, now = Date.now()): Promise<PerfEvent[]> {
  const days = Math.max(1, Math.ceil((now - since) / 86_400_000) + 1);
  const out: PerfEvent[] = [];
  for (const f of await logFiles(dir, now, days)) {
    const text = await fs.readFile(f, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as PerfEvent;
        if (e.t >= since) out.push(e);
      } catch {
        /* a line cut off by a crash */
      }
    }
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== "scrubber" && k !== "dir")) as Partial<T>;
}
