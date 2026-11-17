import { Clock } from "./engine/clock.js";
import { CloudSeaRenderer } from "./scene/cloudsea.js";
import { THEMES, THEME_ORDER } from "./themes/theme.js";
import { WeatherSystem, WEATHER_PRESETS } from "./systems/weather.js";
import { TrainSystem } from "./systems/train.js";

/**
 * M0–M6 入口：一块画布 + 一条时间轴 + 一个渲染器 + 天气系统。
 *
 * URL 参数：
 *   ?theme=classic|cyber|ink|polar   主题
 *   ?weather=sunny|overcast|storm    天气（直接以该状态启动，不做过渡）
 *   ?freeze=1&t=12.5                 冻结时间，确定性渲染
 *   ?bench=60&w=1920&h=1080          同步渲染 60 帧并量平均帧时
 *   ?report=1                        把 bench 结果 POST 给 tools/bench-server.py
 *   ?quality=0.5|1|2                 画质档位（决定云层渲染倍率）
 *   ?cloudscale=0.5|0.75|1           直接指定云层渲染倍率
 *   ?carve=N                         把"列车拨云"强度放大 N 倍（调试）
 *   ?flash=0.8                       强制闪电亮度（截雷暴用）
 */

const params = new URLSearchParams(location.search);

const canvas = document.querySelector("#gl");
const statusEl = document.querySelector("#status");
const timeEl = document.querySelector("#time");
const fpsEl = document.querySelector("#fps");
const pauseButton = document.querySelector("#pause");
const resetButton = document.querySelector("#reset");
const qualitySelect = document.querySelector("#quality");
const themeSelect = document.querySelector("#theme");
const weatherSelect = document.querySelector("#weather");
const speedInput = document.querySelector("#speed");
const benchEl = document.querySelector("#bench");

const qualityParam = Number(params.get("quality"));
if ([0.5, 1, 2].includes(qualityParam)) qualitySelect.value = String(qualityParam);

// 画质 → 云层渲染倍率（云是最贵的一步，列车/城市始终全分辨率）
const CLOUD_SCALE_BY_QUALITY = { 0.5: 0.5, 1: 0.75, 2: 1 };
const cloudScaleOverride = Number(params.get("cloudscale")) || 0;
// 自适应倍率："自动"档按实测帧时在 0.5–0.85 之间调节
let adaptiveScale = 0.75;
let frameCostAvg = 16;
const isAutoQuality = () => qualitySelect.value === "auto";
const cloudScaleFor = () =>
  cloudScaleOverride > 0
    ? cloudScaleOverride
    : isAutoQuality()
      ? adaptiveScale
      : (CLOUD_SCALE_BY_QUALITY[Number(qualitySelect.value)] ?? 0.75);

// 设置持久化：主题 / 天气 / 画质
const SETTINGS_KEY = "cloudsea-settings-v1";
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {};
  } catch {
    return {};
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      theme: themeSelect.value,
      weather: weatherSelect.value,
      quality: qualitySelect.value,
    }));
  } catch {}
}

for (const id of THEME_ORDER) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = THEMES[id].name;
  themeSelect.append(option);
}
const savedSettings = loadSettings();
if (!params.get("quality") && savedSettings.quality && [...qualitySelect.options].some((o) => o.value === savedSettings.quality)) {
  qualitySelect.value = savedSettings.quality;
}
const themeParam = params.get("theme");
if (themeParam && THEMES[themeParam]) themeSelect.value = themeParam;
else if (savedSettings.theme && THEMES[savedSettings.theme]) themeSelect.value = savedSettings.theme;

const weatherParam = params.get("weather");
if (weatherParam && WEATHER_PRESETS[weatherParam]) weatherSelect.value = weatherParam;
else if (savedSettings.weather && WEATHER_PRESETS[savedSettings.weather]) weatherSelect.value = savedSettings.weather;

const weather = new WeatherSystem(weatherSelect.value);
const forcedFlash = Number(params.get("flash") || 0) || 0;
const train = new TrainSystem();

// ?train=0.25,0.2 → 直接停在飞行姿态（截图/调试用）
const trainParam = params.get("train");
if (trainParam) {
  const [tx, ty] = trainParam.split(",").map((v) => Number(v) || 0);
  train.mode = "flying";
  train.offset = { x: tx, y: ty };
  train.scale = 1.5;
}
// ?charge=0.6 → 停在蓄力状态（截图蓄力条用）
const chargeParam = Number(params.get("charge") || 0);
if (chargeParam > 0) {
  train.mode = "charging";
  train.charge = Math.min(1, chargeParam);
}

const stage = document.querySelector("#stage");
const chargeEl = document.querySelector("#charge");
const chargeFill = document.querySelector("#charge-fill");
const trainHint = document.querySelector("#train-hint");

const clock = new Clock({
  frozen: params.get("freeze") === "1",
  start: Number(params.get("t") || 0) || 0,
});
clock.rate = Number(speedInput.value) || 1;

let renderer = null;
let frameHandle = 0;
let fpsFrames = 0;
let fpsSince = 0;
let lastElapsed = clock.elapsed;
let cloudTime = clock.elapsed;
let pointerTarget = null;
let lastPointerAt = -Infinity;

const TRAIN_HINTS = {
  rail: "长按画面蓄力，松开让列车离开轨道",
  charging: "蓄力中… 松开起飞",
  flying: "拖动引导列车 · 停手 10 秒自动回轨",
  docking: "正在回到轨道…",
};

function updateTrainHud() {
  trainHint.textContent = TRAIN_HINTS[train.mode] || TRAIN_HINTS.rail;
  if (train.mode === "charging") {
    chargeEl.hidden = false;
    chargeFill.style.width = `${Math.round(train.charge * 100)}%`;
  } else if (!chargeEl.hidden) {
    chargeEl.hidden = true;
  }
}

// 指针视差：只喂给星点/城市/粒子，不改变云层速度（截图时为 0）
const parallaxTarget = [0, 0];
const parallax = [0, 0];
window.addEventListener("pointermove", (event) => {
  parallaxTarget[0] = (event.clientX / window.innerWidth) * 2 - 1;
  parallaxTarget[1] = (event.clientY / window.innerHeight) * 2 - 1;
});

// ---- 列车操控 ----
stage.addEventListener("pointerdown", (event) => {
  if (train.mode !== "rail") return;
  train.startCharge();
  stage.setPointerCapture?.(event.pointerId);
});
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    if (type === "pointercancel") train.cancelCharge();
    else train.release();
  });
}
stage.addEventListener("pointermove", (event) => {
  if (train.mode !== "flying") return;
  const rect = canvas.getBoundingClientRect();
  const uvX = (event.clientX - rect.left) / rect.height;
  const uvY = (rect.bottom - event.clientY) / rect.height;
  pointerTarget = { x: uvX - 0.25, y: uvY - 0.31 };
  lastPointerAt = performance.now();
});

function targetSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = dpr * (Number(qualitySelect.value) || 1);
  return {
    width: Math.max(1, Math.min(3840, Math.floor(canvas.clientWidth * scale))),
    height: Math.max(1, Math.min(2160, Math.floor(canvas.clientHeight * scale))),
  };
}

function updatePauseLabel() {
  pauseButton.textContent = clock.paused ? "继续" : "暂停";
  pauseButton.setAttribute("aria-pressed", String(clock.paused));
}

function togglePause() {
  clock.paused = !clock.paused;
  updatePauseLabel();
}

function reset() {
  clock.reset(0);
  lastElapsed = 0;
  cloudTime = 0;
  benchEl.textContent = "";
}

function publishBench(result) {
  benchEl.textContent = JSON.stringify(result);
  document.title = `bench ${result.avgMs}ms`;
  console.log("[bench]", result);

  if (params.has("report")) {
    // text/plain 让浏览器把它当简单请求，避免 CORS 预检
    fetch("http://127.0.0.1:8790/bench", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(result),
    }).catch(() => {});
  }
}

/**
 * 同步 bench：连续 render + 1 像素回读，测的是"提交并跑完 N 帧"的真实耗时。
 * 不用 rAF，所以无头环境与 virtual-time 都不会影响结果；
 * 回读比 gl.finish() 可靠——finish 在部分后端会直接返回，量不到 GPU 时间。
 */
function runBench(frames) {
  const gl = renderer.gl;
  const fixedWidth = Number(params.get("w") || 0);
  const fixedHeight = Number(params.get("h") || 0);
  const fromLayout = targetSize();
  const width = fixedWidth > 0 ? fixedWidth : fromLayout.width;
  const height = fixedHeight > 0 ? fixedHeight : fromLayout.height;
  canvas.width = width;
  canvas.height = height;

  const pixel = new Uint8Array(4);
  const settle = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

  for (let i = 0; i < 3; i += 1) renderer.render(0, width, height); // 预热
  settle();

  const started = performance.now();
  for (let i = 0; i < frames; i += 1) {
    renderer.render(i / 60, width, height);
    settle();
  }
  const avgMs = (performance.now() - started) / frames;

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = debugInfo
    ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);

  publishBench({
    frames,
    avgMs: Number(avgMs.toFixed(2)),
    width,
    height,
    quality: Number(qualitySelect.value),
    dpr: Number((window.devicePixelRatio || 1).toFixed(2)),
    theme: themeSelect.value,
    weather: weatherSelect.value,
    renderer: String(rendererName).slice(0, 120),
  });
}

function frame(now) {
  frameHandle = requestAnimationFrame(frame);
  const time = clock.advance(now);
  const dt = Math.max(0, time - lastElapsed);
  lastElapsed = time;

  // 天气：参数在 8 秒内插值；风速只影响云层漂移，不影响 UI 时间
  const weatherNow = weather.update(dt);
  if (Math.abs(weatherNow.wind - 1) < 1e-4) cloudTime = time;
  else cloudTime += dt * weatherNow.wind;

  const { width, height } = targetSize();
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const started = performance.now();
  parallax[0] += (parallaxTarget[0] - parallax[0]) * 0.06;
  parallax[1] += (parallaxTarget[1] - parallax[1]) * 0.06;
  renderer.setParallax(parallax[0], parallax[1]);
  renderer.setCloudTime(cloudTime);
  renderer.setWeather({
    active: weather.isDefault ? 0 : 1,
    brightness: weatherNow.brightness,
    contrast: weatherNow.contrast,
    saturation: weatherNow.saturation,
    particleMul: weatherNow.particleMul,
    particleDir: weatherNow.particleDir,
    particleSpeed: weatherNow.particleSpeed,
    particleDriftX: weatherNow.particleDriftX,
    particleShape: weatherNow.particleShape,
    particleSize: weatherNow.particleSize,
    particleMix: weatherNow.particleMix,
    particleColor: weatherNow.particleColor,
    precipType: weatherNow.precipType,
    precipAmount: weatherNow.precipAmount,
    tornado: weatherNow.tornado,
  });
  renderer.setFlash(forcedFlash > 0 ? forcedFlash : weather.flashIntensity(dt));
  // 列车：停手 1.2 秒后视为"没有输入"，10 秒无输入自动回轨
  if (now - lastPointerAt > 1200) pointerTarget = null;
  train.update(dt, pointerTarget, width / height);
  renderer.setTrainFrame({
    x: train.offset.x,
    y: train.offset.y,
    scale: train.scale,
    smokeFade: train.smokeFade,
    railFade: train.railFade,
  });
  renderer.setCarve(0.225 + train.offset.x, 0.315 + train.offset.y, 0.13);
  updateTrainHud();
  renderer.render(time, width, height);
  const cost = performance.now() - started;

  // 自动画质：按平滑后的帧时调节云层倍率
  if (isAutoQuality() && cloudScaleOverride === 0) {
    frameCostAvg = frameCostAvg * 0.92 + cost * 0.08;
    if (frameCostAvg > 20 && adaptiveScale > 0.5) {
      adaptiveScale = Math.max(0.5, adaptiveScale - 0.05);
      renderer.setCloudScale(adaptiveScale);
    } else if (frameCostAvg < 11 && adaptiveScale < 0.85) {
      adaptiveScale = Math.min(0.85, adaptiveScale + 0.02);
      renderer.setCloudScale(adaptiveScale);
    }
  }

  fpsFrames += 1;
  if (now - fpsSince >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsEl.textContent = `${fps} fps · ${cost.toFixed(1)} ms`;
    fpsFrames = 0;
    fpsSince = now;
  }
  timeEl.textContent = clock.display;
}

async function boot() {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) throw new Error("无法启用 WebGL 2。请使用支持 WebGL 2 的浏览器并开启图形加速。");

  renderer = await CloudSeaRenderer.create(gl, { cloudScale: cloudScaleFor() });
  renderer.setCarveBoost(Number(params.get("carve") || 1) || 1);
  renderer.setTheme(THEMES[themeSelect.value] || THEMES.classic);
  gl.clearColor(0.1, 0.06, 0.08, 1);

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    statusEl.hidden = false;
    statusEl.textContent = "图形连接暂时中断，恢复后将重新加载。";
  });
  canvas.addEventListener("webglcontextrestored", () => location.reload());

  statusEl.hidden = true;

  const benchFrames = Number(params.get("bench") || 0) || 0;
  if (benchFrames > 0) {
    runBench(benchFrames);
    return; // bench 模式不启动 rAF，避免两套时间轴互相干扰
  }

  fpsSince = performance.now();
  frameHandle = requestAnimationFrame(frame);
}

function fail(error) {
  console.error(error);
  statusEl.hidden = false;
  statusEl.textContent = error instanceof Error ? error.message : String(error);
}

pauseButton.addEventListener("click", togglePause);
resetButton.addEventListener("click", reset);
qualitySelect.addEventListener("change", () => {
  const { width, height } = targetSize();
  canvas.width = width;
  canvas.height = height;
  if (renderer) renderer.setCloudScale(cloudScaleFor());
  saveSettings();
});
themeSelect.addEventListener("change", () => {
  const theme = THEMES[themeSelect.value];
  if (theme && renderer) renderer.setTheme(theme);
  saveSettings();
});
weatherSelect.addEventListener("change", () => {
  weather.setTarget(weatherSelect.value);
  saveSettings();
});
speedInput.addEventListener("input", () => {
  clock.rate = Number(speedInput.value) || 0;
  document.querySelector("#speed-value").textContent = `${clock.rate.toFixed(2)}×`;
});
document.querySelector("#full").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.querySelector("#stage").requestFullscreen().catch(() => {});
});
document.addEventListener("keydown", (event) => {
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePause();
  } else if (event.key.toLowerCase() === "r") {
    reset();
  } else if (event.key.toLowerCase() === "f") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.querySelector("#stage").requestFullscreen().catch(() => {});
  }
});
document.addEventListener("visibilitychange", () => {
  clock.last = null;
});

updatePauseLabel();
boot().catch(fail);
