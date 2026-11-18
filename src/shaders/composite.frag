// 合成 pass（全分辨率）：半分辨率云图 + 城市剪影 + 列车 + 烟 + 桥 + 前景云 + 粒子
// iChannel0 = 天空/背景云，iChannel1 = 前景云（带 alpha）

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
uniform float uPrecipType;   // 0 无 / 1 雨 / 2 雪
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

// 暴雨：三层，彼此的速度/斜率/透明度不同；每条雨丝长度随机、头尾渐隐、带微弱风噪
float rainField(vec2 uv, float t, float slant) {
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
        float k = float(i);
        float cells = 26.0 * (1.0 + k * 0.55);
        float layerSlant = slant * (0.55 + k * 0.55);   // 每层角度不同，避免平行雨幕
        vec2 p = vec2(uv.x * cells + t * slant * (0.35 + k * 0.45),
                      uv.y * cells * 0.5 - t * (9.0 + k * 7.0));
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;

        float h = hash21(cell + k * 7.0);
        float h2 = hash21(cell + k * 7.0 + 11.3);
        float alive = step(0.42, h);

        // 长短随机：40%–100% 个单元高，位置在单元内随机
        float len = 0.40 + 0.60 * h2;
        float yc = (h2 - 0.5) * (1.0 - len);
        float ly = (f.y - yc) / len;              // -0.5（尾）… +0.5（头）
        float along = 1.0 - abs(ly) * 2.0;        // 两端 0，中间 1
        float taper = smoothstep(0.0, 0.22, along); // 头尾渐隐，不是硬白条

        // 阵风：逐条雨丝的水平扰动，随时间缓变
        float wobble = sin(t * 1.7 + h * 24.0) * 0.018;
        float across = abs(f.x + wobble - ly * len * layerSlant * 0.22);
        float streak = smoothstep(0.055, 0.0, across) * taper;

        acc += alive * streak * (0.62 - k * 0.14) * (0.55 + 0.45 * h2);
    }
    return acc;
}

// 暴雪：三层不同大小的雪花，缓慢下落 + 横向摆动
float snowField(vec2 uv, float t) {
    float acc = 0.0;
    for (int i = 0; i < 3; i++) {
        float k = float(i);
        float cells = 16.0 * (1.0 + k * 0.7);
        vec2 p = vec2(uv.x * cells + sin(uv.y * 4.0 + t * 0.9 + k * 2.0) * 0.45,
                      uv.y * cells * 0.75 - t * (1.4 + k * 1.1));
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float h = hash21(cell + k * 13.0);
        float alive = step(0.58, h);
        float d = length(f);
        acc += alive * smoothstep(0.26 + k * 0.05, 0.0, d) * (0.7 - k * 0.15);
    }
    return acc;
}

// 龙卷：下窄上宽的螺旋柱 + 底部尘幕
float tornadoBody(vec2 uv, vec2 c, float t) {
    vec2 p = uv - c;
    float hgt = clamp(p.y / 0.58, 0.0, 1.0);
    float width = 0.024 + 0.155 * pow(hgt, 1.9);   // 底部窄、顶部张开成喇叭口
    float sway = 0.035 * sin(p.y * 6.0 + t * 1.4);
    float x = abs(p.x - sway);
    float body = smoothstep(width, width * 0.5, x);

    // 旋转条纹：角度 + 高度 + 时间
    float ang = atan(p.x - sway, p.y + 1e-3);
    float spiral = 0.5 + 0.5 * sin(ang * 4.0 + p.y * 30.0 - t * 9.0);
    body *= 0.45 + 0.55 * spiral;
    // 细密的竖直流线，避免"一根光滑圆柱"
    body *= 0.72 + 0.28 * sin(p.x * 110.0 + p.y * 18.0 - t * 14.0);

    // 底部尘幕：贴着云海铺开一圈
    float skirt = exp(-pow((p.y - 0.005) * 13.0, 2.0)) * smoothstep(0.22, 0.0, abs(p.x)) * 0.6;
    // 被卷起的碎屑
    float debris = step(0.86, hash21(floor((p + vec2(0.0, t * 0.05)) * 46.0)))
                 * smoothstep(0.20, 0.0, abs(p.x)) * smoothstep(0.22, 0.02, p.y) * 0.8;
    skirt += debris;

    return clamp(body + skirt, 0.0, 1.0) * step(-0.06, p.y) * smoothstep(0.62, 0.2, p.y);
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

    // 龙卷：亮灰螺旋柱 + 外围螺旋云臂 + 边缘高光 + 附近压暗
    if (uTornado > 0.001) {
        // 云臂（很淡的灰度带，绕漏斗向外卷）
        vec2 ap = (uv - uTornadoPos) * vec2(0.8, 1.0);
        float ar = length(ap) + 1e-4;
        float aa = atan(ap.y, ap.x);
        float armPhase = aa * 3.0 + ar * 18.0 - iTime * 1.3;
        float armBand = smoothstep(0.55, 0.0, abs(sin(armPhase)));
        float armMask = smoothstep(0.26, 0.34, ar) * smoothstep(0.70, 0.44, ar);
        col = mix(col, vec3(0.60, 0.58, 0.63), armBand * armMask * 0.16 * uTornado);

        float f = tornadoBody(uv, uTornadoPos, iTime);
        vec3 tornadoColor = vec3(0.74, 0.72, 0.78);
        col = mix(col, tornadoColor, f * 0.88 * uTornado);
        col += vec3(0.26, 0.26, 0.30) * f * f * uTornado;
        col *= 1.0 - 0.38 * uTornado * smoothstep(0.55, 0.0, length((uv - uTornadoPos) * vec2(1.0, 0.65)));
    }

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

    // 降水：暴雨/暴雪直接覆在画面最前层（除粒子外）
    if (uPrecipAmount > 0.001) {
        if (uPrecipType > 1.5) {
            float snow = snowField(uv, iTime);
            float snowVis = mix(1.0, 0.70, fg.a) * mix(0.80, 1.0, 1.0 - cloudTexel.a);
            vec3 snowTint = vec3(0.97, 0.99, 1.0) + vec3(0.5, 0.6, 0.8) * uFlash;
            col = mix(col, snowTint, clamp(snow * uPrecipAmount * snowVis * 0.9, 0.0, 0.9));
        } else {
            float rain = rainField(uv, iTime, uWindSlant);
            // 雨色采样背景：60% 揉进当前画面，再按背景亮度提亮，避免"浮在最上层的白条"
            vec3 rainTint = mix(vec3(0.80, 0.88, 0.98), col * 1.35 + 0.02, 0.45);
            float lum = dot(col, vec3(0.299, 0.587, 0.114));
            // 遮挡：前景雾挡掉大部分雨；天空缝隙里雨更清楚
            float rainVis = mix(1.0, 0.55, fg.a) * mix(0.70, 1.0, 1.0 - cloudTexel.a);
            float vis = clamp(rain * uPrecipAmount * rainVis * (0.80 + 0.60 * lum), 0.0, 0.9);
            // 闪电瞬间：雨色更亮、雨丝自身也发光
            rainTint += vec3(0.90, 0.95, 1.0) * uFlash * 0.55;
            vis = clamp(vis * (1.0 + 0.55 * uFlash), 0.0, 0.95);
            col = mix(col, rainTint, vis);
            col += rain * 0.09 * (0.35 + lum) * (1.0 + 1.6 * uFlash);
        }
    }

    // 粒子与扫描线
    vec3 particleColor = mix(uParticleColor, uWeatherParticleColor, uWeatherParticleMix);
    col += particleColor * particleField(uv + uParallax * 0.008, iTime * uParticleSpeed) * uParticleDensity * uWeatherParticleMul;
    col *= 1.0 - uScanline * 0.12 * step(0.5, fract(gl_FragCoord.y * 0.5));

    fragColor = vec4(col, 1.0);
}
