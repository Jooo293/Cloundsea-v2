/**
 * 程序化音频（WebAudio）：不加载任何素材，全部用噪声 + 振荡器 + 滤波器合成。
 *
 * 分三层总线：ambient（风 / 雨）、sfx（蓄力 / 起飞 / 雷）。
 * 所有持续音都是"常驻节点 + 参数自动化"，不在每帧创建节点——
 * 和着色器里"别把逐层计算写进循环"是同一个道理。
 *
 * 自动播放限制：必须等第一次用户交互后由外部调用 start()。
 * 冻结截图（?freeze=1）与 bench 模式不会创建 AudioContext。
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class AudioSystem {
  constructor({ muted = false } = {}) {
    this.muted = muted;
    this.ctx = null;
    this.enabled = false;
    this._lastMode = "rail";
    this._lastFlash = 0;
  }

  get available() {
    return typeof window !== "undefined" && !!(window.AudioContext || window.webkitAudioContext);
  }

  /** 第一次用户交互后调用；重复调用无副作用。 */
  start() {
    if (this.enabled || !this.available) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.enabled = true;

    this._setupBuses(ctx);
    this.noise = this._makeNoise(ctx);
    this._buildWind(ctx);
    this._buildRain(ctx);
    this._buildCharge(ctx);

    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  /** master → 压缩器 → 输出，下挂 ambient / sfx 两条总线。 */
  _setupBuses(ctx) {
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.ambient = ctx.createGain();
    this.ambient.gain.value = 0.85;
    this.ambient.connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);
  }

  /** 2 秒白噪声，循环使用；带通/低通在各自链路里做。 */
  _makeNoise(ctx) {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _loopNoise(ctx) {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  // ---------------- 环境风声（常驻） ----------------
  _buildWind(ctx) {
    const src = this._loopNoise(ctx);

    // 主气流：带通 + 缓慢摆动的中心频率 = 阵风
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.65;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain);
    lfoGain.connect(this.windFilter.frequency);

    src.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.ambient);

    // 低频层：雷暴时压下来的一层"厚度"
    this.windLowFilter = ctx.createBiquadFilter();
    this.windLowFilter.type = "lowpass";
    this.windLowFilter.frequency.value = 140;
    this.windLowGain = ctx.createGain();
    this.windLowGain.gain.value = 0;
    src.connect(this.windLowFilter);
    this.windLowFilter.connect(this.windLowGain);
    this.windLowGain.connect(this.ambient);

    src.start();
    lfo.start();
  }

  // ---------------- 暴雨底噪（常驻，雷暴时淡入） ----------------
  _buildRain(ctx) {
    const src = this._loopNoise(ctx);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 6800;

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;

    src.connect(hp);
    hp.connect(lp);
    lp.connect(this.rainGain);
    this.rainGain.connect(this.ambient);

    // 雨势的轻微起伏，避免像一条死白噪
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain);
    lfoGain.connect(this.rainGain.gain);

    src.start();
    lfo.start();
  }

  // ---------------- 蓄力（常驻，按 charge 调制） ----------------
  _buildCharge(ctx) {
    this.chargeOsc = ctx.createOscillator();
    this.chargeOsc.type = "sawtooth";
    this.chargeOsc.frequency.value = 70;

    this.chargeFilter = ctx.createBiquadFilter();
    this.chargeFilter.type = "lowpass";
    this.chargeFilter.frequency.value = 380;
    this.chargeFilter.Q.value = 6;

    this.chargeGain = ctx.createGain();
    this.chargeGain.gain.value = 0;

    this.chargeOsc.connect(this.chargeFilter);
    this.chargeFilter.connect(this.chargeGain);
    this.chargeGain.connect(this.sfx);

    // 叠一层噪声，增加"充能"的颗粒感
    const noiseSrc = this._loopNoise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 1.2;
    this.chargeNoiseGain = ctx.createGain();
    this.chargeNoiseGain.gain.value = 0;
    noiseSrc.connect(bp);
    bp.connect(this.chargeNoiseGain);
    this.chargeNoiseGain.connect(this.sfx);

    this.chargeOsc.start();
    noiseSrc.start();
  }

  /** 起飞一次性音效：低频冲击 + 噪声爆。power 0–1。 */
  launch(power = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = clamp(power, 0.2, 1);

    // 冲击：正弦下滑
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(34, t + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.55 * p, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
    osc.connect(og);
    og.connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.7);

    // 噪声爆：带通从高扫到低，模拟"冲出去"
    const n = this._loopNoise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + 0.55);
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.45 * p, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(this.sfx);
    n.start(t);
    n.stop(t + 0.7);
  }

  /** 雷声：随机延迟 0.3–1.2 s；30% 是云内闷雷（没有爆裂）。 */
  thunder(strength = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const delay = 0.3 + Math.random() * 0.9;
    const t0 = ctx.currentTime + delay;
    const inCloud = Math.random() < 0.3;
    const p = clamp(strength, 0.2, 1) * (inCloud ? 0.6 : 1);

    // 主体：低通噪声的长衰减
    const n = this._loopNoise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = inCloud ? 150 : 220;
    lp.Q.value = 1.1;
    const g = ctx.createGain();
    const dur = inCloud ? 3.4 : 2.6;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5 * p, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    n.connect(lp);
    lp.connect(g);
    g.connect(this.ambient);
    n.start(t0);
    n.stop(t0 + dur + 0.1);

    // 低频隆隆：两个略微失谐的正弦
    for (const [freq, gain] of [[44, 0.16], [37, 0.12]]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.linearRampToValueAtTime(freq * 0.86, t0 + dur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(gain * p, t0 + 0.12);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.9);
      osc.connect(og);
      og.connect(this.ambient);
      osc.start(t0);
      osc.stop(t0 + dur);
    }

    // 近雷爆裂
    if (!inCloud) {
      const crack = this._loopNoise(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t0);
      cg.gain.exponentialRampToValueAtTime(0.32 * p, t0 + 0.01);
      cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      crack.connect(hp);
      hp.connect(cg);
      cg.connect(this.sfx);
      crack.start(t0);
      crack.stop(t0 + 0.2);
    }
  }

  /**
   * 每帧调用。
   * state: { weather: "sunny"|"storm", storm: 0–1, charge: 0–1, mode, flash: 0–1 }
   */
  update(state) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const storm = state.weather === "storm" ? clamp(state.storm || 0, 0, 1) : 0;

    // 风：雷暴时更响、更低沉
    const windLevel = 0.10 + 0.20 * storm;
    this.windGain.gain.setTargetAtTime(windLevel, now, 0.25);
    this.windFilter.frequency.setTargetAtTime(760 - 300 * storm, now, 0.5);
    this.windLowGain.gain.setTargetAtTime(0.015 + 0.11 * storm, now, 0.4);

    // 雨
    this.rainGain.gain.setTargetAtTime(0.24 * storm, now, 0.6);

    // 蓄力：频率、滤波、音量一起随 charge 上行
    const charging = state.mode === "charging";
    const c = charging ? clamp(state.charge || 0, 0, 1) : 0;
    this.chargeGain.gain.setTargetAtTime(charging ? 0.09 + 0.13 * c : 0, now, 0.06);
    this.chargeNoiseGain.gain.setTargetAtTime(charging ? 0.02 + 0.05 * c : 0, now, 0.06);
    this.chargeOsc.frequency.setTargetAtTime(70 + 170 * c, now, 0.05);
    this.chargeFilter.frequency.setTargetAtTime(380 + 1700 * c, now, 0.08);

    // 事件：蓄力 → 飞行 的那一下
    if (this._lastMode === "charging" && state.mode === "flying") {
      this.launch(0.7 + 0.3 * c);
    }
    this._lastMode = state.mode;

    // 闪电：包络越过阈值触发一次
    const flash = state.flash || 0;
    if (flash > 0.45 && this._lastFlash <= 0.45) this.thunder(0.5 + 0.5 * flash);
    this._lastFlash = flash;
  }

  /**
   * 离线自检：用同一套建图代码在 OfflineAudioContext 里渲染一段，返回 RMS。
   * 无头环境没有声卡、虚拟时间也不推进 AudioContext，只有离线渲染能可靠验证"有没有声音"。
   */
  static async renderTest(seconds = 1.2) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return -1;
    const rate = 44100;
    const ctx = new Offline(1, Math.floor(rate * seconds), rate);
    const sys = new AudioSystem({});
    sys.ctx = ctx;
    sys.enabled = true;
    sys._setupBuses(ctx);
    sys.noise = sys._makeNoise(ctx);
    sys._buildWind(ctx);
    sys._buildRain(ctx);
    sys._buildCharge(ctx);

    // 模拟雷暴 + 蓄力，再切到飞行（触发一次起飞）
    sys.update({ weather: "storm", storm: 1, charge: 0.6, mode: "charging", flash: 0 });
    sys.update({ weather: "storm", storm: 1, charge: 0, mode: "flying", flash: 0 });
    sys.thunder(0.9);

    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i];
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    return { rms: Math.sqrt(sum / data.length), peak };
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.enabled) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }

  suspend() {
    if (this.enabled && this.ctx.state === "running") this.ctx.suspend().catch(() => {});
  }

  resume() {
    if (this.enabled && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }
}
