---
title: 聚合网关与 OpenCode
description: 一次导入多个 One API、New API、Sub2API 或 OpenAI 兼容分组，并在 OpenCode 中显示其模型。
---

OpenCodex 会把每个聚合网关分组视为一个独立 provider。One API、New API、Sub2API 的密钥
通常只绑定一个上游分组，因此 GPT key 与 Grok key 不能放进同一个 API-key 故障切换池：
它们授权的模型并不相同。

## 一次导入两个或更多分组

### 前端界面

运行 `ocx gui`，进入**提供方**，点击**批量导入网关**。按需要添加多个相互独立的连接，
为每个连接选择凭据方式，然后：

1. 点击**校验**，在不写入配置的情况下检查整个批次。
2. 确认连接数量以及会被覆盖的同名 provider。
3. 点击**导入连接**，一次性原子化保存完整批次。

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

ocx gateway import my-gateways.json --dry-run
ocx gateway import my-gateways.json --sync
```

Windows PowerShell：

```powershell
$env:GATEWAY_GPT_API_KEY = "..."
$env:GATEWAY_GROK_API_KEY = "..."
ocx gateway import .\my-gateways.json --dry-run
ocx gateway import .\my-gateways.json --sync
```

清单只保存环境变量名。`ocx gateway` 故意不提供原始 `--api-key` 参数，避免密钥进入
PowerShell/bash 历史或被提交到共享 JSON。
运行 OpenCodex 代理的进程也必须能读取这些环境变量。若代理以系统服务运行，应把变量写入服务
环境，不能只在当前 PowerShell/bash 窗口中临时设置。

每个 `connections[]` 支持：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定的 OpenCodex provider ID。 |
| `kind` | `one-api`、`new-api`、`sub2api` 或 `openai-compatible`。 |
| `baseUrl` | 完整 API 前缀，通常以 `/v1` 结尾；OpenCodex 不会擅自补路径。 |
| `protocol` | `chat-completions` 或 `responses`，用于选择上游 adapter。 |
| `apiKeyEnv` | 保存该分组 key 的环境变量名；除非 `keyOptional` 为 `true`，否则必填。 |
| `keyOptional` | 明确允许本机或其他无需鉴权的兼容端点。 |
| `models` | 可选静态兜底列表，在线模型发现不可用时仍可显示。 |
| `selectedModels` | 可选的模型目录白名单。 |
| `defaultModel` | 该连接的默认模型。 |
| `allowPrivateNetwork` | 本机或 RFC1918 内网网关必须明确开启。 |

只有在确实要替换已有自定义 provider 时才使用 `--force`。内置 OpenAI 登录/路由 ID
始终保留，不允许覆盖。

单个分组也可以直接添加：

```bash
ocx gateway add gateway-gpt \
  --kind openai-compatible \
  --base-url https://gateway.example.com/v1 \
  --protocol responses \
  --api-key-env GATEWAY_GPT_API_KEY \
  --model gpt-5.6-sol \
  --model gpt-5.6-terra \
  --default-model gpt-5.6-sol \
  --set-default
```

## 在 OpenCode 模型选择器中显示

OpenCode 本身支持手写 OpenAI 兼容 provider；缺少的是 Sub2API/One API/New API 的一键
多分组导入、模型目录刷新、密钥隔离和可逆启动层。OpenCodex 补的是这一层。

```bash
# 生成/刷新 ~/.opencodex/hosts/opencode.json
ocx opencode configure

# 生成/刷新后直接启动 OpenCode
ocx opencode
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

## 推理档位与 Fast

provider 已配置的 reasoning levels 会转成 OpenCode 模型 variant。通过
`openai-responses` 路由的 GPT-5.5/GPT-5.6 还会得到 `fast` variant：

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

## 可逆性

- 删除导入分组仍使用 `ocx provider remove <id>`。
- OpenCode 托管文件隔离在 `~/.opencodex/hosts/`。
- `ocx stop`、`ocx restore` 保持原有 Codex 恢复语义。
- 清单不包含密钥值；确认 URL 和模型名后可以安全提交到版本库。
