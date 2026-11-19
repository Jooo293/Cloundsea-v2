# AGENTS.md — 给任何 AI 编码助手（DeepSeek / Claude / Codex / Cursor …）的入口

> 完整操作手册在 **[`CLAUDE.md`](CLAUDE.md)**（文件名沿用最初的 Claude Code 约定，内容对所有助手通用）。
> **动手前先完整读一遍 `CLAUDE.md`**，再读 `docs/交接.md` 和 `docs/开发日志.md` 末尾几节。

## 项目一句话

《云海 2.0》：纯原生 WebGL2 + ES 模块的单页作品（无框架、无 npm 依赖）。四套主题、两种天气（晴 / 雷暴）、
可操控列车（长按蓄力松手起飞）、穿云演出（HUD「穿云」/ 快捷键 C）。当前进度 **M27**。

## 三条命令（Windows，项目根目录执行）

```powershell
python -m http.server 8789 --bind 127.0.0.1          # 开发：打开 http://127.0.0.1:8789/index.html
node tools/build-singlefile.mjs                      # 发布：生成 dist/cloudsea.html（双击可玩）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify.ps1   # 自检：构建 + 6 张截图 + 控制台报错
```

## 绝对不能做（摘自 CLAUDE.md §4，违反任何一条都算回归）

1. **classic 主题 + 晴天 = 原版画面**，是唯一回归基线；新特性默认值必须是"关闭"，关闭时逐像素不变。
2. **1080p 帧时 ≤ 12 ms**（默认云倍率 0.75）；超了先优化或降云倍率，不要偷偷砍功能。
3. **源码是 UTF-8**：不要用 PowerShell 的 `Set-Content` / `Add-Content` / `Out-File` 改 `.js/.glsl/.html/.md`。
4. **不要手改 `dist/`**：改完源码重新 `node tools/build-singlefile.mjs`。
5. **不要恢复已删除的功能**：乘客视角、大雨 / 大雪天气、神龙 / 云海巨鲸伴飞、音频；不要重新引入诗词 / 工作台。

## 每次改完必须做

- `node --check` 改过的 `.js`；跑 `tools\verify.ps1`（6/6）；
- **用 `file://` 打开一次 `dist/cloudsea.html`**（`verify.ps1` 只测开发页；单文件构建会把所有模块拼进同一作用域，
  两个模块有同名顶层 `const` 时开发页正常、发布包直接白屏）；
- 用 `?freeze=1&t=20&cloudscale=1` 截图与改动前逐像素对比（不固定 `cloudscale` 时自动画质会让两张图天然不同）；
- 量帧时（`CLAUDE.md` §6），把"改了什么 / 为什么 / 怎么验证 / 数据"写进 `docs/开发日志.md`。
