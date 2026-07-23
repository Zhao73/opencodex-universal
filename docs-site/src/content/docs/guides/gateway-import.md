---
title: Gateway Aggregators & OpenCode
description: Import multiple One API, New API, Sub2API, or OpenAI-compatible groups and expose their models in OpenCode.
---

OpenCodex can treat each aggregator group as an independent routed provider. This matters when a
One API, New API, or Sub2API key is bound to one upstream group: a GPT key and a Grok key must not
be placed in one API-key failover pool, because they do not authorize the same models.

## Import two or more groups

### Dashboard

Run `ocx gui`, open **Providers**, and choose **Import gateways**. Add as many independent
connections as needed, choose a credential mode for each one, then:

1. Select **Validate** to check the complete batch without writing configuration.
2. Review the number of connections and any provider ids that would be replaced.
3. Select **Import connections** to save the complete batch atomically.

Any edit invalidates the preview and requires validation again. Replacement is off by default.
Raw keys entered in the local dashboard are never returned in its validation response.

### Secret-free manifest

Start from the shipped example:

```bash
cp examples/gateways/multi-gateway-gpt-grok.json my-gateways.json
```

Change each `baseUrl`, then provide the keys through environment variables:

```bash
export GATEWAY_GPT_API_KEY="..."
export GATEWAY_GROK_API_KEY="..."

ocx gateway import my-gateways.json --dry-run
ocx gateway import my-gateways.json --sync
```

PowerShell:

```powershell
$env:GATEWAY_GPT_API_KEY = "..."
$env:GATEWAY_GROK_API_KEY = "..."
ocx gateway import .\my-gateways.json --dry-run
ocx gateway import .\my-gateways.json --sync
```

The manifest stores only environment-variable names. `ocx gateway` deliberately has no raw
`--api-key` flag, so a key is not copied into shell history or a shared JSON file.
The environment variable must also be present in the process that runs the OpenCodex proxy. If the
proxy runs as a service, add it to that service's environment instead of only the current shell.

Each `connections[]` entry supports:

| Field | Meaning |
| --- | --- |
| `id` | Stable OpenCodex provider id. |
| `kind` | `one-api`, `new-api`, `sub2api`, or `openai-compatible`. |
| `baseUrl` | Full API prefix, usually ending in `/v1`. OpenCodex does not guess or append it. |
| `protocol` | `chat-completions` or `responses`; this selects the upstream adapter. |
| `apiKeyEnv` | Environment-variable name containing this group's key. Required unless `keyOptional` is `true`. |
| `keyOptional` | Explicitly allow a local or otherwise unauthenticated compatible endpoint. |
| `models` | Optional static fallback list used when live discovery is unavailable. |
| `selectedModels` | Optional catalog allowlist. |
| `defaultModel` | Default model for this connection. |
| `allowPrivateNetwork` | Required for an intentionally local/RFC1918 gateway. |

Use `--force` only when intentionally replacing existing custom providers. Built-in OpenAI
authentication provider ids stay reserved and cannot be overwritten.

For a single group, the equivalent non-manifest command is:

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

## OpenCode model picker

OpenCode already supports hand-written OpenAI-compatible providers. The OpenCodex integration adds
the missing managed layer: it derives the full routed model catalog, refreshes it, keeps the
OpenCode config isolated, and launches OpenCode through the local proxy.

```bash
# Generate/refresh ~/.opencodex/hosts/opencode.json
ocx opencode configure

# Generate/refresh it and launch OpenCode
ocx opencode
```

The launcher sets `OPENCODE_CONFIG` for that process. It does not overwrite
`~/.config/opencode/opencode.json` or a project's `opencode.json`. OpenCode merges configuration
sources, so a project-level provider/model override can still take precedence.

The OpenCode `/models` picker receives full ids such as:

```text
opencodex/gateway-gpt/gpt-5.6-sol
opencodex/gateway-grok/grok-4.5
opencodex/openrouter/anthropic/claude-sonnet-5
```

Native slash namespaces are preserved because OpenCode supports them.

## Reasoning and fast variants

Configured reasoning levels become OpenCode model variants. GPT-5.5 and GPT-5.6 models routed
through an `openai-responses` provider also receive a `fast` variant:

```json
{
  "fast": {
    "serviceTier": "priority"
  }
}
```

The Chat Completions bridge preserves that request as Responses `service_tier: "priority"`.
Availability is still an upstream capability: the account/group must actually permit priority
processing. Set OpenCodex `fastMode` to `false` to suppress fast variants, or `true` to force
priority tier globally for eligible Responses routes.

## Reversibility

- Removing an imported group is the ordinary `ocx provider remove <id>` operation.
- The managed OpenCode file is isolated under `~/.opencodex/hosts/`.
- `ocx stop` and `ocx restore` retain their existing Codex restoration behavior.
- Gateway manifests contain no secret values and are safe to commit after checking their URLs and
  model names.
