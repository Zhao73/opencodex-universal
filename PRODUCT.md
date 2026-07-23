# Product

## Register

product

## Users

Developers and technical operators who use Codex, OpenCode, Claude Code, or
compatible coding clients with multiple upstream AI accounts and API gateways.
They need to add, inspect, test, switch, and remove independently authorized
provider groups without editing several client-specific configuration files.

## Product Purpose

OpenCodex Universal is a local control plane and protocol bridge for AI coding
clients. It connects first-party accounts, OpenAI-compatible providers, and
aggregators such as One API, New API, and Sub2API, then exposes a consistent
model catalog and routing surface to supported clients. Success means that a
user can configure multiple unrelated gateways once, see exactly which models
belong to each connection, and reverse every integration without losing native
client state.

## Brand Personality

Direct, technical, trustworthy. Copy should name the actual protocol, provider,
credential boundary, and resulting action. The interface should feel like a
quiet local developer tool rather than a hosted reseller console.

## Anti-references

- Vendor-specific white-label dashboards that make one gateway look like the
  product's only supported backend.
- Opaque account pools that hide which credential or upstream group handles a
  request.
- Marketing-heavy AI interfaces with decorative gradients, animated chrome,
  or invented capability claims.
- Configuration flows that persist raw secrets in shareable manifests or
  silently overwrite a user's existing client configuration.

## Design Principles

- Provider-neutral by construction: product language and default examples must
  work for any standards-compatible gateway.
- One visible connection equals one authorization and routing boundary.
- Show the effective configuration: model IDs, protocol, base URL, and default
  route remain inspectable before and after saving.
- Safe operations are explicit and reversible, with validation before writes
  and no silent replacement of existing providers.
- Reuse familiar dashboard controls and terminology so the interface disappears
  into the operator's task.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All workflows must support keyboard-only operation, visible
focus, screen-reader labels, non-color status cues, reduced motion, and the
existing light, dark, and system themes. Error messages must identify the field
and corrective action without exposing credentials.
