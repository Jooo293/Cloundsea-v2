/**
 * 穿云演出（M21）：一次性的镜头动画，约 6.4 秒。
 *
 *   0.0 – 1.9  厚云从画面下方与四周蔓延，直到完全遮住视野（第三人称）
 *   1.9 – 2.5  全遮挡：镜头在云里切到第一人称（推到车头前方），速度线开始加速
 *   2.5 – 4.4  列车冲出：中心破开一个洞，云被冲击波向四周甩开、炸散
 *   2.5 – 6.4  镜头从车头前方平滑拉回原来的第三人称远景
 *
 * 只输出几个 0..1 的包络，渲染全在 final pass；不演出时 active=false，着色器整段跳过。
 */

const DURATION = 6.4;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

export class CloudBurst {
  constructor() {
    this.time = -1; // <0 = 未在演出
  }

  get active() {
    return this.time >= 0 && this.time < DURATION;
  }

  start() {
    if (!this.active) this.time = 0;
  }

  /** 截图/调试：直接停在某个时刻（?burst=2.8） */
  seek(time) {
    this.time = time;
  }

  update(dt) {
    if (this.time < 0) return;
    this.time += dt;
    if (this.time >= DURATION) this.time = -1;
  }

  /**
   * cover  云层覆盖 0..1（1 = 完全遮挡）
   * burst  破洞半径进度 0..1
   * zoom   镜头倍率（1 = 原画面）
   * speed  速度线 / 径向模糊强度 0..1
   */
  state() {
    const t = this.time;
    if (!this.active) return { active: false, cover: 0, burst: 0, zoom: 1, speed: 0, time: 0 };
    const cover = clamp01(t / 1.9);   // 各层的缓动在着色器里做
    const burst = easeOutCubic(clamp01((t - 2.5) / 1.9));
    // 全遮挡期间瞬切到近景（看不到切换），之后顺滑拉回
    const zoom = t < 2.2 ? 1 : 1 + 1.6 * (1 - easeInOutSine((t - 2.5) / 3.9));
    const speed = smooth(1.9, 2.6, t) * (1 - smooth(3.6, 5.6, t));
    return { active: true, cover, burst, zoom, speed, time: t };
  }
}
