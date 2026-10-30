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
连接才可使用。

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

终止响应的 `output` 数组为空时，保留已由 `output_item.done` 标记正常完成的
输出项；未完成的输出项仍会报错，非空最终列表仍须完整且一致。

响应流中断时，Ink 提示中断原因，不自动重放半轮请求。已完成工具结果仍保留，
可用 `ink -r <id>` 恢复后发送“继续”。收到终止事件后立即停止读取。
只有明确的输出 token 上限对应截断处理；内容过滤及其他 incomplete 原因会报错。
响应缺少 `Content-Type` 或标注不准确时，不会拒绝有效的 SSE 内容；Ink 校验实际
流内容并要求响应终止事件，不将 JSON/HTML 响应体视为成功的流式回答。

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
- 只配置了一个提供商且尚未选择模型时，新会话以该家族的推荐模型启动。
  ChatGPT 使用账户新鲜列表中的首个模型，不使用固定旧推荐值。列表为空、过期或
  不可用时保持未解决状态。`/model` 可以更改；`/settings defaultModel <id>` 固定
  启动默认值。优先
  级：`-m` > `INK_MODEL` > 设置中的 `defaultModel` > 会话保存值 >
  单提供商推荐值 > 内置默认值。
- `/model [id]` 从下一轮起生效；Ctrl+L 打开选择器。切换模型或思考档位会
  打印一行暗色状态行；连续切换会合并显示。
- 思考档位：`/think [level]` 或 Shift+Tab 循环切换；`--thinking` /
  `INK_THINKING` 设置启动档位；所选档位会持久化到设置中，作为下一个会话
  的默认值。档位遵循各模型的目录条目——有些模型无法关闭思考（gpt-5 base、
  o3、gpt-6），较新的模型提供 `xhigh`/`max`。

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

`openai-codex` 元数据现在读取 pi.dev 的 `openai` 条目，内部身份不变；旧 Codex
元数据缓存被忽略。状态栏和 `/status` 按提供商与模型共同查询上下文窗口。
`INK_CONTEXT_WINDOW` 优先；API key 家族没有目录数据时尝试运行期数据、静态表
及 131,072 默认值。新的订阅家族不使用旧 Codex 的发现数据或静态窗口，缺少目录
元数据时使用 131,072，除非显式覆盖。

```bash
INK_CATALOG_BASE_URL=https://mirror.example   # redirect the catalog source
INK_CATALOG_PATH=/path/to/models-catalog.json # relocate the cache
```
