---
title: Gateway Aggregators & OpenCode
description: Import multiple One API, New API, Sub2API, or OpenAI-compatible groups and expose their models in OpenCode.
---

OpenCodex can treat each aggregator group as an independent routed provider. This matters when a
One API, New API, or Sub2API key is bound to one upstream group: a GPT key and a Grok key must not
be placed in one API-key failover pool, because they do not authorize the same models.

## Import two or more groups

### Dashboard

The Universal preview uses the collision-free `ocxu` command in these examples. Its `ocx` alias is
equivalent only when another installation has not already claimed that name.

Run `ocxu gui`, open **Providers**, and choose **Import gateways**. Add as many independent
connections as needed, choose a credential mode for each one, then:

1. Select **Validate** to check the complete batch without writing configuration.
2. Select **Run connection test** to probe model discovery. Minimal inference and Fast are separate,
   explicit opt-ins because each can consume upstream quota.
3. Review every connection's catalog, inference, and Fast result independently.
4. Select **Import connections** to save the complete batch atomically.

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

ocxu gateway import my-gateways.json --dry-run
ocxu gateway preflight my-gateways.json --json
# Optional billable checks:
ocxu gateway preflight my-gateways.json --inference --fast
ocxu gateway import my-gateways.json --sync
```

PowerShell:

```powershell
$env:GATEWAY_GPT_API_KEY = "..."
$env:GATEWAY_GROK_API_KEY = "..."
ocxu gateway import .\my-gateways.json --dry-run
ocxu gateway preflight .\my-gateways.json --json
# Optional billable checks:
ocxu gateway preflight .\my-gateways.json --inference --fast
ocxu gateway import .\my-gateways.json --sync
```

The manifest stores only environment-variable names. `ocxu gateway` deliberately has no raw
`--api-key` flag, so a key is not copied into shell history or a shared JSON file.
The environment variable must also be present in the process that runs the OpenCodex proxy. If the
proxy runs as a service, add it to that service's environment instead of only the current shell.

Manifest v1 remains supported for existing files. Manifest v2 adds explicit per-model capability
profiles. Each `connections[]` entry supports:

| Field | Meaning |
| --- | --- |
| `id` | Stable OpenCodex provider id. |
| `kind` | `one-api`, `new-api`, `sub2api`, or `openai-compatible`. |
| `baseUrl` | Full API prefix, usually ending in `/v1`. OpenCodex does not guess or append it. |
| `protocol` | `chat-completions` or `responses`; this selects the upstream adapter. |
| `costMultiplier` | Manifest v2 positive display-estimate multiplier. It does not alter routing or upstream billing. |
| `apiKeyEnv` | Environment-variable name containing this group's key. Required unless `keyOptional` is `true`. |
| `keyOptional` | Explicitly allow a local or otherwise unauthenticated compatible endpoint. |
| `models` | Optional static fallback list used when live discovery is unavailable. |
| `modelProfiles` | Manifest v2 metadata keyed by model ID. Controls display labels, limits, modalities, reasoning tiers, and explicit Fast support. |
| `selectedModels` | Optional catalog allowlist. |
| `defaultModel` | Default model for this connection. |
| `allowPrivateNetwork` | Required for an intentionally local/RFC1918 gateway. |

The supported v2 profile fields are:

| Field | Meaning |
| --- | --- |
| `displayName` | User-facing label only. The routed model ID is unchanged. |
| `contextWindow` | Positive context-window limit. |
| `maxInputTokens` / `maxOutputTokens` | Positive input/output token limits. |
| `inputModalities` | Declared inputs such as `["text", "image"]`. |
| `reasoningEfforts` | Supported Codex/OpenCode levels from `low` through `ultra`. |
| `defaultReasoningEffort` | Default level; it must also appear in `reasoningEfforts`. |
| `serviceTiers` | Currently `["priority"]`; this is the explicit capability behind OpenCode's `fast` variant. |
| `supportsReasoningSummaries` | Whether the routed Responses backend accepts reasoning-summary delivery. |

The dashboard exposes this object under **Advanced model capabilities** and includes capability
counts in its dry-run preview. A profile key is automatically added to the connection's static
model fallback, so it cannot become invisible merely because it was omitted from `models`.

Use `--force` only when intentionally replacing existing custom providers. Built-in OpenAI
authentication provider ids stay reserved and cannot be overwritten.

For a single group, the equivalent non-manifest command is:

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

## Connection preflight

Validation, catalog visibility, and inference entitlement are different facts. The preflight keeps
them separate and does not write configuration:

| Gate | What it proves | Billing |
| --- | --- | --- |
| Catalog | The credential can call the configured model-list endpoint and the response is parseable. | Normally none. |
| Inference | One concrete configured model completes a minimal request. | Opt-in; may be billed. |
| Fast | A model explicitly declaring `priority` accepts a minimal priority-tier request. | Opt-in; may be billed at a higher tier. |

`fast_confirmed` means the response explicitly echoed `service_tier: "priority"`.
`fast_accepted_unconfirmed` means the request succeeded but the upstream did not echo the tier; it
is not proof that priority processing or priority billing was applied. HTTP status, latency, and a
stable redacted code are returned, but credentials and upstream response bodies are never returned.
CLI preflight exits with status `2` when any requested gate fails.

## Independent display estimates

`costMultiplier` is per connection, so a GPT group can use `0.3` while a Grok group uses `0.2`.
Composite usage prices every physical attempt with the multiplier of the provider that actually
handled it. The multiplier is applied after any confirmed priority-tier price multiplier.

This is display-only estimation. One API, New API, Sub2API, and other gateway servers remain the
source of truth for balances, channel multipliers, discounts, invoices, and charged currency.

## OpenCode model picker

OpenCode already supports hand-written OpenAI-compatible providers. The OpenCodex integration adds
the missing managed layer: it derives the full routed model catalog, refreshes it, keeps the
OpenCode config isolated, and launches OpenCode through the local proxy.

```bash
# Generate/refresh ~/.opencodex/hosts/opencode.json
ocxu opencode configure

# Generate/refresh it and launch OpenCode
ocxu opencode
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

## Client capability matrix

| Client | Imported model picker | Reasoning controls | Fast behavior |
| --- | --- | --- | --- |
| Codex CLI / App | Managed Codex catalog rows such as `gateway-grok/grok-4.5`. Restart a running client after catalog sync. | Exact declared ladder, clamped to levels supported by the installed Codex runtime. | Explicit `priority` becomes a catalog Fast tier; the installed Codex surface decides where the selector is rendered. |
| OpenCode | Managed `opencodex/<provider>/<model>` rows in `/models`. | Declared levels become model variants. | Explicit `priority` becomes the `fast` variant. |
| Claude Code | Readable `claude-ocx-*` gateway aliases in `/model`. | Declared compatible effort metadata is exposed through Anthropic-flavor discovery. | No equivalent per-model Fast variant; a verified compatible Responses route may use the proxy-wide `fastMode` policy. |

Catalog presence never proves that a membership account or group is entitled to inference. Use the
preflight, then verify one real client request and its routed log entry.

## Reasoning and fast variants

Configured reasoning levels become OpenCode model variants. A manifest v2 model receives a `fast`
variant only when its profile explicitly includes `"serviceTiers": ["priority"]`:

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

Composite models inherit `priority` only when every member declares it. One slow or undeclared
member removes Fast from that Composite. Legacy v1 and manually configured GPT-5.5/GPT-5.6
Responses providers retain the pre-v2 name-based OpenCode fallback for compatibility. Routed Codex
rows do not inherit Fast metadata from a native template; they receive it only from an explicit v2
profile, so third-party models cannot accidentally display an unsupported speed tier.

## Reversibility

- Removing an imported group is the ordinary `ocx provider remove <id>` operation.
- The managed OpenCode file is isolated under `~/.opencodex/hosts/`.
- `ocx stop` and `ocx restore` retain their existing Codex restoration behavior.
- Gateway manifests contain no secret values and are safe to commit after checking their URLs and
  model names.
