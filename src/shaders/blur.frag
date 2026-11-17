// 可分离高斯模糊（5 抽头 × 2 方向，权重和 ≈ 1）
uniform vec2 uDirection;

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.xy;
    vec2 d = uDirection / iResolution.xy;

    vec3 sum = texture(iChannel0, uv).rgb * 0.227;
    sum += (texture(iChannel0, uv + d * 1.3846).rgb + texture(iChannel0, uv - d * 1.3846).rgb) * 0.316;
    sum += (texture(iChannel0, uv + d * 3.2308).rgb + texture(iChannel0, uv - d * 3.2308).rgb) * 0.070;

    fragColor = vec4(sum, 1.0);
}
