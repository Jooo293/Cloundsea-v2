/**
 * 列车状态机（M7）
 *
 *   rail --长按--> charging --松手--> flying --靠近轨道/10s无输入--> docking --> rail
 *
 * 位置用"uv 偏移"表示（1.0 = 画面高度），相机不动，列车被钳制在画面内。
 */

const CHARGE_TIME = 1.1;
const GRAVITY = 0.55;
const DAMPING = 1.15;
const STEER_GAIN = 1.7;
const IDLE_LIMIT = 10;

export class TrainSystem {
  constructor() {
    this.mode = "rail";
    this.offset = { x: 0, y: 0 };
    this.velocity = { x: 0, y: 0 };
    this.charge = 0;
    this.idle = 0;
    this.time = 0;
    this.scale = 1; // 飞行时略微放大，飞起来更可读
  }

  get isFlying() {
    return this.mode === "flying";
  }

  /** 长按开始蓄力（只在轨道上可用）。 */
  startCharge() {
    if (this.mode !== "rail") return;
    this.mode = "charging";
    this.charge = 0;
  }

  /** 松手：按蓄力值起飞；蓄力太少则取消。 */
  release() {
    if (this.mode !== "charging") return;
    if (this.charge < 0.15) {
      this.mode = "rail";
      this.charge = 0;
      return;
    }
    const power = this.charge;
    this.mode = "flying";
    this.velocity.x = 0.12 + 0.18 * power;
    this.velocity.y = 0.30 + 0.55 * power;
    this.charge = 0;
    this.idle = 0;
  }

  cancelCharge() {
    if (this.mode === "charging") {
      this.mode = "rail";
      this.charge = 0;
    }
  }

  /**
   * @param {number} dt 秒
   * @param {{ x: number, y: number } | null} pointerTarget 目标偏移（uv），null 表示没有输入
   * @param {number} aspect 宽高比，用于钳制 x
   */
  update(dt, pointerTarget, aspect) {
    this.time += dt;
    const targetScale = this.mode === "rail" ? 1 : 1.5;
    this.scale += (targetScale - this.scale) * Math.min(1, dt * 4);

    if (this.mode === "charging") {
      this.charge = Math.min(1, this.charge + dt / CHARGE_TIME);
      return;
    }

    if (this.mode === "flying") {
      const hasInput = Boolean(pointerTarget);
      if (hasInput) {
        this.velocity.x += (pointerTarget.x - this.offset.x) * STEER_GAIN * dt;
        this.velocity.y += (pointerTarget.y - this.offset.y) * STEER_GAIN * dt;
        this.idle = 0;
      } else {
        this.idle += dt;
      }

      this.velocity.y -= GRAVITY * dt;
      const damp = Math.exp(-DAMPING * dt);
      this.velocity.x *= damp;
      this.velocity.y *= damp;

      this.offset.x += this.velocity.x * dt;
      this.offset.y += this.velocity.y * dt;

      this.#clamp(aspect);

      // 回轨条件：停手太久 / 已经落回轨道线附近且速度不大
      const nearRail = this.offset.y < 0.02 && Math.abs(this.velocity.y) < 0.12;
      if (this.idle > IDLE_LIMIT || nearRail) this.mode = "docking";
      return;
    }

    if (this.mode === "docking") {
      const k = Math.min(1, dt * 3.2);
      this.offset.x += (0 - this.offset.x) * k;
      this.offset.y += (0 - this.offset.y) * k;
      this.velocity.x *= 0.85;
      this.velocity.y *= 0.85;
      if (Math.abs(this.offset.x) < 0.004 && Math.abs(this.offset.y) < 0.004) {
        this.offset.x = 0;
        this.offset.y = 0;
        this.velocity.x = 0;
        this.velocity.y = 0;
        this.mode = "rail";
      }
    }
  }

  #clamp(aspect) {
    const maxX = Math.max(0.2, aspect - 0.62);
    this.offset.x = Math.max(-0.2, Math.min(maxX, this.offset.x));
    this.offset.y = Math.max(-0.18, Math.min(0.52, this.offset.y));
  }

  get smokeFade() {
    return this.mode === "flying" || this.mode === "docking" ? 0.15 : 1;
  }

  get railFade() {
    return this.mode === "rail" ? 1 : 0.45;
  }
}
