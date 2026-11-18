import { createProgram, createNoiseTexture, drawFullscreen } from "../engine/gl.js";
import { RenderTarget } from "../engine/fbo.js";
import { buildThemeUniforms, PALETTE_SIZE } from "../themes/theme.js";

/**
 * 云海渲染器（M2b：多 pass）
 *
 * 每帧：
 *   1. sky     半分辨率：渐变夜空 + 星点 + 背景 12 层云
 *   2. fg      半分辨率：前景 2 层云（带 alpha）
 *   3. composite 全分辨率：上采样云图 + 城市 + 列车 + 烟 + 桥 + 前景云 + 粒子
 *   4. bright  1/4 分辨率：高光提取
 *   5. blur H  1/4 分辨率
 *   6. blur V  1/4 分辨率
 *   7. final   全分辨率：场景 + bloom + 暗角
 *
 * 云层（最贵的一步）只跑半分辨率；列车/桥/城市在全分辨率，保持边缘锐利。
 * 主题 bloom=0 时跳过 4–6 步。
 */

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 outColor;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
`;

const withEntry = (source) => `${HEADER}${source}
void main() { mainImage(outColor, gl_FragCoord.xy); }
`;

const SKY_UNIFORMS = [
  "iResolution", "iTime", "iChannel0", "uPalette", "uNoise",
  "uLayerCount", "uLayer", "uBandDh", "uBandCount",
  "uSkyTop", "uSkyBottom", "uStarDensity", "uParallax",
  "uInkEdge", "uInkGain", "uInkColor",
  "uMountainEnabled", "uMountainNear", "uMountainFar",
  "uAuroraEnabled", "uAuroraStrength", "uAuroraColor",
  "uIceEnabled", "uIceStrength", "uIceScale", "uIceColor",
  "uWarp", "uRidge", "uCarvePos", "uCarveRadius", "uCarveDepth",
  "uWeatherActive", "uBrightness", "uContrast", "uSaturation", "uCloudTime", "uMist",
  "uTornado", "uTornadoPos", "uFlash", "uBolt",
];

const FG_UNIFORMS = [
  "iResolution", "iTime", "iChannel0", "uPalette", "uNoise",
  "uFgCount", "uFgLayer", "uFgBandDh", "uFgBandCount", "uFgFallback",
  "uCarvePos", "uCarveRadius", "uCarveDepth", "uCloudTime",
];

const COMPOSITE_UNIFORMS = [
  "iResolution", "iTime", "iChannel0", "iChannel1", "uNoise",
  "uTrainBody", "uTrainRoof", "uTrainTrim", "uTrainEmissive", "uEmissiveEnergy",
  "uSmokeA", "uSmokeB", "uSmokeStrength", "uBridgeColor",
  "uCityEnabled", "uCityColor", "uCityWindow",
  "uParticleColor", "uParticleDensity", "uParticleSpeed", "uWeatherParticleMul", "uParticleDir",
  "uWeatherParticleSpeed", "uWeatherParticleDriftX", "uWeatherParticleShape", "uWeatherParticleSize",
  "uWeatherParticleMix", "uWeatherParticleColor",
  "uPrecipAmount", "uWindSlant", "uTornado", "uTornadoPos", "uFlash",
  "uParallax", "uScanline", "uTrainOffset", "uTrainScale", "uSmokeFade", "uRailFade",
  "uTrainGrain", "uCraneEnabled", "uCraneColor",
  "uSnowCover", "uSnowColor",
];

const BRIGHT_UNIFORMS = ["iResolution", "iChannel0", "uThreshold"];
const BLUR_UNIFORMS = ["iResolution", "iChannel0", "uDirection"];
const FINAL_UNIFORMS = [
  "iResolution", "iChannel0", "iChannel1", "uBloomStrength", "uPaper", "uFlash", "uNoise",
  "uBurst", "uBurstTime", "uBurstFocus", "uFogDark", "uFogMid", "uFogLight",
];

async function loadText(path) {
  // 单文件构建时着色器以全局变量注入，优先读内存
  const inline = globalThis.__SHADERS;
  if (inline && inline[path]) return inline[path];
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`加载 ${path} 失败（${response.status}）`);
  return response.text();
}

function loadImage(path) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`加载 ${path} 失败`)), { once: true });
    image.src = globalThis.__NOISE_URL || path;
  });
}

export class CloudSeaRenderer {
  static async create(gl, { basePath = "", cloudScale = 0.5 } = {}) {
    const [vertex, common, sky, fg, composite, bright, blur, final, image] = await Promise.all([
      loadText(`${basePath}src/shaders/fullscreen.vert`),
      loadText(`${basePath}src/shaders/common.glsl`),
      loadText(`${basePath}src/shaders/sky.frag`),
      loadText(`${basePath}src/shaders/fg.frag`),
      loadText(`${basePath}src/shaders/composite.frag`),
      loadText(`${basePath}src/shaders/bright.frag`),
      loadText(`${basePath}src/shaders/blur.frag`),
      loadText(`${basePath}src/shaders/final.frag`),
      loadImage(`${basePath}assets/noise.png`),
    ]);

    const make = (fragment, uniforms, label, defines = "") =>
      createProgram(gl, { vertex, fragment: withEntry(`${defines}${common}\n${fragment}`), uniforms, label });

    // sky 编两份：雷暴变体带龙卷/闪电；其余天气用精简变体，不为用不到的代码付帧时
    const skyPass = make(sky, SKY_UNIFORMS, "sky");
    const skyStormPass = make(sky, SKY_UNIFORMS, "sky-storm", "#define STORM\n");
    const fgPass = make(fg, FG_UNIFORMS, "fg");
    const compositePass = make(composite, COMPOSITE_UNIFORMS, "composite");
    // composite 同理：降水 / 龙卷碎屑只进有天气的变体
    const compositeWeatherPass = make(composite, COMPOSITE_UNIFORMS, "composite-weather", "#define WEATHER\n");
    const brightPass = make(bright, BRIGHT_UNIFORMS, "bright");
    const blurPass = make(blur, BLUR_UNIFORMS, "blur");
    const finalPass = make(final, FINAL_UNIFORMS, "final");
    // final 同理：穿云演出的代码只进演出期间用的变体
    const finalBurstPass = make(final, FINAL_UNIFORMS, "final-burst", "#define BURST\n");

    return new CloudSeaRenderer(gl, { skyPass, skyStormPass, fgPass, compositePass, compositeWeatherPass, brightPass, blurPass, finalPass, finalBurstPass }, createNoiseTexture(gl, image), { cloudScale });
  }

  constructor(gl, passes, noiseTexture, { cloudScale }) {
    this.gl = gl;
    Object.assign(this, passes);
    this.noiseTexture = noiseTexture;
    this.vao = gl.createVertexArray();

    this.cloudScale = Math.min(1, Math.max(0.35, cloudScale));

    this.cloudTarget = new RenderTarget(gl);
    this.fgTarget = new RenderTarget(gl);
    this.sceneTarget = new RenderTarget(gl);
    this.bloomA = new RenderTarget(gl);
    this.bloomB = new RenderTarget(gl);

    this.parallax = [0, 0];
    // 列车拨云的位置（云空间 uv），M7 会跟着列车移动
    this.carve = { x: 0.22, y: 0.31, radius: 0.12 };
    this.carveDepth = 0;
    this.carveBoost = 1;
    // 龙卷中心（uv），每帧缓慢漂移
    this.tornadoPos = [0.62, 0.30];

    // 天气：默认晴天且全部为中性值（着色器会整段跳过保持 classic 不变）
    this.weather = {
      active: 0, brightness: 1, contrast: 1, saturation: 1,
      particleMul: 1, particleDir: 1, particleSpeed: 1, particleDriftX: 0, particleShape: 0, particleSize: 1, particleMix: 0,
      precipAmount: 0, mist: 0, tornado: 0,
      particleColor: [1, 1, 1],
    };
    this.cloudTime = 0;
    this.flash = 0;
    this.bolt = { x: 0.32, seed: 3, visible: 1 };
    this.train = { x: 0, y: 0, scale: 1, smokeFade: 1, railFade: 1 };
    this.bloomStrength = 0;
    // 穿云演出：覆盖 / 破洞 / 镜头倍率 / 速度；颜色取主题前景云
    this.burst = { cover: 0, burst: 0, zoom: 1, speed: 0, time: 0, focus: [0.56, 0.33] };
    this.fog = { dark: [0, 0, 0], mid: [0, 0, 0], light: [0, 0, 0] };
    this.bloomThreshold = 0.7;
    this.themeId = null;

    this.paletteTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setTheme(theme) {
    const gl = this.gl;
    const u = buildThemeUniforms(theme);
    const set3 = (pass, name, color) => {
      const loc = pass.uniforms[name];
      if (loc) gl.uniform3f(loc, color[0], color[1], color[2]);
    };

    // 天空 / 背景云（两个变体都要上传）
    for (const sky of [this.skyPass, this.skyStormPass]) {
      gl.useProgram(sky.program);
      gl.uniform1i(sky.uniforms.uLayerCount, u.layerCount);
      gl.uniform4fv(sky.uniforms.uLayer, u.layers);
      gl.uniform4fv(sky.uniforms.uBandDh, u.bandDh);
      gl.uniform1iv(sky.uniforms.uBandCount, u.bandCount);
      gl.uniform3fv(sky.uniforms.uSkyTop, u.skyTop);
      gl.uniform3fv(sky.uniforms.uSkyBottom, u.skyBottom);
      gl.uniform1f(sky.uniforms.uStarDensity, u.starDensity);
      gl.uniform1f(sky.uniforms.uInkEdge, u.ink.edge);
      gl.uniform1f(sky.uniforms.uInkGain, u.ink.gain);
      set3(sky, "uInkColor", u.ink.color);
      gl.uniform1f(sky.uniforms.uMountainEnabled, u.mountains.on);
      set3(sky, "uMountainNear", u.mountains.near);
      set3(sky, "uMountainFar", u.mountains.far);
      gl.uniform1f(sky.uniforms.uAuroraEnabled, u.aurora.on);
      gl.uniform1f(sky.uniforms.uAuroraStrength, u.aurora.strength);
      set3(sky, "uAuroraColor", u.aurora.color);
      gl.uniform1f(sky.uniforms.uIceEnabled, u.ice.on);
      gl.uniform1f(sky.uniforms.uIceStrength, u.ice.strength);
      gl.uniform1f(sky.uniforms.uIceScale, u.ice.scale);
      set3(sky, "uIceColor", u.ice.color);
      gl.uniform1f(sky.uniforms.uWarp, u.cloud.warp);
      gl.uniform1f(sky.uniforms.uRidge, u.cloud.ridge);
    }
    this.carveDepth = u.cloud.carve;

    // 前景云
    gl.useProgram(this.fgPass.program);
    gl.uniform1i(this.fgPass.uniforms.uFgCount, u.fgCount);
    gl.uniform4fv(this.fgPass.uniforms.uFgLayer, u.fgLayers);
    gl.uniform4fv(this.fgPass.uniforms.uFgBandDh, u.fgBandDh);
    gl.uniform1iv(this.fgPass.uniforms.uFgBandCount, u.fgBandCount);
    gl.uniform3fv(this.fgPass.uniforms.uFgFallback, u.fgFallback);

    // 合成层
    for (const comp of [this.compositePass, this.compositeWeatherPass]) {
      gl.useProgram(comp.program);
      set3(comp, "uTrainBody", u.train.body);
      set3(comp, "uTrainRoof", u.train.roof);
      set3(comp, "uTrainTrim", u.train.trim);
      set3(comp, "uTrainEmissive", u.train.emissive);
      gl.uniform1f(comp.uniforms.uEmissiveEnergy, u.train.energy);
      set3(comp, "uSmokeA", u.train.smokeA);
      set3(comp, "uSmokeB", u.train.smokeB);
      gl.uniform1f(comp.uniforms.uSmokeStrength, u.smokeStrength);
      set3(comp, "uBridgeColor", u.train.bridge);

      gl.uniform1f(comp.uniforms.uCityEnabled, u.city.on);
      set3(comp, "uCityColor", u.city.color);
      set3(comp, "uCityWindow", u.city.window);

      set3(comp, "uParticleColor", u.particles.color);
      gl.uniform1f(comp.uniforms.uParticleDensity, u.particles.density);
      gl.uniform1f(comp.uniforms.uParticleSpeed, u.particles.speed);
      gl.uniform1f(comp.uniforms.uScanline, u.scanline);
      gl.uniform1f(comp.uniforms.uTrainGrain, u.grain);
      gl.uniform1f(comp.uniforms.uCraneEnabled, u.cranes.on);
      set3(comp, "uCraneColor", u.cranes.color);
      gl.uniform1f(comp.uniforms.uSnowCover, u.snow);
      set3(comp, "uSnowColor", [0.95, 0.98, 1.0]);
    }

    // 宣纸纹理在 final pass
    for (const fin of [this.finalPass, this.finalBurstPass]) {
      gl.useProgram(fin.program);
      gl.uniform1f(fin.uniforms.uPaper, u.paper);
    }

    // 调色板纹理（sky / fg 共用）
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PALETTE_SIZE, 1, 0, gl.RGBA, gl.FLOAT, u.palette);

    // 演出云层沿用主题前景云的色带：最暗 = 近层底色，中/亮 = 远层两端
    const near = theme.fg[0].colors;
    const far = theme.fg[theme.fg.length - 1].colors;
    this.fog = { dark: near[0], mid: far[Math.floor(far.length / 2)], light: far[far.length - 1] };

    this.bloomStrength = u.bloom;
    this.bloomThreshold = u.bloomThreshold;
    this.themeId = theme.id;
  }

  setParallax(x, y) {
    this.parallax[0] = x;
    this.parallax[1] = y;
  }

  /** 云层渲染分辨率倍率：0.5 省 4 倍像素，1.0 最清晰。 */
  setCloudScale(scale) {
    this.cloudScale = Math.min(1, Math.max(0.35, Number(scale) || 0.75));
  }

  /** 列车拨云的中心（云空间 uv，未做 y-0.2 偏移）。 */
  setCarve(x, y, radius = this.carve.radius) {
    this.carve.x = x;
    this.carve.y = y;
    this.carve.radius = radius;
  }

  /** 天气参数（由 WeatherSystem 每帧喂进来）。active=0 时着色器整段跳过。 */
  setWeather(weather) {
    this.weather.active = weather.active ? 1 : 0;
    this.weather.brightness = weather.brightness;
    this.weather.contrast = weather.contrast;
    this.weather.saturation = weather.saturation;
    this.weather.particleMul = weather.particleMul;
    this.weather.particleDir = weather.particleDir ?? 1;
    this.weather.particleSpeed = weather.particleSpeed ?? 1;
    this.weather.particleDriftX = weather.particleDriftX ?? 0;
    this.weather.particleShape = weather.particleShape ?? 0;
    this.weather.particleSize = weather.particleSize ?? 1;
    this.weather.particleMix = weather.particleMix ?? 0;
    this.weather.particleColor = weather.particleColor || [1, 1, 1];
    this.weather.precipAmount = weather.precipAmount ?? 0;
    this.weather.mist = weather.mist ?? 0;
    this.weather.tornado = weather.tornado ?? 0;
  }

  setCloudTime(time) {
    this.cloudTime = time;
    this.tornadoPos[0] = 0.60 + Math.sin(this.cloudTime * 0.05) * 0.05;
  }

  /** 闪电强度 + 本次落雷（落点 x 为屏幕横向比例、形状种子、是否有可见电弧）。 */
  /** 穿云演出的包络（CloudBurst.state()）与镜头焦点（uv / 高度 单位）。 */
  setBurst(state, focus) {
    Object.assign(this.burst, state);
    if (focus) this.burst.focus = focus;
  }

  setFlash(value, bolt) {
    this.flash = value;
    if (bolt) this.bolt = bolt;
  }

  /** 列车位移（uv 单位）与淡出系数，由 TrainSystem 每帧喂入。 */
  setTrainFrame({ x, y, scale = 1, smokeFade = 1, railFade = 1 }) {
    this.train.x = x;
    this.train.y = y;
    this.train.scale = scale;
    this.train.smokeFade = smokeFade;
    this.train.railFade = railFade;
  }

  /** 调试/演出用：把拨云强度整体放大（?carve=2）。 */
  setCarveBoost(boost) {
    this.carveBoost = Math.max(0, Number(boost) || 1);
  }

  render(time, width, height) {
    const gl = this.gl;
    const cw = Math.max(1, Math.round(width * this.cloudScale));
    const ch = Math.max(1, Math.round(height * this.cloudScale));

    this.cloudTarget.resize(cw, ch);
    this.fgTarget.resize(cw, ch);
    this.sceneTarget.resize(width, height);

    gl.bindVertexArray(this.vao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cloudTarget.framebuffer);
    gl.viewport(0, 0, cw, ch);
    const stormy = this.weather.tornado > 0.001 || this.flash > 0.001;
    this.draw(stormy ? this.skyStormPass : this.skyPass, [this.noiseTexture], cw, ch, time);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fgTarget.framebuffer);
    gl.viewport(0, 0, cw, ch);
    this.draw(this.fgPass, [this.noiseTexture], cw, ch, time);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.framebuffer);
    gl.viewport(0, 0, width, height);
    const wet = stormy || this.weather.precipAmount > 0.001;
    this.draw(wet ? this.compositeWeatherPass : this.compositePass, [this.cloudTarget.texture, this.fgTarget.texture], width, height, time);

    let bloomTexture = this.sceneTarget.texture;
    if (this.bloomStrength > 0) {
      const bw = Math.max(1, Math.round(width / 4));
      const bh = Math.max(1, Math.round(height / 4));
      this.bloomA.resize(bw, bh);
      this.bloomB.resize(bw, bh);

      gl.viewport(0, 0, bw, bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
      this.draw(this.brightPass, [this.sceneTarget.texture], bw, bh, time, (pass) => {
        gl.uniform1f(pass.uniforms.uThreshold, this.bloomThreshold);
      });

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.framebuffer);
      this.draw(this.blurPass, [this.bloomA.texture], bw, bh, time, (pass) => {
        gl.uniform2f(pass.uniforms.uDirection, 1, 0);
      });

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.framebuffer);
      this.draw(this.blurPass, [this.bloomB.texture], bw, bh, time, (pass) => {
        gl.uniform2f(pass.uniforms.uDirection, 0, 1);
      });

      bloomTexture = this.bloomA.texture;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    const finalPass = this.burst.cover > 0 ? this.finalBurstPass : this.finalPass;
    this.draw(finalPass, [this.sceneTarget.texture, bloomTexture], width, height, time, (pass) => {
      gl.uniform1f(pass.uniforms.uBloomStrength, this.bloomStrength);
      if (!pass.uniforms.uBurst) return;   // 非演出变体没有这些 uniform
      const b = this.burst;
      gl.uniform4f(pass.uniforms.uBurst, b.cover, b.burst, b.zoom, b.speed);
      gl.uniform1f(pass.uniforms.uBurstTime, b.time);
      gl.uniform2f(pass.uniforms.uBurstFocus, b.focus[0], b.focus[1]);
      // 天气压暗时演出云跟着暗，不然雷暴里会冒出一团亮云
      const k = this.weather.active ? 1 + (this.weather.brightness - 1) * 0.8 : 1;
      const fog3 = (name, c) => gl.uniform3f(pass.uniforms[name], c[0] * k, c[1] * k, c[2] * k);
      fog3("uFogDark", this.fog.dark);
      fog3("uFogMid", this.fog.mid);
      fog3("uFogLight", this.fog.light);
    });
  }

  draw(pass, textures, width, height, time, setup) {
    const gl = this.gl;
    gl.useProgram(pass.program);
    gl.uniform3f(pass.uniforms.iResolution, width, height, 1);
    if (pass.uniforms.iTime) gl.uniform1f(pass.uniforms.iTime, time);

    textures.forEach((texture, index) => {
      const loc = pass.uniforms[`iChannel${index}`];
      if (!loc) return;
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(loc, index);
    });

    if (pass.uniforms.uPalette) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
      gl.uniform1i(pass.uniforms.uPalette, 2);
    }

    // 噪声纹理单独走 uNoise（composite 的 iChannel0/1 已被云图与前景云占用）
    if (pass.uniforms.uNoise) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
      gl.uniform1i(pass.uniforms.uNoise, 3);
    }

    if (pass.uniforms.uParallax) {
      gl.uniform2f(pass.uniforms.uParallax, this.parallax[0], this.parallax[1]);
    }

    if (pass.uniforms.uCarvePos) {
      gl.uniform2f(pass.uniforms.uCarvePos, this.carve.x, this.carve.y);
      gl.uniform1f(pass.uniforms.uCarveRadius, this.carve.radius);
      gl.uniform1f(pass.uniforms.uCarveDepth, (this.carveDepth || 0) * this.carveBoost);
    }

    if (pass.uniforms.uCloudTime) {
      gl.uniform1f(pass.uniforms.uCloudTime, this.cloudTime);
    }

    if (pass.uniforms.uMist) {
      gl.uniform1f(pass.uniforms.uMist, this.weather.mist);
    }

    if (pass.uniforms.uWeatherActive) {
      gl.uniform1f(pass.uniforms.uWeatherActive, this.weather.active);
      gl.uniform1f(pass.uniforms.uBrightness, this.weather.brightness);
      gl.uniform1f(pass.uniforms.uContrast, this.weather.contrast);
      gl.uniform1f(pass.uniforms.uSaturation, this.weather.saturation);
    }

    if (pass.uniforms.uWeatherParticleMul) {
      gl.uniform1f(pass.uniforms.uWeatherParticleMul, this.weather.particleMul);
    }

    if (pass.uniforms.uParticleDir) {
      gl.uniform1f(pass.uniforms.uParticleDir, this.weather.particleDir);
      gl.uniform1f(pass.uniforms.uWeatherParticleSpeed, this.weather.particleSpeed);
      gl.uniform1f(pass.uniforms.uWeatherParticleDriftX, this.weather.particleDriftX);
      gl.uniform1f(pass.uniforms.uWeatherParticleShape, this.weather.particleShape);
      gl.uniform1f(pass.uniforms.uWeatherParticleSize, this.weather.particleSize);
      gl.uniform1f(pass.uniforms.uWeatherParticleMix, this.weather.particleMix);
      gl.uniform3f(
        pass.uniforms.uWeatherParticleColor,
        this.weather.particleColor[0],
        this.weather.particleColor[1],
        this.weather.particleColor[2],
      );
    }

    if (pass.uniforms.uFlash) {
      gl.uniform1f(pass.uniforms.uFlash, this.flash);
    }

    if (pass.uniforms.uBolt) {
      gl.uniform3f(pass.uniforms.uBolt, this.bolt.x, this.bolt.seed, this.bolt.visible);
    }

    if (pass.uniforms.uTornado) {
      gl.uniform1f(pass.uniforms.uTornado, this.weather.tornado);
      gl.uniform2f(pass.uniforms.uTornadoPos, this.tornadoPos[0], this.tornadoPos[1]);
    }

    if (pass.uniforms.uPrecipAmount) {
      gl.uniform1f(pass.uniforms.uPrecipAmount, this.weather.precipAmount);
      gl.uniform1f(pass.uniforms.uWindSlant, this.weather.particleDriftX);
    }

    if (pass.uniforms.uTrainOffset) {
      gl.uniform2f(pass.uniforms.uTrainOffset, this.train.x, this.train.y);
      gl.uniform1f(pass.uniforms.uTrainScale, this.train.scale);
      gl.uniform1f(pass.uniforms.uSmokeFade, this.train.smokeFade);
      gl.uniform1f(pass.uniforms.uRailFade, this.train.railFade);
    }

    if (setup) setup(pass);
    drawFullscreen(gl);
  }

  dispose() {
    const gl = this.gl;
    for (const pass of [this.skyPass, this.skyStormPass, this.fgPass, this.compositePass, this.compositeWeatherPass, this.brightPass, this.blurPass, this.finalPass, this.finalBurstPass]) {
      gl.deleteProgram(pass.program);
    }
    gl.deleteTexture(this.noiseTexture);
    gl.deleteTexture(this.paletteTexture);
    for (const target of [this.cloudTarget, this.fgTarget, this.sceneTarget, this.bloomA, this.bloomB]) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    gl.deleteVertexArray(this.vao);
  }
}
