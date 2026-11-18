/**
 * 天气系统（M10 改版）
 *
 * 两种天气（M22 起去掉了大雨 / 大雪）：
 *   晴    —— 原样，微风
 *   雷暴  —— 暴雨 + 飓风级风速 + 闪电 + 龙卷，最暗
 *
 * 每个天气是一组命名参数，切换时用 smoothstep 在 8 秒内插值。
 */

export const WEATHER_PRESETS = {
  sunny: {
    id: "sunny",
    name: "晴",
    brightness: 1.0,
    contrast: 1.0,
    saturation: 1.0,
    wind: 1.0,
    particleMul: 0.65,
    particleSpeed: 1.0,
    particleDir: 1, // +1 上升尘埃
    particleDriftX: 0.0,
    particleShape: 0.0, // 0 = 雨丝（细长），1 = 雪片（圆形）
    particleSize: 1.0,
    particleMix: 0.0, // 0 = 用主题自带的粒子颜色
    particleColor: [1, 1, 1],
    flashRate: 0,
    precipAmount: 0, // 雨量（只有雷暴下雨）
    mist: 0.0,
    tornado: 0,
  },
  storm: {
    id: "storm",
    name: "雷暴",
    brightness: 0.55,
    contrast: 1.18,
    saturation: 0.66,
    wind: 3.2, // 飓风
    particleMul: 0.0,
    particleSpeed: 4.2,
    particleDir: -1,
    particleDriftX: 3.4,
    particleShape: 0.0,
    particleSize: 0.8,
    particleMix: 1.0,
    particleColor: [0.72, 0.86, 1.0],
    flashRate: 3.0,
    precipAmount: 1.35,
    mist: 0.42,
    tornado: 1.0,
  },
};

const NUMERIC = [
  "brightness",
  "contrast",
  "saturation",
  "wind",
  "particleMul",
  "particleSpeed",
  "particleDir",
  "particleDriftX",
  "particleShape",
  "particleSize",
  "particleMix",
  "flashRate",
  "precipAmount",
  "mist",
  "tornado",
];
const smoothstep = (t) => t * t * (3 - 2 * t);

export class WeatherSystem {
  constructor(initialId = "sunny", duration = 8) {
    this.duration = duration;
    this.current = {
      ...WEATHER_PRESETS[initialId],
      particleColor: [...WEATHER_PRESETS[initialId].particleColor],
    };
    this.target = WEATHER_PRESETS[initialId];
    this.from = { ...this.current, particleColor: [...this.current.particleColor] };
    this.progress = 1;
    this.nextFlashIn = this.#rollNextFlash();
    // 每次落雷重新掷一次：落点（屏幕横向比例）/ 形状种子 / 是否有可见电弧（否则只是云内闪光）
    this.bolt = { x: 0.32, seed: 3.0, visible: 1 };
  }

  #rollBolt() {
    this.bolt = {
      x: 0.15 + Math.random() * 0.7,
      seed: Math.floor(Math.random() * 97) + 1,
      visible: Math.random() < 0.7 ? 1 : 0,
    };
  }

  #rollNextFlash() {
    const rate = this.current.flashRate / 60;
    if (rate <= 0) return Infinity;
    return -Math.log(1 - Math.random()) / rate;
  }

  get isDefault() {
    return this.current.id === "sunny" && this.progress >= 1;
  }

  setTarget(id) {
    const preset = WEATHER_PRESETS[id];
    if (!preset || preset.id === this.target.id) return;
    this.from = { ...this.current, particleColor: [...this.current.particleColor] };
    this.target = preset;
    this.progress = 0;
  }

  /** @param {number} dt 秒 */
  update(dt) {
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt / this.duration);
      const k = smoothstep(this.progress);
      for (const field of NUMERIC) {
        this.current[field] = this.from[field] + (this.target[field] - this.from[field]) * k;
      }
      for (let i = 0; i < 3; i += 1) {
        this.current.particleColor[i] =
          this.from.particleColor[i] + (this.target.particleColor[i] - this.from.particleColor[i]) * k;
      }
      if (this.progress >= 1) this.current.id = this.target.id;
      this.nextFlashIn = this.#rollNextFlash();
    }
    return this.current;
  }

  /**
   * 闪电视觉强度 0..1。
   * 结构：前导微闪 → 主闪（指数衰减）→ 0.2s 后的二次回闪。
   */
  flashIntensity(dt) {
    const rate = this.current.flashRate / 60;
    if (rate <= 0) return 0;
    this.nextFlashIn -= dt;
    if (this.nextFlashIn <= 0) {
      this.nextFlashIn = -Math.log(1 - Math.random()) / rate;
      this.flashAge = 0;
      this.#rollBolt(); // 回闪（echo）沿用同一条通道，和真实闪电一致
    }
    if (this.flashAge === undefined) return 0;
    this.flashAge += dt;
    const age = this.flashAge;
    if (age > 0.6) return 0;
    if (age < 0.07) return (age / 0.07) * 0.25;
    const main = Math.exp(-(age - 0.07) * 10) * 0.9;
    const echo = age > 0.2 ? Math.exp(-(age - 0.2) * 14) * 0.35 : 0;
    return Math.min(1, main + echo);
  }
}
