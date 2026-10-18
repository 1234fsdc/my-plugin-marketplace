# ponytail ZCode 定制版

基于上游 [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) **v5.3.2**，为 ZCode 重新适配。

## 与上游的区别

上游在 **v4.13.0** 移除了 ZCode 支持（PR #1040），后续 PR #1049 尝试恢复但未合并。本定制版在 v5.3.2 基础上重新加回 ZCode 兼容：

| 文件 | 改动 |
|---|---|
| `hooks/ponytail-runtime.js` | 加回 `isZcode` 检测（`ZCODE_APP_VERSION` 环境变量），在 `writeHookOutput` 中复用 Qoder 的 `hookSpecificOutput` JSON 分支输出规则集 |
| `hooks/ponytail-activate.js` | 导入 `isZcode`，跳过 statusline nudge（ZCode 不适用 Claude 的 settings.json） |
| `hooks/ponytail-mode-tracker.js` | 导入 `isZcode`（ZCode 有 SessionStart，不需要 Qoder 的双份注入路径） |

## 上游 v5.3.2 功能保留

- 规则重写（长度减半，更强调变更影响范围）
- `/ponytail-review` 重做（完整 review：bug、安全、负载、测试、速度、精简）
- `/ponytail-audit`（全仓库审计，按优先级排序）
- band/board（Claude Code prompt 上方任务成本显示 + 本地看板）
- `shortcut:` 中性注释标记（替代旧 `ponytail:` 品牌标记）
- 多平台支持（Codex、Copilot、Cursor、CodeBuddy、Kimi、Grok 等）

## ZCode 已知限制

- band/board 是 Claude Code 专属 UI，ZCode 无法显示（文件保留供其他 host 使用）
- statusline nudge 被跳过（ZCode 无 statusline 配置）
- 子代理 hook（SubagentStart）在 ZCode 上被注册时丢弃，行为与上游一致

## 版本号

`5.3.2-zcode.1` — 基于 v5.3.2，ZCode 适配第 1 版。
