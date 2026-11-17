// 前景云（半分辨率 pass）
// 输出 (平均颜色, 平均透明度)：composite 里用 mix(col, rgb, a) 叠加，
// 与单 pass 版本 `fg += foreground(...)/n` 的语义一致。

#define MAX_FG_LAYERS 4
#define MAX_BANDS 4
#define FG_PALETTE_OFFSET 64

uniform sampler2D uPalette;
uniform int uFgCount;
uniform vec4 uFgLayer[MAX_FG_LAYERS];
uniform vec4 uFgBandDh[MAX_FG_LAYERS];
uniform int uFgBandCount[MAX_FG_LAYERS];
uniform vec3 uFgFallback;

// 列车拨云（前景云也要让开，否则车周围永远是一团白雾）
uniform vec2 uCarvePos;
uniform float uCarveRadius;
uniform float uCarveDepth;
uniform float uCloudTime;

vec3 paletteColor(int index) {
    return texelFetch(uPalette, ivec2(index, 0), 0).rgb;
}

vec4 foreground(vec2 uv, float t) {
    uv.y -= 0.2;

    for (int i = 0; i < MAX_FG_LAYERS; i++) {
        if (i >= uFgCount) break;

        vec4 spec = uFgLayer[i];
        vec2 samplePosition = uv + vec2(t / spec.z + spec.w, 0.0);
        float h = (fbm(samplePosition, 8) - 0.5) * spec.y;

        if (uCarveDepth > 0.0001) {
            vec2 cd = (uv + vec2(0.0, 0.2) - uCarvePos) * vec2(0.55, 2.2);
            float dist = length(cd);
            h -= smoothstep(uCarveRadius, 0.0, dist) * uCarveDepth;
        }

        vec4 dh = uFgBandDh[i];
        for (int b = 0; b < MAX_BANDS; b++) {
            if (b >= uFgBandCount[i]) break;
            if (uv.y < h + spec.x - dh[b]) {
                return vec4(paletteColor(FG_PALETTE_OFFSET + i * MAX_BANDS + b), 1.0);
            }
        }
    }
    return vec4(uFgFallback, 0.0);
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.y;
    float t = uCloudTime * 4.0;

    vec4 fg = vec4(0.0);
    int n = 5;
    if (uv.y < 0.5) {
        for (int i = 0; i < n; i++) {
            fg += foreground(uv, t + 4.0 * float(i) / float(n) / 60.0) / float(n);
        }
    }
    fragColor = fg;
}
