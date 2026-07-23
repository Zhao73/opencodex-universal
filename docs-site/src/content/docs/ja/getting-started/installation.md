---
title: インストール
description: opencodex(ocx)プロキシと前提条件をインストールし、正常に実行できるか確認します。
---

opencodex をインストールすると同じ実行ファイルを指す `ocx` と `opencodex` コマンドが一緒に提供されます。
どちらも Bun ベースの小さなローカル HTTP サーバーを実行します。モデルリクエストはルーティングで選ばれたプロバイダーに
転送され、必要に応じて vision とウェブ検索のサイドカーが ChatGPT ログインを使うこともあります。

## 前提条件

| 要件 | 理由 |
 --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` は Bun ランタイムで実行されますが、ランタイムは `npm install` 時に自動でバンドルされるため、Bun を自分でインストールする必要は**ありません**。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App、または SDK) | opencodex が前に立つクライアントです。opencodex は `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)に書き込みます。 |
| プロバイダーアカウントまたは API キー | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API キー、OpenAI 互換エンドポイント、または ChatGPT ログイン。 |

## macOS インストール（arm64 / x64）

```bash
version="0.1.0-preview.1"
artifact="opencodex-universal-${version}.tgz"
release="https://github.com/Zhao73/opencodex-universal/releases/download/v${version}"
installer="/tmp/opencodex-universal-install.sh"

curl -fsSL "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v${version}/scripts/install.sh" -o "$installer"
sha256="$(curl -fsSL "${release}/${artifact}.sha256")"
OPENCODEX_PACKAGE_SPEC="${release}/${artifact}" \
OPENCODEX_PACKAGE_SHA256="$sha256" \
  bash "$installer"
```

## Windows インストール（PowerShell 5.1+、x64 / arm64）

```powershell
$version = "0.1.0-preview.1"
$artifact = "opencodex-universal-$version.tgz"
$release = "https://github.com/Zhao73/opencodex-universal/releases/download/v$version"
$installer = Join-Path $env:TEMP "opencodex-universal-install.ps1"

Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v$version/scripts/install.ps1" -OutFile $installer
$sha256 = (Invoke-WebRequest -UseBasicParsing "$release/$artifact.sha256").Content.Trim()
& $installer -PackageSpec "$release/$artifact" -ExpectedSha256 $sha256
```

両方のインストーラーは SHA-256 を検証し、ユーザー所有の staging へ展開します。新しいランチャーと
既存のバックグラウンドサービスが正常な場合だけ旧ランタイムから切り替えます。確認:

```bash
ocxu --version
```

同じコマンドを再実行するとトランザクション形式でアップグレードされます。`install.sh check` /
`install.ps1 -Action Check` はローカルランタイムを検証します。`uninstall` は設定を残して
ランタイムだけを削除し、`purge` は Codex の復元とローカル状態の削除も行います。

## ソースから実行

opencodex 自体を直接修正しながら作業するには:

```bash
git clone https://github.com/Zhao73/opencodex-universal.git
cd opencodex-universal
bun install
bun run dev:proxy   # 開発モードでプロキシ API を起動 (src/cli/index.ts start)
bun run dev:gui     # ダッシュボード dev サーバーを起動 (別ターミナル)
```

`bun run dev` は `bun run dev:proxy` のエイリアスとして残っています。プロキシ API は `/healthz`、
`/v1/responses`、`/api/*` を公開し、`GET /` は `bun run build:gui` が `gui/dist` を生成した
後にのみパッケージされたダッシュボードを提供します。ダッシュボードを編集する際は `bun run dev:gui` でフロントエンドを
別途実行してください。

## 生成されるもの

opencodex の状態ファイルは `$OPENCODEX_HOME`(デフォルト `~/.opencodex`)の下に、Codex 連携ファイルは
`$CODEX_HOME`(デフォルト `~/.codex`)の下に保存されます。

| パス | 用途 |
 --- | --- |
| `$OPENCODEX_HOME/config.json` | プロバイダー、デフォルトプロバイダー、ポート、オプション。 |
| `$OPENCODEX_HOME/ocx.pid` | 実行中のプロキシの PID(単一インスタンスガード)。 |
| `$OPENCODEX_HOME/runtime-port.json` | 自動で選んだ代替ポートを含む現在の PID、ホスト名、ポート。 |
| `$OPENCODEX_HOME/auth.json` | 保存された OAuth 認証情報(`ocx login` 時)。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex が変更する前に作成した Codex モデルカタログのバックアップ。 |
| `$CODEX_HOME/config.toml` | ローカル専用構成では opencodex が管理するルート `openai_base_url` を追加します。ローカル以外のアドレスにバインドする場合は Codex が API 認証ヘッダーを送れるよう `model_provider = "opencodex"` と `[model_providers.opencodex]` を使います。 |
| `$CODEX_HOME/opencodex.config.toml` | デフォルト Codex 設定と一緒に生成される参考用 fallback プロファイル。 |
| `$CODEX_HOME/opencodex-catalog.json` | Codex が使うネイティブおよびルーティングモデルカタログ。 |

:::note
opencodex は決して Codex 設定を削除しません。すべての注入は元に戻せます — `ocx stop`、`ocx restore`、
または `ocx eject` は opencodex が追加した行だけを正確に削除し、ネイティブ Codex を復元します。
:::

## 次へ

[クイックスタート](/opencodex-universal/ja/getting-started/quickstart/)に進んで最初のプロバイダーを設定するか、
アーキテクチャを知るには[仕組み](/opencodex-universal/ja/getting-started/how-it-works/)をお読みください。
