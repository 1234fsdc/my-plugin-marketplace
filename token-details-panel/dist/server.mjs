// Token Details 侧边栏面板 —— MCP server（只读，零依赖，手写 stdio JSON-RPC）
// 数据口径 1:1 移植自 TokenDetailsNative.cs RefreshDetail（zcode 源）：
// today_summary / session_stats(30min) / dmodels(500行+8条加权) / today_by_model /
// today_sessions(子代理归并) / compact_stats(30天) / week_daily(7日)。
// 只读打开 ~/.zcode/cli/db/db.sqlite；每请求现算（本地面板低频，无需缓存）。
// 协议：MCP stdio = 换行分隔 JSON-RPC 2.0。stdout 只发协议消息，日志走 stderr。
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CACHE_BILL = 0.1;        // 缓存读按 1 折计费（对照 CACHE_BILL）
const TOK_PER_CHAR = 0.6;      // 无回报模型估算（对照 TokPerChar）
const SPEED_WINDOW = 8;        // 每模型加权窗口
const SPEED_ROWS = 500;        // 每模型速度的行窗口

const HtmlUri = "ui://token-details-panel/panel.html";
const DbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

const log = (...a) => console.error("[token-details-panel]", ...a);
let SessLogged = false;   // 首次 tools/call 记录一次会话绑定结果（stderr 进宿主日志）

function day0() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const num = (v) => (v == null ? 0 : Number(v));

// provider_id -> 可读名（对照 LoadProvNames：v2 providerRules + 旧 cli providers）
const ProvNames = {};
try {
  for (const p of [join(homedir(), ".zcode", "cli", "config.json"),
                   join(homedir(), ".zcode", "v2", "provider_config.json")]) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const rules = cfg?.config?.providerConfigRules?.providerRules;
    if (Array.isArray(rules)) {
      for (const r of rules) if (r?.providerId && r?.providerName) ProvNames[r.providerId] = r.providerName;
      continue;
    }
    let provs = cfg?.providers ?? cfg?.provider;
    if (Array.isArray(provs)) {
      const map = {};
      for (const d of provs) if (d?.id) map[d.id] = d;
      provs = map;
    }
    for (const [k, d] of Object.entries(provs ?? {})) if (d?.name) ProvNames[k] = d.name;
  }
} catch { }
const provOf = (pid) => (!pid ? "?" : (ProvNames[pid] ?? (pid.length > 8 ? pid.slice(0, 8) : pid)));

// model_id -> 上下文窗口上限（宿主真实口径：v2 provider_config.json 的 modelConfigRules）
const ModelWin = {};
try {
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "provider_config.json"), "utf8")); } catch { }
  const entries = Object.values(cfg?.config?.modelConfigRules ?? {}).flat();
  for (const e of entries) {
    const w = num(e?.config?.properties?.contextWindow);
    if (e?.modelId && w > 0) ModelWin[e.modelId] = w;
  }
} catch { }

let DbH = null;
function db() {
  if (!DbH) DbH = new DatabaseSync(DbPath, { readOnly: true });
  return DbH;
}

// ---- 无回报模型估算（对照 EstMap：>=3 条完成行且输出回报合计 <20 tok 判无回报，
//      usage.id 内嵌 message.id，part 正文字符数 x 0.6 折算） ----
function estMap(rows) {
  const stat = {};
  for (const r of rows) {
    if (r.status !== "completed") continue;
    const m = r.model_id;
    if (m == null) continue;
    (stat[m] ??= [0, 0]);
    stat[m][0]++; stat[m][1] += num(r.output_tokens) + num(r.reasoning_tokens);
  }
  const silent = new Set(Object.entries(stat).filter(([, s]) => s[0] >= 3 && s[1] < 20).map(([m]) => m));
  if (silent.size === 0) return {};
  const midOf = {};
  for (const r of rows) {
    if (r.model_id == null || !silent.has(r.model_id) || r.id == null) continue;
    const j = r.id.indexOf("msg_");
    if (j < 0) continue;
    midOf[r.id] = r.id.slice(j).replace(/_[^_]*$/, "");
  }
  const mids = Object.values(midOf);
  if (mids.length === 0) return {};
  const c2t = {};
  try {
    for (let j = 0; j < mids.length; j += 400) {
      const batch = mids.slice(j, j + 400);
      const ph = batch.map(() => "?").join(",");
      const rs = db().prepare(
        `SELECT p.message_id, CAST(COALESCE(SUM(LENGTH(COALESCE(json_extract(p.data,'$.text'),''))`
        + `+LENGTH(COALESCE(json_extract(p.data,'$.state.input'),''))),0)*${TOK_PER_CHAR} AS INT) t `
        + `FROM part p WHERE p.message_id IN (${ph}) GROUP BY 1`).all(...batch);
      for (const r of rs) c2t[r.message_id] = num(r.t);
    }
  } catch { return {}; }
  const est = {};
  for (const [uid, mid] of Object.entries(midOf)) if (c2t[mid] > 0) est[uid] = c2t[mid];
  return est;
}
const elapsedMs = (r) => (num(r.started_at) > 0 && num(r.completed_at) > num(r.started_at)) ? num(r.completed_at) - num(r.started_at) : 0;
const rowTok = (r) => num(r.output_tokens) + num(r.reasoning_tokens);
const effTok = (r, est) => { const t = rowTok(r); return t > 0 ? t : (est[r.id] ?? 0); };

// ---- 概览（对照 RefreshDetail） ----
function overview() {
  const h = db();
  const d0 = day0();
  const bill = String(CACHE_BILL);
  const s = h.prepare(
    `SELECT COUNT(CASE WHEN query_source!='compact' THEN 1 END) n,
      COALESCE(SUM(output_tokens+reasoning_tokens+input_tokens+cache_creation_input_tokens+cache_read_input_tokens),0) tok,
      COALESCE(SUM(CASE WHEN query_source!='compact' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at>started_at THEN output_tokens+reasoning_tokens END),0) talk_tok,
      COALESCE(SUM(CASE WHEN query_source!='compact' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at>started_at THEN completed_at-started_at END),0) talk_ms,
      COALESCE(SUM(output_tokens),0) out, COALESCE(SUM(input_tokens),0) inp,
      COALESCE(SUM(reasoning_tokens),0) reason,
      COALESCE(SUM(cache_creation_input_tokens),0) cw,
      COALESCE(SUM(cache_read_input_tokens),0) cr,
      COALESCE(SUM(cache_creation_input_tokens+cache_read_input_tokens),0) cache,
      AVG(CASE WHEN query_source!='compact' AND first_token_at IS NOT NULL AND started_at IS NOT NULL AND first_token_at>=started_at THEN first_token_at-started_at END) ttft,
      MIN(CASE WHEN query_source!='compact' THEN completed_at END) mn,
      MAX(CASE WHEN query_source!='compact' THEN completed_at END) mx
     FROM model_usage WHERE status='completed' AND completed_at >= ?`).get(d0);
  // 今日真实 token 总量 = input + output（对照宿主 computed_total_tokens：input 已含缓存读/写，output 已含思考）
  const dayTotal = num(s.inp) + num(s.out);
  const sum = {
    n: num(s.n), tok: num(s.tok), talkTok: num(s.talk_tok), talkMs: num(s.talk_ms),
    out: num(s.out), inp: num(s.inp), reason: num(s.reason), cache: num(s.cache),
    cr: num(s.cr), total: dayTotal,
    cacheHit: num(s.inp) > 0 ? num(s.cr) / num(s.inp) : null,
    mn: num(s.mn), mx: num(s.mx),
    ttft: s.ttft == null ? null : num(s.ttft) / 1000,
    rpm: (num(s.n) > 0 && num(s.mx) > num(s.mn)) ? num(s.n) * 60000 / (num(s.mx) - num(s.mn)) : 0,
  };
  // 会话速度（30 分钟窗口，排除子代理；HAVING 用别名 last 由 SQLite 支持）
  const cutSess = Date.now() - 30 * 60 * 1000;
  const sess = h.prepare(
    `SELECT u.session_id sid, COALESCE(s.title, u.session_id) title, COUNT(*) cnt,
      SUM(CASE WHEN u.started_at IS NOT NULL AND u.completed_at IS NOT NULL AND u.completed_at>u.started_at THEN u.output_tokens+u.reasoning_tokens END) tok,
      CAST(SUM(u.output_tokens+u.reasoning_tokens+u.input_tokens+u.cache_creation_input_tokens+u.cache_read_input_tokens*${bill}) AS INT) usage,
      SUM(CASE WHEN u.started_at IS NOT NULL AND u.completed_at IS NOT NULL AND u.completed_at>u.started_at THEN u.completed_at-u.started_at END) ms,
      MAX(COALESCE(u.completed_at,u.started_at)) last,
      AVG(CASE WHEN u.first_token_at IS NOT NULL AND u.started_at IS NOT NULL AND u.first_token_at>=u.started_at THEN u.first_token_at-u.started_at END) ttft,
      MIN(COALESCE(u.completed_at,u.started_at)) first,
      (SELECT u2.model_id FROM model_usage u2 WHERE u2.session_id=u.session_id AND u2.query_source!='compact' AND u2.status='completed' ORDER BY COALESCE(u2.completed_at,u2.started_at) DESC LIMIT 1) model
     FROM model_usage u LEFT JOIN session s ON s.id=u.session_id
     WHERE u.query_source!='compact' AND u.task_type!='subagent_child'
     GROUP BY u.session_id HAVING last >= ${cutSess} ORDER BY ms DESC LIMIT 30`).all();
  const sessions = sess.map((r) => ({
    title: r.title ?? r.sid, cnt: num(r.cnt),
    tok: num(r.tok), usage: num(r.usage), ms: num(r.ms), last: num(r.last),
    ttft: r.ttft == null ? null : num(r.ttft) / 1000,
    first: num(r.first), model: r.model ?? "-",
    tps: num(r.ms) > 0 ? num(r.tok) * 1000 / num(r.ms) : 0,
    rpm: (num(r.first) > 0 && num(r.last) > num(r.first)) ? num(r.cnt) / ((num(r.last) - num(r.first)) / 60000) : 0,
  }));
  // 每模型速度 · 今日（500 行窗口 + 8 条加权，对照 dmodels）
  const rows5 = h.prepare(
    `SELECT id, provider_id, model_id, status, started_at, first_token_at,
      completed_at, duration_ms, output_tokens, reasoning_tokens FROM model_usage
     WHERE query_source!='compact' ORDER BY COALESCE(completed_at, started_at) DESC LIMIT ${SPEED_ROWS}`).all();
  const stat = h.prepare(
    `SELECT model_id m, COUNT(*) cnt, MIN(COALESCE(completed_at,started_at)) mn,
      MAX(COALESCE(completed_at,started_at)) mx FROM model_usage
     WHERE status='completed' AND query_source!='compact' AND COALESCE(completed_at,started_at)>=? AND model_id!='' GROUP BY model_id`).all(d0);
  const statMap = new Map(stat.map((r) => [r.m, r]));
  const est5 = estMap(rows5);
  const by = new Map();
  const order = [];
  const eff5 = new Map();
  for (const r of rows5) {
    const m = r.model_id ?? "?";
    if (!by.has(m)) { by.set(m, []); order.push(m); }
    by.get(m).push(r);
    const et = effTok(r, est5);
    if (et > 0 && elapsedMs(r) > 0) eff5.set(r, et);
  }
  const dmodels = [];
  for (const m of order) {
    const latest = by.get(m)[0];
    if ((num(latest.completed_at) || num(latest.started_at)) < d0) continue;
    let tot = 0, el = 0, n = 0;
    for (const r of by.get(m)) {
      if (n >= SPEED_WINDOW) break;
      if (r.status !== "completed") continue;
      const e2 = elapsedMs(r);
      const tk = eff5.get(r) ?? 0;
      if (tk <= 0 || e2 <= 0) continue;
      tot += tk; el += e2; n++;
    }
    if (el <= 0) continue;
    const tps = tot * 1000 / el;
    const st = statMap.get(m);
    dmodels.push({
      model: m, prov: provOf(latest.provider_id),
      tps: tps.toFixed(1), tpsV: Math.round(tps),
      cnt: st ? num(st.cnt) : 0,
      rpm: st && num(st.cnt) > 1 && num(st.mx) > num(st.mn) ? num(st.cnt) * 60000 / (num(st.mx) - num(st.mn)) : 0,
      when: new Date(num(latest.completed_at) || num(latest.started_at)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
    });
  }
  // 按模型 · 今日
  const bm = h.prepare(
    `SELECT model_id m, provider_id p,
      CAST(SUM(output_tokens+reasoning_tokens+input_tokens+cache_creation_input_tokens+cache_read_input_tokens*${bill}) AS INT) tok, COUNT(*) cnt
     FROM model_usage WHERE status='completed' AND completed_at>=? AND model_id!='' GROUP BY model_id, provider_id ORDER BY 3 DESC`).all(d0);
  const total = 1 + bm.reduce((a, r) => a + num(r.tok), 0);
  const byModel = bm.map((r) => ({ model: r.m, prov: provOf(r.p), tok: num(r.tok), cnt: num(r.cnt), pct: Math.round(num(r.tok) * 100 / total) }));
  // 按会话 · 今日（子代理归并）
  const ts = h.prepare(
    `SELECT CASE WHEN u.task_type='subagent_child' THEN '子代理' ELSE COALESCE(s.title, u.session_id) END title,
      COUNT(*) cnt, CAST(SUM(u.output_tokens+u.reasoning_tokens+u.input_tokens+u.cache_creation_input_tokens+u.cache_read_input_tokens*${bill}) AS INT) tok
     FROM model_usage u LEFT JOIN session s ON s.id=u.session_id
     WHERE u.status='completed' AND u.completed_at>=? GROUP BY 1 ORDER BY 3 DESC LIMIT 20`).all(d0);
  const bySession = ts.map((r) => ({ title: r.title, cnt: num(r.cnt), tok: num(r.tok) }));
  // 今日工具调用（turn_usage 有 completed_at）
  const tu = h.prepare(
    `SELECT COUNT(*) turns, COALESCE(SUM(tool_call_count),0) tools, COALESCE(SUM(tool_error_count),0) terr
     FROM turn_usage WHERE completed_at>=? AND status='completed'`).get(d0);
  const tools = { turns: num(tu.turns), tools: num(tu.tools), terr: num(tu.terr) };
  // 今日会话数 / 今日压缩数
  const sc2 = h.prepare(
    `SELECT COUNT(DISTINCT session_id) n FROM model_usage WHERE status='completed' AND completed_at>=?`).get(d0);
  const cpT = h.prepare(
    `SELECT COUNT(*) n FROM model_usage WHERE query_source='compact' AND status='completed' AND completed_at>=?`).get(d0);
  const sessN = num(sc2.n), compactN = num(cpT.n);
  // 会话压缩（30 天，未归档）
  const cutCp = Date.now() - 30 * 86400 * 1000;
  const cp = h.prepare(
    `SELECT COALESCE(s.title, u.session_id) title, COUNT(*) n, MAX(u.completed_at) last
     FROM model_usage u LEFT JOIN session s ON s.id=u.session_id
     WHERE u.query_source='compact' AND u.status='completed' AND u.completed_at>=? AND s.time_archived IS NULL
     GROUP BY u.session_id ORDER BY 3 DESC`).all(cutCp);
  const compact = cp.map((r) => ({ title: r.title, n: num(r.n), last: num(r.last) }));
  // 近 7 日
  const day0w = d0 - 6 * 86400 * 1000;
  const wd = h.prepare(
    `SELECT strftime('%Y-%m-%d', completed_at/1000, 'unixepoch', 'localtime') d,
      CAST(SUM(output_tokens+reasoning_tokens+input_tokens+cache_creation_input_tokens+cache_read_input_tokens*${bill}) AS INT) tok
     FROM model_usage WHERE status='completed' AND completed_at>=? GROUP BY 1`).all(day0w);
  const sums = new Map(wd.map((r) => [r.d, num(r.tok)]));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(day0w + i * 86400 * 1000);
    const p = (x) => String(x).padStart(2, "0");
    // SQL 键是 %Y-%m-%d，label 才是 MM-dd（对照 Python week_daily）
    const key = `${dd.getFullYear()}-${p(dd.getMonth() + 1)}-${p(dd.getDate())}`;
    days.push({ label: `${p(dd.getMonth() + 1)}-${p(dd.getDate())}`, tok: sums.get(key) ?? 0 });
  }
  return { sum, sessions, dmodels, byModel, bySession, compact, days, tools, sessN, compactN };
}

// ---- 当前会话统计（宿主在 tools/call 的 _meta 注入会话 ID，对照 zcode-context readSessionContext） ----
function sessStats(sid) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sid)) return null;
  const h = db();
  const meta = h.prepare(`SELECT title, time_created, time_updated FROM session WHERE id=?`).get(sid);
  if (!meta) return null;
  const t = h.prepare(
    `SELECT COUNT(CASE WHEN query_source!='compact' THEN 1 END) n,
      COALESCE(SUM(CASE WHEN query_source!='compact' THEN output_tokens+reasoning_tokens END),0) out_r,
      COALESCE(SUM(CASE WHEN query_source!='compact' THEN output_tokens END),0) out_p,
      COALESCE(SUM(CASE WHEN query_source!='compact' THEN input_tokens END),0) inp,
      COALESCE(SUM(CASE WHEN query_source!='compact' THEN cache_read_input_tokens END),0) cr,
      COALESCE(SUM(CASE WHEN query_source!='compact' THEN cache_creation_input_tokens END),0) cw,
      AVG(CASE WHEN status='completed' AND query_source='main_turn' AND first_token_at IS NOT NULL AND started_at IS NOT NULL AND first_token_at>=started_at THEN first_token_at-started_at END) ttft,
      SUM(CASE WHEN status='error' THEN 1 END) errs,
      SUM(CASE WHEN status='cancelled' THEN 1 END) cancels,
      SUM(CASE WHEN query_source='compact' THEN 1 END) compacts,
      SUM(retry_count) retries,
      MIN(CASE WHEN query_source!='compact' THEN started_at END) first_req,
      MAX(COALESCE(completed_at,started_at)) last_done
     FROM model_usage WHERE session_id=?`).get(sid);
  // 上下文占用 = 最近一次完成请求的 input_tokens（OpenAI 口径已含 cache_read，勿再加 cr/cw 重复计）
  const ctxRow = h.prepare(
    `SELECT input_tokens i, cache_read_input_tokens cr,
      (SELECT model_id FROM model_usage WHERE session_id=? AND query_source!='compact' AND status='completed' ORDER BY COALESCE(completed_at,started_at) DESC LIMIT 1) model
     FROM model_usage WHERE session_id=? AND status='completed' ORDER BY COALESCE(completed_at,started_at) DESC LIMIT 1`).get(sid, sid);
  // 会话总速度（简版）：全部完成请求的简单平均 = 总输出字数 / 总生成时长
  const spd = h.prepare(
    `SELECT COALESCE(SUM(output_tokens+reasoning_tokens),0) tok, COALESCE(SUM(duration_ms),0) dur
     FROM model_usage
     WHERE session_id=? AND status='completed' AND query_source='main_turn'
     AND duration_ms IS NOT NULL AND duration_ms>0`).get(sid);
  const tu = h.prepare(
    `SELECT COUNT(*) turns, COALESCE(SUM(tool_call_count),0) tools, COALESCE(SUM(tool_error_count),0) tool_errs
     FROM turn_usage WHERE session_id=?`).get(sid);
  const sub = h.prepare(
    `SELECT COUNT(DISTINCT s.id) n, COALESCE(SUM(u.output_tokens+u.reasoning_tokens),0) tok
     FROM session s LEFT JOIN model_usage u ON u.session_id=s.id WHERE s.parent_id=?`).get(sid);
  const subList = h.prepare(
    `SELECT COALESCE(NULLIF(s.title,''), s.id) title, COUNT(u.id) cnt,
      COALESCE(SUM(u.output_tokens+u.reasoning_tokens),0) tok
     FROM session s LEFT JOIN model_usage u ON u.session_id=s.id
     WHERE s.parent_id=? GROUP BY s.id HAVING cnt>0 OR tok>0 ORDER BY tok DESC LIMIT 20`).all(sid)
    .map((r) => ({ title: r.title, cnt: num(r.cnt), tok: num(r.tok) }));
  const byModel = h.prepare(
    `SELECT u.model_id m, COUNT(*) cnt, COALESCE(SUM(u.output_tokens+u.reasoning_tokens),0) tok,
      (SELECT CAST((u2.output_tokens+u2.reasoning_tokens)*1000.0/u2.duration_ms AS INT)
       FROM model_usage u2
       WHERE u2.session_id=u.session_id AND u2.model_id=u.model_id
         AND u2.status='completed' AND u2.query_source='main_turn'
         AND u2.duration_ms>0 AND (u2.output_tokens+u2.reasoning_tokens)>0
       ORDER BY COALESCE(u2.completed_at,u2.started_at) DESC LIMIT 1) last_tps
     FROM model_usage u WHERE u.session_id=? AND u.query_source!='compact'
     GROUP BY u.model_id ORDER BY tok DESC`).all(sid)
    .map((r) => ({ model: r.m ?? "-", cnt: num(r.cnt), tok: num(r.tok), lastTps: r.last_tps == null ? null : num(r.last_tps) }));
  const durMs = Math.max(0, num(t.last_done) - num(meta.time_created));
  // 本会话真实 token 总量：input + output（含思考，output 已是 output_tokens 含 reasoning 的口径，见 out_p 交叉验证）
  const usedTok = num(t.inp) + num(t.out_p);
  return {
    title: meta.title ?? sid,
    bound: true,
    ctx: ctxRow ? num(ctxRow.i) : 0,
    total: ModelWin[ctxRow?.model] ?? null,
    model: ctxRow?.model ?? "-",
    n: num(t.n), outR: num(t.out_r), usedTok,
    cacheHit: num(t.inp) > 0 ? num(t.cr) / num(t.inp) : null,
    ttft: t.ttft == null ? null : num(t.ttft) / 1000,
    tps: num(spd.dur) > 0 ? num(spd.tok) * 1000 / num(spd.dur) : 0,
    turns: num(tu.turns), tools: num(tu.tools), toolErrs: num(tu.tool_errs),
    errs: num(t.errs), cancels: num(t.cancels), compacts: num(t.compacts), retries: num(t.retries),
    durMs, firstReq: num(t.first_req), lastDone: num(t.last_done),
    sub: { n: num(sub.n), tok: num(sub.tok), list: subList },
    byModel,
  };
}

// ---- 极简 MCP stdio server：initialize / tools/list / tools/call / resources/read ----
const TOOL = {
  name: "get_tokens_overview",
  description: "App-only read-only Token usage stats: today summary, per-model speed, active sessions (30min), by-model/session today, compaction (30d), 7-day trend.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ["app"] } },
};

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "token-details-panel", version: "1.0.0" },
    };
  }
  if (method === "tools/list") return { tools: [TOOL] };
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) throw new Error(`Unknown tool: ${params?.name}`);
    // 会话绑定：宿主注入 _meta["com.zcode/request-context"].session_id（对照 zcode-context）
    const sid = params?._meta?.["com.zcode/request-context"]?.session_id;
    if (!SessLogged) { SessLogged = true; log("session binding:", sid ? `ok ${sid}` : `absent (meta keys: ${params?._meta ? Object.keys(params._meta).join(",") : "none"})`); }
    return { content: [], structuredContent: { ...overview(), sess: sid ? sessStats(sid) : null } };
  }
  if (method === "resources/list") {
    return { resources: [{ uri: HtmlUri, name: "Token 统计面板", mimeType: "text/html;profile=mcp-app" }] };
  }
  if (method === "resources/read") {
    if (params?.uri !== HtmlUri) throw new Error(`Unknown resource: ${params?.uri}`);
    return {
      contents: [{
        uri: HtmlUri,
        mimeType: "text/html;profile=mcp-app",
        text: readFileSync(join(import.meta.dirname, "panel.html"), "utf8"),
      }],
    };
  }
  if (method === "ping") return {};
  return null; // 通知/未知请求不回
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.method?.startsWith("notifications/")) return;
  if (msg.id === undefined) return;
  let result, error = null;
  try { result = handle(msg); }
  catch (e) { log(msg.method, e?.stack || e); error = { code: -32603, message: String(e?.message || e) }; }
  if (result === null && !error) return;   // 未知请求静默（避免噪音）
  const out = { jsonrpc: "2.0", id: msg.id };
  if (error) out.error = error; else out.result = result;
  process.stdout.write(JSON.stringify(out) + "\n");
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
log("ready (readonly)", DbPath);
