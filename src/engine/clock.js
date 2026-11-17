/**
 * 时间轴：可暂停、可倍速、可冻结（截屏与 bench 需要确定性时间）。
 * 单帧步长有上限，避免切回标签页时云层瞬移。
 */
export class Clock {
  constructor({ frozen = false, start = 0, maxStep = 0.1 } = {}) {
    this.frozen = frozen;
    this.elapsed = start;
    this.rate = 1;
    this.paused = false;
    this.maxStep = maxStep;
    this.last = null;
  }

  advance(now) {
    if (this.last === null) {
      this.last = now;
      return this.elapsed;
    }
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), this.maxStep);
    this.last = now;
    if (!this.paused && !this.frozen) this.elapsed += dt * this.rate;
    return this.elapsed;
  }

  reset(value = 0) {
    this.elapsed = value;
    this.last = null;
  }

  /** 给 HUD 用的 mm:ss。 */
  get display() {
    const total = Math.floor(this.elapsed);
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
}
