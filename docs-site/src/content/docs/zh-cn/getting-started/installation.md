---
title: 安装
description: 安装 opencodex(ocx)代理及其前置条件,并验证它能够运行。
---

预览安装器会提供不与旧版冲突的 `ocxu` 命令，并保留已有的上游 `ocx`。命令指向同一个基于 Bun 的
小型本地 HTTP 服务器。模型请求会发往路由所选的 provider；当已路由模型需要时，可选的
vision 和网络搜索 sidecar 也可以使用你的 ChatGPT 登录凭据。

## 前置条件

| 要求 | 原因 |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocxu` 运行在 Bun 运行时上，安装器会自动选择匹配架构的运行时，你**无需**自己安装 Bun。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App 或 SDK) | opencodex 所代理的客户端。opencodex 会写入 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。 |
| 一个 provider 账号或 API key | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API key、一个 OpenAI 兼容端点,或你的 ChatGPT 登录凭据。 |

## macOS 安装（arm64 / x64）

```bash
version="0.1.0-preview.2"
artifact="opencodex-universal-${version}.tgz"
release="https://github.com/Zhao73/opencodex-universal/releases/download/v${version}"
installer="/tmp/opencodex-universal-install.sh"

curl -fsSL "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v${version}/scripts/install.sh" -o "$installer"
sha256="$(curl -fsSL "${release}/${artifact}.sha256")"
OPENCODEX_PACKAGE_SPEC="${release}/${artifact}" \
OPENCODEX_PACKAGE_SHA256="$sha256" \
  bash "$installer"
```

## Windows 安装（PowerShell 5.1+，x64 / arm64）

```powershell
$version = "0.1.0-preview.2"
$artifact = "opencodex-universal-$version.tgz"
$release = "https://github.com/Zhao73/opencodex-universal/releases/download/v$version"
$installer = Join-Path $env:TEMP "opencodex-universal-install.ps1"

Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v$version/scripts/install.ps1" -OutFile $installer
$sha256 = (Invoke-WebRequest -UseBasicParsing "$release/$artifact.sha256").Content.Trim()
& $installer -PackageSpec "$release/$artifact" -ExpectedSha256 $sha256
```

两端都会先校验 SHA-256，安装到用户目录的 staging，并在切换前验证启动器；如果已有后台服务，
旧运行时会保留到服务刷新成功。安装后验证：

```bash
ocxu --version
```

重复运行同一命令即可升级；`install.sh check` / `install.ps1 -Action Check` 用于本机自检。
`uninstall` 只移除运行时并保留 `~/.opencodex`，`purge` 还会恢复 Codex 并删除本地状态。

## 从源码运行

若要对 opencodex 本身进行开发:

```bash
git clone https://github.com/Zhao73/opencodex-universal.git
cd opencodex-universal
bun install
bun run dev:proxy   # 以开发模式启动代理 API (src/cli/index.ts start)
bun run dev:gui     # 启动仪表盘 dev 服务器 (另一个终端)
```

`bun run dev` 作为 `bun run dev:proxy` 的别名保留。代理 API 暴露 `/healthz`、`/v1/responses`、
`/api/*`;只有在 `bun run build:gui` 生成 `gui/dist` 之后,`GET /` 才会提供打包后的仪表盘。
开发仪表盘时,请用 `bun run dev:gui` 单独运行前端。

## 会创建哪些内容

opencodex 状态文件位于 `$OPENCODEX_HOME`（默认 `~/.opencodex`），Codex 集成文件位于
`$CODEX_HOME`（默认 `~/.codex`）。

| 路径 | 用途 |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | 你的 provider、默认 provider、端口及选项。 |
| `$OPENCODEX_HOME/ocx.pid` | 正在运行的代理的 PID（单实例保护）。 |
| `$OPENCODEX_HOME/runtime-port.json` | 当前 PID、主机名和端口，包括自动选择的备用端口。 |
| `$OPENCODEX_HOME/auth.json` | 执行 `ocx login` 后保存的 OAuth 凭据。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex 修改 Codex 模型目录前创建的备份。 |
| `$CODEX_HOME/config.toml` | 仅监听回环地址时，opencodex 会添加由自身标记管理的根级 `openai_base_url`；监听非回环地址时，则使用 `model_provider = "opencodex"` 和 `[model_providers.opencodex]`，以便 Codex 发送 API 认证 header。 |
| `$CODEX_HOME/opencodex.config.toml` | 与 Codex 主配置一同写入的备用/参考 profile。 |
| `$CODEX_HOME/opencodex-catalog.json` | 供 Codex 使用的原生与已路由模型目录。 |

:::note
opencodex 绝不会删除你的 Codex 配置。每次注入都是可逆的 —— `ocx stop`、`ocx restore`
或 `ocx eject` 会精确剥离 opencodex 所添加的那些行,并恢复原生 Codex。
:::

## 下一步

继续阅读 [快速开始](/opencodex-universal/zh-cn/getting-started/quickstart/) 以配置你的第一个 provider,
或阅读 [工作原理](/opencodex-universal/zh-cn/getting-started/how-it-works/) 了解其架构。
