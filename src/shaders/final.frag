// 最终合成：场景 + bloom + 宣纸纹理 + 暗角
uniform float uBloomStrength;
uniform float uPaper;
uniform float uFlash;

// 程序化闪电：按高度分段的折线（每一段随机抖动），近似真实闪电的锯齿
float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float bolt(vec2 uv, float seed, float x0, float width, float top, float bottom, float spread) {
    float seg = floor(uv.y * 10.0 + seed);
    float f = fract(uv.y * 10.0 + seed);
    float j1 = hash21(vec2(seg, seed)) - 0.5;
    float j2 = hash21(vec2(seg + 1.0, seed)) - 0.5;
    float x = x0 + mix(j1, j2, f) * spread;
    float core = smoothstep(width, 0.0, abs(uv.x - x));
    core *= smoothstep(bottom, bottom + 0.05, uv.y) * smoothstep(top, top - 0.12, uv.y);
    return core;
}

float lightning(vec2 uv) {
    float acc = 0.0;
    // 主枝
    acc += bolt(uv, 1.7, 0.30, 0.0022, 0.70, 0.16, 0.085);
    acc += bolt(uv, 4.2, 0.55, 0.0019, 0.66, 0.20, 0.075) * 0.9;
    acc += bolt(uv, 8.9, 0.70, 0.0016, 0.60, 0.26, 0.070) * 0.75;
    // 分叉（更短、更细）
    acc += bolt(uv, 3.3, 0.34, 0.0012, 0.50, 0.30, 0.12) * 0.55;
    acc += bolt(uv, 9.1, 0.58, 0.0011, 0.46, 0.28, 0.10) * 0.5;
    acc += bolt(uv, 6.4, 0.44, 0.0010, 0.56, 0.36, 0.14) * 0.4;
    return acc;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col = texture(iChannel0, uv).rgb;
    vec3 bloom = texture(iChannel1, uv).rgb;
    col += bloom * uBloomStrength;

    // 宣纸：横向拉伸的纤维 + 细颗粒（水墨主题开，其余为 0）
    if (uPaper > 0.001) {
        float fiber = fbm(uv * vec2(220.0, 46.0), 3);
        float grain = fbm(uv * 520.0, 2);
        col *= 1.0 - uPaper * (0.10 * fiber + 0.05 * grain);
        col += uPaper * 0.015;
    }

    col *= vignetteFactor(uv);

    // 闪电：曝光 + 电弧本体（雷暴天气才非 0）
    if (uFlash > 0.001) {
        vec2 suv = vec2(uv.x, 1.0 - uv.y); // 让闪电从上往下
        float b = lightning(suv);
        col += uFlash * vec3(0.55, 0.68, 0.95) * (0.35 + 0.45 * dot(col, vec3(0.33)));
        col += uFlash * vec3(0.92, 0.96, 1.0) * b * 2.2;
        col += uFlash * vec3(0.55, 0.68, 1.0) * b * 0.6;
    }

    fragColor = vec4(col, 1.0);
}
