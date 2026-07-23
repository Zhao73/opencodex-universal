---
title: Установка
description: Установите прокси opencodex (ocx) и необходимые компоненты и убедитесь, что он запускается.
---

opencodex устанавливает два эквивалентных имени команды: `ocx` и `opencodex`. Обе запускают один и
тот же небольшой локальный HTTP-сервер (построенный на Bun). Запросы к моделям идут к провайдеру,
выбранному маршрутизацией; опциональные сайдкары для vision и веб-поиска также могут использовать
ваш вход в ChatGPT, когда они нужны маршрутизируемой модели.

## Предварительные требования

| Требование | Зачем |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` работает на рантайме Bun, но рантайм автоматически поставляется в комплекте при `npm install` — устанавливать Bun самостоятельно **не нужно**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App или SDK) | Клиент, перед которым работает opencodex. opencodex записывает данные в `$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`). |
| Аккаунт провайдера или API-ключ | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI-совместимая конечная точка или ваш вход в ChatGPT. |

## Установка на macOS (arm64 / x64)

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

## Установка на Windows (PowerShell 5.1+, x64 / arm64)

```powershell
$version = "0.1.0-preview.1"
$artifact = "opencodex-universal-$version.tgz"
$release = "https://github.com/Zhao73/opencodex-universal/releases/download/v$version"
$installer = Join-Path $env:TEMP "opencodex-universal-install.ps1"

Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Zhao73/opencodex-universal/v$version/scripts/install.ps1" -OutFile $installer
$sha256 = (Invoke-WebRequest -UseBasicParsing "$release/$artifact.sha256").Content.Trim()
& $installer -PackageSpec "$release/$artifact" -ExpectedSha256 $sha256
```

Оба установщика проверяют SHA-256 и разворачивают пакет в пользовательский staging prefix.
Переключение со старого рантайма выполняется только после проверки нового запуска и существующей
фоновой службы. Проверка установки:

```bash
ocxu --version
```

Повторный запуск той же команды выполняет транзакционное обновление. `install.sh check` /
`install.ps1 -Action Check` проверяет локальный рантайм. `uninstall` удаляет только рантайм,
сохраняя настройки, а `purge` также восстанавливает Codex и удаляет локальное состояние.

## Запуск из исходного кода

Чтобы работать над самим opencodex:

```bash
git clone https://github.com/Zhao73/opencodex-universal.git
cd opencodex-universal
bun install
bun run dev:proxy   # запускает API прокси в режиме разработки (src/cli/index.ts start)
bun run dev:gui     # запускает dev-сервер панели управления (в другом терминале)
```

`bun run dev` остаётся псевдонимом для `bun run dev:proxy`. API прокси предоставляет `/healthz`,
`/v1/responses` и `/api/*`; `GET /` отдаёт упакованную панель управления только после того, как
`bun run build:gui` создаст `gui/dist`. Пока вы работаете над панелью управления, запускайте
фронтенд отдельно командой `bun run dev:gui`.

## Что создаётся

Состояние opencodex хранится в `$OPENCODEX_HOME` (по умолчанию `~/.opencodex`). Файлы интеграции
с Codex находятся в `$CODEX_HOME` (по умолчанию `~/.codex`).

| Путь | Назначение |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Ваши провайдеры, провайдер по умолчанию, порт и параметры. |
| `$OPENCODEX_HOME/ocx.pid` | PID запущенного прокси (защита от повторного запуска). |
| `$OPENCODEX_HOME/runtime-port.json` | Текущие PID, имя хоста и порт, включая автоматически выбранный запасной порт. |
| `$OPENCODEX_HOME/auth.json` | Сохранённые учётные данные OAuth (после `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Резервные копии каталога моделей Codex, создаваемые перед тем, как opencodex его изменит. |
| `$CODEX_HOME/config.toml` | На loopback-адресе opencodex добавляет корневой `openai_base_url`, отмеченный собственным маркером; при привязке не к loopback используются `model_provider = "opencodex"` и `[model_providers.opencodex]`, чтобы Codex мог отправлять заголовок API-аутентификации. |
| `$CODEX_HOME/opencodex.config.toml` | Резервный/справочный профиль, записываемый рядом с основной конфигурацией Codex. |
| `$CODEX_HOME/opencodex-catalog.json` | Синхронизированный каталог нативных и маршрутизируемых моделей, используемый Codex. |

:::note
opencodex никогда не удаляет вашу конфигурацию Codex. Каждое внедрение обратимо — `ocx stop`,
`ocx restore` или `ocx eject` убирают ровно те строки, которые добавил opencodex, и восстанавливают
нативный Codex.
:::

## Далее

Переходите к разделу [Быстрый старт](/opencodex-universal/ru/getting-started/quickstart/), чтобы настроить
первого провайдера, или прочитайте [Как это работает](/opencodex-universal/ru/getting-started/how-it-works/),
чтобы разобраться в архитектуре.
