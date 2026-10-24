/* zcode-workflow
description: 全流程验收：自动识别网页/桌面/安卓/接口四条测试线，从八个维度（功能/交互/报错/多尺寸布局/异常输入/脏状态中断/数据一致性/体验建议）做测→修→审→提交→刷新→复测，直到一轮零新问题（含建议类）或达
  5 轮上限；报告写入项目根 qa-report.md。
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
// 全流程验收 —— 测 → 修 → 审 → 提交 → 刷新 → 复测，直到一轮零新问题或达轮数上限。
// 四条测试线自动识别：网页 / 桌面应用 / 安卓(adb) / 后端接口。

const target = typeof args.target === "string" ? args.target.trim() : "";
const scope = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim() : "全部页面、功能和接口";
const MAX_ROUNDS = 5;

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
  /** 被测项目根目录（绝对路径） */
  projectRoot: string;
  /** 识别出的测试线 */
  lines: EnvLine[];
  /** 项目是否 git 仓库 */
  isGit: boolean;
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
  /** 证据：报错输出、截图路径、断言结果等 */
  evidence: string;
  /** low=建议类；medium=一般缺陷；high=崩溃/数据丢失/错误结果 */
  severity: "low" | "medium" | "high";
}

interface TestResult {
  /** 本轮新发现的问题（含建议类），没有就是空数组 */
  findings: Finding[];
  /** 上一轮修复、本轮复测确认已解决的历史问题编号 */
  verifiedFixed: string[];
  /** 想测但测不了的项及原因 */
  blocked: string[];
}

interface FixReport {
  /** 本轮改动过的文件 */
  changedFiles: string[];
  /** 逐条修复说明，id 对应问题编号 */
  fixed: Array<{ id: string; how: string }>;
  /** 放弃修复的及原因 */
  skipped: Array<{ id: string; reason: string }>;
}

interface Review {
  /** 改动是否合格：修复对症、无新问题、无越界改动 */
  approved: boolean;
  /** 意见逐条；approved 时为空数组 */
  comments: string[];
}

interface RefreshReport {
  /** 每条线是否就绪 */
  ready: Array<{ kind: string; ok: boolean; note?: string }>;
}

interface FinalDoc {
  /** 写入 qa-report.md 的完整 markdown 全文 */
  markdown: string;
  /** 两三句话总结 */
  summary: string;
}

// 旁观视图：问题看板 + 每轮新发现数
artifact.board("findings-board", {
  title: "问题看板",
  key: "id",
  status: "status",
  columns: ["待修复", "已修复待复测", "复测通过"],
  cardTitle: "what",
  detail: [{ field: "where" }, { field: "severity" }],
});
artifact.chart("rounds-chart", {
  title: "每轮新发现数",
  x: { field: "round", label: "轮次" },
  y: { field: "count", label: "新问题数" },
});

const lineLabel: Record<"web" | "desktop" | "android" | "api", string> = {
  web: "网页",
  desktop: "桌面",
  android: "安卓",
  api: "接口",
};

function linePersona(kind: "web" | "desktop" | "android" | "api") {
  const common =
    "你是验收测试员：穷尽式测试分给你的清单项，从八个维度抠——" +
    "①功能：该有的行为有没有；②交互：操作跟手、有反馈；③报错：控制台干净、出错有提示不白屏；" +
    "④布局与多尺寸适配：手机宽/平板宽/电脑宽各过一遍，不串行、不遮挡、不破版；" +
    "⑤异常输入与边界：空值、超长、emoji/特殊字符、负数、错误类型都喂一遍；" +
    "⑥脏状态与中断恢复：连点提交、中途返回、填一半刷新、断网重试、退出再进；" +
    "⑦数据一致性：同一数据多处显示要同步，改了要处处生效；⑧体验建议：文案、多余步骤。" +
    "八类发现全算问题。只测试，绝不修改任何文件。测不了的项如实列入 blocked，" +
    "绝不编造结果；环境缺失或指令矛盾时直接上报，不要绕过。";
  if (kind === "web")
    return {
      system:
        common +
        "驱动浏览器的方式：先在 Git Bash 里试 cat ~/.zcode/skills/ego-browser/SKILL.md，" +
        "读得到就按它说的用 Bash 写 nodejs 脚本操作页面（打开、点击、填表、截图、取内容）；" +
        "读不到就改用本机可用的浏览器自动化（如 playwright 脚本）；两条路都不通就把该线列入 blocked，不要编造。",
    };
  if (kind === "desktop")
    return {
      system:
        common +
        "驱动桌面应用的方式：在 ~/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/ 下" +
        "找最新版本目录里的 skills/computer-use/SKILL.md 并读它，按它的方式用鼠标键盘操作原生界面；" +
        "本机没装 computer-use 插件就如实报 blocked。",
    };
  if (kind === "android")
    return {
      system:
        common +
        "安卓真机测试方式：Bash 里用 adb（uiautomator dump 取界面结构、screencap 截图、input 模拟点击输入），" +
        "先 adb devices 确认设备在线。脏状态与中断恢复在这条线=切后台再回来、旋转屏幕、杀进程重进。",
    };
  return {
    system:
      common +
      "接口测试方式：Bash 里用 curl 直接请求并断言状态码与响应体。" +
      "异常输入与边界在这条线=缺字段、错类型、超长值、非法值；脏状态=重复提交、超时重试。",
  };
}

phase("探测被测项目环境");
const adbCheck = await world.run("adb", ["devices"]).catch(() => null);
const env = await agent("勘察员", {
  system:
    "你是环境勘察员：只调查不修改。判断被测项目属于哪些测试线（网页/桌面/安卓/接口，可多选），" +
    "查明每条线怎么启动、改码后怎么刷新到最新，以及项目是否 git 仓库。" +
    "判断不了的就如实写进 notes，不要猜。",
}).ask<EnvPlan>(
  `勘察被测项目：${target}\n测试范围一句话：${scope}\n` +
    `本机 adb 检测结果：${adbCheck === null ? "未安装" : adbCheck.stdout.trim()}\n` +
    `用你的文件与命令工具实地查看（package.json / 构建脚本 / 仓库布局等），给出每条线的启动与刷新方式。`,
);

const kinds = Array.from(new Set(env.lines.map((l) => l.kind)));
const lines = kinds
  .map((k) => env.lines.find((l) => l.kind === k))
  .filter((l): l is EnvLine => l !== undefined)
  .filter((l) => !(adbCheck === null && l.kind === "android"));

const notCovered: string[] = [];
if (adbCheck === null && env.lines.some((l) => l.kind === "android"))
  notCovered.push("本机未安装 adb，安卓线整线跳过（装好 adb 后重跑即可）");
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
  `项目根目录：${env.projectRoot}\n测试范围：${scope}\n测试线：${JSON.stringify(lines.map((l) => l.kind))}\n` +
    `实地查看项目（路由/页面/模块/接口定义）后生成验收清单。`,
);

const testers = lines.map((l) => ({
  line: l,
  tester: agent(`测试员·${lineLabel[l.kind]}`, linePersona(l.kind)),
}));
const fixer = agent("修复工程师", {
  system:
    "你是修复工程师：只改被测项目源码，逐条修复给出的问题——缺陷和建议类都修，不做无关重构，" +
    "不顺手优化。修完自己先跑一遍能跑的检查再交。实在修不了的给出真实原因。" +
    "指令矛盾或环境缺失时直接上报，不要硬凑。",
});
const reviewer = agent("代码审查员", {
  system:
    "你是代码审查员：审每轮验收修复的改动。只读不写。判断三件事：修复是否对症、有没有引入新问题、" +
    "有没有越界改动。意见具体到文件与行；没问题就 approved，不要为了显得严格硬挑。",
});

phase("启动被测环境");
const refresher = agent("环境刷新员", {
  system:
    "你负责让被测环境跑起来、并始终跑最新代码：网页=启动/重启 dev server 并确认可访问；" +
    "接口=重启服务并确认健康；桌面=重新构建并启动应用；安卓=构建 APK 并 adb install 到设备。" +
    "只做环境刷新，不改业务代码。失败如实报告，不要假装就绪。",
});
const startReport = await refresher.ask<RefreshReport>(
  `启动被测环境。项目根目录：${env.projectRoot}\n各线启动方式：\n${JSON.stringify(
    lines.map((l) => ({ kind: l.kind, howToRun: l.howToRun })),
  )}\n逐线确认就绪并返回结果。`,
);
for (const r of startReport.ready) if (!r.ok) notCovered.push(`启动失败·${r.kind}：${r.note ?? "无说明"}`);

const allFindings: Finding[] = [];
const verifiedFixed = new Set<string>();
const roundLog: Array<{ round: number; found: number; fixed: number; committed: boolean }> = [];
const commitLog: string[] = [];
let finalStatus = "";

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase("全量验收测试");
  log(`第 ${round} 轮：${checklist.items.length} 个清单项，${testers.length} 条线并行测试`);
  const results = await Promise.all(
    testers.map(async ({ line, tester }) => {
      const mine = checklist.items.filter((i) => i.line === line.kind);
      const head =
        round === 1
          ? `第 1 轮验收测试。项目根目录：${env.projectRoot}\n你的线：${lineLabel[line.kind]}（${line.howToRun}）\n范围：${scope}`
          : `第 ${round} 轮全量复测。上一轮修复的问题如复发算新发现；确认已解决的把编号列进 verifiedFixed；继续探索新问题。`;
      return tester.ask<TestResult>(
        `${head}\n你的清单项：\n${JSON.stringify(mine)}\n` +
          `每个发现都要有证据；建议类（severity=low）也算发现。`,
      );
    }),
  );

  const newFindings = results.flatMap((r) => r.findings);
  for (const r of results)
    for (const v of r.verifiedFixed)
      if (!verifiedFixed.has(v)) {
        verifiedFixed.add(v);
        const old = allFindings.find((f) => f.id === v);
        if (old) report({ ...old, status: "复测通过" }, "findings-board");
      }
  for (const f of newFindings) report({ ...f, status: "待修复" }, "findings-board");
  for (const b of results.flatMap((r) => r.blocked)) if (b) notCovered.push(`第${round}轮·测不了：${b}`);
  report({ round, count: newFindings.length }, "rounds-chart");
  allFindings.push(...newFindings);

  if (newFindings.length === 0) {
    finalStatus = `第 ${round} 轮全量复测零新问题（含建议类），验收通过`;
    roundLog.push({ round, found: 0, fixed: 0, committed: false });
    break;
  }

  phase("修复本轮全部问题");
  const fix = await fixer.ask<FixReport>(
    `修复以下 ${newFindings.length} 个问题（含建议类全修），只改 ${env.projectRoot} 下的源码：\n${JSON.stringify(newFindings)}\n` +
      `逐条返回怎么修的；实在修不了的给原因。`,
  );
  for (const f of newFindings) report({ ...f, status: "已修复待复测" }, "findings-board");
  for (const s of fix.skipped) notCovered.push(`问题 ${s.id} 放弃修复：${s.reason}`);

  phase("审查改动并提交");
  let review = await reviewer.ask<Review>(
    `审本轮修复。改动文件：${JSON.stringify(fix.changedFiles)}\n问题清单：${JSON.stringify(newFindings)}\n` +
      `${env.isGit ? `可先跑 git -C "${env.projectRoot}" diff HEAD 看全部未提交改动，` : "该项目不是 git 仓库，"}再读改动文件本身核对。`,
  );
  if (!review.approved) {
    await fixer.ask(`代码审查员退回本轮改动，逐条处理：\n${JSON.stringify(review.comments)}\n处理完返回新的 FixReport。`);
    review = await reviewer.ask<Review>("修复者已按你的意见返工，复审本轮改动（同上标准）。");
  }
  let committed = false;
  if (env.isGit) {
    const add = await world.run("git", ["-C", env.projectRoot, "add", "-A"]);
    if (add.exitCode === 0) {
      const commit = await world.run("git", [
        "-C",
        env.projectRoot,
        "commit",
        "-m",
        `全流程验收 第${round}轮：修复 ${fix.fixed.length} 个问题`,
      ]);
      committed = commit.exitCode === 0;
      if (committed) commitLog.push(`第${round}轮：修复 ${fix.fixed.length} 个问题`);
      else log(`⚠️ 第 ${round} 轮提交失败：${commit.stderr.slice(0, 200)}`);
    } else log(`⚠️ git add 失败，本轮只改文件不提交：${add.stderr.slice(0, 200)}`);
  } else log("非 git 仓库，只改文件不提交");
  roundLog.push({ round, found: newFindings.length, fixed: fix.fixed.length, committed });

  if (round === MAX_ROUNDS) {
    finalStatus = `达到 ${MAX_ROUNDS} 轮上限强制停止，仍有问题在修`;
    notCovered.push(`第 ${MAX_ROUNDS} 轮的修复已提交但未复测（轮数上限）`);
    break;
  }

  phase("刷新环境准备复测");
  const refresh = await refresher.ask<RefreshReport>(
    `第 ${round} 轮修复已提交，让所有线跑最新代码：\n${JSON.stringify(
      lines.map((l) => ({ kind: l.kind, howToRefresh: l.howToRefresh })),
    )}\n逐线确认就绪。`,
  );
  for (const r of refresh.ready) if (!r.ok) notCovered.push(`第${round}轮刷新失败·${r.kind}：${r.note ?? "无说明"}`);
}

phase("汇总验收报告");
const doc = await agent("汇总员", {
  system:
    "你是验收汇总员：把整场验收写成给项目负责人看的中文 markdown 报告——总结论先行，" +
    "然后逐轮记录、问题全表（含最终状态）、审查与提交情况、未覆盖项。不美化：没测到的就写没测到。",
}).ask<FinalDoc>(
  `把验收报告写入 ${env.projectRoot}/qa-report.md（用你的文件工具），并返回全文。\n` +
    `终止状态：${finalStatus}\n逐轮记录：${JSON.stringify(roundLog)}\n` +
    `全部问题：${JSON.stringify(allFindings.map((f) => ({ ...f, result: verifiedFixed.has(f.id) ? "复测通过" : "未通过或未复测" })))}\n` +
    `提交记录：${JSON.stringify(commitLog)}\n未覆盖项：${JSON.stringify(notCovered)}`,
);
await artifact.markdown("qa-report", doc.markdown, {
  title: "全流程验收报告",
  description: `${finalStatus}；共 ${allFindings.length} 个问题，复测通过 ${verifiedFixed.size} 个。`,
  primary: true,
});

const leftover = allFindings.length - verifiedFixed.size;
return {
  conclusion:
    `${finalStatus}。全程共发现 ${allFindings.length} 个问题（含建议类），复测通过 ${verifiedFixed.size} 个，` +
    `残留 ${leftover} 个。完整报告：${env.projectRoot}/qa-report.md。${doc.summary}`,
  findings: allFindings.map((f) => ({
    ...f,
    status: verifiedFixed.has(f.id) ? ("verified" as const) : ("unconfirmed" as const),
  })),
  verified: [
    `每轮按 ${checklist.items.length} 项清单做全量复测，直到 ${finalStatus}`,
    ...commitLog,
  ],
  notCovered,
};
