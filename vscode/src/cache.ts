/** A tiny time-to-live cache so a burst of triggers (focus, git change, timer) makes one call. */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: T }>();
  constructor(private now: () => number = Date.now) {}

  get(key: string, ttlMs: number): T | undefined {
    const e = this.entries.get(key);
    return e && this.now() - e.at < ttlMs ? e.value : undefined;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { at: this.now(), value });
  }

  clear(): void {
    this.entries.clear();
  }

  /** Runs `load` unless there is a fresh value; a failure is not cached. */
  async through(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key, ttlMs);
    if (hit !== undefined) return hit;
    const value = await load();
    this.set(key, value);
    return value;
  }
}
