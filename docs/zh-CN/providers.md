# 提供商与模型

当你登录、切换模型，或想了解 Ink 支持哪些提供商时，读这一篇。CLI 参数见
[cli.md](cli.md)。

## 登录：/login

REPL 中的 `/login` 把凭据存入 `~/.ink/auth.json`（权限 0600）。已存储的
key 优先于环境变量。

```
/login            → Z.AI · Anthropic · OpenAI · OpenAI (ChatGPT plan) ·
                    DeepSeek · Moonshot AI · Moonshot AI CN
/login zai        → straight to the key prompt; any family name works
/logout           → remove a stored credential (environment variables stay)
```

每一行显示对应提供商的状态（`signed in — stored key`、`env: ZAI_API_KEY`、
`not signed in`）。ChatGPT 套餐所在的行通过浏览器 OAuth 授权：Ink 显示授权
URL 并尝试打开浏览器。TUI 还支持粘贴完整回调 URL，输入不回显。Esc/Ctrl+C
可取消而不会强制退出。readline REPL 仅使用浏览器回调，不创建第二个输入读取器。

## 家族

### Z.ai GLM Coding Plan

官方途径是 zai 家族：

```bash
export ZAI_API_KEY=<your z.ai api key>
export INK_MODEL=glm-5.3   # or glm-5.2, glm-4.7, ... per your plan
```

或者 `/login` → Z.AI。不带前缀的 `glm-*` id 会无条件路由到 zai；没有凭据
时 Ink 会打印登录指引（`/login zai`），绝不静默回退。`ZAI_BASE_URL` 可覆盖
端点（例如国内镜像 `https://open.bigmodel.cn/api/coding/paas/v4`）。思考
档位：glm-5.2 = off/high/max；glm-5.3 = low/high/max（无法关闭）。在 zai 家族
出现之前的 anthropic 兼容配置（将 `ANTHROPIC_BASE_URL` 指向 z.ai）在显式
强制时仍然可用（`ink -m anthropic/glm-5.3`），且仅支持二元的思考开关。

### Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

或者 `/login anthropic`。`ANTHROPIC_AUTH_TOKEN` 发送 Bearer 风格的认证；
已存储的 `/login anthropic` key 会以 x-api-key 风格将其覆盖——在兼容
端点上，优先使用环境变量组合（见下一节）。

### 任意 Anthropic 兼容服务

```bash
export ANTHROPIC_AUTH_TOKEN=<token>          # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=<your endpoint>
export INK_MODEL=<id the endpoint serves>
```

### OpenAI

API key：`export OPENAI_API_KEY=...`，或者 `/login openai`。此方式仍使用
Chat Completions。任何 OpenAI 兼容服务（OpenRouter、MiniMax 等）都可以通过
`OPENAI_BASE_URL` 配合该端点提供的模型 id 来使用。

ChatGPT 套餐：`ink login`（CLI）或 `/login` → OpenAI (ChatGPT plan) 在浏览器中
打开 Sign in with ChatGPT，授权 Ink 一次。浏览器已有有效登录时可能无需再次输入
密码，但 OpenAI 仍可要求身份验证。回调仅监听 `127.0.0.1`，优先使用 1455 端口，
占用时改用可用端口。CLI 交互终端和 TUI 可接受粘贴的完整回调 URL，不回显内容。
授权等待 10 分钟后超时，Ctrl+C 可取消。身份和实际授予的订阅权限校验通过后，
连接才可使用。在凭据文件的原子替换提交前取消，会保留原有凭据；替换一旦提交，
就会完成，取消不能撤销已保存的登录。

**旧设备码登录用户必须运行一次 `ink login`。** 无需先退出登录；没有旧 token
转换、旧后端回退或自动 API key 计费回退。其他提供商的 key 会保留。
provider ID 和模型前缀仍为 `openai-codex`，请求改发至
`https://api.openai.com/v1/responses`。`OPENAI_CODEX_BASE_URL` 可覆盖订阅 API
基址（仅 HTTPS）；`OPENAI_BASE_URL` 和 `OPENAI_API_KEY` 不影响此连接。

`ink logout` / `/logout` 尝试远端撤销并清除本地订阅 token，保留注册供之后授权。
远端撤销无法确认时会提示，可在 ChatGPT 设置中断开应用。刷新通过跨进程锁协调，
轮换后的凭据以原子方式保存，文件权限仅允许所有者读取。

工具参数支持流式片段、完整快照和并行调用。已完成响应中缺少最终结束事件、
参数数据，或存在非法 JSON、调用身份冲突时，会产生 `Codex protocol error`，
该响应的工具均不执行。显式 `{}` 仍需通过工具必填字段校验。输出达到 token 上限
而截断时，整批工具调用不执行，由模型重新发出完整调用。

推理摘要以 thinking 内容显示；最终推理密文、item ID、文本分段和 phase 存为可选
回放元数据，只发送给同一提供商的同一模型。切换模型、其他提供商和摘要提示均不
接收密文。旧会话没有这些字段也可继续使用。

正常完成的响应中，终止事件的 `output` 缺失或为空时，所有流式输出项都必须已收到
`output_item.done`，且最终状态省略或为 `completed`。否则会报协议错误，不保存该条
助手回复，也不执行该响应的工具。非空最终列表仍须完整且一致。已有会话文件不会
被重写。

响应流中断时，Ink 不自动重放半轮请求。公开诊断使用固定的 `connection closed`
描述，若识别到错误码，仅显示 `UND_ERR_SOCKET`、`ECONNRESET` 或 `EPIPE`。
任意底层或 cause 消息、URL 和凭据不会被复制到该公开消息及其运行错误日志中。
原始错误仍作为 `cause` 保留供本地调试，它本身未经脱敏。已完成工具结果仍保留，
可用 `ink -r <id>` 恢复后发送“继续”。收到终止事件后立即停止读取。
只有明确的输出 token 上限对应截断处理；内容过滤及其他 incomplete 原因会报错。
响应缺少 `Content-Type` 或标注不准确时，不会拒绝有效的 SSE 内容；Ink 校验实际
流内容并要求响应终止事件，不将 JSON/HTML 响应体视为成功的流式回答。

上下文溢出恢复先判断具体的结构化错误码，再判断 reason 和消息文本。档位、鉴权、
额度或协议拒绝不会仅因消息提到上下文限制就触发压缩和重试。通用请求或状态诊断
仍可使用既有的明确溢出措辞；`unknown_incomplete` 表示未提供具体的 incomplete
原因，不会禁用这一文本判断。明确的上下文溢出错误码或 reason 仍可触发现有的
一次压缩和重试，所选速度模式不变。

稳定的对话 ID 哈希用于 `prompt_cache_key` 及 HTTP headers `session_id`、
`x-client-request-id`，不发送原始 ID。HTTP 每次发送完整历史，使用 `store:false`
和 `stream:true`，没有 WebSocket 或 `previous_response_id` 增量续传，不保证缓存命中。
订阅路径不接受 `--max-tokens` 输出限制、temperature 或显式缓存保留控制。

订阅及应用用量达到上限时会链接到 ChatGPT 用量设置，不按普通限流重试。
新连接不增加额度，也不提供所有 API key 端点的权限。费用显示为目录估算，不是
订阅实际扣费。恢复、`/new` 和子会话行为见[会话](sessions.md)。

### DeepSeek

```bash
export DEEPSEEK_API_KEY=...
ink -m deepseek/deepseek-v4-pro        # or deepseek/deepseek-flash
```

或者 `/login deepseek`。`DEEPSEEK_BASE_URL` 覆盖端点；已存储的 key 优先于
环境变量。

### Moonshot / Kimi

```bash
export MOONSHOT_API_KEY=...
ink -m moonshotai/kimi-k3       # overseas: api.moonshot.ai/v1
ink -m moonshotai-cn/kimi-k3    # China: api.moonshot.cn/v1
```

或者 `/login moonshotai` / `/login moonshotai-cn`（按家族分别存储 key）。
`MOONSHOT_BASE_URL` / `MOONSHOT_CN_BASE_URL` 覆盖端点。思考档位：k2.6 在
off/on 之间切换；k2.7-code 和 k3 始终会思考（k3 接受 `reasoning_effort` 的
low/high/max；启动档位 `medium` 映射为 `high`）。

## 模型解析与 /model

- 没有任何凭据时，Ink 会如实说明（`no model available — run /login to
  connect one`），而不是假装可用。未选择的内置占位模型不持久化；用户明确选择
  的订阅模型即使缺少凭据也会保留，避免恢复时悄悄改变计费方式。
- 新会话的选择顺序是 `-m` > `INK_MODEL` > 获准加载的项目 `defaultModel` >
  全局 `defaultModel` > 内置默认值。配置默认值在本次信任决定之后解析：首次
  `--trust`、交互批准和仅本会话批准，都能让项目默认模型当次生效。拒绝项目时
  不从中选择模型。`/settings defaultModel <id>` 可保存启动默认值。
- 仅在没有配置模型且内置选择缺少凭据时，才尝试使用唯一、无歧义凭据来源的
  推荐模型。内置选择已有凭据时保持不变；新会话不会悄悄替换明确配置但缺少
  凭据的模型。ChatGPT 推荐取自新鲜账户列表的首个模型，列表为空、过期或
  不可用时保持未解决状态。
- 恢复会话时，只有启动参数 `-m` 覆盖已保存的模型及 Fast／普通选择；其他情况
  下，保存的选择优先于环境变量和设置默认值。未保存模型的旧会话先使用上述
  默认值，再遵循现有恢复机制。非订阅模型缺少凭据时，该机制可能选择唯一的
  API key 提供商；明确选择的订阅模型绝不切换到 API key 计费。这些恢复规则不变。
- `/model [id]` 从下一轮起生效；Ctrl+L 打开选择器。切换模型或思考档位会
  打印一行暗色状态行；连续切换会合并显示。
- 选择器先向已配置的端点请求模型列表。默认 API key 端点不可用时（包括鉴权
  失败），先使用该家族已缓存的公共模型目录；没有目录时才使用随包内置列表。
  Moonshot 两个平台的内置列表均包含 `kimi-k2.6`、`kimi-k2.7-code`、
  `kimi-k2.7-code-highspeed` 和 `kimi-k3`。离线选项不能证明凭据或访问权限有效。
  使用 `*_BASE_URL` 重定向的端点不回退到公共目录或内置列表：Ink 会报告端点
  不可达，不为该服务虚构模型。当前选择即使未被列出也仍可选择。ChatGPT 套餐
  的可用模型仅取自账户列表，规则见下文。
- 思考档位：`/think [level]` 或 Shift+Tab 循环切换；`--thinking` /
  `INK_THINKING` 设置启动档位；所选档位会持久化到设置中，作为下一个会话
  的默认值。档位遵循各模型的目录条目——有些模型无法关闭思考（gpt-5 base、
  o3、gpt-6），较新的模型提供 `xhigh`/`max`。

## Codex Fast 请求

Fast 是 ChatGPT 订阅提供商（`openai-codex`）的逐模型请求模式，不适用于
API key `openai`，也不是 Ultrafast 或全局速度开关。`/model`（Ctrl+L）为
**账户列表中每个具备 Fast 能力的 Codex 模型**提供基础模型及紧随其后的
`·fast` 选项，不限于 Sol。例如：

```text
/model openai-codex/gpt-6.1-sol·fast
/model openai-codex/gpt-6.1-sol
```

第二条命令选择普通处理并清除 Fast。`-m` / `--model`、`INK_MODEL` 和设置
`defaultModel` 也接受此后缀。状态栏、`/status` 和模型切换提示会显示它。
自动启动及登录建议仍使用普通模式，不会替换用户明确选择的 Fast。

账户列表可选的能力提示优先于 Ink 随包内置、固定版本的官方 Codex 模型目录
快照，包括明确的否定提示。`service_tiers` 中的 `id:"priority"` 或
`id:"fast"`，或旧字段 `additional_speed_tiers` 中的 `"fast"`，表示支持
Fast。任一字段给出肯定证据即可；否则，不含 Fast 的有效数组（包括 `[]`）
是否定证据。仅有缺失或格式错误的字段时表示未知，改查快照。
若支持情况仍为未知或否定，就不自动添加 Fast 选项。快照和 pi.dev 元数据
都不会补入账户未列出的模型；模型名称也不能证明能力。离线 Fast 选项沿用
基础列表的过期、未经确认提示。

用户明确选择的、格式有效的 `openai-codex/<id>·fast` 仍是有效请求，即使
模型是自定义、未知或被标为不支持，也包括从会话恢复的选择。能力变化不会
清除它。服务端可以拒绝不支持的请求；本地接受不代表账户有权使用。

选择器提示 `Fast requested; higher usage; availability unverified`，即已请求
Fast、用量更高、可用性未经确认。Fast 可能消耗更多订阅额度或产生额外费用。
目录参考费用估算现在包含下文所述的逐次调用服务档位假设；它不代表实际订阅扣费，
也不是经验证的额度倍率。模型被列出或具备能力都不能验证账户权限，也不保证更快。
2026-11-10 的首次订阅探测使用
`service_tier:"fast"`，返回 **HTTP 400**，未保留可确定原因的诊断。另行授权的
后续实验完成了 42 次请求（2 次预热和 20 组随机正式配对），报告用量共 18,942
个 token，输出全部正确，无失败或排除项。该工作负载和观测时段内，配对字符
交付表现提高 42.29%，总延迟降低 23.62%。所有终止响应的档位均为 `default`；
这些结果仅是该实验的性能证据，不能确认内部处理档位、账户权限、计费，也不
构成普遍速度保证。

Ink 发送不变的基础模型 ID 和 `service_tier:"priority"`，这是官方 Codex 使用的
Fast 等效取值。普通请求省略该字段。`·fast` 是选择和显示语法，不是新模型：
上下文、视觉、定价元数据和回放身份都仍使用基础模型。思考档位独立配置
（`/think`、`--thinking`）；选择 Fast 不会降低思考档位。

出错时保留选择和原始带类型诊断。只有 Fast 模式下明确的服务档位拒绝才会附加
`To retry without Fast, explicitly select the normal model with /model.`，
即若要不使用 Fast 重试，须通过 `/model` 明确选择普通模型。识别范围仅包括带类型
错误中的 `unsupported_service_tier`、`invalid_service_tier`、`tier_unavailable`
错误码，或同时带有 `param:"service_tier"` 的 `unsupported_parameter`。
这是保守的结构化诊断，不保证账户权限，也不保证上游始终采用这些错误码。
仅有 HTTP 状态、参数名或消息文本不足以匹配。不相关的鉴权、额度、网络、超时或
中断、上下文、缺失工具输出、回放及协议错误不附加 Fast 提示；普通模式诊断不变。
如果错误对象无法补充提示，仍保留原始异常，不用添加提示时的新异常替换它。
重试仍请求 Fast；不会静默按普通模式重试、替换模型、切换凭据或计费方式，
也不回退到旧后端。有效终止响应即使报告 `default`、`standard`、`flex`、未知
档位或不报告档位，也会正常完成。原已支持的 `max_output_tokens` 不完整响应
路径同样如此；不完整的工具批次仍不会执行。实际流失败、终止错误、不支持的
不完整原因、无效工具或回放数据、截断的流仍然报错。HTTP 200 本身不代表完成；
流错误保留带类型的诊断状态，但不再使用误导性的 `API error 200` 表述。

Codex 助手消息单独保存有长度和字符限制的 `serviceTier` 观测：Fast 的
`requested` 为 `priority`，普通请求为 `omitted`；可选的 `reported` 使用终止
响应原值，不改写为请求值，也不取自创建事件。格式错误的报告值会被忽略。
这些值都不能证明实际处理方式或扣费。`/status` 显示活动历史中与当前提供商和
基础模型精确匹配的 **LAST response**（最后一条响应）观测，而不是确认当前选择。
未发送和未报告分别显示 `omitted`、`unreported`。该模型最新的助手消息若无有效
观测，不会替用更旧的记录。旧会话仍有效，也不会每轮显示警告。

## Codex 参考费用估算

仅对 `openai-codex`，Ink 根据产生用量的每次调用所捕获的观测，调整当前基础模型的
目录费率。规则版本为 `pi-2cac4f1a9`，固定依据为
[Pi revision 2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c](https://github.com/earendil-works/pi/blob/2cac4f1a934cdc4a80b05a7d8ff2543cf5ee623c/packages/ai/src/api/openai-codex-responses.ts#L623-L660)。
这只是本地参考估算，不是账单、订阅额度测量或实际处理档位的确认。它不改变请求、
模型身份、选择、能力、认证、重试或错误处理。

| 捕获的终止响应 `reported` 值 | 仅用于估算的档位 |
|---|---|
| `priority` 或 `fast` | 优先档位（`fast` 是别名） |
| `flex` | Flex，即使请求的是优先档位 |
| `default` 或缺失 | 该次调用捕获的 `requested:"priority"` 对应优先档位，否则使用基础费率 |
| `standard`、`auto` 或 `scale` | 基础费率，遵循 Pi 的参考规则，不代表验证了计费条款 |
| 其他值 | 仅基础费率估算，档位定价不完整 |

优先档位将四类金额费率（输入、输出、缓存读取、缓存写入）全部乘以相应倍率：
**基础 ID 精确为 `gpt-5.5` 时为 2.5，其他 ID 为 2**。其他模型使用 2 倍是与 Pi
兼容的假设，不是未知或未来模型经验证的费率。Flex 使用 **0.5**，基础费率使用
**1**。这些调整仅影响金额：原始 token 计数和缓存命中率绝不乘以倍率，其他提供商
不变。原始 `reported` 值保持不变，包括 `default`；使用请求档位作为回退只用于
估算，不会改写报告，也不能证明实际采用了优先处理。

对已识别模型且费率已知的 Codex 用量，缺少有效档位观测（包括旧记录）时，正用量
保留仅基础费率的估算，并标记档位定价不完整。格式错误或与原始用量不一致的定价
元数据不会抹去有效原始用量；
会回退，而不是只对报告的一部分定价。目录费率缺失时仍无法定价；目录费率为零
只表示零参考估算，不能证明订阅使用免费。估算使用当前目录费率，不保存历史账单费率。

会话费用显示（状态栏、`/status` 和会话统计）使用 `~` 表示参考定价不完整，包括
未知档位和旧 Codex 记录的仅基础费率估算。`!` 仍表示已知存在缺失用量，不表示倍率
未知；原有的未知费率和订阅标记保留。倍率不能重建未报告的工作用量。普通模式与
Fast 混用、历史导航、重新打开会话、子代理和摘要重试都保留每次调用的原始归属，
不采用当前选择或最后一条响应的档位。用量统计及被拒绝摘要的回执见
[会话](sessions.md)。

## 模型目录（pi.dev）

模型元数据——上下文窗口、费用费率、思考档位阶梯、视觉能力、家族模型
列表——来自 `pi.dev` 的公开目录服务。磁盘缓存
（`~/.ink/models-catalog.json`）让它可安全离线使用：启动时 Ink 同步加载
缓存（随包内置的静态表是冻结的最终兜底），缓存超过 4 小时未更新时会以
非阻塞方式刷新；打开 `/model` 会重新检查同一时间窗口。没有周期性轮询。
抓取成功时，目录总是优先于内置表，因此新模型和价格变动无需发布新版 Ink
即可生效。

ChatGPT 订阅的**可用模型**来自使用同一 OAuth 凭据访问的 `/v1/models`，仅展示
`visibility:list` 的 slug，保持服务端顺序。成功的空列表不会用种子模型补充。
账户列表单独缓存 5 分钟；离线选择器可显示明确标注为过期、未经确认的账户快照。
元数据不代表账户权限。登录只在当前模型不可用、且没有明确选择时自动选模型。
当前已可用的内置或自动选择模型不会因登录其他提供商而被替换，只提示可手动使用
`/model` 切换。已有配置和恢复的模型选择不变，即使凭据缺失。

`openai-codex` 使用的全部元数据来自该家族自己的公开目录
`https://pi.dev/api/models/providers/openai-codex`，包括上下文窗口、输出上限、
费用估算、思考档位映射和视觉能力。普通 `openai` 继续使用独立目录。例如，
GPT-6.1 Sol 当前的订阅窗口为 500,000 tokens；普通 OpenAI 目录的 272,000 是
为避免 API 长上下文加价而采用的默认值。更换元数据来源不会改变认证、账户
可用模型列表或 `https://api.openai.com/v1/responses` 推理端点。

之前从普通 OpenAI 目录生成的订阅缓存及其 ETag 会被忽略。下次启动或打开
`/model` 刷新时会请求订阅目录，即使旧缓存生成尚不足 4 小时。成功缓存的新来源
数据仍可离线使用；首次成功获取之前，仍采用缺少元数据时的保守回退值。

状态栏和 `/status` 按提供商与模型共同查询上下文窗口。加载有效缓存后，无需
先打开 `/model` 即可显示该提供商的窗口。`INK_CONTEXT_WINDOW` 优先；API key
家族没有目录窗口时尝试运行期数据、静态表及 131,072 默认值。订阅家族不使用
旧 Codex 的发现数据或静态窗口，缺少目录元数据时使用 131,072，除非显式覆盖。

```bash
INK_CATALOG_BASE_URL=https://mirror.example   # redirect the catalog source
INK_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache
```
