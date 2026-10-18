// 面板离线测试 harness：模拟宿主（parent）侧 ext-apps 桥。
// 用 node 起 http 服务，iframe 加载 panel.html（同源模拟不同 frame），
// 宿主脚本监听 message 回 ui/initialize + tools/call（喂 server.mjs 的真实输出）。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "..", "dist", "panel.html"), "utf8");

// 起一个真 server.mjs 子进程拿真实数据
const srv = spawn("node", [join(here, "..", "dist", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let mid = 0;
srv.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } catch { }
  }
});
function call(method, params) {
  return new Promise((res) => { const id = ++mid; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
}
const overview = await call("tools/call", { name: "get_tokens_overview", arguments: {} });

const hostHtml = `<!DOCTYPE html><html><head><meta charset="utf8"><title>host</title>
<style>body{margin:0;font-family:sans-serif;background:#e8e8ec;display:flex}#side{width:420px;height:100vh;background:#fff;border-right:1px solid #ccc;position:relative}
#if{width:100%;height:100%;border:none}#bar{position:absolute;top:6px;right:8px;font-size:11px;color:#888}</style></head><body>
<div id="side"><div id="bar">模拟侧边栏 420px</div><iframe id="if" src="/panel"></iframe></div>
<div style="padding:20px"><h3>模拟宿主</h3><p>面板应显示真实数据</p><p id="st"></p></div>
<script>
const overview = ${JSON.stringify(overview.result)};
window.addEventListener("message", async (ev) => {
  const m = ev.data; if (!m || m.jsonrpc !== "2.0") return;
  const win = document.getElementById("if").contentWindow;
  if (m.id === undefined) return;
  if (m.method === "ui/initialize") {
    win.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26",
      hostInfo: { name: "zcode-host-test", version: "0" },
      hostCapabilities: {}, hostContext: { theme: "light", locale: "zh-CN" } } }, "*");
  } else if (m.method === "tools/call" && m.params?.name === "get_tokens_overview") {
    win.postMessage({ jsonrpc: "2.0", id: m.id, result: overview }, "*");
  } else {
    win.postMessage({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not impl: " + m.method } }, "*");
  }
});
document.getElementById("st").textContent = "overview bytes: " + JSON.stringify(overview).length;
</script></body></html>`;

createServer((req, res) => {
  if (req.url === "/panel") { res.setHeader("content-type", "text/html; charset=utf8"); res.setHeader("cache-control","no-store"); res.end(panel); }
  else { res.setHeader("content-type", "text/html; charset=utf8"); res.setHeader("cache-control","no-store"); res.end(hostHtml); }
}).listen(8931, () => console.log("panel test harness at http://127.0.0.1:8931  (Ctrl+C 退出)"));
