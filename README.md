# my-plugin-marketplace

ZCode 插件市场。仓库根目录的 `marketplace.json` 即市场定义，ZCode 可直接识别导入。

## 结构约定

```
my-plugin-marketplace/
├── marketplace.json      # 市场定义（name + plugins[]）
├── <plugin-name>/        # 每个插件一个子目录
│   ├── package.json      # { name, version, description }
│   ├── skills/           # 技能（可选）
│   └── agents/           # 子代理（可选）
└── README.md
```

`marketplace.json` 中每个插件条目形如：

```json
{
  "name": "my-plugin",
  "source": "./my-plugin",
  "version": "1.0.0",
  "description": "一句话说明这个插件做什么",
  "author": { "name": "木" },
  "license": "MIT"
}
```

- `source` 用 `./` 相对路径指向子目录
- 插件内容放 `skills/` 或 `agents/`
- `package.json` 必须有 `name` 和 `version`

## 当前插件

| 插件 | 说明 |
|---|---|
| `auto-chinese-desc` | 新安装的 Skill 自动补中文描述 |
| `page-testing` | 前端项目逐页扫描审计 + 竞品调研；附 full-acceptance 全流程验收工作流脚本 |
| `token-details-panel` | 侧边栏 Token 统计面板 |
| `mattpocock-skills` | Matt Pocock 工程技能（精简版，去掉了 to-spec） |
| `document-skills` | Excel / Word / PowerPoint / PDF 文档处理套件 |
| `ponytail` | 极简编码模式（ZCode 特调版：v4.9.0 基座 + v5.3.2 核心技能） |

## 导入 ZCode

在 ZCode 插件市场界面添加市场，source 选 `github`，填 `1234fsdc/my-plugin-marketplace` 即可。

## 添加插件

告诉我插件的：名称、功能描述、技能/代理内容。我会在仓库下新建子目录、写 `package.json` 与内容，并更新 `marketplace.json` 的 `plugins` 数组。

## 附带的工作流：full-acceptance 全流程验收（page-testing 1.6.0+）

`page-testing/workflows/full-acceptance.dwf.ts` 是一个 ZCode 动态工作流脚本（**不是技能**）：对有源码的项目做全流程验收——基线全量测试（8 维度）→ 缺陷独立确证 → 修复 → 代码审查 → 本地提交 → 定向复测，直到零新缺陷；报告写入项目根 `qa-report.md`。

ZCode 插件不会自动注册工作流（合法位置只有全局 `~/.zcode/workflows/` 和项目 `.zcode/workflows/`），所以装好插件后把它复制到全局工作流目录**一次**即可长期使用，之后不再需要任何技能参与：

- 最简单：对你的 AI 说「把 page-testing 插件 cache 里的 full-acceptance 工作流脚本复制到 ~/.zcode/workflows/」
- 或手动（Git Bash，版本号取 cache 里最新的那个目录）：

```bash
cp ~/.zcode/cli/plugins/cache/my-plugin-marketplace/page-testing/<版本号>/workflows/full-acceptance.dwf.ts ~/.zcode/workflows/
```

装好后**新开会话**，说「全流程验收 <项目源码路径>」即可启动；可选划范围：「全流程验收 C:\proj，只测登录和下单流程」。
