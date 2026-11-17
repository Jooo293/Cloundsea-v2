// 天空 + 星点 + 背景云（半分辨率 pass）
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

// 龙卷：把云层采样绕涡心拧起来
uniform float uTornado;
uniform vec2 uTornadoPos;

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

vec4 background(vec2 uv, float t, vec2 warpOffset) {
    for (int i = 0; i < MAX_BG_LAYERS; i++) {
        if (i >= uLayerCount) break;

        vec4 spec = uLayer[i];
        vec2 samplePosition = uv + vec2(t / spec.z + spec.w, 0.0) + warpOffset;

        if (uTornado > 0.001) {
            vec2 d = samplePosition - uTornadoPos;
            float r = length(d) + 1e-4;
            float ang = uTornado * 4.2 * exp(-r * 1.9);
            float c = cos(ang);
            float sn = sin(ang);
            samplePosition = uTornadoPos
                + vec2(c * d.x - sn * d.y, sn * d.x + c * d.y)
                - d / r * 0.09 * uTornado * exp(-r * 2.6);
        }

        float n = fbm(samplePosition, 8);
        n = mix(n, 1.0 - abs(n * 2.0 - 1.0), uRidge);
        float h = (n - 0.5) * spec.y;

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

    vec4 bg = background(uv, t, warpOffset);
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

    // 积墨：用颜色梯度找云带边缘，再用低频噪声做飞白（断续的干笔）
    if (uInkEdge > 0.001) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float raw = length(vec2(dFdx(lum), dFdy(lum))) * uInkGain;
        float edge = smoothstep(0.04, 0.26, raw);
        float dry = smoothstep(0.30, 0.72, fbm(uv * 7.0, 3));
        col = mix(col, uInkColor, edge * uInkEdge * (0.35 + 0.65 * dry));
    }

    fragColor = vec4(col, 1.0);
}
