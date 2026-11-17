/**
 * 主题数据（M2）
 *
 * 一个主题 = 云层几何/配色 + 天空 + 列车材质 + 城市 + 粒子 + 后处理强度。
 * 全部是纯数据，切换主题只更新 uniform 与调色板纹理，不重编译 shader。
 *
 * classic 的数值逐条复刻原版（云、列车、桥、烟），并关闭所有新元素
 * （城市/粒子/星点/霓虹/扫描线），因此仍然可以作为回归基线。
 */

const MAX_BG_LAYERS = 16;
const MAX_FG_LAYERS = 4;
const MAX_BANDS = 4;
export const PALETTE_SIZE = 128;
export const FG_PALETTE_OFFSET = 64;

/** 原版背景层：从近（c12）到远（c1），顺序即绘制顺序。 */
export const CLASSIC_BG = [
  { mid: 0.30, disp: 0.9, dist: 10.0, phase: 32.5, dh: [0.14, 0.10, 0.07, 0.00],
    colors: [[0.48, 0.19, 0.20], [0.68, 0.28, 0.19], [0.88, 0.38, 0.24], [0.95, 0.45, 0.30]] },
  { mid: 0.35, disp: 1.0, dist: 15.0, phase: 30.0, dh: [0.04, 0.00],
    colors: [[0.98, 0.76, 0.64], [0.95, 0.80, 0.77]] },
  { mid: 0.35, disp: 3.5, dist: 20.0, phase: 27.5, dh: [0.12, 0.08, 0.04, 0.00],
    colors: [[0.43, 0.32, 0.31], [0.55, 0.42, 0.41], [0.66, 0.42, 0.40], [0.77, 0.48, 0.46]] },
  { mid: 0.45, disp: 2.0, dist: 25.0, phase: 23.0, dh: [0.04, 0.00],
    colors: [[0.98, 0.57, 0.36], [1.00, 0.62, 0.44]] },
  { mid: 0.50, disp: 2.3, dist: 30.0, phase: 20.5, dh: [0.12, 0.08, 0.04, 0.00],
    colors: [[0.41, 0.27, 0.27], [0.53, 0.35, 0.32], [0.80, 0.24, 0.17], [0.99, 0.29, 0.20]] },
  { mid: 0.50, disp: 2.5, dist: 35.0, phase: 18.0, dh: [0.10, 0.05, 0.00],
    colors: [[0.88, 0.38, 0.24], [0.98, 0.42, 0.28], [1.00, 0.48, 0.35]] },
  { mid: 0.60, disp: 2.0, dist: 40.0, phase: 18.0, dh: [0.10, 0.00],
    colors: [[0.95, 0.66, 0.48], [1.00, 0.76, 0.60]] },
  { mid: 0.75, disp: 3.5, dist: 45.0, phase: 15.5, dh: [0.20, 0.15, 0.10, 0.00],
    colors: [[1.00, 0.55, 0.33], [0.98, 0.50, 0.24], [0.90, 0.55, 0.40], [1.00, 0.62, 0.44]] },
  { mid: 0.70, disp: 2.7, dist: 50.0, phase: 12.0, dh: [0.04, 0.00],
    colors: [[0.73, 0.36, 0.30], [0.80, 0.40, 0.34]] },
  { mid: 0.80, disp: 2.7, dist: 60.0, phase: 9.5, dh: [0.10, 0.00],
    colors: [[0.93, 0.58, 0.35], [1.00, 0.76, 0.60]] },
  { mid: 0.90, disp: 3.0, dist: 70.0, phase: 7.0, dh: [0.10, 0.05, 0.00],
    colors: [[0.56, 0.25, 0.22], [0.60, 0.30, 0.27], [0.74, 0.35, 0.30]] },
  { mid: 1.00, disp: 5.0, dist: 100.0, phase: 3.5, dh: [0.10, 0.00],
    colors: [[0.92, 0.85, 0.82], [1.00, 0.94, 0.91]] },
];

/** 原版前景层（最近镜头的一层云，采样 5 次做薄雾）。 */
export const CLASSIC_FG = [
  { mid: -0.10, disp: 1.7, dist: 1.0, phase: 40.0, dh: [0.12, 0.08, 0.04, 0.00],
    colors: [[0.43, 0.32, 0.31], [0.55, 0.42, 0.41], [0.66, 0.42, 0.40], [0.77, 0.48, 0.46]] },
  { mid: 0.05, disp: 1.7, dist: 2.0, phase: 38.0, dh: [0.10, 0.04, 0.00],
    colors: [[0.95, 0.66, 0.48], [0.98, 0.76, 0.64], [0.95, 0.80, 0.77]] },
];

const hexToRgb = (hex) => {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
};

function sampleRamp(stops, t) {
  if (t <= stops[0].at) return stops[0].color;
  for (let i = 1; i < stops.length; i += 1) {
    if (t <= stops[i].at) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a.at) / Math.max(1e-6, b.at - a.at);
      return a.color.map((channel, idx) => channel + (b.color[idx] - channel) * k);
    }
  }
  return stops[stops.length - 1].color;
}

function rampTheme({ id, name, sky, fgFallback, stops, fgStops, layerCount = CLASSIC_BG.length }) {
  const depthOf = (i, b, bands) => {
    const layerT = layerCount <= 1 ? 0 : i / (layerCount - 1);
    const bandT = bands <= 1 ? 0 : b / (bands - 1);
    return Math.min(1, layerT * 0.82 + bandT * 0.18);
  };

  const bg = CLASSIC_BG.slice(0, layerCount).map((spec, i) => ({
    mid: spec.mid,
    disp: spec.disp,
    dist: spec.dist,
    phase: spec.phase,
    dh: spec.dh,
    colors: spec.dh.map((_, b) => sampleRamp(stops, depthOf(i, b, spec.dh.length))),
  }));

  const fg = CLASSIC_FG.map((spec) => ({
    mid: spec.mid,
    disp: spec.disp,
    dist: spec.dist,
    phase: spec.phase,
    dh: spec.dh,
    colors: spec.dh.map((_, b) => sampleRamp(fgStops, spec.dh.length <= 1 ? 0 : b / (spec.dh.length - 1))),
  }));

  return { id, name, bg, fg, sky, fgFallback };
}

// ---------------------------------------------------------------- 经典（回归基线）

const classic = {
  id: "classic",
  name: "原版暖霞",
  bg: CLASSIC_BG,
  fg: CLASSIC_FG,
  sky: { top: [0.58, 0.70, 1.00], bottom: [0.58, 0.70, 1.00], stars: 0 },
  fgFallback: [0.95, 0.80, 0.77],
  train: {
    body: [0.48, 0.19, 0.20],
    roof: [0.18, 0.12, 0.15],
    trim: [0.38, 0.19, 0.20],
    emissive: [0.0, 0.0, 0.0],
    energy: 0,
    smokeA: [1.00, 0.94, 0.91],
    smokeB: [0.92, 0.85, 0.82],
    smokeStrength: 1,
    bridge: [0.29, 0.09, 0.08],
  },
  city: { on: 0, color: [0, 0, 0], window: [0, 0, 0] },
  particles: { color: [0, 0, 0], density: 0, speed: 1 },
  cloud: { warp: 0, ridge: 0, carve: 0 },   // 经典主题：云形态保持原版
  post: { scanline: 0 },
};

// ---------------------------------------------------------------- 赛博霓虹

const cyber = {
  ...rampTheme({
    id: "cyber",
    name: "赛博霓虹",
    sky: { top: hexToRgb("#05020f"), bottom: hexToRgb("#2b0736"), stars: 0.55 },
    fgFallback: hexToRgb("#22103a"),
    stops: [
      { at: 0.0, color: hexToRgb("#24072e") },
      { at: 0.35, color: hexToRgb("#47125c") },
      { at: 0.55, color: hexToRgb("#1b2a6e") },
      { at: 0.75, color: hexToRgb("#27679f") },
      { at: 1.0, color: hexToRgb("#6fb3cf") },
    ],
    fgStops: [
      { at: 0.0, color: hexToRgb("#170826") },
      { at: 1.0, color: hexToRgb("#6a2a93") },
    ],
  }),
  train: {
    body: hexToRgb("#7d8798"),
    roof: hexToRgb("#3d4552"),
    trim: hexToRgb("#5d7f9c"),
    emissive: hexToRgb("#4fe6ff"),
    energy: 1.6,
    smokeA: hexToRgb("#c3d2e4"),
    smokeB: hexToRgb("#9fb4c9"),
    smokeStrength: 0.55,
    bridge: hexToRgb("#221a2e"),
  },
  city: { on: 1, color: hexToRgb("#06040e"), window: hexToRgb("#5fd8f5") },
  particles: { color: hexToRgb("#8fdcff"), density: 0.5, speed: 1 },
  cloud: { warp: 0.12, ridge: 0.15, carve: 0.10 },
  post: { scanline: 0.22, bloom: 0.95, threshold: 0.55 },
};

// ---------------------------------------------------------------- 废墟（原水墨）

const ruins = {
  ...rampTheme({
    id: "ruins",
    name: "废墟",
    sky: { top: hexToRgb("#e9e0d2"), bottom: hexToRgb("#cfc4b2"), stars: 0 },
    fgFallback: hexToRgb("#cfc4b2"),
    stops: [
      { at: 0.0, color: hexToRgb("#3b342e") },
      { at: 0.4, color: hexToRgb("#6f645a") },
      { at: 0.75, color: hexToRgb("#b5a999") },
      { at: 1.0, color: hexToRgb("#efe6d8") },
    ],
    fgStops: [
      { at: 0.0, color: hexToRgb("#4a4239") },
      { at: 1.0, color: hexToRgb("#a89c8c") },
    ],
  }),
  train: {
    body: hexToRgb("#4a423a"),
    roof: hexToRgb("#2a2622"),
    trim: hexToRgb("#6b5f52"),
    emissive: [0, 0, 0],
    energy: 0,
    smokeA: hexToRgb("#eef1f0"),
    smokeB: hexToRgb("#c9d2d0"),
    smokeStrength: 0.85,
    bridge: hexToRgb("#3a3833"),
    grain: 0.75,
  },
  city: { on: 0, color: [0, 0, 0], window: [0, 0, 0] },
  particles: { color: [0, 0, 0], density: 0, speed: 1 },
  // 水墨专属：积墨边缘 + 宣纸 + 远山 + 仙鹤
  ink: { edge: 0.7, gain: 12, color: hexToRgb("#242a2b") },
  paper: 0.35,
  mountains: {
    on: 1,
    near: hexToRgb("#7a7066"),
    far: hexToRgb("#b3a89a"),
    parallax: 1,
  },
  cranes: { on: 1, color: hexToRgb("#333b3c"), count: 2 },
  cloud: { warp: 0.18, ridge: 0.30, carve: 0.08 },
  post: { scanline: 0, bloom: 0, threshold: 0.8 },
};

// ---------------------------------------------------------------- 极地冰雪

const polar = {
  ...rampTheme({
    id: "polar",
    name: "极地",
    sky: { top: hexToRgb("#04101d"), bottom: hexToRgb("#3d5f7c"), stars: 0.45 },
    fgFallback: hexToRgb("#cfe3f2"),
    stops: [
      { at: 0.0, color: hexToRgb("#16304a") },
      { at: 0.45, color: hexToRgb("#4f7896") },
      { at: 0.75, color: hexToRgb("#9dc0d8") },
      { at: 1.0, color: hexToRgb("#e6f5ff") },
    ],
    fgStops: [
      { at: 0.0, color: hexToRgb("#6f8ba6") },
      { at: 1.0, color: hexToRgb("#d7e9f5") },
    ],
  }),
  train: {
    body: hexToRgb("#8fa6bb"),
    roof: hexToRgb("#6d8399"),
    trim: hexToRgb("#4c6377"),
    emissive: hexToRgb("#bfe9ff"),
    energy: 0.6,
    smokeA: hexToRgb("#f4fbff"),
    smokeB: hexToRgb("#dcecf7"),
    smokeStrength: 0.9,
    bridge: hexToRgb("#3a4f63"),
    snow: 0.8,
  },
  city: { on: 0, color: [0, 0, 0], window: [0, 0, 0] },
  particles: { color: hexToRgb("#eaf8ff"), density: 0.55, speed: 0.6 },
  ice: { on: 1, strength: 0.18, scale: 22, color: hexToRgb("#e6f7ff") },
  aurora: { on: 1, strength: 0.7, color: hexToRgb("#22d98a") },
  cloud: { warp: 0.10, ridge: 0.12, carve: 0.09 },
  post: { scanline: 0, bloom: 0.25, threshold: 0.62 },
};

export const THEMES = { classic, cyber, ruins, polar };
THEMES.ink = ruins; // 兼容旧链接/旧设置
export const THEME_ORDER = ["classic", "cyber", "ruins", "polar"];

/** 把主题打成 GPU 需要的 uniform 数据（数组 + 标量 + 调色板纹理）。 */
export function buildThemeUniforms(theme) {
  const layers = new Float32Array(MAX_BG_LAYERS * 4);
  const bandDh = new Float32Array(MAX_BG_LAYERS * 4);
  const bandCount = new Int32Array(MAX_BG_LAYERS);
  const fgLayers = new Float32Array(MAX_FG_LAYERS * 4);
  const fgBandDh = new Float32Array(MAX_FG_LAYERS * 4);
  const fgBandCount = new Int32Array(MAX_FG_LAYERS);
  const palette = new Float32Array(PALETTE_SIZE * 4);

  const writeLayer = (target, offset, spec) => {
    target[offset] = spec.mid;
    target[offset + 1] = spec.disp;
    target[offset + 2] = spec.dist;
    target[offset + 3] = spec.phase;
  };

  const writeBands = (dhTarget, countTarget, paletteBase, spec, layerIndex) => {
    const count = Math.min(spec.dh.length, MAX_BANDS);
    countTarget[layerIndex] = count;
    for (let b = 0; b < count; b += 1) {
      dhTarget[layerIndex * 4 + b] = spec.dh[b];
      const texel = (paletteBase + layerIndex * MAX_BANDS + b) * 4;
      const color = spec.colors[b] || spec.colors[spec.colors.length - 1];
      palette[texel] = color[0];
      palette[texel + 1] = color[1];
      palette[texel + 2] = color[2];
      palette[texel + 3] = 1;
    }
  };

  theme.bg.forEach((spec, i) => {
    writeLayer(layers, i * 4, spec);
    writeBands(bandDh, bandCount, 0, spec, i);
  });
  theme.fg.forEach((spec, i) => {
    writeLayer(fgLayers, i * 4, spec);
    writeBands(fgBandDh, fgBandCount, FG_PALETTE_OFFSET, spec, i);
  });

  return {
    layerCount: theme.bg.length,
    fgCount: theme.fg.length,
    layers,
    bandDh,
    bandCount,
    fgLayers,
    fgBandDh,
    fgBandCount,
    palette,
    fgFallback: new Float32Array(theme.fgFallback),
    skyTop: new Float32Array(theme.sky.top),
    skyBottom: new Float32Array(theme.sky.bottom),
    starDensity: theme.sky.stars,
    train: theme.train,
    city: theme.city,
    particles: theme.particles,
    scanline: theme.post.scanline,
    bloom: theme.post.bloom ?? 0,
    bloomThreshold: theme.post.threshold ?? 0.7,
    smokeStrength: theme.train.smokeStrength ?? 1,
    grain: theme.train.grain ?? 0,
    snow: theme.train.snow ?? 0,
    paper: theme.paper ?? 0,
    ice: theme.ice ?? { on: 0, strength: 0, scale: 26, color: [0, 0, 0] },
    aurora: theme.aurora ?? { on: 0, strength: 0, color: [0, 0, 0] },
    cloud: theme.cloud ?? { warp: 0, ridge: 0, carve: 0 },
    ink: theme.ink ?? { edge: 0, gain: 20, color: [0, 0, 0] },
    cloud: theme.cloud ?? { warp: 0, ridge: 0, carve: 0 },
    mountains: theme.mountains ?? { on: 0, near: [0, 0, 0], far: [0, 0, 0] },
    cranes: theme.cranes ?? { on: 0, color: [0, 0, 0] },
  };
}
