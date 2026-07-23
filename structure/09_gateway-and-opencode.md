# Gateway Import And OpenCode Host SOT

## Purpose

The gateway layer onboards One API, New API, Sub2API, and generic OpenAI-compatible aggregators
without teaching the router vendor-specific behavior. A connection is a normal OpenCodex provider
with additional provenance and safer setup semantics.

## Credential and routing boundary

- One manifest connection maps to exactly one `config.providers[id]` entry.
- Different aggregator groups are different providers even when they share one `baseUrl`.
- `apiKeyPool` is only same-provider credential failover. It must not combine GPT, Grok, Claude, or
  other keys that authorize different groups.
- Manifests store `apiKeyEnv`; persisted provider config stores `${ENV_NAME}`. The CLI has no raw
  key argument.
- `apiKeyEnv` is mandatory unless `keyOptional: true` explicitly declares an unauthenticated
  endpoint. The referenced variable must be available to the proxy process/service.
- Built-in OpenAI auth ids (`openai`, `chatgpt`, `openai-multi`) cannot be overwritten.
- Local/private destinations require explicit `allowPrivateNetwork`; metadata targets remain
  blocked by the ordinary destination policy.
- Import validates the complete manifest before one atomic config write. `--dry-run` writes
  nothing, and an existing provider aborts the whole import unless `--force` is explicit.

## Protocol mapping

| Manifest protocol | Provider adapter | Expected upstream resource |
| --- | --- | --- |
| `chat-completions` | `openai-chat` | `/v1/chat/completions` |
| `responses` | `openai-responses` | `/v1/responses` |

`baseUrl` is authoritative and must include the intended API prefix. Import never guesses `/v1`.

## OpenCode host adapter

OpenCode already accepts custom OpenAI-compatible providers. OpenCodex adds a managed host adapter
that:

1. resolves the routed model catalog (live first, configured fallback);
2. preserves native inner-slash model ids because OpenCode supports them;
3. writes `~/.opencodex/hosts/opencode.json` atomically with mode `0600`;
4. launches OpenCode with `OPENCODE_CONFIG` instead of editing global/project files;
5. refreshes the generated file on every launch.

The generated OpenCode provider is named `opencodex`, uses
`@ai-sdk/openai-compatible`, and points at the local `/v1/chat/completions` bridge. That bridge
replays through the canonical Responses handler, so every existing router, OAuth, pool, sidecar,
and adapter policy remains in force.

Non-loopback binds require `OPENCODEX_API_AUTH_TOKEN`; generated config references the environment
variable and never persists its value.

## Model variants

- Provider/model reasoning ladders become OpenCode variants using `reasoningEffort`.
- GPT-5.5/GPT-5.6 models whose routed provider uses `openai-responses` receive a `fast` variant with
  `serviceTier: "priority"`, unless `config.fastMode === false`.
- The Chat Completions inbound bridge accepts both standard `service_tier` and OpenCode/AI-SDK
  `serviceTier`, then normalizes either form into the internal Responses body.
- `config.fastMode === true` remains the global force-on policy; `false` strips the tier; undefined
  allows the OpenCode variant/client request to decide.
- Catalog visibility does not prove upstream entitlement. A group/account can still reject a model,
  reasoning tier, or priority service tier at inference time.

## Reversibility

Gateway providers use normal provider removal. The OpenCode file is isolated under the OpenCodex
config root, and no OpenCode user file is rewritten. Codex injection/restoration remains owned by
the existing lifecycle paths.

[Decision Log]
- Purpose: Make multi-group aggregator setup explicit and safe while giving OpenCode a real routed
  model picker.
- Existing constraints: Aggregator keys can be group-bound; OpenCode config sources merge; Codex
  uses an inner-slash codec that OpenCode does not need; secrets must not enter CLI history.
- Chosen design: Declarative v1 manifest, one provider per group, environment-backed credentials,
  and an isolated generated OpenCode config/launcher.
- Rejected alternatives: One cross-group key pool (incorrect authorization semantics), rewriting
  global OpenCode config (conflict-prone), and storing keys in manifests (secret leakage).
- Tradeoff: The initial manifest intentionally covers OpenAI-compatible Chat/Responses protocols.
  Native Anthropic/Google protocols can be added later as explicit protocol types without weakening
  the v1 boundary.
