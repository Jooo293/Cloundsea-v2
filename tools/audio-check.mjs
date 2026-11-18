/**
 * 音频自检（CDP）：用无头 Edge 打开 ?audiotest=1，真实等待若干秒，
 * 收集控制台里的 [audio] 日志，确认离线渲染有输出（rms > 0）。
 *
 * 为什么不用 --screenshot + --virtual-time-budget：
 * 虚拟时间会瞬间耗尽，而 OfflineAudioContext 的渲染需要真实时间，
 * 页面会在 promise 兑现前被杀掉。所以这里走 DevTools 协议、按真实秒数等待。
 *
 * 用法：node tools/audio-check.mjs [url]
 * 退出码：0 通过，1 失败。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE =
  process.env.EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.AUDIO_CHECK_PORT || 9223);
const PAGE =
  process.argv[2] || "http://127.0.0.1:8789/index.html?freeze=1&t=20&audiotest=1";
const WAIT_MS = Number(process.env.AUDIO_CHECK_WAIT || 6000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error("DevTools 端口没起来");
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "cloudsea-audio-"));
  const browser = spawn(
    EDGE,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--use-angle=d3d11",
      "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const lines = [];
  let ws;
  try {
    await waitForDevtools();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const target = list.find((t) => t.type === "page");
    if (!target) throw new Error("没有 page target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    let id = 0;
    const send = (method, params = {}) =>
      ws.send(JSON.stringify({ id: (id += 1), method, params }));

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ""))
          .join(" ");
        if (text.includes("[audio]")) lines.push(text);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        lines.push(`[exception] ${d.exception?.description || d.text}`);
      }
    });

    send("Runtime.enable");
    send("Page.enable");
    send("Page.navigate", { url: PAGE });
    await sleep(WAIT_MS);
  } finally {
    try {
      ws?.close();
    } catch {}
    browser.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(lines.join("\n") || "(没有收到 [audio] 日志)");
  const offline = lines.find((l) => l.includes("offline"));
  const rms = offline ? Number((offline.match(/"rms":([0-9.]+)/) || [])[1]) : NaN;
  if (!offline || !(rms > 0)) {
    console.error("\nRESULT: FAIL（没有可测量的音频输出）");
    process.exitCode = 1;
  } else {
    console.log(`\nRESULT: PASS（rms=${rms}）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
