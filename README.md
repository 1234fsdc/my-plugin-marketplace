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
| `page-testing` | 前端项目逐页扫描审计 + 竞品调研 |
| `token-details-panel` | 侧边栏 Token 统计面板 |
| `mattpocock-skills` | Matt Pocock 工程技能（精简版，去掉了 to-spec） |
| `document-skills` | Excel / Word / PowerPoint / PDF 文档处理套件 |
| `ponytail` | 极简编码模式（ZCode 特调版：v4.9.0 基座 + v5.3.2 核心技能） |

## 导入 ZCode

在 ZCode 插件市场界面添加市场，source 选 `github`，填 `1234fsdc/my-plugin-marketplace` 即可。

## 添加插件

告诉我插件的：名称、功能描述、技能/代理内容。我会在仓库下新建子目录、写 `package.json` 与内容，并更新 `marketplace.json` 的 `plugins` 数组。
