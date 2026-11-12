# 设置

当你配置默认值时阅读本文：设置文件、其中的键，以及每个键的作用。CLI
各参数的覆盖方式见 [cli.md](cli.md)。

## 文件

| 文件 | 范围 |
|---|---|
| `~/.ink/settings.json` | 全局（所有项目） |
| `<project>/.ink/settings.json` | 项目——位于[信任门控](index.md#project-trust)之后；优先于全局 |

设置加载刻意保持宽容：未知键会从生效视图中丢弃（它们仍保留在文件里），
格式错误的文件也绝不会阻止启动。`INK_SETTINGS_PATH` 覆盖全局路径（测试
用）。

在 REPL 中，`/settings <key> <value>` 读取或写入；`/settings` 打开面板。
环境变量层始终优先：`INK_MODEL` 胜过 `defaultModel`，各个门控变量
（`INK_AUTOCOMPACT=0` 等）胜过对应的设置键。
每次刷新面板或表格只读取一次允许加载的配置文件，显示值及其来源标签使用
同一份快照；下次刷新会重新读取。当前会话已捕获的设置仍维持原有生效方式。

直接构造 Runner 的宿主可传入 `RunnerOptions.projectTrusted`，一次捕获项目
settings、具名 agent 及 SYSTEM.md／APPEND_SYSTEM.md 的会话许可。这是 Runner
选项，不是 settings.json 配置键。`false` 拒绝三个范围；`true` 允许加载，但
不能覆盖旧单项选项中明确的 `false`。`projectSettingsAllowed`、
`agentsProjectAllowed` 和 `systemPromptProjectAllowed` 仍可使用；省略
`projectTrusted` 时，三者原有默认值分别保持 `false`、`true`、`false`，不会
因授权一个旧范围而授权其他范围。CLI 始终传入本次解析的会话决定，不依赖这些
旧默认值，并将该决定直接传给 MCP。独立的扩展及 agent 加载器保留原有的默认
允许契约；直接调用它们的宿主仍须明确应用自己的项目门控。

## 键

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultModel` | string | — | 缺少 `-m`/`INK_MODEL` 时的启动模型；Codex 订阅接受 `·fast` |
| `defaultThinkingLevel` | string | `medium` | 启动思考档位（模型须支持该调节项） |
| `hideThinkingBlock` | boolean | `false` | 将推理轨迹隐藏在 `Thinking...` 标签之后（Ctrl+T 切换） |
| `autoCompact` | boolean | `true` | 自动压缩门控（`INK_AUTOCOMPACT=0` 优先） |
| `skills` | string[] | — | 额外的技能文件/目录（裸字符串会转成单元素数组） |
| `enableSkillCommands` | boolean | `true` | 注册 `/skill:name` 命令（目录仍保留） |
| `steeringMode` | `all` \| `one-at-a-time` | `all` | 排队的转向指令如何逐条处理（有意偏离 pi 的 `one-at-a-time`） |
| `followUpMode` | `all` \| `one-at-a-time` | `one-at-a-time` | 排队的后续追问如何逐条处理 |
| `images.autoResize` | boolean | `true` | 通过 photon 阶梯缩放过大的图片；`false` 时发送原始字节 |
| `mcp.enabled` | boolean | `true` | MCP 总门控（`INK_MCP=0` 优先） |
| `treeFilterMode` | `default` \| `no-tools` \| `user-only` \| `labeled-only` \| `all` | `default` | 树形选择器打开时的默认过滤器 |
| `branchSummary.skipPrompt` | boolean | `false` | 在 `/tree` 跳转时跳过“摘要左分支吗？”的询问 |

## 默认模型选择

`defaultModel` 接受与 `/model` 和 `-m` 相同的选择引用，包括 ChatGPT 订阅
提供商的精确 `·fast` 后缀：

```json
{
  "defaultModel": "openai-codex/gpt-6.1-sol·fast",
  "defaultThinkingLevel": "high"
}
```

项目默认值在本次启动的信任决定之后选择，因此首次 `--trust`、交互批准或仅
本会话批准都能立即生效。仅本会话批准不写入信任记录。新会话中，`-m` 和
`INK_MODEL` 优先于项目默认值，项目又优先于全局默认值。实际恢复会话时，只有
启动参数 `-m` 覆盖已保存的模型，环境变量和设置默认值不会覆盖。未保存模型的
旧会话，以及不可用的非订阅模型，仍遵循[提供商说明](providers.md)中的现有恢复规则。

也可使用 `/settings defaultModel openai-codex/gpt-6.1-sol·fast`。不带后缀的
普通引用选择普通处理；Fast 不是独立的设置键或全局开关。思考档位独立，
启动和恢复优先级不变。Fast 请求可能消耗更多额度；可用性和账户权限仍未经
确认。API key `openai` 不在此功能范围内。能力规则和错误处理见
[提供商](providers.md)。

## ~/.ink 中的相关文件

| 路径 | 用途 |
|---|---|
| `~/.ink/auth.json` | 凭据、订阅注册及随机安装标识（0600）；存储的密钥优先于环境变量 |
| `~/.ink/models-catalog.json` | 模型元数据磁盘缓存（4 小时刷新窗口） |
| `~/.ink/chatgpt-models.json` | 账户专属订阅模型列表和可选的 Fast 能力提示（5 分钟有效窗口） |
| `~/.ink/commands/` | Markdown 快捷命令（`/<filename>`） |
| `~/.ink/extensions/` | 全局扩展 |
| `~/.ink/agents/` | 全局具名 agent |
| `~/.ink/skills/` | 全局技能 |
| `~/.ink/SYSTEM.md` | 自定义系统提示（全局层级） |
| `~/.ink/APPEND_SYSTEM.md` | 追加的提示段落（全局层级） |
| `~/.ink/trust.json` | 记录的项目信任决策 |

## 自定义系统提示

- `.ink/SYSTEM.md`（项目，需要信任）或 `~/.ink/SYSTEM.md`——文件内容替换
  默认提示主体（身份、核心规则、工具目录）。工作目录行、项目上下文文件
  （AGENTS.md/CLAUDE.md）、技能、agent 名册和扩展上下文段落仍会加载——
  这些是路由信息，而非人设。
- `.ink/APPEND_SYSTEM.md` / `~/.ink/APPEND_SYSTEM.md`——在两种模式下都
  追加在提示主体之后（例如“用中文回答”）。

逐文件比较，项目层级优先于全局层级。文件为空会针对该组合禁用自定义提示
（默认提示仍然保留）。

## Markdown 快捷命令

把一个 `.md` 文件放进 `~/.ink/commands/`（全局）或
`<project>/.ink/commands/`（项目——位于信任门控之后），其文件名就会成为
一个斜杠命令：

```markdown
---
description: review the current diff against the plan
allowedDuringRun: false
---
Review the working tree diff against PROJECT_PLAN.md. Focus on contract
drift. $ARGUMENTS
```

`$ARGUMENTS` 会被替换为命令名之后的所有内容（没有占位符时，参数会作为
末尾段落追加）。同名的项目文件覆盖全局文件；与内置命令或扩展命令重名会
被拒绝并给出诊断信息。`/help` 列出它们时带有 `md:global` / `md:project`
标签。脚本化（管道输入）的 REPL 在目录受信任时会加载它们；打印模式
（`-p`）从不加载。
