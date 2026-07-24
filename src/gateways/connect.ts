/**
 * `ocx connect` core — paste an API key, get a working provider.
 *
 * Given `{ apiKey, baseUrl? }` candidates from `connect-parse`, this probes the
 * gateway, identifies the product (Sub2API / One API / New API / generic
 * OpenAI-compatible), reads the catalog the key is actually entitled to, and
 * emits a request for the existing gateway import pipeline. Nothing is written
 * here — `prepareGatewayManagementImport` stays the single write path.
 */
import { isValidProviderName } from "../config";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import type { OcxConfig } from "../types";
import { maskApiKey, type ConnectCandidate } from "./connect-parse";
import {
  buildModelProfile,
  inferGatewayPlatform,
  pickDefaultModel,
  profileFromCatalogRow,
  type GatewayModelProfileInput,
  type GatewayPlatform,
} from "./connect-profiles";
import type { GatewayKind, GatewayProtocol } from "./manifest";

export interface DetectedGateway {
  id: string;
  label: string;
  kind: GatewayKind;
  /** Ready for the manifest: gateway root plus `/v1`. */
  baseUrl: string;
  protocol: GatewayProtocol;
  platform: GatewayPlatform;
  apiKey: string;
  maskedKey: string;
  costMultiplier?: number;
  models: string[];
  modelProfiles: Record<string, GatewayModelProfileInput>;
  defaultModel?: string;
  allowPrivateNetwork?: boolean;
  /** Provider id this connection replaces, when refreshing an existing import. */
  replaces?: string;
  notes: string[];
}

export interface ConnectFailure {
  maskedKey: string;
  baseUrl?: string;
  reason:
    | "key-rejected"
    | "no-endpoint"
    | "no-models"
    | "unreachable"
    | "blocked-destination";
  message: string;
}

export interface ConnectDetectionResult {
  detected: DetectedGateway[];
  failures: ConnectFailure[];
}

export interface ConnectOptions {
  /** Extra roots to try before the built-ins (from `--base-url`). */
  baseUrls?: string[];
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Existing config: supplies known roots and lets re-connect stay idempotent. */
  config?: OcxConfig;
  idPrefix?: string;
}

/**
 * Reference Sub2API deployment. Any other host is discovered from the paste or
 * from roots already present in the user's config, so this list stays short by
 * design — it is a convenience, not a registry.
 */
export const BUILTIN_GATEWAY_ROOTS = ["https://mallowapi.com"] as const;

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_CATALOG_BYTES = 4_000_000;
const MAX_MODELS = 2_000;
/** Codex clients send this; Sub2API answers OpenAI groups with the richer manifest. */
const CODEX_CLIENT_VERSION = "0.60.0";

function rootsFromConfig(config: OcxConfig | undefined): string[] {
  if (!config) return [];
  const roots: string[] = [];
  for (const provider of Object.values(config.providers ?? {})) {
    if (!provider?.gateway || typeof provider.baseUrl !== "string") continue;
    const root = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (root) roots.push(root);
  }
  return roots;
}

export function candidateRoots(candidate: ConnectCandidate, options: ConnectOptions): string[] {
  const envRoot = process.env.OPENCODEX_CONNECT_BASE_URL?.trim();
  const ordered = [
    ...(candidate.baseUrl ? [candidate.baseUrl] : []),
    ...(options.baseUrls ?? []),
    ...(envRoot ? [envRoot] : []),
    ...rootsFromConfig(options.config),
    ...BUILTIN_GATEWAY_ROOTS,
  ].map(root => root.replace(/\/+$/, ""));
  return [...new Set(ordered.filter(Boolean))];
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) throw new Error("response_too_large");
  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) throw new Error("response_too_large");
  return JSON.parse(text);
}

interface ProbeResponse {
  status: number;
  body: unknown;
}

async function getJson(
  url: string,
  apiKey: string | null,
  options: ConnectOptions,
): Promise<ProbeResponse | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    // One API / New API accept Bearer; Anthropic-shaped deployments also read
    // x-api-key, and sending both is harmless for every product we probe.
    headers["x-api-key"] = apiKey;
  }
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await boundedJson(response);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

function modelRows(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as { data?: unknown; models?: unknown };
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return rows.filter((row): row is Record<string, unknown> =>
    !!row && typeof row === "object" && !Array.isArray(row));
}

function modelIdFromRow(row: Record<string, unknown>): string | null {
  const raw = typeof row.id === "string"
    ? row.id
    : typeof row.slug === "string"
      ? row.slug
      : typeof row.name === "string"
        ? row.name
        : null;
  if (!raw) return null;
  const id = raw.trim();
  return id && !id.includes("\n") ? id : null;
}

function billingMultiplier(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (record.object !== "sub2api.key_billing") return undefined;
  for (const field of ["effective_rate_multiplier", "resolved_rate_multiplier", "group_rate_multiplier"]) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000) return value;
  }
  return 1;
}

function productLabel(statusBody: unknown): { kind: GatewayKind; label?: string } | null {
  if (!statusBody || typeof statusBody !== "object") return null;
  const data = (statusBody as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const name = typeof record.system_name === "string" ? record.system_name : undefined;
  if (name === undefined && record.version === undefined) return null;
  const isNewApi = typeof name === "string" && /new\s*api/i.test(name);
  return { kind: isNewApi ? "new-api" : "one-api", ...(name ? { label: name } : {}) };
}

export function providerIdFromRoot(root: string, platform: GatewayPlatform, prefix?: string): string {
  if (prefix?.trim()) return sanitizeId(prefix.trim());
  let host = root;
  try {
    host = new URL(root).hostname;
  } catch {
    // Fall through with the raw string; sanitizeId still produces a usable id.
  }
  // An IP literal or localhost has no meaningful stem — every self-hosted
  // gateway would otherwise collapse to the same "127-0-0" prefix.
  const isAddress = /^\[?[0-9a-f:.]+\]?$/i.test(host) && /[.:]/.test(host);
  const labels = host.split(".").filter(Boolean);
  const stem = isAddress || host === "localhost"
    ? "local"
    : labels.length > 1 ? labels.slice(0, -1).join("-") : labels.join("-");
  const suffix = platform === "openai"
    ? "gpt"
    : platform === "anthropic"
      ? "claude"
      : platform === "grok"
        ? "grok"
        : platform === "gemini"
          ? "gemini"
          : platform === "mixed"
            ? "mixed"
            : "models";
  return sanitizeId(`${stem || "gateway"}-${suffix}`);
}

function sanitizeId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const id = cleaned || "gateway";
  return isValidProviderName(id) ? id : `gw-${id}`;
}

/**
 * Sub2API answers OpenAI groups with the ChatGPT Codex manifest when a
 * client_version is present. That payload carries reasoning ladders and speed
 * tiers the plain list omits, so it is worth the extra request — but only for
 * GPT catalogs, and never fatally.
 */
async function enrichFromCodexManifest(
  root: string,
  apiKey: string,
  options: ConnectOptions,
): Promise<Map<string, GatewayModelProfileInput>> {
  const enriched = new Map<string, GatewayModelProfileInput>();
  const probe = await getJson(
    `${root}/v1/models?client_version=${CODEX_CLIENT_VERSION}`,
    apiKey,
    options,
  );
  if (!probe || probe.status !== 200) return enriched;
  for (const row of modelRows(probe.body)) {
    const id = modelIdFromRow(row);
    if (id) enriched.set(id, profileFromCatalogRow(row));
  }
  return enriched;
}

async function detectAtRoot(
  root: string,
  candidate: ConnectCandidate,
  options: ConnectOptions,
): Promise<{ ok: true; gateway: DetectedGateway } | { ok: false; failure: ConnectFailure }> {
  const maskedKey = maskApiKey(candidate.apiKey);
  const destinationError = await providerDestinationResolvedError("connect", {
    baseUrl: `${root}/v1`,
    allowPrivateNetwork: options.allowPrivateNetwork,
  });
  if (destinationError) {
    return {
      ok: false,
      failure: {
        maskedKey,
        baseUrl: root,
        reason: "blocked-destination",
        message: `${root}: ${destinationError} (re-run with --allow-private-network for a self-hosted gateway)`,
      },
    };
  }

  const notes: string[] = [];
  const billing = await getJson(`${root}/v1/sub2api/billing`, candidate.apiKey, options);
  let kind: GatewayKind = "openai-compatible";
  let label = candidate.label ?? root.replace(/^https?:\/\//, "");
  let costMultiplier: number | undefined;

  if (billing?.status === 200) {
    const multiplier = billingMultiplier(billing.body);
    if (multiplier !== undefined) {
      kind = "sub2api";
      costMultiplier = multiplier;
      notes.push(`Sub2API billing confirmed (rate ×${multiplier})`);
    }
  }
  if (kind !== "sub2api") {
    const status = await getJson(`${root}/api/status`, null, options);
    const product = status?.status === 200 ? productLabel(status.body) : null;
    if (product) {
      kind = product.kind;
      if (product.label) label = product.label;
      notes.push(`Identified as ${product.kind}`);
    }
  }

  const catalog = await getJson(`${root}/v1/models`, candidate.apiKey, options);
  if (!catalog) {
    return {
      ok: false,
      failure: { maskedKey, baseUrl: root, reason: "unreachable", message: `${root}: no response from /v1/models` },
    };
  }
  if (catalog.status === 401 || catalog.status === 403) {
    return {
      ok: false,
      failure: { maskedKey, baseUrl: root, reason: "key-rejected", message: `${root}: key rejected (HTTP ${catalog.status})` },
    };
  }
  if (catalog.status !== 200) {
    return {
      ok: false,
      failure: { maskedKey, baseUrl: root, reason: "no-endpoint", message: `${root}: /v1/models returned HTTP ${catalog.status}` },
    };
  }

  const rows = modelRows(catalog.body);
  const reported = new Map<string, GatewayModelProfileInput>();
  const models: string[] = [];
  for (const row of rows) {
    const id = modelIdFromRow(row);
    if (!id || reported.has(id)) continue;
    if (models.length >= MAX_MODELS) break;
    models.push(id);
    reported.set(id, profileFromCatalogRow(row));
  }
  if (models.length === 0) {
    return {
      ok: false,
      failure: { maskedKey, baseUrl: root, reason: "no-models", message: `${root}: the key is valid but exposes no models` },
    };
  }

  const platform = inferGatewayPlatform(models);
  if (platform === "openai") {
    for (const [id, profile] of await enrichFromCodexManifest(root, candidate.apiKey, options)) {
      if (!reported.has(id)) continue;
      reported.set(id, { ...reported.get(id), ...profile });
    }
  }

  const modelProfiles: Record<string, GatewayModelProfileInput> = {};
  for (const id of models) {
    const profile = buildModelProfile(id, reported.get(id) ?? {});
    if (Object.keys(profile).length > 0) modelProfiles[id] = profile;
  }

  // GPT catalogs get the Responses protocol (reasoning + priority tier ride on
  // it); every other family is served over chat-completions, which Sub2API,
  // One API and New API all expose for their whole catalog.
  const protocol: GatewayProtocol = platform === "openai" ? "responses" : "chat-completions";

  return {
    ok: true,
    gateway: {
      id: providerIdFromRoot(root, platform, options.idPrefix),
      label,
      kind,
      baseUrl: `${root}/v1`,
      protocol,
      platform,
      apiKey: candidate.apiKey,
      maskedKey,
      ...(costMultiplier !== undefined ? { costMultiplier } : {}),
      models,
      modelProfiles,
      ...(pickDefaultModel(models) ? { defaultModel: pickDefaultModel(models) } : {}),
      ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      notes,
    },
  };
}

async function detectCandidate(
  candidate: ConnectCandidate,
  options: ConnectOptions,
): Promise<{ ok: true; gateway: DetectedGateway } | { ok: false; failure: ConnectFailure }> {
  const roots = candidateRoots(candidate, options);
  let lastFailure: ConnectFailure = {
    maskedKey: maskApiKey(candidate.apiKey),
    reason: "no-endpoint",
    message: "no gateway endpoint to try — pass --base-url",
  };
  for (const root of roots) {
    const attempt = await detectAtRoot(root, candidate, options);
    if (attempt.ok) return attempt;
    lastFailure = attempt.failure;
    // A rejected key at an explicitly supplied root is final; otherwise keep
    // walking the known roots, because the key simply belongs elsewhere.
    if (attempt.failure.reason === "key-rejected" && candidate.baseUrl) return attempt;
  }
  return { ok: false, failure: lastFailure };
}

const MAX_ID_SUFFIX = 50;

/**
 * Pick the provider id for a detection. Re-pasting a key that already has a
 * connection at the same base URL refreshes that provider in place; anything
 * else takes the next free suffix so an unrelated provider is never clobbered.
 */
export function allocateProviderId(
  baseId: string,
  baseUrl: string,
  config: OcxConfig | undefined,
  used: Set<string>,
): { id: string; replaces?: string } {
  const providers = config?.providers ?? {};
  const isRefresh = (id: string): boolean => {
    const existing = providers[id];
    return !used.has(id)
      && existing?.gateway !== undefined
      && typeof existing.baseUrl === "string"
      && existing.baseUrl.replace(/\/+$/, "") === baseUrl;
  };
  const isFree = (id: string): boolean => !used.has(id) && providers[id] === undefined;

  if (isRefresh(baseId)) return { id: baseId, replaces: baseId };
  if (isFree(baseId)) return { id: baseId };
  for (let suffix = 2; suffix <= MAX_ID_SUFFIX; suffix += 1) {
    const id = `${baseId}-${suffix}`;
    if (isRefresh(id)) return { id, replaces: id };
    if (isFree(id)) return { id };
  }
  throw new Error(`Too many connections named "${baseId}" — remove some with \`ocx provider remove\`.`);
}

/** Resolve every pasted candidate. Order is preserved; ids are deduplicated. */
export async function detectGateways(
  candidates: ConnectCandidate[],
  options: ConnectOptions = {},
): Promise<ConnectDetectionResult> {
  const detected: DetectedGateway[] = [];
  const failures: ConnectFailure[] = [];
  const results = await Promise.all(candidates.map(candidate => detectCandidate(candidate, options)));
  const used = new Set<string>();
  for (const result of results) {
    if (!result.ok) {
      failures.push(result.failure);
      continue;
    }
    const gateway = result.gateway;
    const allocated = allocateProviderId(gateway.id, gateway.baseUrl, options.config, used);
    gateway.id = allocated.id;
    if (allocated.replaces) gateway.replaces = allocated.replaces;
    used.add(gateway.id);
    detected.push(gateway);
  }
  return { detected, failures };
}

export interface ConnectImportOptions {
  setDefault?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

/** Shape the detections for `prepareGatewayManagementImport`. */
export function buildConnectImportRequest(
  detected: DetectedGateway[],
  options: ConnectImportOptions = {},
): Record<string, unknown> {
  const defaultProvider = options.setDefault ? detected[0]?.id : undefined;
  return {
    version: 2 as const,
    connections: detected.map(gateway => ({
      id: gateway.id,
      label: gateway.label,
      kind: gateway.kind,
      baseUrl: gateway.baseUrl,
      protocol: gateway.protocol,
      ...(gateway.costMultiplier !== undefined ? { costMultiplier: gateway.costMultiplier } : {}),
      credential: { mode: "stored" as const, apiKey: gateway.apiKey },
      ...(gateway.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      liveModels: true,
      models: gateway.models,
      ...(Object.keys(gateway.modelProfiles).length > 0 ? { modelProfiles: gateway.modelProfiles } : {}),
      ...(gateway.defaultModel ? { defaultModel: gateway.defaultModel } : {}),
    })),
    ...(defaultProvider ? { defaultProvider } : {}),
    // Re-pasting a key must refresh the connection instead of erroring out.
    force: options.force ?? detected.some(gateway => gateway.replaces !== undefined),
    dryRun: options.dryRun ?? false,
  };
}
