export type Ease = (t: number) => number;
export const easeInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut: Ease = (t) => 1 - Math.pow(1 - t, 3);

interface Tw { key: string; from: number; to: number; dur: number; t: number; ease: Ease; set: (v: number) => void; done?: () => void }
export class Tweens {
  private list: Tw[] = [];
  private values = new Map<string, number>();
  get(key: string, fallback = 0): number { return this.values.get(key) ?? fallback; }
  /** Animate a keyed value toward `to`. Restarts from the current value if already running. */
  to(key: string, to: number, dur: number, set: (v: number) => void, ease: Ease = easeInOut, done?: () => void, from?: number): void {
    const cur = from ?? this.values.get(key) ?? 0;
    this.list = this.list.filter((t) => t.key !== key);
    if (dur <= 0 || cur === to) { this.values.set(key, to); set(to); done?.(); return; }
    this.list.push({ key, from: cur, to, dur, t: 0, ease, set, done });
  }
  busy(key: string): boolean { return this.list.some((t) => t.key === key); }
  update(dt: number): void {
    for (const t of [...this.list]) {
      t.t = Math.min(1, t.t + dt / t.dur);
      const v = t.from + (t.to - t.from) * t.ease(t.t);
      this.values.set(t.key, v); t.set(v);
      if (t.t >= 1) { this.list = this.list.filter((x) => x !== t); t.done?.(); }
    }
  }
}
