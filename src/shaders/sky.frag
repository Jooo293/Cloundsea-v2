// 天空 + 星点 + 背景云（半分辨率 pass）
// STORM 变体（cloudsea.js 编译两份）：龙卷挖空/涡旋/漏斗/闪电只在雷暴变体里编译；
// 晴雨雪用精简变体——哪怕分支不走，多出来的代码也会让 Intel 核显帧时 +1~3 ms（寄存器压力）。
// 输出不透明 rgb；城市/列车等前景元素在 composite pass 里叠加。

#define MAX_BG_LAYERS 16
#define MAX_BANDS 4

uniform sampler2D uPalette;
uniform int uLayerCount;
uniform vec4 uLayer[MAX_BG_LAYERS];
uniform vec4 uBandDh[MAX_BG_LAYERS];
uniform int uBandCount[MAX_BG_LAYERS];
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform float uStarDensity;
uniform vec2 uParallax;

// 水墨：积墨边缘
uniform float uInkEdge;
uniform float uInkGain;
uniform vec3 uInkColor;

// 水墨：远山（画在云之后，云会自然遮住山脚）
uniform float uMountainEnabled;
uniform vec3 uMountainNear;
uniform vec3 uMountainFar;

// 极地：极光 + 冰晶
uniform float uAuroraEnabled;
uniform float uAuroraStrength;
uniform vec3 uAuroraColor;
uniform float uIceEnabled;
uniform float uIceStrength;
uniform float uIceScale;
uniform vec3 uIceColor;

// 天气：亮度 / 对比 / 饱和（默认全为 1 时整段跳过，保证 classic 逐像素不变）
uniform float uWeatherActive;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uCloudTime;

// 雨雾：低频薄雾，营造空气湿度
uniform float uMist;

// 龙卷：把云层采样绕涡心拧起来
uniform float uTornado;
uniform vec2 uTornadoPos;

// 闪电：强度 + (落点横向比例, 形状种子, 是否有可见电弧)
uniform float uFlash;
uniform vec3 uBolt;

// 云形态：域扭曲 / 浪尖 / 列车拨云
uniform float uWarp;
uniform float uRidge;
uniform vec2 uCarvePos;
uniform float uCarveRadius;
uniform float uCarveDepth;

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 paletteColor(int index) {
    return texelFetch(uPalette, ivec2(index, 0), 0).rgb;
}

// hit = 命中的云层序号（0 最近）；没命中云为 MAX_BG_LAYERS。龙卷/闪电靠它判断"被哪几层云挡住"
vec4 background(vec2 uv, float t, vec2 warpOffset, float carveDelta, out int hit) {
    hit = MAX_BG_LAYERS;
    for (int i = 0; i < MAX_BG_LAYERS; i++) {
        if (i >= uLayerCount) break;

        vec4 spec = uLayer[i];
        vec2 samplePosition = uv + vec2(t / spec.z + spec.w, 0.0) + warpOffset;

#ifdef STORM
        if (uTornado > 0.001) {
            vec2 d = samplePosition - uTornadoPos;
            float r = length(d) + 1e-4;
            float ang = uTornado * 3.8 * exp(-r * 2.0);
            float c = cos(ang);
            float sn = sin(ang);
            vec2 swirled = vec2(c * d.x - sn * d.y, sn * d.x + c * d.y);
            // 向心拉拽 + 切向拉伸：云被吸进漩涡再甩出去
            samplePosition = uTornadoPos + swirled
                - d / r * 0.10 * uTornado * exp(-r * 2.4)
                + vec2(-d.y, d.x) / r * 0.07 * uTornado * exp(-pow((r - 0.16) * 5.0, 2.0));
        }
#endif

        float n = fbm(samplePosition, 8);
        n = mix(n, 1.0 - abs(n * 2.0 - 1.0), uRidge);
        float h = (n - 0.5) * spec.y;

#ifdef STORM
        // 龙卷挖空（每像素只算一次，见 mainImage）；最近两层云海不挖，留作漏斗底部的前景
        if (i >= 2) h += carveDelta;
#endif

        // 列车拨云：椭圆核下压 + 环状隆起，做出"被排开"的边界
        if (uCarveDepth > 0.0001) {
            vec2 cd = (uv - uCarvePos) * vec2(0.55, 2.2);
            float dist = length(cd);
            h -= smoothstep(uCarveRadius, 0.0, dist) * uCarveDepth;
            h += exp(-pow((dist - uCarveRadius) * 14.0, 2.0)) * uCarveDepth * 0.35;
        }

        vec4 dh = uBandDh[i];
        for (int b = 0; b < MAX_BANDS; b++) {
            if (b >= uBandCount[i]) break;
            if (uv.y < h + spec.x - dh[b]) {
                hit = i;
                return vec4(paletteColor(i * MAX_BANDS + b), 1.0);
            }
        }
    }
    return vec4(0.0);
}

float starField(vec2 uv) {
    vec2 p = uv * 240.0;
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = hash21(cell);
    float bright = step(0.988, h);
    vec2 offset = vec2(hash21(cell + 7.1), hash21(cell + 13.7)) - 0.5;
    float d = length(f - offset * 0.55);
    return bright * smoothstep(0.055, 0.0, d) * (0.35 + 0.65 * h);
}

// 山脊：低频 fbm 给大形，ridged fbm 给尖峰
float mountainMask(vec2 uv, float scale, float base, float height, float seed, float parallax) {
    float x = uv.x * scale + parallax * scale + seed;
    float broad = fbm(vec2(x, seed), 4);
    float ridged = 1.0 - abs(fbm(vec2(x * 2.7, seed + 5.0), 3) * 2.0 - 1.0);
    float ridge = 0.55 * broad + 0.45 * ridged;
    float top = base + height * ridge;
    return step(uv.y, top) * step(0.0, uv.y);
}

vec3 mountains(vec3 sky, vec2 uv) {
    float far = mountainMask(uv, 2.1, 0.52, 0.22, 11.0, uParallax.x * 0.008);
    float near = mountainMask(uv, 1.3, 0.46, 0.28, 4.0, uParallax.x * 0.020);
    sky = mix(sky, uMountainFar, far * 0.85);
    sky = mix(sky, uMountainNear, near);
    return sky;
}

// 极光：三条上下摆动的光带，用 fbm 做竖向流苏（不跑体积 ray march）
vec3 auroraCurtain(vec2 uv, float t) {
    float x = uv.x * 2.2 + t * 0.015;
    float band = 0.0;
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float curve = 0.60 + 0.10 * sin(x * 1.3 + fi * 2.1)
                    + 0.05 * fbm(vec2(x * 0.8 + fi * 9.0, t * 0.04), 3);
        float ribbon = exp(-abs(uv.y - curve) * 24.0);
        float shimmer = 0.40 + 0.60 * fbm(vec2(x * 6.0 + fi * 3.0, t * 0.35 + fi), 3);
        band += ribbon * shimmer;
    }
    return uAuroraColor * band * uAuroraStrength;
}

// 冰晶：Voronoi 边界当晶体棱线，再叠一点闪烁
float voronoiEdge(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = vec2(hash21(n + g), hash21(n + g + 17.3));
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < f1) { f2 = f1; f1 = d; }
            else if (d < f2) { f2 = d; }
        }
    }
    return sqrt(f2) - sqrt(f1);
}

// 取主题调色板里某层云的某条色带（越界时夹到最后一层/最后一条）
vec3 paletteTone(int layer, int band) {
    int l = min(layer, uLayerCount - 1);
    int b = min(band, uBandCount[l] - 1);
    return paletteColor(l * MAX_BANDS + b);
}

// ---------------------------------------------------------------- 龙卷漏斗
// 和云用同一套画法：噪声侵蚀出来的硬轮廓 + 主题调色板里的 4 档色阶，
// 而不是半透明灰色渐变柱。返回 (覆盖 0/1, 色阶 0..3)。
vec2 tornadoFunnel(vec2 uv, float t) {
    vec2 p = uv - uTornadoPos;
    if (abs(p.x) > 0.55 || p.y < -0.08 || p.y > 0.80) return vec2(0.0);

    float hgt = clamp(p.y / 0.72, 0.0, 1.0);
    float grow = smoothstep(0.0, 1.0, uTornado);
    // 中轴：上部被风推向下风侧，整根缓慢蛇形摆动
    float axis = 0.09 * hgt * hgt + 0.020 * sin(p.y * 7.0 - t * 0.08) * (0.35 + hgt);
    float radius = (0.020 + 0.16 * pow(hgt, 2.2)) * grow;
    float x = (p.x - axis) / max(radius, 1e-4);

    // 圆柱展开：角度随时间转动，噪声"绕着柱子转"；带一点螺旋上升
    float theta = asin(clamp(x, -1.0, 1.0));
    float spin = t * 0.18;   // t 是云时间，雷暴下已是 3.2 倍速
    float n = fbm(vec2(theta * 0.8 + spin - p.y * 4.0, p.y * 8.0), 5);
    // 轮廓：越往上侵蚀越强，顶部碎成团块并入云底
    // 边缘再叠一层竖向高频噪声：轮廓是一团团鼓包，而不是两条直线
    float lump = fbm(vec2(theta * 1.3 + spin * 1.2, p.y * 26.0), 3);
    // 侵蚀只作用在外缘（|x| 越大越强），芯部不会被掏空成两只角
    float rim = smoothstep(0.2, 0.9, abs(x));
    float edge = abs(x) + ((n - 0.5) * (0.6 + 0.7 * smoothstep(0.5, 1.0, hgt)) + (lump - 0.5) * 0.55) * rim;
    float cover = step(edge, 1.0) * step(-0.02, p.y) * step(hgt, 0.62 + 0.55 * n);

    // 底部卷起的云裙：贴着云海铺开的扁团
    float sn = fbm(vec2(p.x * 7.0 - t * 0.12, p.y * 10.0), 4);
    float skirtD = length(vec2((p.x - axis) / (0.16 * grow + 1e-4), (p.y - 0.012) / 0.055)) + (sn - 0.5) * 0.9;
    float skirt = step(skirtD, 1.0) * grow;

    // 明暗：光从左上来（圆柱法线 x 分量）+ 沿螺旋拉长的条纹，再量化成 4 档
    float streak = fbm(vec2(theta * 1.6 + spin * 1.4 - p.y * 12.0, p.y * 1.5), 3);
    float shade = 0.50 - 0.38 * x + (streak - 0.5) * 1.1 + 0.30 * hgt;
    float tone = clamp(floor(shade * 4.0), 0.0, 3.0);
    if (cover < 0.5 && skirt > 0.5) tone = clamp(floor((sn + 0.10 - 0.2 * (p.x - axis)) * 3.0), 0.0, 2.0);
    return vec2(max(cover, skirt), tone);
}

vec3 tornadoTone(float tone) {
    // 从主题自己的云层里挑 4 个由暗到亮的色带：暗部 = 近处暗云，亮部 = 远处高云
    if (tone < 0.5) return paletteTone(2, 0);
    if (tone < 1.5) return paletteTone(2, 3);
    if (tone < 2.5) return paletteTone(7, 2);
    return paletteTone(11, 0);
}

// ---------------------------------------------------------------- 闪电
float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

// 一维折线噪声：段内线性插值 → 每段是直线、转折是尖角
vec2 jag(float y, float seed) {
    float i = floor(y);
    float h0 = hash11(i + seed * 17.0);
    float h1 = hash11(i + 1.0 + seed * 17.0);
    return vec2(mix(h0, h1, fract(y)) - 0.5, h1 - h0);   // (值, 对 y 的斜率 / 频率)
}

// 分形折线：4 个倍频叠加，大折 + 小抖（每次落雷 seed 不同，形状不重复）。
// 同时返回斜率——不用再为求导多算两次路径
vec2 boltPath(float y, float seed) {
    vec2 a = jag(y * 5.0, seed) * vec2(0.11, 0.11 * 5.0);
    vec2 b = jag(y * 13.0, seed + 3.1) * vec2(0.045, 0.045 * 13.0);
    vec2 c = jag(y * 31.0, seed + 7.7) * vec2(0.020, 0.020 * 31.0);
    vec2 d = jag(y * 77.0, seed + 1.3) * vec2(0.007, 0.007 * 77.0);
    return a + b + c + d;
}

// 到折线 x = x0 + lean*y + path(y) 的近似距离（按斜率修正，斜段不会变粗）
float boltDist(vec2 uv, float x0, float lean, float seed) {
    vec2 path = boltPath(uv.y, seed);
    float slope = lean + path.y;
    return abs(uv.x - x0 - lean * uv.y - path.x) / sqrt(1.0 + slope * slope);
}

// 返回 (电弧核心, 光晕)；主枝从云顶打进云海，两条分叉。
// 折线最大摆幅约 0.09，再加光晕，离中线 0.15 以外直接跳过
vec2 lightningBolt(vec2 uv, float x0, float seed) {
    const float top = 1.02;
    const float bottom = 0.26;
    if (uv.y < bottom - 0.02 || abs(uv.x - x0) > 0.40) return vec2(0.0);

    float along = clamp((uv.y - bottom) / (top - bottom), 0.0, 1.0);
    float w = 0.0016 + 0.0024 * along;               // 上粗下细
    float core = 0.0;
    float glow = 0.0;
    if (abs(uv.x - x0) < 0.15) {
        float d = boltDist(uv, x0, 0.0, seed);
        core = 1.0 - smoothstep(w * 0.45, w, d);
        glow = exp(-d / (w * 5.0));
    }

    for (int j = 0; j < 2; j++) {
        float fj = float(j);
        float y0 = mix(0.45, 0.85, hash11(seed * 3.7 + fj * 11.0));
        float len = 0.10 + 0.12 * hash11(seed * 5.1 + fj * 7.0);
        float dir = (hash11(seed * 9.3 + fj) < 0.5 ? -1.0 : 1.0) * (0.35 + 0.45 * hash11(seed + fj * 3.0));
        if (uv.y > y0 || uv.y < y0 - len) continue;
        if (abs(uv.x - x0 - (y0 - uv.y) * dir) > 0.24) continue;
        float k = (y0 - uv.y) / len;                  // 0 分叉点 … 1 末端
        float bseed = seed + 20.0 + fj;
        // 分叉：x(y0) 恰好落在主枝上，往下按 dir 斜出去，自带一条更细的抖动
        float bx0 = x0 + boltPath(y0, seed).x - boltPath(y0, bseed).x + y0 * dir;
        float bd = boltDist(uv, bx0, -dir, bseed);
        float bw = w * (0.65 - 0.45 * k);
        float fade = 1.0 - k;
        core = max(core, (1.0 - smoothstep(bw * 0.45, bw, bd)) * fade * 0.85);
        glow = max(glow, exp(-bd / (bw * 5.0)) * fade * 0.7);
    }

    float ends = smoothstep(bottom - 0.02, bottom + 0.06, uv.y);
    return vec2(core, glow) * ends;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.y;
    float t = uCloudTime * 4.0;

    vec3 sky = mix(uSkyBottom, uSkyTop, clamp(uv.y, 0.0, 1.0));
    sky += starField(uv + uParallax * 0.012) * uStarDensity;
    if (uMountainEnabled > 0.5) sky = mountains(sky, uv);

    // 域扭曲：一次低频流场，作用到所有云层的采样位置（每帧只算 2 次 fbm）
    vec2 warpOffset = vec2(0.0);
    if (uWarp > 0.0001) {
        float wa = fbm(uv * 0.55 + vec2(t * 0.06, t * 0.02), 4);
        float wb = fbm(uv * 0.85 - vec2(t * 0.03, 0.0), 4);
        warpOffset = vec2(wa - 0.5, wb - 0.5) * uWarp;
    }

    // 龙卷：中心挖空 + 边缘抬升 + 外围螺旋云臂
    float carveDelta = 0.0;
#ifdef STORM
    if (uTornado > 0.001) {
        vec2 td = (uv - uTornadoPos) * vec2(0.80, 1.0);
        // 半径加一点低频噪声：云墙边缘跟着云块起伏，而不是一个正圆穹顶
        float tr = length(td) + 1e-4 + (fbm(td * 3.0 + vec2(t * 0.03, 0.0), 3) - 0.5) * 0.22;
        // 洞壁要陡：缓坡会让 12 层云的等高线排成一圈圈同心环
        float hole = -(1.0 - smoothstep(0.07, 0.17, tr)) * 1.45;
        float rim = exp(-pow((tr - 0.21) * 8.0, 2.0)) * 0.20;
        // 云臂：角度 + 半径的螺旋相位，随时间旋转；越靠外越弱
        float ang = atan(td.y, td.x);
        float phase = ang * 3.0 + tr * 22.0 - t * 1.4;
        float arms = sin(phase) * 0.5;
        float armMask = smoothstep(0.24, 0.34, tr) * (1.0 - smoothstep(0.46, 0.78, tr));
        carveDelta = (hole + rim + arms * armMask * 0.52) * uTornado;
    }
#endif

    int hit;
    vec4 bg = background(uv, t, warpOffset, carveDelta, hit);

#ifdef STORM
    // 龙卷漏斗：插在第 2 层云之后——最近的两层云海会盖住它的底部
    if (uTornado > 0.001 && hit >= 2) {
        vec2 funnel = tornadoFunnel(uv, t);
        if (funnel.x > 0.5) {
            bg = vec4(tornadoTone(funnel.y), 1.0);
            hit = 2;
        }
    }
#endif

    vec3 col = mix(sky, bg.rgb, bg.a);

    if (uWeatherActive > 0.5) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(lum), col, uSaturation);
        col = (col - 0.5) * uContrast + 0.5;
        col *= uBrightness;
        col = max(col, vec3(0.0));
    }

    // 极光：压在云海之上、只保留画面上部（云把天空盖住时也能看到光带）
    if (uAuroraEnabled > 0.5) {
        col += auroraCurtain(uv + uParallax * 0.006, t) * smoothstep(0.45, 0.85, uv.y);
    }

    // 冰晶：只在高亮云面上叠一层细细的晶体棱线
    if (uIceEnabled > 0.5) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float e = 1.0 - smoothstep(0.0, 0.035, voronoiEdge(uv * uIceScale + vec2(0.0, t * 0.02)));
        e *= smoothstep(0.45, 0.80, lum);
        float twinkle = 0.70 + 0.30 * sin(t * 2.0 + uv.x * 40.0);
        col += uIceColor * e * uIceStrength * twinkle;
    }

#ifdef STORM
    // 闪电：先照亮云（按块色阶化，和云带一样是平涂的台阶），再画电弧；
    // 电弧排在第 3 层云之后，打进云海的那一截会被近处的云吞掉
    if (uFlash > 0.001) {
        float aspect = iResolution.x / iResolution.y;
        float bx = uBolt.x * aspect;
        vec3 cool = vec3(0.62, 0.70, 0.95);

        // 云内的光是横向铺开的一片，边界跟着云块走（噪声扭曲 + 只在云上取色阶）
        vec2 L = vec2(bx, 0.84);
        float wn = fbm(uv * vec2(3.2, 4.5) + uBolt.y * 1.7, 3);
        float dist = length((uv - L) * vec2(0.45, 1.35)) + (wn - 0.5) * 0.75;
        float lit = uFlash * exp(-max(dist, 0.0) * 2.0);
        float litQ = floor(lit * 4.0) / 4.0 * bg.a + lit * 0.25 * (1.0 - bg.a);
        // 滤色叠加：暗云亮得多、亮云亮得少，不会冲成一片白
        col = 1.0 - (1.0 - col) * (1.0 - litQ * 0.62 * vec3(0.82, 0.88, 1.0));
        col += cool * uFlash * 0.04;

        if (uBolt.z > 0.5 && hit >= 3) {
            vec2 b = lightningBolt(uv, bx, uBolt.y);
            float on = smoothstep(0.25, 0.6, uFlash);
            col = mix(col, cool * 1.15 + 0.2, clamp(b.y * 0.6 * on, 0.0, 1.0));
            col = mix(col, vec3(1.0, 0.98, 0.95), b.x * on);
        }
    }
#endif

    // 雨雾：两层低频噪声，缓慢横向流动，随高度略增（贴近云顶更浓）
    if (uMist > 0.001) {
        vec2 mp = vec2(uv.x * 2.2 + t * 0.02, uv.y * 1.4 + t * 0.01);
        float m = fbm(mp, 4) * 0.6 + fbm(mp * 2.7 + 11.0, 3) * 0.4;
        float band = smoothstep(0.22, 0.78, m) * (0.55 + 0.45 * smoothstep(0.0, 0.9, uv.y));
        vec3 mistColor = mix(col, vec3(0.72, 0.78, 0.86), 0.55);
        col = mix(col, mistColor, band * uMist);
    }

    // 积墨：用颜色梯度找云带边缘，再用低频噪声做飞白（断续的干笔）
    if (uInkEdge > 0.001) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float raw = length(vec2(dFdx(lum), dFdy(lum))) * uInkGain;
        float edge = smoothstep(0.04, 0.26, raw);
        float dry = smoothstep(0.30, 0.72, fbm(uv * 7.0, 3));
        col = mix(col, uInkColor, edge * uInkEdge * (0.35 + 0.65 * dry));
    }

    // alpha = 云覆盖率（1 云 / 0 天空），供降水做遮挡
    fragColor = vec4(col, bg.a);
}
