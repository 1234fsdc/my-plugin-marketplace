// 插件独立性自检：不依赖原生应用（TokenDetailsNative.exe / TokenDetails.exe），仅读 ZCode 自己的库
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = readFileSync(join(root, "dist", "server.mjs"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, ".zcode-plugin", "plugin.json"), "utf8"));

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. 无第三方依赖：只用 node: 内置
const importLines = [...server.matchAll(/^import\s+(.+?)\s+from\s+["']([^"']+)["']/gm)];
const modules = importLines.map((m) => m[2]);
const builtin = modules.length > 0 && modules.every((m) => m.startsWith("node:"));
add("仅依赖 node: 内置模块", builtin, modules.join(", "));

// 2. 无原生应用可执行文件引用（注释行不算，注释里提到 .cs 源是正常的移植说明）
const codeOnly = server.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const nativeRefs = /TokenDetails(Native)?\.exe|TokenDetailsNative\.dll/i.test(codeOnly);
add("不引用原生应用可执行文件", !nativeRefs, nativeRefs ? "发现引用" : "无引用");

// 3. 只读打开数据库；无写操作 SQL（只看实际 SQL 文本，不看字段名如 time_updated）
const readonly = /DatabaseSync\(DbPath,\s*\{\s*readOnly:\s*true\s*\}\)/.test(server);
const sqlText = [...codeOnly.matchAll(/(?:prepare|exec)\(\s*`([^`]*)`/g)].map((m) => m[1]).join("\n");
const writeSql = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i.test(sqlText);
add("数据库只读且无写操作 SQL", readonly && !writeSql, `readOnly=${readonly} 写SQL=${writeSql}`);

// 4. 无网络 / 无子进程 / 无原生依赖
const noNet = !/\bfetch\(|require\(['"](http|https|net)['"]|from\s+["']node:(http|https|net)['"]/.test(codeOnly);
const noSpawn = !/child_process|\bspawn\(|\bexec\(/.test(codeOnly);
add("无网络请求", noNet, noNet ? "确认" : "发现网络调用");
add("无子进程调用", noSpawn, noSpawn ? "确认" : "发现 spawn/exec");

// 5. 运行时入口只有 node dist/server.mjs（不依赖外部二进制）
const cmd = manifest.mcpServers?.tokens?.command;
add("MCP 启动命令仅为 node", cmd === "node", `command=${cmd}`);

// 6. 面板资源自包含（HTML 内联在 dist，无外部资源引用）
const panel = readFileSync(join(root, "dist", "panel.html"), "utf8");
const noRemote = !/<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/.test(panel);
add("面板无远程资源依赖", noRemote, noRemote ? "确认" : "发现外链");

const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
process.exit(bad.length ? 1 : 0);
