# OpenCodex Universal `0.1.0-preview.2` 联合验收

这份手册只用于候选版验收。它不会把配置部署到棉花糖生产环境，也不把 Draft PR
合并到 `dev` 或 `main`。

## 1. 固定测试对象

- 仓库：`Zhao73/opencodex-universal`
- 版本：`0.1.0-preview.2`
- 标签：`v0.1.0-preview.2`
- 命令：`ocxu`，不会覆盖上游项目的 `ocx`
- 发布文件：`opencodex-universal-0.1.0-preview.2.tgz`
- 发布清单：`release-manifest.json`

开始前先下载发布页里的 `release-manifest.json`，核对安装包文件名、字节数和
SHA-256。发布提交可用下面的命令确认：

```bash
git rev-list -n 1 v0.1.0-preview.2
```

不要把真实 API 密钥、一次性配对令牌或完整上游错误正文贴到 Issue、PR 或聊天中。

## 2. 安装门

### macOS

```bash
version="0.1.0-preview.2"
artifact="opencodex-universal-${version}.tgz"
release="https://github.com/Zhao73/opencodex-universal/releases/download/v${version}"
installer="/tmp/opencodex-universal-install.sh"

curl -fsSL \
  "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v${version}/scripts/install.sh" \
  -o "$installer"
sha256="$(curl -fsSL "${release}/${artifact}.sha256")"
OPENCODEX_PACKAGE_SPEC="${release}/${artifact}" \
OPENCODEX_PACKAGE_SHA256="$sha256" \
  bash "$installer"

ocxu --version
```

### Windows PowerShell 5.1+

```powershell
$version = "0.1.0-preview.2"
$artifact = "opencodex-universal-$version.tgz"
$release = "https://github.com/Zhao73/opencodex-universal/releases/download/v$version"
$installer = Join-Path $env:TEMP "opencodex-universal-install.ps1"

Invoke-WebRequest -UseBasicParsing `
  "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v$version/scripts/install.ps1" `
  -OutFile $installer
$sha256 = (Invoke-WebRequest -UseBasicParsing "$release/$artifact.sha256").Content.Trim()
& $installer -PackageSpec "$release/$artifact" -ExpectedSha256 $sha256

ocxu --version
```

通过标准：

- 输出版本为 `0.1.0-preview.2`。
- 旧 `ocx` 命令和用户自己的 Codex、OpenCode、Claude Code 配置仍存在。
- 重复运行安装命令成功。
- 故意使用错误 SHA-256 时，安装必须失败，且原来可运行的版本不损坏。

安装成功不代表任何模型可用。

## 3. 准备不含密钥的多分组清单

复制仓库里的示例：

```bash
cp examples/gateways/multi-gateway-gpt-grok.json joint-gateways.json
```

把每个连接的 `baseUrl` 改成该分组的完整 API 前缀。不要猜测 `/v1`，以网关实际地址为准。
示例默认把 GPT 和 Grok 作为两条独立连接：

- GPT：独立 URL、密钥、模型目录、协议与 `costMultiplier: 0.3`
- Grok：独立 URL、密钥、模型目录、协议与 `costMultiplier: 0.2`

macOS/Linux：

```bash
export GATEWAY_GPT_API_KEY="仅在本机填写"
export GATEWAY_GROK_API_KEY="仅在本机填写"
```

Windows：

```powershell
$env:GATEWAY_GPT_API_KEY = "仅在本机填写"
$env:GATEWAY_GROK_API_KEY = "仅在本机填写"
```

## 4. 分开的四道连接门

### 4.1 清单校验

```bash
ocxu gateway import joint-gateways.json --dry-run --json
```

通过标准：所有连接一次性通过结构、目标地址和凭据引用校验；磁盘配置尚未改变。

### 4.2 模型目录

```bash
ocxu gateway preflight joint-gateways.json --json
```

通过标准：

- 每条连接单独返回目录状态、延迟、HTTP 分类和稳定错误代码。
- 清单指定的模型确实出现在上游目录；否则为 `configured_model_missing`。
- 目录成功只证明“能列出模型”，不证明“能调用模型”。

### 4.3 最小真实推理

这一步可能产生上游费用：

```bash
ocxu gateway preflight joint-gateways.json --inference --json
```

通过标准：GPT 和 Grok 分别通过自己的 URL、密钥和协议返回最小有效响应。任一条失败都要
保留它自己的 HTTP 分类和稳定错误代码，不能把另一条连接的成功当成替代。

### 4.4 Fast / priority

这一步可能按更高费率计费：

```bash
ocxu gateway preflight joint-gateways.json --inference --fast --json
```

仅对模型配置中明确声明 `"serviceTiers": ["priority"]` 的连接执行 Fast。

- `fast_confirmed`：上游响应明确回显 `service_tier: "priority"`。
- `fast_accepted_unconfirmed`：请求成功，但上游未回显 tier；不能据此声称已加速或按
  priority 计费。
- 上游拒绝 Fast 必须原样归类为失败；不得静默退回标准模式后显示成功。

`grok-4.5` 示例没有声明 priority，所以不应伪造 Fast 选项。

## 5. 原子导入与客户端模型显示

四道门确认后再写入：

```bash
ocxu gateway import joint-gateways.json --sync
ocxu gui
```

在仪表盘确认每条连接保留自己的 URL、协议、模型和估算倍率。随后分别验收：

### Codex CLI / Desktop

- 重启已经打开的 Codex 客户端，让托管目录重新载入。
- 模型目录应显示路由行，例如 `gateway-gpt/gpt-5.6-sol` 与
  `gateway-grok/grok-4.5`。
- 只有显式声明 priority 的路由模型才带 Fast 元数据；是否显示为独立控件仍取决于
  当前 Codex 客户端界面。
- 发送一条短请求，然后在 OpenCodex 日志里核对请求模型、实际 provider 和实际模型。

### OpenCode

```bash
ocxu opencode configure
ocxu opencode
```

`/models` 应显示：

```text
opencodex/gateway-gpt/gpt-5.6-sol
opencodex/gateway-grok/grok-4.5
```

显式 priority 模型应有 `fast` variant；未声明的模型不应有。

### Claude Code

```bash
ocxu claude
```

兼容连接通过 `claude-ocx-*` 别名出现在 `/model`。Claude Code 没有与 OpenCode 完全
等价的逐模型 Fast variant，因此不要把“能显示模型”写成“支持逐模型 Fast”。

## 6. Composite 与计费显示

建立 GPT + Grok Composite 后，故意让第一条连接返回可故障转移的失败，再让第二条成功。

通过标准：

- 日志保留每次物理尝试，不只保留最后一次。
- 每次尝试使用实际处理它的 provider 的倍率。
- GPT `0.3` 与 Grok `0.2` 分别计算，不能被 Composite 的路由权重替代。
- 页面明确标为估算。One API、New API、Sub2API 等上游账单仍是实际扣费依据。
- Composite 只有在所有成员都明确声明 priority 时才显示 Fast。

## 7. 常见失败判定

- 错误 URL 指向 `https://api.openai.com/...`，但本应走本地代理：客户端绕过了
  OpenCodex。先记录 `ocxu status --json` 和客户端实际 base URL。
- `401` / `403`：凭据或分组授权失败；模型出现在下拉框并不能证明有推理权限。
- `configured_model_missing`：静态配置的模型不在本次真实目录响应中。
- `all available accounts exhausted`：上游账号池容量失败，不是安装成功与否的问题。
- `503`：先看 OpenCodex 日志中的实际 provider、上游状态分类和 Composite 尝试链，
  不要只依据客户端统一错误页。

## 8. 回退门

保留用户状态、只卸载运行时：

```bash
bash /tmp/opencodex-universal-install.sh uninstall
```

Windows：

```powershell
& $installer -Action Uninstall
```

通过标准：

- 新运行时和 `ocxu` shim 被移除。
- 安装器添加的 Windows 用户 PATH 项被移除。
- `~/.opencodex` 或 `%USERPROFILE%\.opencodex` 中用户自己的状态仍保留。
- 旧 `ocx` 与未受管的 Codex、OpenCode、Claude Code 配置不变。

## 9. 联合验收记录

每个系统分别记录以下结果，不要只写“成功”：

| 项目 | macOS arm64/x64 | Windows x64/arm64 |
| --- | --- | --- |
| 安装 / 重装 / 错 SHA 拒绝 / 卸载 |  |  |
| GPT 目录 / 推理 / Fast |  |  |
| Grok 目录 / 推理 / Fast 不伪造 |  |  |
| Codex 模型显示与真实路由 |  |  |
| OpenCode 模型与 variant |  |  |
| Claude Code 模型别名 |  |  |
| Composite 尝试链与 `0.3` / `0.2` 估算 |  |  |
| 日志、API、产物无密钥 |  |  |

全部通过后，才讨论合并到 `dev`；棉花糖生产接入仍需单独部署与回滚方案。
