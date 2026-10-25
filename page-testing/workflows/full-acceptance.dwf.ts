/* zcode-workflow
description: 全流程验收：基线全量一轮 + 定向复测（修复验证/牵连面/缺口/聚集四类带依据计划项）循环；缺陷级（medium/high）发现独立确证后修复，low 建议类只记录不修；通过分级：干净通过/带已知缺陷通过（仅 medium 放弃未确证在案）/未证实（high 级在案或有覆盖缺口）；复审否决/快检不过或超时不提交，判「通过」前必过快检；报告写入项目根 qa-report.md。
whenToUse: 对本机有源码的项目做全面验收并自动修复再复测时；用户说「全流程验收」「验收这个项目」「测到测不出问题为止」并给出项目路径。
args:
  scope:
    type: string
    description: 测试范围一句话，如「登录和下单流程」「管理后台全部页面」；不给则由 AI 全自定
    default: 全部页面、功能和接口
  target:
    type: string
    description: 被测项目源码根目录（绝对路径）
    required: true
*/
// 全流程验收 v4.5 —— 基线全量一轮，测 → 独立确证 → 修 → 审 → 项目快速检查 → 提交 → 刷新 → 定向复测；判「通过」前必过快检门禁（退出码即确证）。
// 分级口径：medium/high=缺陷级（确证后修复）；low=建议类（只记录不修，不阻塞通过）。
// 通过判定：零新缺陷 + 无 blocked + 台账全登记 + 各线就绪 + 上轮修复都闭环 + 无未终结问题 + 通过前快检（项目有则必过）；缺一判「未证实」。

const target = typeof args.target === "string" ? args.target.trim() : "";
const scope = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim() : "全部页面、功能和接口";
const MAX_ROUNDS = 5;
const GHOST_LIMIT = 2; // 同一 where+what 累计确证失败达此次数后熔断：复发报告不再进确证流水线，按未确证在案处理
const root = target; // 一律以启动参数为准，不信任勘察员的转述路径

if (!target) {
  return {
    conclusion: "缺少 target 参数（被测项目源码根目录），验收未执行。",
    findings: [],
    verified: [],
    notCovered: ["全部——没有被测对象"],
  };
}

/** 一条测试线：环境探测给出的、针对被测项目的一种测试与刷新方式。 */
interface EnvLine {
  /** 线类型 */
  kind: "web" | "desktop" | "android" | "api";
  /** 怎么把这条线跑起来（命令、入口地址、注意事项） */
  howToRun: string;
  /** 改完代码后怎么让这条线跑上最新代码（重启/重建/重装命令） */
  howToRefresh: string;
  /** 补充说明 */
  notes?: string;
}

interface EnvPlan {
  /** 被测项目根目录（绝对路径，应与启动参数一致） */
  projectRoot: string;
  /** 识别出的测试线 */
  lines: EnvLine[];
  /** 项目是否 git 仓库 */
  isGit: boolean;
  /** 项目自带的快速验证命令；必须能在任意工作目录下对项目生效：npm 用 ["--prefix",根目录,...]、pnpm ["--dir",根目录,...]、yarn ["--cwd",根目录,...]、cargo ["--manifest-path",清单路径,...]；cmd 只能是 npm/pnpm/yarn/cargo，做不到就 null 并写进 notes */
  quickCheck: { cmd: string; args: string[] } | null;
  /** 探测发现的其他情况（构建慢、缺依赖等） */
  notes?: string;
}

interface ChecklistItem {
  /** 清单项编号，如 w1、d1、p1 */
  id: string;
  /** 测什么，一句话 */
  title: string;
  /** 怎么到达 / 怎么测 */
  how: string;
  /** 属于哪条线 */
  line: "web" | "desktop" | "android" | "api";
}

interface Checklist {
  items: ChecklistItem[];
}

interface Finding {
  /** 问题编号：线-轮-序号，如 web-r2-3 */
  id: string;
  /** 位置：文件路径:行号，或页面/界面/接口名 */
  where: string;
  /** 一句话说清什么问题（缺陷与建议都写具体） */
  what: string;
  /** 证据：报错输出、几何断言结果、日志等 */
  evidence: string;
  /** low=建议类（只记录不修）；medium=一般缺陷；high=崩溃/数据丢失/错误结果 */
  severity: "low" | "medium" | "high";
  /** 所属测试线（收集结果时由脚本标记；快检合成发现归 api 线） */
  line?: "web" | "desktop" | "android" | "api";
}

interface TestResult {
  /** 本轮新发现的问题（缺陷与建议都报），没有就是空数组 */
  findings: Finding[];
  /** 上一轮修复、本轮复测确认已解决的历史问题编号 */
  verifiedFixed: string[];
  /** 想测但测不了的项及原因 */
  blocked: string[];
  /** 逐项执行台账：分到的每个清单/计划项都登记一条 */
  executed?: Array<{ id: string; done: boolean; note?: string }>;
  /** 覆盖说明与可疑但无证据的点，供下轮定向计划参考 */
  notes?: string;
}

interface FixReport {
  /** 本轮改动过的文件（相对项目根的相对路径；git add 只收这些，务必如实完整） */
  changedFiles: string[];
  /** 逐条修复说明，id 对应问题编号 */
  fixed: Array<{ id: string; how: string }>;
  /** 放弃修复的及原因 */
  skipped: Array<{ id: string; reason: string }>;
}

/** 定向复测计划里的一条：必须带依据，没有依据的条目不允许出现。 */
interface RetestPlanItem {
  /** 测试点：清单编号或具体页面/文件/场景描述（gap 类写清怎么到达） */
  what: string;
  /** 归属测试线 */
  line: "web" | "desktop" | "android" | "api";
  /** 理由类别：fix-verify=修复验证；blast-radius=牵连面回归；gap=缺口补测；cluster=聚集加深 */
  reasonKind: "fix-verify" | "blast-radius" | "gap" | "cluster";
  /** 一句话依据：凭什么测这条（引用上轮改动/历史问题/新发现入口） */
  why: string;
  /** 对应清单项的编号（有则填） */
  checklistId?: string;
  /** fix-verify 条目必须填：对应上轮修复的问题编号 */
  fixId?: string;
  /** 执行编号（计划后由脚本编发 pr轮-序号，随任务下发，台账按它登记） */
  id?: string;
}

interface RetestPlan {
  items: RetestPlanItem[];
}

/** 独立确证员对一个中高危发现的复现结论。 */
interface Confirmation {
  /** 对应问题编号 */
  id: string;
  /** 凭证据独立复现是否成立 */
  confirmed: boolean;
  /** 复现依据，或判定误报的原因 */
  note: string;
}

interface Review {
  /** 改动是否合格：修复对症、无新问题、无越界改动 */
  approved: boolean;
  /** 意见逐条；approved 时为空数组 */
  comments: string[];
}

interface RefreshReport {
  /** 每条线是否就绪（有几条线就必须有几条） */
  ready: Array<{ kind: string; ok: boolean; note?: string }>;
}

interface FinalDoc {
  /** 写入 qa-report.md 的完整 markdown 全文 */
  markdown: string;
  /** 两三句话总结 */
  summary: string;
}

// 旁观视图：问题看板 + 每轮新缺陷数
artifact.board("findings-board", {
  title: "问题看板",
  key: "id",
  status: "status",
  columns: ["待修复", "已修复待复测", "复测通过", "未确证", "放弃修复", "建议不修"],
  cardTitle: "what",
  detail: [{ field: "where" }, { field: "severity" }, { field: "line" }],
});
artifact.chart("rounds-chart", {
  title: "每轮新缺陷数",
  x: { field: "round", label: "轮次" },
  y: { field: "count", label: "新缺陷数" },
});

const lineLabel: Record<"web" | "desktop" | "android" | "api", string> = {
  web: "网页",
  desktop: "桌面",
  android: "安卓",
  api: "接口",
};

// 项目自带快速检查的门禁：命令名必须是编译期字面量，且必须自带根目录参数（world.run 的 cwd 是会话目录，不是被测项目）；超时/无法执行是 rejection 不是 exitCode，调用处必须 catch 并按门禁未跑成处理
async function runQuickCheck(qc: { cmd: string; args: string[] }): Promise<WorldRunResult | null> {
  switch (qc.cmd) {
    case "npm":
      return await world.run("npm", qc.args, { timeoutMs: 600000 });
    case "pnpm":
      return await world.run("pnpm", qc.args, { timeoutMs: 600000 });
    case "yarn":
      return await world.run("yarn", qc.args, { timeoutMs: 600000 });
    case "cargo":
      return await world.run("cargo", qc.args, { timeoutMs: 600000 });
    default:
      return null;
  }
}

function linePersona(kind: "web" | "desktop" | "android" | "api") {
  const common =
    "你是验收测试员：按分给你的条目从八个维度抠——" +
    "①功能：该有的行为有没有；②交互：操作跟手、有反馈；③报错：控制台干净、出错有提示不白屏；" +
    "④布局与多尺寸适配：不串行、不遮挡、不破版；" +
    "⑤异常输入与边界；⑥脏状态与中断恢复；" +
    "⑦数据一致性：同一数据多处显示要同步，改了要处处生效；⑧体验建议：文案、多余步骤。" +
    "定级规则：①-⑦类行为性问题按真实影响标 medium/high，⑤⑥⑦维度发现的问题一律不得标 low；" +
    "只有⑧纯文案与体验建议标 low（low 只记录不会被修）。" +
    "只测试，绝不修改任何文件。测不了的项如实列入 blocked，绝不编造结果；" +
    "偶发或不可复现的现象先重试复现，复现不了就写进 notes、不要当缺陷报；" +
    "分到的每个条目都要登记 executed 台账（done=true/false）；测不了的如实写进 blocked/notes 返回，不要绕过、不要编造；" +
    "但指令自相矛盾或任务前提不成立时，直接向运行主人提问，不要磨轮数硬凑。";
  if (kind === "web")
    return {
      system:
        common +
        "驱动浏览器的方式：先在 Git Bash 里试 cat ~/.zcode/skills/ego-browser/SKILL.md，" +
        "读得到就按它说的用 Bash 写 nodejs 脚本操作页面；读不到就改用本机可用的浏览器自动化（如 playwright 脚本）；" +
        "两条路都不通就把该线列入 blocked，不要编造。" +
        "你看不了截图图片：④布局与多尺寸适配用几何断言验证（getBoundingClientRect、元素包围盒重叠、不同视口宽下的盒模型），" +
        "截图只作报告附件，不作为你的判断依据。",
    };
  if (kind === "desktop")
    return {
      system:
        common +
        "驱动桌面应用的方式：在 ~/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/ 下" +
        "找最新版本目录里的 skills/computer-use/SKILL.md 并读它，按它的方式操作原生界面；" +
        "若你的工具集里没有对应能力就如实报 blocked，不要硬凑。",
    };
  if (kind === "android")
    return {
      system:
        common +
        "安卓真机测试方式：Bash 里用 adb（uiautomator dump 取界面结构、screencap 截图、input 模拟点击输入），" +
        "先 adb devices 确认设备在线。脏状态与中断恢复在这条线=切后台再回来、旋转屏幕、杀进程重进。" +
        "涉及提交/下单/支付等写操作前先确认登录的是测试账号；是真实账号就跳过该写操作并列入 blocked 说明。" +
        "你看不了截图图片：布局问题用 uiautomator 的 bounds 几何数据判断，截图只作报告附件。",
    };
  return {
    system:
      common +
      "接口测试方式：Bash 里用 curl 直接请求并断言状态码与响应体。" +
      "④布局与多尺寸适配维度在这条线不适用，忽略。",
  };
}

phase("探测被测项目环境");
const adbCheck = await world.run("adb", ["devices"]).catch(() => null);
const env = await agent("勘察员", {
  system:
    "你是环境勘察员：只调查不修改。判断被测项目属于哪些测试线（网页/桌面/安卓/接口，可多选），" +
    "查明每条线怎么启动、改码后怎么刷新到最新、项目是否 git 仓库。" +
    "再找项目自带的快速验证命令（package.json scripts / Makefile / CI 配置，如 test/build）：命令会在任意工作目录下执行，" +
    "所以 args 必须自带根目录参数——npm 用 --prefix、pnpm 用 --dir、yarn 用 --cwd、cargo 用 --manifest-path；" +
    "cmd 只能是 npm/pnpm/yarn/cargo 这四种，go/gradlew/flutter/python 等没有干净等价物，做不到就 quickCheck=null 并把原因写进 notes。" +
    "其他判断不了的就如实写进 notes，不要猜。",
}).ask<EnvPlan>(
  `勘察被测项目：${target}\n测试范围一句话：${scope}\n` +
    `本机 adb 检测结果：${adbCheck === null ? "未安装" : adbCheck.stdout.trim()}\n` +
    `用你的文件与命令工具实地查看（package.json / 构建脚本 / 仓库布局等）。projectRoot 必须原样返回：${target}`,
);

const kinds = Array.from(new Set(env.lines.map((l) => l.kind)));
const lines = kinds
  .map((k) => env.lines.find((l) => l.kind === k))
  .filter((l): l is EnvLine => l !== undefined)
  .filter((l) => !(adbCheck === null && l.kind === "android"));

const notCovered: string[] = [];
const seenNotCovered = new Set<string>();
function addNotCovered(s: string): void {
  if (!seenNotCovered.has(s)) {
    seenNotCovered.add(s);
    notCovered.push(s);
  }
}

if (adbCheck === null && env.lines.some((l) => l.kind === "android"))
  addNotCovered("本机未安装 adb，安卓线整线跳过（装好 adb 后重跑即可）");
if (!env.quickCheck)
  addNotCovered("项目无白名单可用的快速检查（仅支持 npm/pnpm/yarn/cargo 且能带根目录参数），修复循环与通过判定都没有机器门禁");
if (lines.length === 0)
  return {
    conclusion: `未能识别「${target}」的任何可测试线，验收未执行。勘察备注：${env.notes ?? "无"}`,
    findings: [],
    verified: [],
    notCovered: ["全部——环境探测没有给出可执行的测试线"],
  };

log(`识别出 ${lines.length} 条测试线：${lines.map((l) => lineLabel[l.kind]).join("、")}`);

phase("按测试范围生成验收清单");
const checklist = await agent("清单员", {
  system:
    "你是验收清单员：把测试范围展开成可逐条验收的清单——页面、功能流、界面区域、接口，" +
    "每项一句话说清怎么到达怎么测，并归入对应测试线。范围含糊就按项目实际情况全量展开。",
}).ask<Checklist>(
  `项目根目录：${root}\n测试范围：${scope}\n测试线：${JSON.stringify(lines.map((l) => l.kind))}\n` +
    `实地查看项目（路由/页面/模块/接口定义）后生成验收清单。`,
);

const testers = lines.map((l) => ({
  line: l,
  tester: agent(`测试员·${lineLabel[l.kind]}`, linePersona(l.kind)),
}));
const fixer = agent("修复工程师", {
  system:
    "你是修复工程师：只改被测项目源码，逐条修复给出的缺陷级问题，不做无关重构，不顺手优化。" +
    "changedFiles 必须用相对项目根的相对路径、如实完整上报（后续 git add 只收这些文件，漏报等于改动丢失；每次返工/补救后都要报全量改动清单）。" +
    "修完只做针对所修问题的定向自查；项目自带的测试套件由脚本统一执行，你不要自己跑全量套件。" +
    "实在修不了的把真实原因写进 skipped 返回，不要硬凑；指令矛盾或要求只能靠越界改动满足时，直接向运行主人提问而不是绕过。",
});
const reviewer = agent("代码审查员", {
  system:
    "你是代码审查员：审每轮验收修复的改动。只读不写。判断三件事：修复是否对症、有没有引入新问题、" +
    "有没有越界改动（changedFiles 之外的工作区改动也要点名）。意见具体到文件与行；没问题就 approved，不要为了显得严格硬挑。",
});
const planner = agent("复测计划员", {
  system:
    "你是复测计划员：只制定向复测计划，不执行测试。计划里每条必须带理由，理由只许四类——" +
    "fix-verify（修复验证：重放原问题场景，必须带 fixId，上一轮 fixed 的每条问题都要覆盖到）、" +
    "blast-radius（牵连面：真去读代码，列出改动文件的调用方与共享方）、" +
    "gap（缺口：上轮新发现的入口、分支，或修复引入的新路径）、" +
    "cluster（聚集：历史出过至少 2 个问题的模块，写明这轮往哪个方向加深、凭什么）。" +
    "给不出具体依据的条目不要写，宁缺毋滥，不许为了凑数把全量塞回来。",
});

phase("启动被测环境");
const refresher = agent("环境刷新员", {
  system:
    "你负责让被测环境跑起来、并始终跑最新代码：网页=启动/重启 dev server 并确认可访问；" +
    "接口=重启服务并确认健康；桌面=重新构建并启动应用；安卓=构建 APK 并 adb install 到设备。" +
    "只做环境刷新，不改业务代码。失败如实报告，不要假装就绪；ready 数组有几条测试线就必须有几条。",
});
const startReport = await refresher.ask<RefreshReport>(
  `启动被测环境。项目根目录：${root}\n各线启动方式：\n${JSON.stringify(
    lines.map((l) => ({ kind: l.kind, howToRun: l.howToRun })),
  )}\n逐线确认就绪并返回结果。`,
);
let envReady = startReport.ready.length === lines.length && startReport.ready.every((r) => r.ok);
for (const r of startReport.ready)
  if (!r.ok) addNotCovered(`启动失败·${r.kind}：${r.note ?? "无说明"}`);

const allFindings: Finding[] = [];
const verifiedFixed = new Set<string>();
const skippedIds = new Set<string>();
const unconfirmedIds = new Set<string>();
const superseded = new Set<string>();
const unconfirmedCount = new Map<string, number>(); // 同 where+what 的累计确证失败次数（幽灵缺陷熔断）
const coveredIds = new Set<string>();
const roundLog: Array<{ round: number; found: number; fixed: number; committed: boolean }> = [];
const commitLog: string[] = [];
const reviewLog: string[] = [];
const checkLog: string[] = [];
let finalStatus = "";
let lastFix: FixReport = { changedFiles: [], fixed: [], skipped: [] };
let lastRoundFindings: Finding[] = [];
let lastRoundNotes: string[] = [];
let codeUngated = true; // 当前被测代码是否未经快检把关（初始=从未跑过；修复改动后置 true，快检通过置 false）

/** 幽灵缺陷熔断的匹配键：同一位置+同一问题视为同一个幽灵（空白与全半角先归一，防措辞微差漏配）。 */
function ghostKey(f: Finding): string {
  const norm = (s: string) =>
    s.replace(/\s+/g, " ").trim().replace(/[＀-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return JSON.stringify([norm(f.where), norm(f.what)]);
}

/** 未终结的缺陷级问题：既没复测通过，也没放弃、没判未确证、没被复发新编号接替。 */
function openIssues(): Finding[] {
  return allFindings.filter(
    (f) =>
      f.severity !== "low" &&
      !verifiedFixed.has(f.id) &&
      !skippedIds.has(f.id) &&
      !unconfirmedIds.has(f.id) &&
      !superseded.has(f.id),
  );
}

/** 已知缺陷：修不了被放弃或未确证、但仍在案的缺陷级问题（high 挡通过，medium 降级判词）。 */
function knownDefects(): Finding[] {
  return allFindings.filter(
    (f) =>
      f.severity !== "low" &&
      (skippedIds.has(f.id) || unconfirmedIds.has(f.id)) &&
      !superseded.has(f.id),
  );
}

async function snapshot(round: number): Promise<void> {
  await artifact.markdown(
    "progress",
    [
      "# 全流程验收·进度快照",
      "",
      `- 状态：${finalStatus || `第 ${round} 轮进行中或刚结束`}`,
      `- 缺陷级：累计 ${allFindings.filter((f) => f.severity !== "low").length} 个，复测通过 ${Array.from(verifiedFixed).filter((id) => !superseded.has(id)).length} 个，未终结 ${openIssues().length} 个，已知缺陷 ${knownDefects().length} 个；建议类（不修）${allFindings.filter((f) => f.severity === "low").length} 条`,
      `- 逐轮：${roundLog.map((r) => `第${r.round}轮发现${r.found}修${r.fixed}${r.committed ? "已提交" : "未提交"}`).join("；")}`,
      `- 未覆盖/存疑：${notCovered.length} 条`,
    ].join("\n"),
    { title: "进度快照" },
  );
}

for (let round = 1; round <= MAX_ROUNDS; round++) {
  let results: TestResult[] = [];
  let auditIds: string[] = [];

  if (round === 1) {
    phase("基线全量测试");
    log(`第 1 轮基线：${checklist.items.length} 个清单项 × 8 维度，${testers.length} 条线并行，每 6 项一批`);
    const perLine = await Promise.all(
      testers.map(async ({ line, tester }) => {
        const mine = checklist.items.filter((i) => i.line === line.kind);
        const out: TestResult[] = [];
        for (let i = 0; i < mine.length; i += 6) {
          const chunk = mine.slice(i, i + 6);
          try {
            out.push(
              await tester.ask<TestResult>(
                `第 1 轮基线全量测试（只有这轮是全量）。项目根目录：${root}\n你的线：${lineLabel[line.kind]}（${line.howToRun}）\n范围：${scope}\n` +
                  `本批清单项（每项过 8 个维度）：\n${JSON.stringify(chunk)}\n` +
                  `每个发现都要有证据；定级按系统提示的规则；偶发现象先重试复现，复现不了写进 notes 别当缺陷；` +
                  `本批每项登记 executed 台账；整体覆盖说明和可疑点写进 notes。`,
              ),
            );
          } catch (e) {
            addNotCovered(
              `第 1 轮·${lineLabel[line.kind]}线第 ${Math.floor(i / 6) + 1} 批测试会话失败（${String(e).slice(0, 120)}），按未测计：${chunk.map((c) => c.id).join("、")}`,
            );
          }
        }
        return { kind: line.kind, results: out, ids: mine.map((i) => i.id) };
      }),
    );
    results = perLine.flatMap((p) => p.results);
    auditIds = perLine.flatMap((p) => p.ids);
    for (const p of perLine) for (const f of p.results.flatMap((r) => r.findings)) f.line = p.kind;
  } else {
    phase("制定向复测计划");
    if (!envReady) {
      const retry = await refresher.ask<RefreshReport>(
        `上轮环境刷新未全部就绪，重试一次：\n${JSON.stringify(lines.map((l) => ({ kind: l.kind, howToRefresh: l.howToRefresh })))}\n逐线确认就绪。`,
      );
      envReady = retry.ready.length === lines.length && retry.ready.every((r) => r.ok);
      for (const r of retry.ready)
        if (!r.ok) addNotCovered(`第${round}轮·刷新重试仍失败·${r.kind}：${r.note ?? "无说明"}`);
      if (!envReady) {
        finalStatus = `第 ${round} 轮前环境刷新失败，为避免在旧代码上复测，验收中止（未证实）`;
        roundLog.push({ round, found: 0, fixed: 0, committed: false });
        await snapshot(round);
        break;
      }
    }
    const plan = await planner.ask<RetestPlan>(
      `第 ${round} 轮定向复测计划。项目根目录：${root}\n` +
        `上一轮修复：${JSON.stringify(lastFix.fixed.map((f) => ({ id: f.id, how: f.how })))}；上轮改动文件：${JSON.stringify(lastFix.changedFiles)}\n` +
        `上一轮新发现：${JSON.stringify(lastRoundFindings.map((f) => ({ id: f.id, what: f.what, severity: f.severity })))}\n` +
        `历史全部问题（精简）：${JSON.stringify(allFindings.map((f) => ({ id: f.id, where: f.where, what: f.what, severity: f.severity })))}\n` +
        `测试员上轮备注：${JSON.stringify(lastRoundNotes)}\n` +
        `清单（引用编号）：${JSON.stringify(checklist.items.map((i) => ({ id: i.id, title: i.title, line: i.line })))}\n` +
        `每条给 what/line/reasonKind/why，对应清单项的填 checklistId；fix-verify 条目必须带 fixId 且覆盖上轮全部 fixed 问题；gap 类新条目把到达方式写进 what。`,
    );
    // 代码校验兜底：计划员漏了哪个上轮修复没给 fix-verify，自动补条（快检合成问题除外——快检本身就是复验）
    const coveredFixIds = new Set(plan.items.filter((i) => i.fixId).map((i) => i.fixId));
    let autoAdded = 0;
    for (const fx of lastFix.fixed) {
      if (fx.id.startsWith("qc-r") || coveredFixIds.has(fx.id)) continue;
      const prev = allFindings.find((f) => f.id === fx.id);
      if (prev?.line) {
        plan.items.push({
          what: `复测问题 ${fx.id} 的修复是否生效`,
          line: prev.line,
          reasonKind: "fix-verify",
          why: `代码校验自动补条：计划员未覆盖上轮修复 ${fx.id}`,
          fixId: fx.id,
        });
        autoAdded++;
        addNotCovered(`第${round}轮·计划员漏了 ${fx.id} 的修复验证，已自动补条`);
      } else addNotCovered(`问题 ${fx.id} 缺线别信息，无法自动补条复测`);
    }
    // 每条计划项编执行编号 pr轮-序号：台账按 id 登记，不再依赖 checklistId 才进审计
    const planItems = plan.items.map((item, i) => ({ ...item, id: `pr${round}-${i + 1}` }));
    for (let i = 0; i < planItems.length; i++) {
      const item = planItems[i];
      auditIds.push(item.id);
      if (item.checklistId) coveredIds.add(item.checklistId);
      if (item.reasonKind === "gap") {
        const id = `gap-r${round}-${i + 1}`;
        checklist.items.push({ id, title: item.what, how: item.what, line: item.line });
        coveredIds.add(id);
      }
    }
    log(
      `第 ${round} 轮定向计划：${planItems.length} 条（自动补条 ${autoAdded}），理由类别：${Array.from(new Set(planItems.map((i) => i.reasonKind))).join("/")}`,
    );
    if (planItems.length > 0) {
      phase("执行定向复测");
      const perLine = await Promise.all(
        testers.map(async ({ line, tester }) => {
          const mine = planItems.filter((i) => i.line === line.kind);
          const out: TestResult[] = [];
          for (let i = 0; i < mine.length; i += 6) {
            const chunk = mine.slice(i, i + 6);
            try {
              out.push(
                await tester.ask<TestResult>(
                  `第 ${round} 轮定向复测。逐条执行——先读 why，按它指的方向和深度测，不要自行扩成全量：\n${JSON.stringify(chunk)}\n` +
                    `确认已解决的历史问题把编号列进 verifiedFixed；新发现照常报；偶发先复现再报；` +
                    `测不了的进 blocked；每条按它的 id 登记 executed 台账；顺带发现的新入口写进 notes 供下轮计划。`,
                ),
              );
            } catch (e) {
              addNotCovered(
                `第 ${round} 轮定向·${lineLabel[line.kind]}线第 ${Math.floor(i / 6) + 1} 批复测会话失败（${String(e).slice(0, 120)}），按未测计：${chunk.map((c) => c.what.slice(0, 40)).join("；")}`,
              );
            }
          }
          return { kind: line.kind, results: out };
        }),
      );
      results = perLine.flatMap((p) => p.results);
      for (const p of perLine) for (const f of p.results.flatMap((r) => r.findings)) f.line = p.kind;
    }
  }

  const newFindings = results.flatMap((r) => r.findings);
  const newDefects = newFindings.filter((f) => f.severity !== "low");
  for (const r of results)
    for (const v of r.verifiedFixed) {
      const old = allFindings.find((f) => f.id === v);
      if (old && !verifiedFixed.has(v)) {
        verifiedFixed.add(v);
        report({ ...old, status: "复测通过" }, "findings-board");
      }
    }
  // 跨轮复发合并：同 where+what 的未闭环旧缺陷，由新编号接替跟踪，旧编号不再计残留
  for (const f of newDefects) {
    const dup = allFindings.find(
      (o) => o.severity !== "low" && o.where === f.where && o.what === f.what && !superseded.has(o.id),
    );
    if (dup && !verifiedFixed.has(dup.id)) superseded.add(dup.id);
  }
  for (const f of newFindings)
    report({ ...f, status: f.severity === "low" ? "建议不修" : "待修复" }, "findings-board");
  // 幽灵缺陷熔断：同 where+what 已累计确证失败 GHOST_LIMIT 次的复发报告不再进确证流水线，直接按未确证在案处理
  const ghosts = newDefects.filter((f) => (unconfirmedCount.get(ghostKey(f)) ?? 0) >= GHOST_LIMIT);
  const liveDefects = newDefects.filter((f) => (unconfirmedCount.get(ghostKey(f)) ?? 0) < GHOST_LIMIT);
  for (const g of ghosts) {
    unconfirmedIds.add(g.id);
    report({ ...g, status: "未确证" }, "findings-board");
    addNotCovered(
      `问题 ${g.id} 与已 ${GHOST_LIMIT} 次确证失败的相同问题（${g.where}）匹配，熔断：不再重复确证，按未确证在案处理`,
    );
  }
  const blockedAll = results.flatMap((r) => r.blocked).filter((b) => b);
  for (const b of blockedAll) addNotCovered(`第${round}轮·测不了：${b}`);
  const executedIds = new Set(
    results.flatMap((r) => (r.executed ?? []).filter((e) => e.done).map((e) => e.id)),
  );
  const notRun = auditIds.filter((id) => !executedIds.has(id));
  if (notRun.length > 0) addNotCovered(`第${round}轮·台账缺登记（按未测计）：${notRun.join("、")}`);
  // 通过判定的机器门禁：本轮零活缺陷且当前代码未经快检（从未跑过或修过没跑过）时，判「通过」前先真跑一次；
  // 失败即合成缺陷级发现进修复流水线——退出码就是确证，不再派确证员复核机器已判的事
  let verdictGateHole = false;
  if (liveDefects.length === 0 && env.quickCheck && codeUngated) {
    if (!["npm", "pnpm", "yarn", "cargo"].includes(env.quickCheck.cmd)) verdictGateHole = true;
    else {
      const check = await runQuickCheck(env.quickCheck).catch(() => null);
      if (check === null) {
        verdictGateHole = true;
        addNotCovered(`第${round}轮·通过前快检超时或无法执行`);
      } else if (check.exitCode !== 0) {
        const f: Finding = {
          id: `qc-r${round}`,
          where: "项目快速检查（quickCheck）",
          what: `${env.quickCheck.cmd} ${env.quickCheck.args.join(" ")} 退出码 ${check.exitCode}`,
          evidence: (check.stderr || check.stdout).slice(0, 500),
          severity: "medium",
          line: "api",
        };
        newFindings.push(f);
        liveDefects.push(f);
        report({ ...f, status: "待修复" }, "findings-board");
        log(`通过前快检未过，合成缺陷 ${f.id} 进修复流水线`);
      } else {
        checkLog.push(`第${round}轮·通过前快检通过`);
        codeUngated = false;
      }
    }
  }
  report({ round, count: liveDefects.length }, "rounds-chart");
  allFindings.push(...newFindings);
  lastRoundFindings = newFindings;
  lastRoundNotes = results.flatMap((r) => (typeof r.notes === "string" && r.notes ? [r.notes] : []));

  if (liveDefects.length === 0) {
    const open = openIssues();
    const known = knownDefects();
    const knownHigh = known.filter((f) => f.severity === "high");
    const knownMedium = known.filter((f) => f.severity === "medium");
    const gaps: string[] = [];
    if (blockedAll.length > 0) gaps.push(`有 ${blockedAll.length} 项测不了`);
    if (notRun.length > 0) gaps.push(`${notRun.length} 项台账未登记`);
    if (!envReady) gaps.push("环境未全部就绪");
    if (verdictGateHole) gaps.push("通过前快检无法执行或不在白名单");
    if (round === 1 && checklist.items.length === 0) gaps.push("验收清单为空");
    if (open.length > 0)
      gaps.push(`存在 ${open.length} 个未终结问题（已修未复测/复发未闭环/悬置）：${open.map((f) => f.id).join("、").slice(0, 200)}`);
    if (knownHigh.length > 0)
      gaps.push(`有 ${knownHigh.length} 个 high 级缺陷已放弃修复或未确证：${knownHigh.map((f) => f.id).join("、").slice(0, 150)}`);
    if (gaps.length === 0) {
      const roundName =
        round === 1
          ? "第 1 轮基线全量零新缺陷（建议类只记录）且覆盖完整（单轮通过，未经修复-复测闭环）"
          : `第 ${round} 轮定向复测（修复验证/牵连面/缺口/聚集）全部执行、零新缺陷且无未终结问题（闭环通过）`;
      finalStatus =
        knownMedium.length > 0
          ? `${roundName}，但带 ${knownMedium.length} 个已知缺陷（medium 级放弃/未确证在案），带已知缺陷通过`
          : `${roundName}，验收通过`;
    } else {
      finalStatus = `第 ${round} 轮零新缺陷，但${gaps.join("；")}，不能判定验收通过`;
      for (const g of gaps) addNotCovered(`第${round}轮·${g}`);
    }
    roundLog.push({ round, found: 0, fixed: 0, committed: false });
    await snapshot(round);
    break;
  }

  const serious = liveDefects;
  const machineDecided = new Set(serious.filter((f) => f.id.startsWith("qc-r")).map((f) => f.id)); // 快检合成发现：退出码即确证，不派确证员
  const toConfirm = serious.filter((f) => !machineDecided.has(f.id));
  const confirmed = new Set<string>(machineDecided);
  let fixable: Finding[] = [];
  if (toConfirm.length > 0) {
    phase("独立确证缺陷级发现");
    log(`独立复现 ${toConfirm.length} 个缺陷级发现${machineDecided.size > 0 ? `；另有 ${machineDecided.size} 条快检合成发现已由退出码确证` : ""}`);
    const settled = await Promise.allSettled(
      toConfirm.map((f, i) =>
        agent(`确证员·${i}-${f.id}`).ask<Confirmation>(
          `独立复现下面这个发现，只凭它自己的证据判断真伪，不要先入为主。项目根目录：${root}\n发现：${JSON.stringify(f)}\n` +
            `用你的工具实地核实（读代码/实际操作/定向跑命令；项目全量测试套件由脚本统一执行，你不要跑全量，只做针对该发现的定向验证）；复现成立才 confirmed=true；确证不了或证明是误报都如实写进 note。只调查不修改；证据与结论矛盾或指令自相矛盾时如实说明返回，必要时向运行主人提问。`,
        ),
      ),
    );
    const verdicts: Confirmation[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") verdicts.push(s.value);
      else addNotCovered(`问题 ${toConfirm[i].id} 确证会话失败（${String(s.reason).slice(0, 120)}），该问题保持未终结`);
    }
    for (const v of verdicts.filter((v) => v.confirmed)) confirmed.add(v.id);
    for (const v of verdicts.filter((x) => !x.confirmed)) {
      const f = serious.find((x) => x.id === v.id);
      if (f) {
        report({ ...f, status: "未确证" }, "findings-board");
        unconfirmedIds.add(v.id);
        unconfirmedCount.set(ghostKey(f), (unconfirmedCount.get(ghostKey(f)) ?? 0) + 1);
      }
      addNotCovered(`问题 ${v.id} 未经确证不修：${v.note}`);
    }
  }
  fixable = serious.filter((f) => confirmed.has(f.id));

  let committed = false;
  if (fixable.length > 0) {
    phase("修复本轮全部问题");
    let fix = await fixer.ask<FixReport>(
      `修复以下 ${fixable.length} 个缺陷级问题，只改 ${root} 下的源码：\n${JSON.stringify(fixable)}\n` +
        `逐条返回怎么修的；实在修不了的给原因；changedFiles 用相对 ${root} 的相对路径、如实完整上报。`,
    );

    phase("审查改动并提交");
    let review = await reviewer.ask<Review>(
      `审本轮修复。改动文件：${JSON.stringify(fix.changedFiles)}\n本轮修复的问题：${JSON.stringify(fixable.map((f) => f.id))}\n` +
        `${env.isGit ? `可先跑 git -C "${root}" diff HEAD 看全部未提交改动（changedFiles 之外的改动要点名），` : "该项目不是 git 仓库，"}再读改动文件本身核对。`,
    );
    if (!review.approved) {
      fix = await fixer.ask<FixReport>(
        `代码审查员退回本轮改动，逐条处理：\n${JSON.stringify(review.comments)}\n处理完返回新的 FixReport（changedFiles 报全部改动）。`,
      );
      review = await reviewer.ask<Review>("修复者已按你的意见返工，复审本轮改动（同上标准）。");
    }
    let commitBlocker = review.approved ? "" : `复审否决：${review.comments.join("；").slice(0, 300)}`;
    if (review.approved && env.quickCheck) {
      const inWhitelist = ["npm", "pnpm", "yarn", "cargo"].includes(env.quickCheck.cmd);
      if (!inWhitelist) addNotCovered(`quickCheck 命令 ${env.quickCheck.cmd} 不在白名单，门禁未执行`);
      let check = inWhitelist ? await runQuickCheck(env.quickCheck).catch(() => null) : null;
      if (check && check.exitCode !== 0) {
        fix = await fixer.ask<FixReport>(
          `项目自带的快速检查没过，修复它（只改 ${root} 下源码；返回新的 FixReport，changedFiles 报全部改动）：\n${(check.stderr || check.stdout).slice(0, 1500)}`,
        );
        check = await runQuickCheck(env.quickCheck).catch(() => null);
      }
      if (!check && inWhitelist) {
        commitBlocker = "项目快速检查超时或无法执行";
      } else if (check && check.exitCode !== 0) {
        commitBlocker = "项目快速检查未通过";
      } else if (check) {
        checkLog.push(`第${round}轮·项目快速检查通过`);
        codeUngated = false;
        // 快检转绿同时闭环在案的快检合成问题（qc-*）——「快检失败」这类缺陷，转绿即复验通过
        for (const f of allFindings)
          if (f.id.startsWith("qc-r") && !verifiedFixed.has(f.id) && !skippedIds.has(f.id)) {
            verifiedFixed.add(f.id);
            report({ ...f, status: "复测通过" }, "findings-board");
          }
      }
    }
    if (commitBlocker) {
      addNotCovered(`第${round}轮·${commitBlocker}，改动留在工作区不提交`);
      reviewLog.push(`第${round}轮未提交：${commitBlocker}`);
      log(`⚠️ 第 ${round} 轮不提交（${commitBlocker.slice(0, 120)}）`);
    } else if (env.isGit) {
      const files = fix.changedFiles.filter((f) => f && f.trim().length > 0);
      if (files.length === 0 && fix.fixed.length > 0) {
        addNotCovered(`第${round}轮·修复者未报改动文件，为避免全仓扫入不提交`);
        log("⚠️ changedFiles 为空，本轮只改文件不提交");
      } else if (files.length > 0) {
        const add = await world.run("git", ["-C", root, "add", "--", ...files]);
        if (add.exitCode === 0) {
          const commit = await world.run("git", [
            "-C",
            root,
            "commit",
            "-m",
            `全流程验收 第${round}轮：修复 ${fix.fixed.length} 个问题（待下轮复测）`,
          ]);
          committed = commit.exitCode === 0;
          if (committed) commitLog.push(`第${round}轮：修复 ${fix.fixed.length} 个问题`);
          else log(`⚠️ 第 ${round} 轮提交失败：${commit.stderr.slice(0, 200)}`);
        } else log(`⚠️ git add 失败，本轮只改文件不提交：${add.stderr.slice(0, 200)}`);
      }
    }
    lastFix = fix;
    if (fix.changedFiles.length > 0) codeUngated = true;
    for (const f of fixable) {
      const skipped = fix.skipped.some((s) => s.id === f.id);
      report({ ...f, status: skipped ? "放弃修复" : "已修复待复测" }, "findings-board");
    }
    for (const s of fix.skipped) {
      skippedIds.add(s.id);
      addNotCovered(`问题 ${s.id} 放弃修复：${s.reason}`);
    }
    roundLog.push({ round, found: liveDefects.length, fixed: fix.fixed.length, committed });
  } else {
    lastFix = { changedFiles: [], fixed: [], skipped: [] };
    roundLog.push({ round, found: liveDefects.length, fixed: 0, committed: false });
    log(`第 ${round} 轮无可修项（缺陷全未确证或无缺陷发现，建议类只记录）`);
  }

  if (round === MAX_ROUNDS) {
    finalStatus = `达到 ${MAX_ROUNDS} 轮上限强制停止`;
    if (lastFix.fixed.length > 0) addNotCovered(`第 ${MAX_ROUNDS} 轮的修复未复测（轮数上限）`);
    await snapshot(round);
    break;
  }

  if (fixable.length > 0) {
    phase("刷新环境准备复测");
    const refresh = await refresher.ask<RefreshReport>(
      `第 ${round} 轮修复已就绪，让所有线跑最新代码：\n${JSON.stringify(
        lines.map((l) => ({ kind: l.kind, howToRefresh: l.howToRefresh })),
      )}\n逐线确认就绪。`,
    );
    envReady = refresh.ready.length === lines.length && refresh.ready.every((r) => r.ok);
    for (const r of refresh.ready)
      if (!r.ok) addNotCovered(`第${round}轮刷新失败·${r.kind}：${r.note ?? "无说明"}`);
  } else {
    log(`第 ${round} 轮无可修项未改动代码，跳过环境刷新`);
  }
  await snapshot(round);
}

const untouched = checklist.items.filter((i) => !coveredIds.has(i.id)).map((i) => i.id);
const openFinal = openIssues();
const knownFinal = knownDefects();
const verifiedCount = Array.from(verifiedFixed).filter((id) => !superseded.has(id)).length;
const suggestions = allFindings.filter((f) => f.severity === "low");

phase("汇总验收报告");
let reportWritten = true;
let doc: FinalDoc;
try {
  doc = await agent("汇总员", {
    system:
      "你是验收汇总员：把整场验收写成给项目负责人看的中文 markdown 报告——总结论先行，" +
      "然后逐轮记录（基线轮全量、后续定向轮及其计划依据）、缺陷全表（含最终状态与确证结论，复发条目按合并提示归并）、" +
      "建议清单（low，只记录不修）、审查与提交情况、未覆盖项。" +
      "不美化：没测到的就写没测到，「只过基线未被复测」的项要单独列出；「验收通过」四个字只有终止状态明确写了才允许出现。" +
      "存在「带已知缺陷通过」时要把已知缺陷单独成节列明；报告末尾附「已知取舍」一段：不开分支直接提当前分支、多线并行打同一被测环境可能互扰、无时长/token 预算、安卓真机装机（有测试账号守卫）。",
  }).ask<FinalDoc>(
    `把验收报告写入 ${root}/qa-report.md（用你的文件工具），并返回全文。\n` +
      `终止状态：${finalStatus}\n逐轮记录：${JSON.stringify(roundLog)}\n` +
      `全部问题：${JSON.stringify(allFindings.map((f) => ({ ...f, result: verifiedFixed.has(f.id) ? "复测通过" : "未通过或未复测" })))}\n` +
      `复发合并（旧编号由新编号接替）：${JSON.stringify(Array.from(superseded))}\n` +
      `未终结缺陷：${JSON.stringify(openFinal.map((f) => f.id))}\n` +
      `已知缺陷清单（放弃/未确证在案）：${JSON.stringify(knownFinal.map((f) => ({ id: f.id, severity: f.severity, where: f.where, what: f.what })))}\n` +
      `建议清单（low，不修）：${JSON.stringify(suggestions.map((f) => ({ where: f.where, what: f.what })))}\n` +
      `只过基线、从未进入定向轮的清单项：${JSON.stringify(untouched)}\n` +
      `提交记录：${JSON.stringify(commitLog)}\n审查记录：${JSON.stringify(reviewLog)}\n快速检查记录：${JSON.stringify(checkLog)}\n未覆盖项：${JSON.stringify(notCovered)}`,
  );
} catch (e) {
  // 汇总会话失败不丢整场成果：代码拼简版报告兜底（qa-report.md 未写入，报告以卡片交付）
  reportWritten = false;
  doc = {
    markdown: [
      "# 全流程验收·简版报告（汇总会话失败，由脚本兜底生成）",
      "",
      `- 终止状态：${finalStatus}`,
      `- 逐轮：${roundLog.map((r) => `第${r.round}轮发现${r.found}修${r.fixed}${r.committed ? "已提交" : "未提交"}`).join("；")}`,
      `- 复测通过：${Array.from(verifiedFixed).filter((id) => !superseded.has(id)).join("、") || "无"}`,
      `- 未终结：${openFinal.map((f) => f.id).join("、") || "无"}`,
      `- 已知缺陷：${knownFinal.map((f) => `${f.id}（${f.severity}）`).join("、") || "无"}`,
      `- 建议类（不修）：${suggestions.length} 条`,
      `- 只过基线未被定向轮覆盖：${untouched.join("、") || "无"}`,
      `- 提交记录：${commitLog.join("；") || "无"}`,
      `- 审查记录：${reviewLog.join("；") || "无"}`,
      `- 快检记录：${checkLog.join("；") || "无"}`,
      "",
      "## 未覆盖项",
      ...notCovered.map((s) => `- ${s}`),
    ].join("\n"),
    summary: `汇总会话失败（${String(e).slice(0, 120)}），已生成简版报告；${root}/qa-report.md 未写入，缺陷明细见问题看板。`,
  };
}
await artifact.markdown("qa-report", doc.markdown, {
  title: "全流程验收报告",
  description: `${finalStatus}；缺陷级 ${allFindings.filter((f) => f.severity !== "low").length} 个（复测通过 ${verifiedCount}、未终结 ${openFinal.length}、已知缺陷 ${knownFinal.length}），建议 ${suggestions.length} 条不修。`,
  primary: true,
});

return {
  conclusion:
    `${finalStatus}。缺陷级问题：累计 ${allFindings.filter((f) => f.severity !== "low").length} 个，复测通过 ${verifiedCount} 个，未终结 ${openFinal.length} 个，已知缺陷（放弃/未确证在案）${knownFinal.length} 个；` +
    `另有建议 ${suggestions.length} 条只记录不修；${untouched.length} 个清单项只过基线未被定向轮覆盖。完整报告：${reportWritten ? `${root}/qa-report.md` : "上方简版报告卡片（qa-report.md 未写入）"}。${doc.summary}`,
  findings: allFindings.map((f) => ({
    ...f,
    status: verifiedFixed.has(f.id) && !superseded.has(f.id) ? ("verified" as const) : ("unconfirmed" as const),
  })),
  verified: [`第 1 轮为全量基线；停止依据=${finalStatus}`, ...checkLog],
  notCovered,
};
