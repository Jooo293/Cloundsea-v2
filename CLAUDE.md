# CLAUDE.md — 给 AI 编码助手的项目手册

> 你正在接手一个已经迭代到 M27 的单页 WebGL 作品。先读完这份文件再动手。
> 文件名沿用 Claude Code 的约定，内容对任何 AI 编码助手（DeepSeek 等）通用；根目录的 `AGENTS.md` 是同一份规则的精简入口。
> 人类协作者看 `README.md`；变更历史看 `docs/开发日志.md`；每个里程碑的技术细节看 `docs/bench/m*.md`。

## 1. 这是什么

《云海 2.0》：从《云海拾句》剥离出来的单场景云海，去掉全部诗句，重做成可玩的世界。
四套主题（原版暖霞 / 赛博霓虹 / 废墟 / 极地）、液态云、两种天气（晴 / 雷暴；大雨、大雪已在 M22 按用户要求移除）、可操控列车。
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
src/systems/cloudburst.js 穿云演出的时间轴（cover / burst / zoom / speed 四个包络）
src/shaders/*          sky / fg / composite / bright / blur / final + common
tools/build-singlefile.mjs  单文件打包
tools/bench-server.py        bench 结果收集器（页面 POST 到 127.0.0.1:8790）
```

**每帧的 7 个 pass**：

1. `sky`（云倍率，默认 0.75）：天空 + 星点/极光/远山 + 背景 12 层云 + 龙卷漏斗 + 闪电 + 雨雾 + 墨线/冰晶
   （alpha 输出云覆盖率，供降水遮挡；龙卷的挖空与云臂也在这里形变）
2. `fg`（同倍率）：前景 2 层云，输出 (颜色, alpha)
3. `composite`（全分辨率）：云图 + 龙卷碎屑 + 城市 + 列车 + 烟 + 桥 + 前景云 + 降水（含闪电提亮）+ 粒子
4. `bright`（1/4）：高光提取
5. `blur` H / 6. `blur` V（1/4）
7. `final`（全分辨率）：场景（演出时带镜头缩放 + 径向模糊）+ bloom + 宣纸 + 穿云云海 + 闪电整体曝光 + 暗角

`sky` / `composite` / `final` 各有两个编译变体（`STORM` / `WEATHER` / `BURST`），平时走精简版。

## 4. 必须守住的五条不变量

1. **classic + 晴 = 原版画面**。这是唯一的回归基线：任何新特性都必须能被主题参数关掉（值为 0 时公式恒等）。改动后至少确认 classic 画面没有结构性变化（对比方法见 §6）。
2. **性能门禁**：1080p、默认云倍率（0.75）下 ≤ 12 ms（Intel Arc 核显基准）。超了先降云倍率，而不是砍功能。
3. **源码是 UTF-8**。**不要**用 PowerShell 的 `Set-Content` / `Add-Content` / `Out-File` 批量改 `.js/.glsl/.html/.md`——曾经因为编码把整个 `main.js` 写坏、页面直接 SyntaxError。用编辑器或 Python（`open(..., encoding="utf-8")`）。
4. `dist/cloudsea.html` 是**生成物**：改完源码必须重跑 `node tools/build-singlefile.mjs`，不要手改 dist。
5. 不要恢复**已移除**的功能（乘客视角、大雨 / 大雪天气、神龙 / 云海巨鲸伴飞、音频均已按用户要求删除）；不要重新引入诗词/工作台。

## 5. 加东西的标准流程

**加一个主题字段**（例如云层参数 `warp`）：

1. `src/themes/theme.js`：主题对象里加字段 → `buildThemeUniforms()` 里透传；
2. `src/scene/cloudsea.js`：加进对应 pass 的 `*_UNIFORMS` 数组 → `setTheme()` 里 `gl.uniform*`；
3. shader 里声明 `uniform` 并使用；
4. **默认值必须是"关闭"**，否则 classic 会变。

**加一个天气参数**：

1. `src/systems/weather.js`：两个预设（sunny / storm）各加值 → 若是数值，加进 `NUMERIC` 数组才会插值；颜色之类的非数值要单独插值；
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
| `smoothstep(edge0>edge1)` | 结果未定义：硬切边、白斑，且不同 GPU 表现不同 | 反向渐变写 `1.0 - smoothstep(a, b, x)`，a<b |
| 用 `step(hash, floor(p*N))` 做碎屑 | 每格整块亮灭 → 灰色网格 | 软边圆点 + 格内随机偏移；或真粒子 |
| 把逐层重复的计算写进云层循环 | 12 层 × 每层 exp/pow，帧时 8.9 → 11.8 ms | 与层无关的量提到循环外，循环内只做加法 |
| 天气专属代码只用 `if (uniform)` 跳过 | 晴天也慢 0.5–1 ms（寄存器压力） | 放进 `#ifdef STORM` / `#ifdef WEATHER` 变体，cloudsea.js 按天气选 program |
| `?bench` 不走 `frame()` | M20 前雷暴 bench 实际量的是晴天 | 已修：bench 前先 `pushWeather()` |
| 不固定 cloudscale 做像素对比 | 自动画质按帧时改云倍率，两张图天然不同 | 回归对比一律带 `?cloudscale=1` |
| 新模块顶层名字和别的模块重名 | 开发页正常，`dist` 单文件 SyntaxError 整页不渲染 | 单文件构建把所有模块拼进同一作用域：顶层名字加前缀；`verify.ps1` 只测开发页，改完用 `file://` 开一次 `dist` |
| 新效果里用了随机数 | `?freeze=1` 截图每次不一样，逐像素对比出假阳性 | 冻结模式下关掉随机 |
| 大包围盒里逐像素算 8 倍频 fbm | 曾让雷暴帧时到 13.6 ms | 噪声项有界时先判断是否可能命中再算（输出不变） |
| 新效果自己画一套"云" | 半透明雾 / 同心环 / 软团，和原作两种画风 | 复用原版算法：`fbm(uv, 8)` 当云面高度 + 云面以下硬色带 + 主题调色板（见 M21） |
| 用 Python 字符串替换写 JS | `"\n"` 写成了真换行 → SyntaxError，整页不渲染，bench 静默失败 | 改完跑 `node --check src/**/*.js`；bench 脚本要核对结果条数 |

## 8. 当前待办（按优先级，验收标准要可测）

> 已完成（M12–M22、M26 已移除）：
> - 雨丝质感：长短随机/头尾渐隐/每层斜率/背景色采样/云缝遮挡/闪电提亮/雨雾；
> - 龙卷：真实挖空云层/螺旋漏斗/云臂/碎屑粒子/顶部平滑渐隐；
> - M20：雨/闪电/龙卷改成和云同一套画法（主题调色板色阶、按云层深度遮挡、闪电每次随机），见开发日志；
> - M21：穿云演出（HUD「穿云」/ 快捷键 C；`?burst=N` 定格），见开发日志；
> - M26：音频 P0（风/雨/蓄力/起飞/雷），**M27 已按用户要求全部移除**。
> 下面的清单从「还没做的」开始排。

1. **竖屏构图**：430×860 下 `uv.x` 只有 0.5，列车占比过大；需要给云层一套纵向参数或降低车体占比。
2. **飞行姿态**：抬轮/倾斜、车体轮廓光、发光尾迹（现在飞起来像一道光）。
3. **雷暴云增厚**：雷暴时把 `disp` 放大或加两层云。
4. **雨簇疏密与水花**：雨目前全屏均匀，可加低频噪声控制疏密；桥/车顶可加溅水。
5. **废墟/极地美术**：废墟的墨线偏碎（应先模糊再取梯度）；极光的混色应改滤色。

## 9. 交付标准（Definition of Done）

- `node tools/build-singlefile.mjs` 通过，`dist/cloudsea.html` **用 `file://` 实际打开过**（`verify.ps1` 只测开发页，发布包的模块重名问题它测不出来）；
- 改过的 `.js` 都过了 `node --check`；
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify.ps1` 全绿（6 张截图 = 4 主题 + 晴 / 雷暴，无控制台报错）；
- 大块新效果放在 `#ifdef` 编译变体里，不在场时帧时与改动前一致（交替跑多次取中位数比较）；
- 1080p 帧时不超过 12 ms；
- classic + 晴 画面与上一版基线无结构性差异；
- 变更写进 `docs/开发日志.md`（日期 / 改了什么 / 为什么 / 验证结果）。
