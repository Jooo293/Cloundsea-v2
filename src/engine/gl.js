/**
 * 极简 WebGL2 封装：全屏三角形 + program 构建 + 纹理工具。
 * 刻意只保留 M0 需要的部分，等 M1 再补 pass 系统与 uniform 反射。
 */

/** 编译单个着色器，失败时抛出带日志的错误。 */
export function compileShader(gl, type, source, label = "shader") {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "unknown error";
    gl.deleteShader(shader);
    throw new Error(`[${label}] 着色器编译失败:\n${log}`);
  }
  return shader;
}

/**
 * 构建 program 并缓存指定 uniform 的 location。
 * @param {WebGL2RenderingContext} gl
 * @param {{ vertex: string, fragment: string, uniforms?: string[], label?: string }} options
 */
export function createProgram(gl, { vertex, fragment, uniforms = [], label = "program" }) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex, `${label}:vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment, `${label}:fs`);

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "unknown error";
    gl.deleteProgram(program);
    throw new Error(`[${label}] program 链接失败:\n${log}`);
  }

  const locations = Object.fromEntries(
    uniforms.map((name) => [name, gl.getUniformLocation(program, name)]),
  );
  return { program, uniforms: locations, label };
}

/**
 * 把 1024×1024 的噪声图做成可平铺、带 mipmap 的纹理。
 * 着色器里按 p/1024 采样，所以贴图尺寸必须是 1024。
 */
export function createNoiseTexture(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

/** 画那一个覆盖全屏的三角形。 */
export function drawFullscreen(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
