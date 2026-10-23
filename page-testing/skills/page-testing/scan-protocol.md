# scan-protocol — 扫描专用协议（仅扫描派单时随 prompt 传入）

> 本文件只在 page-testing 扫描派单时使用。通用浏览器任务不需要它。
> 用法：主 agent 派单时把本文件全文塞进 `agent-browser` 子代理的 prompt。

**目录**：台账协议（保证一个不漏）/ DOM 级自动扫描（每页必跑，不依赖视觉模型）/ 扫描返回格式（严格遵守）

## 证据选择

- 普通 DOM 页面默认调用 `page.snapshot()`，必要时使用 `scope: "full_page"`，并保存快照文本或路径；交互前后用快照、DOM 值或 API 字段对比状态。
- 只有需要判断像素或视觉层级时才调用 `page.screenshot()`，例如布局、遮挡、裁切、响应式、动画、canvas、富文本、表格和地图。
- 快照不能证明像素布局；截图也不能替代交互状态或数据链路证据。两者都不应被用来代替 API、后端或下游取证。

## 台账协议（保证一个不漏）

> 「不漏」靠机制不靠自觉：**机械枚举 → 台账记账 → 零 pending 才能返回**。AI 不负责"找全"，只负责"处置完"。

**① 机械枚举（每页固定执行，确定性代码，不靠 AI 目测）**

> 以下确定性规则在页面上下文中执行，返回 JSON 数组。

```javascript
function cssPath(el) {
  const p = [];
  for (; el && el.nodeType === 1; el = el.parentElement) {
    const sibs = el.parentElement ? [...el.parentElement.children] : [el];
    const same = sibs.filter(c => c.tagName === el.tagName);
    p.unshift(el.tagName.toLowerCase() +
      (same.length > 1 ? ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : ''));
  }
  return p.join(' > ');
}
return [...document.querySelectorAll(
  'button, a[href], input, textarea, select, [onclick], [role="button"], [tabindex]'
)]
// checkVisibility() 同时处理 display:none / visibility:hidden，且不像
// offsetParent 那样误杀 position:fixed 元素（fixed 元素 offsetParent 恒为 null）
.filter(el => el.checkVisibility())
// CSS 属性选择器不支持 >=，负 tabindex 在 JS 里过滤（-1 是程序化聚焦容器，非交互元素）
.filter(el => { const t = el.getAttribute('tabindex'); return t === null || +t >= 0; })
.map((el, i) => ({
  id: 'el-' + String(i + 1).padStart(3, '0'),
  tag: el.tagName.toLowerCase(),
  text: (el.innerText || el.getAttribute('aria-label') || el.value || '')
        .trim().slice(0, 50),
  selector: cssPath(el),            // 唯一 CSS 选择器
  disabled: !!el.disabled ||
            el.getAttribute('aria-disabled') === 'true',
  status: 'pending'
}));
```

去重规则：同 `selector` + 同 `text` 视为同一元素。
**台账 JSON 字段名强制**：`elements` / `selector` / `el-NNN` / `status`（取值 clicked / skipped-* / uploaded / disabled / equivalent）——禁止自创字段名（如 `entries`/`sel`），主 agent 跨页聚合按此 schema 解析。

**② 台账记账**

- 每页写一个 `click-ledger/{页面名}.json`，初始全部 `pending`
- 每实际点击一个 → `status: "clicked"`，并记录结果（正常 / 报错 / 无反应）
- **状态变化断言（交互结论硬要求）**：点击前记录可观测基线（计数/文本/状态值/视图数值），点击后验证基线按预期变化。发送/提交类断言目标区域出现新条目；筛选类断言结果集变化；缩放/视图类断言数值按方向变化且受边界约束。「事件已触发」「无报错」「预览出现」都不等于功能生效；基线未变化 → 记「点击无效果」P1，而不是 `clicked-正常`
- 跳过必须填原因，不允许静默跳过：
  - `skipped-login` — 需要登录态，无凭据
  - `skipped-destructive` — 对真实数据的破坏性操作，且无法用测试数据替代
  - `disabled` — 元素本身禁用（仍要验证点击后无异常）
  - 其他情况自定义原因字符串
- **特殊元素处置（不直接点，但必须有结论，不算跳过）**：
  - `a[href]` 跨页链接 → 新标签打开验证目标可达后立即关闭，原页台账记 `clicked`（直接点会导航离开、丢失扫描上下文）
  - `input[type=file]` → 真实上传 + 分层取证：请求层确认文件进入实际 payload，后端层确认存储/接口返回包含该文件引用；仅预览出现只算入口通过，缺失层在 findings 标 `⚠️ 未验证`。无法上传才记 `skipped-upload` 并只验入口 UI。
  - 下载类链接（download 属性 / 文件扩展名 href）→ 记 `skipped-download`，只验证触发行为不等待文件
- **状态持久化验证（状态类操作必做）**：勾选/筛选/设置保存/排序/隐藏列等状态类操作完成后，**刷新页面一次（强制绕过缓存）**验证状态保持；弹窗保存后**重新打开弹窗**验证已保存值。刷新后丢失 / 保存后回显不一致 → 记「状态未持久化」P1
- **返回条件：台账零 `pending` 后必须立即汇总返回**——禁止访问本页之外的任何页面（包括本页问题的跨页线索；跨页验证归调用方）。canvas/图谱类页面交互测试也在本页内进行，不受此句影响

**③ 动态差额核对**

每轮点击操作后重跑一遍枚举脚本，与台账做 diff——新出现的元素追加进台账（解决「点了 A 才弹出 B」的遗漏）。循环直到连续两轮无新增且零 pending。

**④ 覆盖边界声明**

以下区域机械枚举扫不到，返回中必须逐项声明未覆盖，不得沉默：
Shadow DOM 深层、跨域 iframe、canvas/webview 内部控件。

---

## 分层证据（链路类结论必填）

> 「预览出现」「入口能点」「请求 200」都不等于「内容真的到达了目的地」。凡结论涉及内容/数据到达某处（上传、发送、提交、导出、保存、AI 消费），必须逐层独立取证：

| 层 | 取证内容 | 典型手段 |
|---|---|---|
| 界面层 | 目标 DOM 出现且可见（计数/文本/src 非空） | querySelector + checkVisibility |
| 请求层 | 真实请求发出且 payload 含该内容 | 网络监听/请求体捕获 |
| 后端层 | 同 ID 读回：存储或接口状态包含该内容 | 读回 API/落库查询 |
| 消费层 | 下游消费者实际收到（模型输入含该内容/文件落盘/第三方回执） | spy/日志/消费端读回 |

- 上层证据不能替代下层；每层证据独立列出，缺失层在 findings 标 `⚠️ 未验证：缺 N 层证据`
- 消费层因外部服务/凭据无法触达时必须显式声明；不得以「请求成功」冒充「已消费」

---

## DOM 级自动扫描（每页必跑，不依赖视觉模型）

> 以下检查直接在页面内执行 JS 读 DOM 和控制台，**不依赖视觉模型**。每条都对应一类「视觉模型容易漏、但 DOM 一眼就能看出来」的问题。每页打开后先跑完这轮，再执行分支协议。
>
> **执行方式**：14 条检查合并执行并输出一个 JSON；每条命中项带选择器、文本和位置。

**1. 占位文字残留**
- 关键词扫描所有文本节点：`TODO` / `TBD` / `xxx` / `待填` / `Lorem` / `placeholder` / `TKTK` / `占位` / `暂无` / `（此处）`
- 命中即记入 findings，标注元素位置和上下文

**2. 空按钮 / 空链接**
- 所有 `<button>`：文字为空 且 无 aria-label → 记入
- 所有 `<a href="#">` 或 `<a href="javascript:void(0)">` → 记入（死链接）
- 纯图标按钮无 title/tooltip → 记入（用户无法判断点击目标）

**3. 图片 alt 缺失**
- 所有 `<img>`：alt 属性为空或缺失 → 记入（装饰性图片需显式标注 alt=""）

**4. 重复 ID**
- 页面内 id 重复 → 记入，标注重复值和位置

**5. 禁用态伪装**
- disabled 的 `<button>` / `<input>` / `<a>`：检查计算样式，如果视觉上没有禁用态（透明度/灰色/无悬停变化）→ 记入「看起来能点但实际不能」

**6. z-index 遮挡**
- 对所有 position:absolute/fixed 且 z-index>0 的元素，计算覆盖区域是否遮挡了按钮/链接/输入框
- 遮挡 → 记入，标注被遮挡元素和遮挡物

**7. 控件焦点顺序**
- 所有 tabindex 值是否连续自然（0→1→2→...），是否有跳跃或负值导致 Tab 键乱序

**8. 控制台警告收集**
- 注入 console.warn 拦截器（与 console.error 同理），操作过程中收集所有 warning
- CSP 违规（Refused to...）、弃用 API、低对比度警告等均在此收集
- ⚠️ 不要只收集 error，warning 里经常有「图片被 CSP 拦截」「API 即将弃用」这类线索

**9. CSP 响应头检查**
- 对页面所有 fetch/XHR 请求检查响应头 Content-Security-Policy
- 记录是否缺少 blob: / data: 等常见指令（导致图片/字体/下载不显示）

**10. 交互元素台账核对**
- 按上方台账协议执行机械枚举并建立 `click-ledger/{页面名}.json`
- 本轮检查确认：台账已初始化、无遗漏的 pending 项；动态差额核对本页至少跑过一轮
- 完成条件硬性约束：**台账零 pending 才能返回**，跳过项必须带原因

**11. 中文页英文残留**
- 扫描可见文本节点：中文字界面上字段值、表头、按钮、toast/报错提示中出现的英文单词（排除专有名词、URL、数字单位如 KB/ID）→ 记「未本地化」，附原文和位置
- 对应真实 bug 类型：「导出表头是英文」「创建来源显示英文」「拖拽出现英文提示」

**12. 溢出隐藏（内容存在但看不见）**
- 对所有滚动容器检查 `scrollWidth > clientWidth` 或 `scrollHeight > clientHeight`，且无可滚动条/无滚动提示 → 记「内容不可见」P1
- 对应真实 bug 类型：「缺少滚动条，看不到表格后面的内容」

**13. 控件内重叠（容器内部，第 6 条测不到）**
- 对每个「图标 + 文本」型控件（输入框/按钮/带前缀图标的输入组）：在页面内取容器内绝对定位子元素与文本节点前部的 boundingRect，求交集；相交 → 记「控件内重叠」，标注重叠像素与被盖文本
- 对应真实 bug 类型：「放大镜图标盖住 placeholder 第一个字」——功能全绿但用户看得一清二楚

**14. 同类控件一致性抽查（每页至少一组）**
- 每页选至少一组同类控件（同一筛选栏的输入框与按钮、同一表格操作列的按钮、同组 tab），用 `getComputedStyle` + `offsetHeight` 对比 height / font-size / line-height / padding / border-radius
- 同组任一维度 computed 值不一致 → 记「控件基线不一致」，逐个列出具体值
- 对应真实 bug 类型：「清除按钮和输入框高度不一样」「详情有边框删除没边框」——单看每个都正常，放一起才暴露

---

## 扫描返回格式（严格遵守）

> 本节覆盖 `agent-browser` 子代理的默认输出格式。
>
> **最终输出必须包含 findings 与 ledger**——没有它们等于没扫描。每完成一个维度检查，立即把该维度 findings 追加写入 `findings/{页面}-r{N}.md`（边扫边落盘，禁止最后憋大招）；即使被中断，已落盘部分也算数。

```
findings: [{维度, 问题, 严重度 P0-P3, 证据/位置}]
ledger:   {发现 N, 已点击 N, 跳过 N+原因, pending: 0}
dom_hits: {占位文字 N / 空按钮 N / alt缺失 N / 重复ID N / 禁用态 N / 遮挡 N / 焦点 N / 警告 N / CSP N / 台账 N / 英文残留 N / 溢出 N / 控件内重叠 N / 控件基线不一致 N}
声明: [未覆盖区域（Shadow DOM/iframe/canvas）、测试数据写入位置——无则「无」]
版本断言: [每轮必填：页面实际加载的 JS/CSS 版本与派单声明比对；涉及后端链路时附后端代码生效证据（行为探针结果或进程启动时间晚于代码修改时间）；任一不符则整轮无效]
快照: [路径清单]
截图: [仅视觉证据需要时的路径清单；无则 []]
```

严重度：P0 功能不可用/数据错误/安全漏洞/白屏；P1 核心体验严重受损；P2 体验不佳可绕过；P3 细节优化。