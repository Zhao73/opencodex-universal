---
title: Connect a Key in One Paste
description: Paste an API key and OpenCodex identifies the gateway, loads the models that key is entitled to, and wires them into Codex, Claude Code, and OpenCode.
---

`ocxu connect` turns a copied API key into working models. It identifies the gateway product,
reads the catalog that key is actually entitled to, and imports each key as its own routed
provider — no manifest file, no base-URL hunting, no environment variables.

```bash
ocxu connect                      # paste, then press Enter on an empty line
ocxu connect --file keys.txt      # read the paste from a file
pbpaste | ocxu connect            # pipe the clipboard (macOS)
```

The paste is read from **stdin** by default so the secret never enters shell history. `--key`
exists for scripts that already hold the value; use it only where shell history is not a concern.

## Accepted paste formats

| Paste | Result |
|---|---|
| `sk-abc123` | Endpoint discovered from `--base-url`, the endpoints already in your config, then the built-in reference host |
| `sk-abc123@https://gateway.example.com` | Explicit pairing |
| `https://gateway.example.com/v1#sk-abc123` | Explicit pairing |
| `Base URL: …` and `API Key: …` on separate lines | Keys inherit the most recent URL above them |
| `export ANTHROPIC_BASE_URL=…` + `export ANTHROPIC_AUTH_TOKEN=…` | Env blocks are parsed |
| `curl https://…/v1/chat/completions -H "Authorization: Bearer sk-…"` | Endpoint tail is stripped back to the gateway root |
| `{"base_url": "…", "api_key": "…"}` or an array of such objects | JSON, including nested objects |
| Several keys in one paste (up to 20) | Each becomes an independent provider |

Placeholder values are rejected on purpose: `${OPENAI_API_KEY}`, `your-api-key-here`,
`sk-xxxxxxxx`, `<paste key here>` and similar never produce a connection.

## What detection does

1. **Product identification.**
   A [Sub2API](https://github.com/Wei-Shaw/sub2api) deployment answers
   `GET /v1/sub2api/billing` with `{"object": "sub2api.key_billing", …}`. That response also carries
   the key's effective rate multiplier, which is imported as the connection's **estimate-only**
   `costMultiplier` — it changes what OpenCodex displays, never what the gateway bills.
   One API and New API are identified from `GET /api/status`. Anything else is imported as a
   generic OpenAI-compatible endpoint.

2. **Catalog discovery.**
   `GET /v1/models` is called with your key, so the imported model list is exactly what that key
   can use. For GPT catalogs, OpenCodex additionally requests
   `GET /v1/models?client_version=…`, the ChatGPT Codex manifest form, and harvests display names,
   the reasoning ladder (`low` … `max`), the default effort, and the `priority` Fast tier.
   Reported capabilities always beat OpenCodex's built-in family table.

3. **Protocol selection.**
   A GPT catalog routes over the **Responses** API, because per-model reasoning effort and the
   Fast/priority tier ride on it. Claude, Grok, Gemini and mixed catalogs route over
   **Chat Completions**, which every Sub2API / One API / New API group exposes.

4. **Provider naming.**
   The id is derived from the host and the model family: `mallowapi-gpt`, `mallowapi-claude`,
   `mallowapi-grok`. Self-hosted gateways on an IP or `localhost` use the `local-…` stem.

## Re-pasting is safe

Pasting a key that already has a connection at the same base URL **refreshes that provider in
place** — same id, fresh catalog, fresh rate. A provider that OpenCodex did not import through a
gateway flow is never overwritten; the new connection takes the next free suffix (`-2`, `-3`, …)
instead.

## Several keys at once

Each key becomes an independent provider with its own credential, protocol, model list and rate.
A GPT credential can therefore never end up in a Grok key's failover pool, and both stay routable
at the same time:

```console
$ ocxu connect
Found 2 keys: sk-cg-9f…8a63, sk-cg-1b…04d7
Probing gateways…

Connected 2 gateway(s):
  mallowapi-gpt
    endpoint  https://mallowapi.com/v1  [sub2api · responses]  rate ×0.2
    key       sk-cg-9f…8a63
    models    4 (openai)  default: gpt-5.6-sol
  mallowapi-grok
    endpoint  https://mallowapi.com/v1  [sub2api · chat-completions]  rate ×0.2
    key       sk-cg-1b…04d7
    models    6 (grok)  default: grok-4.5
```

## Options

| Flag | Purpose |
|---|---|
| `--base-url <url>` | Try this gateway root first. Repeatable. |
| `--file <path>` | Read the paste from a file instead of stdin. |
| `--key <value>` | Pass a single key inline. |
| `--id <prefix>` | Use an explicit provider id prefix instead of the derived one. |
| `--set-default` | Make the first detected connection the default provider. |
| `--allow-private-network` | Permit `localhost` / RFC1918 gateways. Metadata endpoints stay blocked. |
| `--apply codex,opencode` | Configure clients right after the import. `all` covers every target. |
| `--dry-run` | Detect and print; write nothing. |
| `--force` | Replace providers that already own these ids. |
| `--timeout <ms>` | Per-request probe timeout (default 12000). |
| `--json` | Machine-readable output. Keys are masked. |

## Using the connected models

Nothing else is required — `connect` writes ordinary routed providers:

```bash
ocxu start          # Codex CLI and Codex app pick up the synced catalog
ocxu claude         # Claude Code, with claude-ocx-<provider>--<model> aliases
ocxu opencode       # OpenCode, with per-model reasoning variants and `fast`
ocxu models         # list everything that is now routable
```

## Dashboard

The same flow lives in the dashboard: **`ocxu gui` → Providers → Import gateways → Paste an API
key**. It posts to `POST /api/gateways/connect`, the management-API twin of this command. The full
manual form is still on the same screen for connections that need explicit control.

## Where the key goes

Detected keys are stored in `~/.opencodex/config.json` (directory mode `0700`). A paste that names
its endpoint is only ever sent there. A **bare** key has no endpoint, so it is probed against known
roots in order — `--base-url`, the gateway roots already in your config, then the built-in
reference host. `ocxu connect` prints that list before the first request leaves the machine; pass
`--base-url` to probe only your own gateway.

CLI output, `--json` output, and every management-API response carry masked keys such as
`sk-cg-9f…8a63`; the raw value is never echoed back after it is parsed.

For manifest-based imports, environment-variable credentials, capability profiles, and billable
preflight probes, see [Gateway Aggregators & OpenCode](/guides/gateway-import/).
