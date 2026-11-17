# CLAUDE.md — 给 AI 编码助手的项目手册

> 你正在接手一个已经迭代到 M11 的单页 WebGL 作品。先读完这份文件再动手。
> 人类协作者看 `README.md`；变更历史看 `docs/开发日志.md`；每个里程碑的技术细节看 `docs/bench/m*.md`。

## 1. 这是什么

《云海 2.0》：从《云海拾句》剥离出来的单场景云海，去掉全部诗句，重做成可玩的世界。
四套主题（原版暖霞 / 赛博霓虹 / 废墟 / 极地）、液态云、四种天气（晴 / 大雨 / 大雪 / 雷暴）、可操控列车。
纯原生 WebGL2 + ES 模块，无框架、无构建依赖、无 npm 安装。

## 2. 三条命令

```powershell
# 开发（改代码用，需要 HTTP 因为要 fetch .glsl）
python -m http.server 8789 --bind 127.0.0.1
# → http://127.0.0.1:8789/index.html

# 发布（单文件，双击可玩）
node tools/build-singlefile.mjs
# → dist/cloudsea.html

# 自检（构建 + 截图 + 控制台报错检查）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify.ps1
```

Windows 上浏览器是 Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
无头截图/bench 需要它能启动（本机会直接启动，不需要额外参数）。

## 3. 架构地图

```
index.html            DOM 骨架 + HUD（主题 / 天气 / 画质 / 速度 / 暂停）
src/main.js           装配层：时间轴、渲染循环、天气、列车、HUD、bench
src/engine/gl.js      program 编译、全屏三角形、噪声纹理
src/engine/fbo.js     离屏渲染目标
src/engine/clock.js   暂停 / 倍速 / 冻结时间
src/scene/cloudsea.js 7 个 pass 的编排 + setTheme（只换 uniform，不重编译）
src/themes/theme.js   主题数据：云层几何/配色、天空、列车、城市、粒子、后处理
src/systems/weather.js 天气预设 + 8 秒插值 + 闪电包络
src/systems/train.js  列车状态机（rail / charging / flying / docking）
src/shaders/*          sky / fg / composite / bright / blur / final + common
tools/build-singlefile.mjs  单文件打包
tools/bench-server.py        bench 结果收集器（页面 POST 到 127.0.0.1:8790）
```

**每帧的 7 个 pass**：

1. `sky`（云倍率，默认 0.75）：天空 + 星点/极光/远山 + 背景 12 层云 + 墨线/冰晶
2. `fg`（同倍率）：前景 2 层云，输出 (颜色, alpha)
3. `composite`（全分辨率）：云图 + 龙卷漏斗 + 城市 + 列车 + 烟 + 桥 + 前景云 + 降水 + 粒子
4. `bright`（1/4）：高光提取
5. `blur` H / 6. `blur` V（1/4）
7. `final`（全分辨率）：场景 + bloom + 宣纸 + 闪电 + 暗角

## 4. 必须守住的五条不变量

1. **classic + 晴 = 原版画面**。这是唯一的回归基线：任何新特性都必须能被主题参数关掉（值为 0 时公式恒等）。改动后至少确认 classic 画面没有结构性变化（对比方法见 §6）。
2. **性能门禁**：1080p、默认云倍率（0.75）下 ≤ 12 ms（Intel Arc 核显基准）。超了先降云倍率，而不是砍功能。
3. **源码是 UTF-8**。**不要**用 PowerShell 的 `Set-Content` / `Add-Content` / `Out-File` 批量改 `.js/.glsl/.html/.md`——曾经因为编码把整个 `main.js` 写坏、页面直接 SyntaxError。用编辑器或 Python（`open(..., encoding="utf-8")`）。
4. `dist/cloudsea.html` 是**生成物**：改完源码必须重跑 `node tools/build-singlefile.mjs`，不要手改 dist。
5. 不要恢复**已移除**的功能（乘客视角已按用户要求删除）；不要重新引入诗词/工作台。

## 5. 加东西的标准流程

**加一个主题字段**（例如云层参数 `warp`）：

1. `src/themes/theme.js`：主题对象里加字段 → `buildThemeUniforms()` 里透传；
2. `src/scene/cloudsea.js`：加进对应 pass 的 `*_UNIFORMS` 数组 → `setTheme()` 里 `gl.uniform*`；
3. shader 里声明 `uniform` 并使用；
4. **默认值必须是"关闭"**，否则 classic 会变。

**加一个天气参数**：

1. `src/systems/weather.js`：四个预设各加值 → 若是数值，加进 `NUMERIC` 数组才会插值；颜色之类的非数值要单独插值；
2. `src/scene/cloudsea.js`：`setWeather()` 存字段 → `draw()` 里上传；
3. `src/main.js`：`renderer.setWeather({...})` 里透传。

**改渲染结构**：先量帧时（§6），再改；改完对比 `docs/bench/` 里的历史数据。

## 6. 怎么验证（不要靠"看起来差不多"）

```powershell
# 1) 确定性截图（冻结时间）
#    ?freeze=1&t=20&theme=cyber&weather=storm
# 2) 与原版对照（原版参考图在 up-in-the-cloud-sea/ 仓库，不在本项目里）
#    用 ?cloudscale=1 渲染 classic，再和旧基线图做逐像素 diff
# 3) 帧时
#    启动 tools/bench-server.py，然后打开：
#    http://127.0.0.1:8789/index.html?bench=60&w=1920&h=1080&quality=1&theme=cyber&report=1
#    结果追加到 shots/bench.jsonl，报告里会带 GPU 名称
```

历史基线（同机 Intel Arc 核显，1080p）：M2b 8.9 ms / M5 10.1 ms / M9 约 8.3 ms。
**测帧时用 `readPixels` 强制同步**（bench 已内置），`gl.finish()` 在部分后端会直接返回、量不到。

## 7. 常见坑（都踩过）

| 坑 | 现象 | 正确做法 |
| --- | --- | --- |
| `iChannel0` 复用 | 多 pass 后烟雾变成光滑香蕉形 | 噪声走独立 `uNoise` 纹理单元 |
| 桥淡出公式 | `1-(1-k)*fade` 几乎无效 | `mix(col, bridge, (1-k)*fade)` |
| `hidden` 属性 | 加 `.show` 类但不显示 | 同时切 `root.hidden` |
| 风速与时间轴 | 切天气时云瞬移 | 单独维护 `cloudTime` 累加器，wind=1 时对齐 |
| PowerShell 改源码 | 中文乱码、语法错误 | 见不变量 §4.3 |
| 列车淡出 | 飞行时烟停在半空 | `uSmokeFade` 跟着状态走 |

## 8. 当前待办（按优先级，验收标准要可测）

1. **音频**：风声（随天气变强/变弱）、雷声（跟闪电包络，延迟 0.3–1.2 s）、起飞音效。用 WebAudio 程序化合成，不要引入版权素材。
2. **龙卷把云吹散**：现在只有涡旋扭曲，没有真正的云层缺口。做法接近已有的列车拨云：在 `sky.frag` 里对龙卷中心附近额外下压云高，并让边缘产生向外甩的弧线。
3. **竖屏构图**：430×860 下 `uv.x` 只有 0.5，列车占比过大；需要给云层一套纵向参数或降低车体占比。
4. **飞行姿态**：抬轮/倾斜、车体轮廓光、发光尾迹（现在飞起来像一道光）。
5. **雷暴云增厚**：雷暴时把 `disp` 放大或加两层云。
6. **废墟/极地美术**：废墟的墨线偏碎（应先模糊再取梯度）；极光的混色应改滤色。

## 9. 交付标准（Definition of Done）

- `node tools/build-singlefile.mjs` 通过，`dist/cloudsea.html` 能双击打开；
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify.ps1` 全绿（8 张截图 + 无控制台报错）；
- 1080p 帧时不超过 12 ms；
- classic + 晴 画面与上一版基线无结构性差异；
- 变更写进 `docs/开发日志.md`（日期 / 改了什么 / 为什么 / 验证结果）。
