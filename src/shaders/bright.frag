// 亮度提取：只留高光，供 bloom 模糊
uniform float uThreshold;

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord / iResolution.xy;
    vec3 c = texture(iChannel0, uv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(uThreshold, uThreshold + 0.35, lum);
    fragColor = vec4(c * k, 1.0);
}
