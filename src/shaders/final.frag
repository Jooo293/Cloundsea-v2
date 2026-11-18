// 最终合成：场景 + bloom + 宣纸纹理 + 穿云演出 + 暗角
uniform float uBloomStrength;
uniform float uPaper;
uniform float uFlash;

// 穿云演出（M21）：x 覆盖 / y 破洞 / z 镜头倍率 / w 速度。
// 演出代码只编进 BURST 变体（cloudsea.js 只在演出期间用它）：哪怕分支不走，全分辨率下也要多付 ~3.5 ms
uniform vec4 uBurst;
uniform float uBurstTime;
uniform vec2 uBurstFocus;   // 镜头焦点（uv / iResolution.y 单位，和 composite 一致）
uniform vec3 uFogDark;      // 主题前景云的三档颜色
uniform vec3 uFogMid;
uniform vec3 uFogLight;

#ifdef BURST
// 色带：内部平涂、带与带之间软过渡——和原版前景云（5 次采样平均）的柔边是同一种质感
vec3 fogColor(float tone) {
    vec3 c = mix(uFogDark, uFogMid, smoothstep(0.38, 0.41, tone));
    return mix(c, uFogLight, smoothstep(0.64, 0.67, tone));
}

// 演出云层：三层云海由远到近叠起来（和原版云层一样每层有自己的色带），返回 (颜色, 不透明度)
vec4 burstClouds(vec2 fragCoord) {
    float aspect = iResolution.x / iResolution.y;
    vec2 uv = fragCoord / iResolution.y;
    vec2 p = uv - uBurstFocus;
    float r = length(p) + 1e-4;
    vec2 dir = p / r;
    float bt = uBurstTime;
    float cover = uBurst.x;
    float burst = uBurst.y;
    float speed = uBurst.w;

    // 第一人称冲刺：沿径向流出的噪声（方向向量 + 对数半径，没有 atan 的接缝）；中心附近不拉丝
    float rush = 0.5;
    float rushMix = 0.0;
    if (speed > 0.0) {
        float flow = log(r + 0.04) - bt * 1.6;
        rush = fbm(dir * 2.4 + flow * vec2(1.1, 0.8), 4);
        rushMix = speed * 0.65 * smoothstep(0.03, 0.25, r);
    }

    // 破洞：从焦点炸开，边缘被噪声撕成一团团（越往后撕得越碎）
    float hole = 1.0;
    if (burst > 0.0) {
        float rag = fbm(dir * 2.2 + vec2(bt * 0.35, 1.7), 4) - 0.5;
        float R = burst * 2.0 - 0.08;
        // 和云边一样是硬边（只留 2px 抗锯齿），不要一圈糊边
        hole = smoothstep(R, R + 0.004, r + rag * (0.22 + 0.35 * burst));
    }

    // 云海涨潮：和原版云层是同一个算法——fbm 当"云面高度"，云面以下按深度切硬色带。
    // 三层由远到近：远层一路涨过画面顶（铺满），近两层停在半腰，成为叠在上面的前景云头
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    float pixel = 1.5 / iResolution.y;
    for (int i = 0; i < 3; i++) {
        float fi = float(i);
        // 冲击波：近的层被推得更快（视差），采样点向焦点回缩 = 图案向外走
        vec2 q = uBurstFocus + p / (1.0 + burst * (1.8 + 0.9 * fi));
        vec2 sp = q * (1.0 + 0.25 * fi) + vec2(bt * (0.10 + 0.08 * fi) + 7.3 * fi + 3.0, 0.0);
        // 8 个倍频（和原版云层一样）：fbm 增益 0.7，最高两个倍频决定了云边那种细碎的颗粒感，砍掉就成了软团
        float n = mix(fbm(sp, 8), rush, rushMix);

        // 近层先涨（从脚下漫上来），远层最后涨过头顶把天空也盖住
        float delay = 0.14 * (2.0 - fi);
        float rise = smoothstep(0.0, 1.0, clamp((cover - delay) / (1.0 - delay), 0.0, 1.0));
        float level = mix(-0.05, i == 0 ? 1.75 : 0.85 - 0.27 * fi, rise);
        float surface = level + (n - 0.5) * (2.2 - 0.4 * fi);
        float depth = surface - q.y;                       // >0 = 在云里
        float a = smoothstep(-pixel, pixel, depth) * hole;

        // 色带（原版 dh 的做法）：贴着云面最亮，往下一档档变深；越近的层底色越深
        vec3 deep = mix(uFogMid, uFogDark, 0.18 * fi);
        vec3 band = mix(deep, mix(uFogMid, uFogLight, 0.5), step(depth, 0.10));
        band = mix(band, uFogLight, step(depth, 0.04));
        band = mix(band, uFogLight * 1.08, rushMix * 0.25 * (rush - 0.3));
        col = mix(col, band, a);
        alpha = max(alpha, a);
    }

    // 速度线：很细的放射亮丝，只在离中心一段距离外出现
    float lines = smoothstep(0.70, 0.86, noise(dir * 46.0 + vec2(0.0, floor(bt * 18.0) * 3.1)));
    col = mix(col, uFogLight * 1.15, lines * speed * smoothstep(0.12, 0.55, r) * 0.55);

    // 破洞瞬间：中心透出一团光（冲出云层的那一下）
    float pulse = smoothstep(0.0, 0.08, burst) * (1.0 - smoothstep(0.08, 0.55, burst));
    col += uFogLight * exp(-r * 4.0) * pulse * 0.45 * alpha;
    return vec4(col, alpha);
}
#endif

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.xy;
    vec3 col;
    vec3 bloom;

#ifdef BURST
    {
        // 镜头：以焦点为中心推近（第一人称）再拉回；冲刺时沿径向 6 次采样做速度模糊 + 轻微震动
        vec2 f01 = vec2(uBurstFocus.x * iResolution.y / iResolution.x, uBurstFocus.y);
        vec2 shake = vec2(sin(uBurstTime * 53.0), cos(uBurstTime * 41.0)) * 0.003 * uBurst.w;
        vec2 suv = f01 + (uv - f01) / uBurst.z + shake;
        col = vec3(0.0);
        for (int i = 0; i < 6; i++) {
            float k = float(i) / 5.0;
            col += texture(iChannel0, f01 + (suv - f01) * (1.0 - k * 0.10 * uBurst.w)).rgb;
        }
        col /= 6.0;
        bloom = texture(iChannel1, suv).rgb;
    }
#else
    col = texture(iChannel0, uv).rgb;
    bloom = texture(iChannel1, uv).rgb;
#endif
    col += bloom * uBloomStrength;

    // 宣纸：横向拉伸的纤维 + 细颗粒（水墨主题开，其余为 0）
    if (uPaper > 0.001) {
        float fiber = fbm(uv * vec2(220.0, 46.0), 3);
        float grain = fbm(uv * 520.0, 2);
        col *= 1.0 - uPaper * (0.10 * fiber + 0.05 * grain);
        col += uPaper * 0.015;
    }

#ifdef BURST
    vec4 fog = burstClouds(fragCoord);
    col = mix(col, fog.rgb, fog.a);
#endif

    // 闪电瞬间暗角收缩：画面边缘跟着亮起来
    col *= mix(vignetteFactor(uv), 1.0, uFlash * 0.55);

    // 闪电：电弧与云的照亮都在 sky pass（会被近处的云挡住）；这里只留一点整体曝光
    if (uFlash > 0.001) {
        col += uFlash * vec3(0.30, 0.36, 0.52) * (0.10 + 0.25 * dot(col, vec3(0.33)));
    }

    fragColor = vec4(col, 1.0);
}
