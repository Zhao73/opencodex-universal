---
title: Installation
description: Install the opencodex (ocx) proxy, its prerequisites, and verify it runs.
---

The preview installer exposes the collision-free `ocxu` command and leaves an existing upstream
`ocx` untouched. Both launch the same small local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocxu` runs on the Bun runtime, but the matching runtime is bundled automatically — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client opencodex sits in front of. opencodex writes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## macOS install (arm64 or x64)

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

## Windows install (PowerShell 5.1+; x64 or arm64)

```powershell
$version = "0.1.0-preview.1"
$artifact = "opencodex-universal-$version.tgz"
$release = "https://github.com/Zhao73/opencodex-universal/releases/download/v$version"
$installer = Join-Path $env:TEMP "opencodex-universal-install.ps1"

Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v$version/scripts/install.ps1" -OutFile $installer
$sha256 = (Invoke-WebRequest -UseBasicParsing "$release/$artifact.sha256").Content.Trim()
& $installer -PackageSpec "$release/$artifact" -ExpectedSha256 $sha256
```

Both installers verify SHA-256, install into a user-owned staging prefix, validate the launcher,
and preserve the old runtime until an existing background service has also been refreshed. Verify:

```bash
ocxu --version
```

Re-run the command to upgrade. `install.sh check` / `install.ps1 -Action Check` validates the local
runtime. `uninstall` removes the runtime while preserving `~/.opencodex`; `purge` also restores
Codex and removes local opencodex state.

## Run from source

To hack on opencodex itself:

```bash
git clone https://github.com/Zhao73/opencodex-universal.git
cd opencodex-universal
bun install
bun run dev:proxy   # starts the proxy API in dev mode (src/cli/index.ts start)
bun run dev:gui     # starts the dashboard dev server (another terminal)
```

`bun run dev` remains an alias for `bun run dev:proxy`. The proxy API exposes `/healthz`,
`/v1/responses`, and `/api/*`; `GET /` serves the packaged dashboard only after `bun run build:gui`
has produced `gui/dist`. While hacking on the dashboard, run the frontend separately with
`bun run dev:gui`.

## What gets created

opencodex state lives under `$OPENCODEX_HOME` (default `~/.opencodex`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

| Path | Purpose |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Your providers, default provider, port, and options. |
| `$OPENCODEX_HOME/ocx.pid` | PID of the running proxy (single-instance guard). |
| `$OPENCODEX_HOME/runtime-port.json` | The live PID, hostname, and port, including an automatically selected fallback port. |
| `$OPENCODEX_HOME/auth.json` | Stored OAuth credentials (when you `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Codex model catalog backups made before opencodex edits it. |
| `$CODEX_HOME/config.toml` | On loopback, opencodex adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "opencodex"` plus `[model_providers.opencodex]` so Codex can send the API-auth header. |
| `$CODEX_HOME/opencodex.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/opencodex-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
opencodex never deletes your Codex config. Every injection is reversible — `ocx stop`, `ocx restore`,
or `ocx eject` strip exactly the lines opencodex added and restore native Codex.
:::

## Next

Continue to the [Quickstart](/opencodex-universal/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/opencodex-universal/getting-started/how-it-works/) for the architecture.
