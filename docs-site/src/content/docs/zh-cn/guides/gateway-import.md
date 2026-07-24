---
title: 聚合网关与 OpenCode
description: 一次导入多个 One API、New API、Sub2API 或 OpenAI 兼容分组，并在 OpenCode 中显示其模型。
---

OpenCodex 会把每个聚合网关分组视为一个独立 provider。One API、New API、Sub2API 的密钥
通常只绑定一个上游分组，因此 GPT key 与 Grok key 不能放进同一个 API-key 故障切换池：
它们授权的模型并不相同。

## 一次导入两个或更多分组

### 前端界面

本 Universal 预览版的示例统一使用不与现有安装冲突的 `ocxu` 命令。只有在没有其他程序
占用 `ocx` 名称时，`ocx` 别名才与它等价。

运行 `ocxu gui`，进入**提供方**，点击**批量导入网关**。按需要添加多个相互独立的连接，
为每个连接选择凭据方式，然后：

1. 点击**校验**，在不写入配置的情况下检查整个批次。
2. 点击**运行连接测试**检查模型目录；最小推理与 Fast 测试需要单独开启，因为它们可能消耗上游额度。
3. 分别确认每个连接的模型目录、推理和 Fast 结果，不能用“看得到模型”代替“实际可用”。
4. 点击**导入连接**，一次性原子化保存完整批次。

任何字段发生修改都会令旧预览失效，必须重新校验。覆盖已有 provider 默认关闭。
在本机前端输入的原始密钥不会出现在校验响应中。

### 不含密钥的清单

从仓库内示例开始：

```bash
cp examples/gateways/multi-gateway-gpt-grok.json my-gateways.json
```

替换各个 `baseUrl`，再通过环境变量提供密钥：

```bash
export GATEWAY_GPT_API_KEY="..."
export GATEWAY_GROK_API_KEY="..."

ocxu gateway import my-gateways.json --dry-run
ocxu gateway preflight my-gateways.json --json
# 可选、可能计费的测试：
ocxu gateway preflight my-gateways.json --inference --fast
ocxu gateway import my-gateways.json --sync
```

Windows PowerShell：

```powershell
$env:GATEWAY_GPT_API_KEY = "..."
$env:GATEWAY_GROK_API_KEY = "..."
ocxu gateway import .\my-gateways.json --dry-run
ocxu gateway preflight .\my-gateways.json --json
# 可选、可能计费的测试：
ocxu gateway preflight .\my-gateways.json --inference --fast
ocxu gateway import .\my-gateways.json --sync
```

清单只保存环境变量名。`ocxu gateway` 故意不提供原始 `--api-key` 参数，避免密钥进入
PowerShell/bash 历史或被提交到共享 JSON。
运行 OpenCodex 代理的进程也必须能读取这些环境变量。若代理以系统服务运行，应把变量写入服务
环境，不能只在当前 PowerShell/bash 窗口中临时设置。

旧的 Manifest v1 文件仍然兼容。Manifest v2 新增显式的逐模型能力配置。每个
`connections[]` 支持：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定的 OpenCodex provider ID。 |
| `kind` | `one-api`、`new-api`、`sub2api` 或 `openai-compatible`。 |
| `baseUrl` | 完整 API 前缀，通常以 `/v1` 结尾；OpenCodex 不会擅自补路径。 |
| `protocol` | `chat-completions` 或 `responses`，用于选择上游 adapter。 |
| `costMultiplier` | Manifest v2 正数展示估算倍率；不改变路由，也不改变上游真实计费。 |
| `apiKeyEnv` | 保存该分组 key 的环境变量名；除非 `keyOptional` 为 `true`，否则必填。 |
| `keyOptional` | 明确允许本机或其他无需鉴权的兼容端点。 |
| `models` | 可选静态兜底列表，在线模型发现不可用时仍可显示。 |
| `modelProfiles` | Manifest v2 的逐模型元数据，用于显示名、限制、模态、推理档位和显式 Fast 能力。 |
| `selectedModels` | 可选的模型目录白名单。 |
| `defaultModel` | 该连接的默认模型。 |
| `allowPrivateNetwork` | 本机或 RFC1918 内网网关必须明确开启。 |

v2 能力配置支持：

| 字段 | 含义 |
| --- | --- |
| `displayName` | 仅用于显示，不改变实际路由模型 ID。 |
| `contextWindow` | 正整数上下文上限。 |
| `maxInputTokens` / `maxOutputTokens` | 正整数输入、输出 Token 上限。 |
| `inputModalities` | 声明输入模态，例如 `["text", "image"]`。 |
| `reasoningEfforts` | 从 `low` 到 `ultra` 的 Codex/OpenCode 推理档位。 |
| `defaultReasoningEffort` | 默认档位，且必须同时存在于 `reasoningEfforts`。 |
| `serviceTiers` | 当前支持 `["priority"]`，它是 OpenCode `fast` 变体的显式依据。 |
| `supportsReasoningSummaries` | 该 Responses 后端是否接受推理摘要字段。 |

控制台在“高级模型能力”中提供此对象，并在预校验结果中显示能力模型数量。配置中的模型
键会自动加入静态回退列表，因此不会因漏写在 `models` 中而消失。

只有在确实要替换已有自定义 provider 时才使用 `--force`。内置 OpenAI 登录/路由 ID
始终保留，不允许覆盖。

单个分组也可以直接添加：

```bash
ocxu gateway add gateway-gpt \
  --kind openai-compatible \
  --base-url https://gateway.example.com/v1 \
  --protocol responses \
  --api-key-env GATEWAY_GPT_API_KEY \
  --cost-multiplier 0.3 \
  --model gpt-5.6-sol \
  --model gpt-5.6-terra \
  --default-model gpt-5.6-sol \
  --set-default
```

## 连接预检

配置合法、模型可见、账号有推理权限是三个不同事实。预检不会写入配置，并分别返回：

| 检查 | 能证明什么 | 是否可能计费 |
| --- | --- | --- |
| 模型目录 | 该凭据能访问模型列表端点，且返回结构可解析。 | 通常不计费。 |
| 最小推理 | 一个明确配置的模型能完成最小请求。 | 需主动开启，可能计费。 |
| Fast | 显式声明 `priority` 的模型能接受最小 priority 请求。 | 需主动开启，可能按更高档位计费。 |

`fast_confirmed` 表示响应明确返回了 `service_tier: "priority"`；
`fast_accepted_unconfirmed` 只表示请求成功，但上游没有回显档位，不能证明实际走了加速或
priority 计费。响应只包含 HTTP 状态、耗时和稳定脱敏错误码，不会返回密钥或上游响应正文。
任何已请求检查失败时，CLI 预检退出码为 `2`。

## 分组独立费用估算

`costMultiplier` 属于每个连接，因此 GPT 分组可设 `0.3`，Grok 分组可设 `0.2`。
Composite 会按每次实际尝试使用的 provider 倍率分别估算；若同时确认了 priority 费用倍率，
分组倍率在其后应用。

它只影响 OpenCodex 展示的列表价估算。余额、渠道倍率、折扣、账单和真实扣费仍以 One API、
New API、Sub2API 或其他网关服务端为准。

## 在 OpenCode 模型选择器中显示

OpenCode 本身支持手写 OpenAI 兼容 provider；缺少的是 Sub2API/One API/New API 的一键
多分组导入、模型目录刷新、密钥隔离和可逆启动层。OpenCodex 补的是这一层。

```bash
# 生成/刷新 ~/.opencodex/hosts/opencode.json
ocxu opencode configure

# 生成/刷新后直接启动 OpenCode
ocxu opencode
```

启动器只给本次进程设置 `OPENCODE_CONFIG`，不会覆盖
`~/.config/opencode/opencode.json` 或项目里的 `opencode.json`。OpenCode 会合并配置源，
因此项目级 provider/model 配置仍可按其优先级覆盖托管值。

OpenCode 的 `/models` 中会出现完整 ID：

```text
opencodex/gateway-gpt/gpt-5.6-sol
opencodex/gateway-grok/grok-4.5
opencodex/openrouter/anthropic/claude-sonnet-5
```

OpenCode 支持模型 ID 内层斜杠，因此不会把第三方原生命名改成短横线。

## 客户端能力矩阵

| 客户端 | 导入模型如何显示 | 推理档位 | Fast 行为 |
| --- | --- | --- | --- |
| Codex CLI / App | 托管目录中显示 `gateway-grok/grok-4.5` 等路由项；目录同步后需重启正在运行的客户端。 | 使用显式声明的档位，并按本机 Codex 支持范围收紧。 | 显式 `priority` 会写成目录 Fast 档位；具体选择入口由已安装 Codex 界面决定。 |
| OpenCode | `/models` 显示 `opencodex/<provider>/<model>`。 | 声明档位成为 model variant。 | 显式 `priority` 生成 `fast` variant。 |
| Claude Code | `/model` 显示可读的 `claude-ocx-*` 网关别名。 | 通过 Anthropic 风格发现接口暴露兼容 effort 元数据。 | 暂无等价的逐模型 Fast variant；通过预检的 Responses 路由可使用代理全局 `fastMode`。 |

目录中出现模型不等于会员账号或分组拥有推理权限。必须再跑预检，并检查一次真实客户端请求及其
路由日志。

## 推理档位与 Fast

provider 已配置的 reasoning levels 会转成 OpenCode 模型 variant。Manifest v2 模型
只有显式包含 `"serviceTiers": ["priority"]` 时才会得到 `fast` variant：

```json
{
  "fast": {
    "serviceTier": "priority"
  }
}
```

Chat Completions 桥会保留它，并转换成 Responses 的
`service_tier: "priority"`。最终能否加速仍由上游账号/分组权限决定。把 OpenCodex
`fastMode` 设为 `false` 会隐藏 Fast；设为 `true` 则会对符合条件的 Responses 路由
全局强制 priority。

Composite 只有在每个成员都声明 `priority` 时才会继承 Fast。任一成员未声明或不支持，
该 Composite 就不会显示 Fast。旧版 v1 和手工配置的 GPT-5.5/GPT-5.6 Responses provider
仍保留原有的 OpenCode 按名称兼容判断。第三方 Codex 路由项不会继承原生模板里的 Fast；
只有 Manifest v2 明确声明后才写入，避免给不支持的模型显示无效档位。

## 可逆性

- 删除导入分组仍使用 `ocx provider remove <id>`。
- OpenCode 托管文件隔离在 `~/.opencodex/hosts/`。
- `ocx stop`、`ocx restore` 保持原有 Codex 恢复语义。
- 清单不包含密钥值；确认 URL 和模型名后可以安全提交到版本库。
