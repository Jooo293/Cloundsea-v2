// 合成 pass（全分辨率）：半分辨率云图 + 城市剪影 + 列车 + 烟 + 桥 + 前景云 + 粒子
// iChannel0 = 天空/背景云，iChannel1 = 前景云（带 alpha）
// WEATHER 变体（cloudsea.js 编译两份）：降水与龙卷碎屑只在有天气时编译，晴天不为它们付寄存器压力

uniform vec3 uTrainBody;
uniform vec3 uTrainRoof;
uniform vec3 uTrainTrim;
uniform vec3 uTrainEmissive;
uniform float uEmissiveEnergy;
uniform vec3 uSmokeA;
uniform vec3 uSmokeB;
uniform float uSmokeStrength;
uniform vec3 uBridgeColor;

uniform float uCityEnabled;
uniform vec3 uCityColor;
uniform vec3 uCityWindow;

uniform vec3 uParticleColor;
uniform float uParticleDensity;
uniform float uParticleSpeed;
uniform float uWeatherParticleMul;
uniform float uParticleDir;
uniform float uWeatherParticleSpeed;
uniform float uWeatherParticleDriftX;
uniform float uWeatherParticleShape;
uniform float uWeatherParticleSize;
uniform float uWeatherParticleMix;
uniform vec3 uWeatherParticleColor;

// 降水与龙卷
uniform float uFlash;        // 闪电强度，用来照亮雨丝
uniform float uPrecipAmount;
uniform float uWindSlant;
uniform float uTornado;
uniform vec2 uTornadoPos;

uniform vec2 uParallax;
uniform float uScanline;

// 列车操控：位移 / 烟淡出 / 轨道淡出
uniform vec2 uTrainOffset;
uniform float uTrainScale;
uniform float uSmokeFade;
uniform float uRailFade;

// 国风：车厢木纹 + 仙鹤
uniform float uTrainGrain;
uniform float uCraneEnabled;
uniform vec3 uCraneColor;

// 极地：车顶积雪
uniform float uSnowCover;
uniform vec3 uSnowColor;

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// 城市：每层就是一列"楼"，楼高按列哈希；窗光细分到每栋楼 4 列。
vec2 cityLayer(vec2 uv, float cells, float baseY, float height, float seed, float parallax) {
    vec2 p = vec2(uv.x * cells + parallax * cells, uv.y - baseY);
    float column = floor(p.x);
    float hh = hash21(vec2(column, seed));
    float h = height * (0.12 + 0.88 * hh * hh);
    float gap = step(0.18, hash21(vec2(column, seed + 4.7)));
    float body = step(0.0, p.y) * step(p.y, h) * gap;

    vec2 w = vec2(fract(p.x) * 4.0, p.y * 26.0);
    float cellHash = hash21(vec2(column * 4.0 + floor(w.x), floor(w.y)) + seed);
    float win = step(0.52, cellHash);
    win *= step(0.22, fract(w.x)) * step(fract(w.x), 0.78);
    win *= step(0.30, fract(w.y)) * step(fract(w.y), 0.74);
    return vec2(body, body * win);
}

vec3 cityComposite(vec3 col, vec2 uv) {
    vec2 far = cityLayer(uv, 34.0, 0.42, 0.10, 11.3, uParallax.x * 0.010);
    vec2 mid = cityLayer(uv, 22.0, 0.38, 0.13, 7.7, uParallax.x * 0.020);
    vec2 near = cityLayer(uv, 14.0, 0.34, 0.16, 3.1, uParallax.x * 0.035);

    float mask = max(near.x, max(mid.x * 0.92, far.x * 0.78));
    float win = max(near.y, max(mid.y * 0.8, far.y * 0.55));

    vec3 outCol = mix(col, uCityColor, mask);
    outCol += uCityWindow * win * 0.42;
    outCol += uCityWindow * mask * 0.035;
    return outCol;
}

// 暴雨：不画"白线"，而是让背景沿雨丝方向被轻微提亮（像镜头前的动态模糊）。
// 远层细密、几乎成纹理；近层稀疏、更宽更虚；疏密由低频"雨幕"控制（阵雨一片片扫过）。
// 返回 (雨丝强度, 雨幕浓度)
vec2 rainField(vec2 uv, float t, float slant) {
    // 雨幕：沿风向斜切的低频噪声，快速下扫
    float sheer = slant * 0.10;
    float s = uv.x + uv.y * sheer;
    float curtain = fbm(vec2(s * 2.0 + t * 0.10 * slant, uv.y * 0.7 + t * 1.1), 3);
    float gust = smoothstep(0.32, 0.72, curtain);

    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
        float k = float(i);                           // 0 远 … 2 近
        float cells = 90.0 / (1.0 + k * 1.3);         // 远层格子密
        float layerSheer = sheer * (0.8 + k * 0.25);  // 每层斜率略有不同，避免完全平行
        float speed = 1.6 + k * 1.1;                  // 近层更快
        vec2 p = vec2((uv.x + uv.y * layerSheer) * cells,
                      (uv.y + t * speed) * cells * 0.16);
        vec2 cell = floor(p);
        vec2 f = fract(p);

        float h = hash21(cell + k * 7.0);
        float h2 = hash21(cell + k * 7.0 + 11.3);
        float alive = step(h, mix(0.10, 0.55, gust) * (1.0 - k * 0.22));

        // 长度随机，头（下端）略亮，两端渐隐
        float len = 0.45 + 0.50 * h2;
        float y0 = h * (1.0 - len);
        float a = (f.y - y0) / len;                   // 0 下端 … 1 上端
        float along = smoothstep(0.0, 0.15, a) * (1.0 - smoothstep(0.35, 1.0, a));

        // 横向：远层 ~1px 实线，近层宽而虚（越近越"糊"）
        float x0 = 0.2 + 0.6 * h2;
        float across = abs(f.x - x0) / cells;         // 回到 uv 单位
        float width = 0.0006 + 0.0006 * k;
        float streak = exp(-across * across / (width * width));

        acc += alive * along * streak * (0.55 + 0.25 * k);
    }
    return vec2(acc, gust);
}

// 龙卷碎屑：软边圆点，按格哈希随机偏移与相位（不再是整格亮灭的方块阵）
float tornadoDebris(vec2 uv, vec2 c, float t) {
    float acc = 0.0;
    vec2 p = (uv - c) * vec2(0.8, 1.0);
    for (int i = 0; i < 3; i++) {
        float k = float(i);
        float count = 24.0 + k * 18.0;
        vec2 q = p * count;
        vec2 id = floor(q);
        vec2 f = fract(q) - 0.5;

        float h1 = hash21(id + k * 31.0);
        float h2 = hash21(id + k * 17.0 + 5.3);
        float h3 = hash21(id + k * 23.0 + 9.1);
        float alive = step(0.62, h1);

        // 每颗在格内绕小圈漂移，半径随时间伸缩（被甩出去又卷回来）
        // 统一角速度（同一旋转方向），只有相位差
        float ang = t * 1.15 + h1 * 6.2831;
        float orbit = 0.12 + 0.20 * h2 + 0.08 * sin(t * 0.9 + h1 * 6.28);
        vec2 offset = vec2(cos(ang), sin(ang)) * orbit;

        float d = length(f - offset);
        float size = 0.045 + 0.05 * h2;
        // 只保留漏斗附近的碎屑
        // 只在漏斗下半段附近：被卷起来的东西贴着柱子转，不铺满整片天
        float nearFunnel = 1.0 - smoothstep(0.04, 0.20, length((p - vec2(0.0, 0.09)) * vec2(1.0, 0.55)));
        acc += alive * (1.0 - smoothstep(0.0, size, d)) * (0.35 + 0.65 * h2) * nearFunnel;
    }
    return acc;
}

float particleField(vec2 uv, float t) {
    vec2 p = vec2(uv.x * 20.0 + t * uWeatherParticleDriftX, uv.y * 11.0 - t * 0.5 * uParticleDir * uWeatherParticleSpeed);
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    float h = hash21(cell);
    float alive = step(0.93, h);
    vec2 offset = vec2((h - 0.5) * 0.5, 0.0);
    vec2 aniso = mix(vec2(7.0, 2.4), vec2(1.5, 1.5), uWeatherParticleShape);
    float d = length((f - offset) * aniso);
    float twinkle = 0.45 + 0.55 * sin(t * 2.0 + h * 40.0);
    return alive * smoothstep(0.30 * uWeatherParticleSize, 0.0, d) * twinkle;
}

// 仙鹤：一只振翅的 V 形 + 一点身体，远看就是水墨里的飞鸟
float craneField(vec2 uv, float t) {
    float acc = 0.0;
    for (int i = 0; i < 2; i++) {
        float fi = float(i);
        vec2 center = vec2(0.16 + 0.62 * fract(t * 0.005 + fi * 0.51),
                           0.70 + 0.04 * sin(t * 0.32 + fi * 2.1));
        vec2 p = (uv - center) * vec2(1.0, 1.8);
        float flap = sin(t * 4.5 + fi * 1.7);
        float wing = smoothstep(0.007, 0.0, abs(p.y - (0.05 + 0.13 * flap) * abs(p.x)));
        wing *= step(abs(p.x), 0.055);
        float body = smoothstep(0.010, 0.0, length(p * vec2(1.0, 2.6)));
        acc = max(acc, max(wing, body));
    }
    return acc;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.y;
    float t = iTime * 4.0;

    vec4 cloudTexel = texture(iChannel0, fragCoord / iResolution.xy);
    vec3 col = cloudTexel.rgb;

#ifdef WEATHER
    // 龙卷：漏斗本体已在 sky pass 里按云的画法绘制；这里只加被卷起的暗色碎屑与周围压暗
    if (uTornado > 0.001) {
        float debris = tornadoDebris(uv, uTornadoPos, iTime);
        col = mix(col, col * 0.35, clamp(debris, 0.0, 1.0) * 0.85 * uTornado);
        col *= 1.0 - 0.22 * uTornado * (1.0 - smoothstep(0.0, 0.55, length((uv - uTornadoPos) * vec2(1.0, 0.65))));
    }
#endif

    // 城市剪影：压在云海之上、列车与前景云之下
    if (uCityEnabled > 0.5) col = cityComposite(col, uv);

    // ---- 列车 / 烟 / 桥 ----
    // 以列车中心为轴缩放：飞行时放大，离开轨道后仍可辨认
    vec2 trainCenter = vec2(0.24, 0.315);
    vec2 tuv = (uv - trainCenter - uTrainOffset) / uTrainScale + trainCenter;
    tuv.y -= 0.2;
    TrainMasks train = productionTrainMasks(tuv);
    col = mix(col, uTrainRoof, train.joinMask);
    col = mix(col, uTrainBody, train.wagon);
    col = mix(col, uTrainRoof, train.roof);

    col = mix(col, uTrainTrim, train.locomotive);
    col = mix(col, uTrainTrim, train.chimneyBody);
    col = mix(col, uTrainRoof, train.locomotiveRoof);
    col = mix(col, uTrainRoof, train.chimneyTop + train.wheels);

    // 木纹：只作用在车身上（经典主题 grain=0 → 无变化）
    if (uTrainGrain > 0.001) {
        float g = fbm(tuv * vec2(90.0, 14.0), 3);
        col *= mix(1.0, 0.80 + 0.40 * g, uTrainGrain * max(train.wagon, train.locomotive));
    }

    // 积雪：盖住车顶与车厢上沿，边缘用噪声打碎（极地主题 snow=1）
    if (uSnowCover > 0.001) {
        float capNoise = fbm(tuv * vec2(38.0, 90.0), 3);
        float cap = smoothstep(0.104, 0.117, tuv.y) * max(train.wagon, train.roof);
        cap *= smoothstep(0.34, 0.56, capNoise);
        col = mix(col, uSnowColor, cap * uSnowCover);
    }

    // 霓虹灯带 + 光晕 + 车头光（经典主题 energy=0 → 无效果）
    float neon = step(0.103, tuv.y) * step(tuv.y, 0.109) * step(tuv.x, 0.45);
    neon *= step(0.5, train.wagon);
    col += uTrainEmissive * neon * uEmissiveEnergy;

    float halo = exp(-abs(tuv.y - 0.106) * 55.0) * step(tuv.x, 0.46) * step(0.5, train.wagon);
    col += uTrainEmissive * halo * uEmissiveEnergy * 0.22;

    float head = length((tuv - vec2(0.492, 0.116)) * vec2(1.0, 1.7));
    col += uTrainEmissive * exp(-head * 60.0) * uEmissiveEnergy * 0.65;

    if(tuv.x < 0.49){
        float y = productionSmokeDistance(tuv, t);
        if(y < 0.0) col = mix(col, uSmokeA, uSmokeStrength * uSmokeFade);
        if(y < - 0.02) col = mix(col, uSmokeB, uSmokeStrength * uSmokeFade);
    }

    // 桥固定在原地：不跟随列车位移
    vec2 buv = uv;
    buv.y -= 0.2;
    float bridgeKeep = productionBridgeKeepMask(buv, t);
    // uRailFade 是桥的不透明度：1 = 原样，0.45 = 飞行时淡化
    col = mix(col, uBridgeColor * smoothstep(-0.08, 0.08, buv.y), (1.0 - bridgeKeep) * uRailFade);

    // 前景云（半分辨率上采样）
    vec4 fg = texture(iChannel1, fragCoord / iResolution.xy);
    col = mix(col, fg.rgb, fg.a);

    // 仙鹤（云前）
    if (uCraneEnabled > 0.5) col = mix(col, uCraneColor, craneField(uv, t) * 0.9);

#ifdef WEATHER
    // 降水（只有雷暴的暴雨）：覆在画面最前层（除粒子外）
    if (uPrecipAmount > 0.001) {
        {
            vec2 rf = rainField(uv, iTime, uWindSlant);
            float rain = rf.x;
            // 遮挡：前景雾挡掉一部分雨；天空缝隙里雨更清楚
            float rainVis = mix(1.0, 0.55, fg.a) * mix(0.70, 1.0, 1.0 - cloudTexel.a);
            // 雨幕：阵雨扫过的地方空气发灰发亮（和雨雾同一思路，颜色取自画面）
            vec3 veil = mix(col, vec3(0.62, 0.68, 0.80), 0.45);
            col = mix(col, veil, rf.y * 0.14 * min(uPrecipAmount, 1.0) * rainVis);
            // 雨丝 = 背景提亮一档并偏冷，不是贴一条白线；闪电时整场雨被照亮
            vec3 lifted = col * 1.18 + vec3(0.08, 0.09, 0.11) + vec3(0.12, 0.14, 0.18) * uFlash;
            float vis = clamp(rain * uPrecipAmount * rainVis * 0.85 * (1.0 + 0.35 * uFlash), 0.0, 0.75);
            col = mix(col, lifted, vis);
        }
    }
#endif

    // 粒子与扫描线
    vec3 particleColor = mix(uParticleColor, uWeatherParticleColor, uWeatherParticleMix);
    col += particleColor * particleField(uv + uParallax * 0.008, iTime * uParticleSpeed) * uParticleDensity * uWeatherParticleMul;
    col *= 1.0 - uScanline * 0.12 * step(0.5, fract(gl_FragCoord.y * 0.5));

    fragColor = vec4(col, 1.0);
}
