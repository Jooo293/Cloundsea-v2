/**
 * 单文件构建：把 index.html + CSS + ES 模块 + 着色器 + 噪声图 打成一个 .html
 *
 *   node tools/build-singlefile.mjs            → dist/cloudsea.html
 *
 * 做法：按 import 关系拓扑排序，去掉 import/export 关键字后顺序拼接；
 * 着色器与噪声图以全局变量注入，运行时 loadText/loadImage 会优先读全局。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 以脚本所在目录为项目根，避免受 cwd 影响
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

const IMPORT_RE = /^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(class|function|const|let|var|async\s+function)\s/gm;

const seen = new Set();
const order = [];

function resolve(from, spec) {
  const target = path.normalize(path.join(path.dirname(from), spec));
  return target.replace(/\\/g, "/");
}

function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  let src = read(file);
  const deps = [];
  src = src.replace(IMPORT_RE, (_, _names, spec) => {
    deps.push(resolve(file, spec));
    return "";
  });
  deps.forEach(visit);
  order.push({ file, src });
}

visit("src/main.js");

const bundle = order
  .map(({ file, src }) => {
    const body = src.replace(EXPORT_RE, "$1 ");
    return `// ---- ${file} ----\n${body}`;
  })
  .join("\n");

// 着色器
const shaderDir = path.join(root, "src", "shaders");
const shaders = {};
for (const name of fs.readdirSync(shaderDir)) {
  shaders[`src/shaders/${name}`] = fs.readFileSync(path.join(shaderDir, name), "utf8");
}

// 噪声图 → data URL
const noisePath = path.join(root, "assets", "noise.png");
const noiseDataUrl = `data:image/png;base64,${fs.readFileSync(noisePath).toString("base64")}`;

let html = read("index.html");

// 1) 内联 CSS
html = html.replace(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/, (_, href) => {
  if (!exists(href)) throw new Error(`找不到样式：${href}`);
  return `<style>\n${read(href)}\n</style>`;
});

// 2) 内联脚本
html = html.replace(
  /<script type="module" src="([^"]+)"><\/script>/,
  () =>
    `<script type="module">\n` +
    `window.__SHADERS = ${JSON.stringify(shaders)};\n` +
    `window.__NOISE_URL = ${JSON.stringify(noiseDataUrl)};\n` +
    bundle +
    `\n</script>`,
);

if (!html.includes("__SHADERS")) throw new Error("脚本没有内联成功，检查 index.html 的 script 标签");

fs.mkdirSync(dist, { recursive: true });
const outFile = path.join(dist, "cloudsea.html");
fs.writeFileSync(outFile, html);

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`✓ ${path.relative(root, outFile)}  ${kb} KB  （模块 ${order.length} 个，着色器 ${Object.keys(shaders).length} 个）`);
