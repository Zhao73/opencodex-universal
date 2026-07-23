import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COMBO_NAMESPACE } from "../combos";
import {
  atomicWriteFile,
  getConfigDir,
} from "../config";
import {
  filterCatalogVisibleModels,
  isMediaGenerationModelId,
  type CatalogModel,
} from "../codex/catalog";
import { fetchAllModels } from "../server/management-api";
import { isLoopbackHostname } from "../server/auth-cors";
import { probeHostname } from "../server/proxy-liveness";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const OPENCODE_MANAGED_PROVIDER_ID = "opencodex";

export interface OpenCodeModelConfig {
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
  variants?: Record<string, Record<string, unknown>>;
}

export interface OpenCodeManagedConfig {
  $schema: "https://opencode.ai/config.json";
  provider: {
    opencodex: {
      npm: "@ai-sdk/openai-compatible";
      name: string;
      options: {
        baseURL: string;
        apiKey?: string;
      };
      models: Record<string, OpenCodeModelConfig>;
    };
  };
  model?: string;
}

export interface OpenCodeModelResolution {
  models: CatalogModel[];
  source: "live" | "configured-fallback";
}

export interface OpenCodeConfigWriteResult {
  path: string;
  modelCount: number;
  defaultModel: string | null;
  fastVariantCount: number;
}

function openCodeModelId(model: CatalogModel): string {
  // Unlike Codex's model manager, OpenCode accepts inner slashes in a custom
  // provider model id. Preserve the upstream namespace (for example,
  // openrouter/anthropic/claude-...) instead of applying Codex's dash codec.
  return model.alias ?? `${model.provider}/${model.id}`;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(value => value.trim().length > 0))];
}

function configuredFallbackModels(config: OcxConfig): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true || provider.authMode === "forward") continue;
    const ids = uniqueStrings([
      ...(provider.selectedModels?.length ? provider.selectedModels : provider.models ?? []),
      ...(provider.defaultModel ? [provider.defaultModel] : []),
    ]);
    for (const id of ids) {
      if (isMediaGenerationModelId(id)) continue;
      models.push({
        provider: providerName,
        id,
        contextWindow: provider.modelContextWindows?.[id] ?? provider.contextWindow,
        maxInputTokens: provider.modelMaxInputTokens?.[id],
        inputModalities: provider.modelInputModalities?.[id],
        reasoningEfforts: provider.modelReasoningEfforts?.[id] ?? provider.reasoningEfforts,
        defaultReasoningEffort: provider.modelDefaultReasoningEfforts?.[id],
      });
    }
  }
  for (const custom of config.customModels ?? []) {
    const provider = config.providers[custom.provider];
    if (!provider || provider.disabled === true || provider.authMode === "forward") continue;
    if (isMediaGenerationModelId(custom.modelId)) continue;
    models.push({
      provider: custom.provider,
      id: custom.modelId,
      displayName: custom.displayName,
      contextWindow: custom.contextWindow,
      inputModalities: custom.inputModalities,
      reasoningEfforts: provider.modelReasoningEfforts?.[custom.modelId] ?? provider.reasoningEfforts,
      defaultReasoningEffort: provider.modelDefaultReasoningEfforts?.[custom.modelId],
    });
  }

  const deduped = new Map<string, CatalogModel>();
  for (const model of models) deduped.set(openCodeModelId(model), model);
  return filterCatalogVisibleModels(
    [...deduped.values()].sort((left, right) => openCodeModelId(left).localeCompare(openCodeModelId(right))),
    config,
  );
}

export async function resolveOpenCodeModels(config: OcxConfig): Promise<OpenCodeModelResolution> {
  try {
    const live = filterCatalogVisibleModels(await fetchAllModels(config), config);
    if (live.length > 0) return { models: live, source: "live" };
  } catch {
    // A gateway may be offline during installation. The configured allowlist is
    // still useful and is refreshed on the next `ocx opencode configure/launch`.
  }
  return { models: configuredFallbackModels(config), source: "configured-fallback" };
}

function providerReasoningEfforts(provider: OcxProviderConfig, model: CatalogModel): string[] {
  return uniqueStrings(
    model.reasoningEfforts
    ?? provider.modelReasoningEfforts?.[model.id]
    ?? provider.reasoningEfforts,
  );
}

function supportsFastVariant(config: OcxConfig, model: CatalogModel): boolean {
  if (config.fastMode === false) return false;
  const provider = config.providers[model.provider];
  if (provider?.adapter !== "openai-responses") return false;
  return /^gpt-5\.(?:5|6)(?:-|$)/i.test(model.id);
}

function modelOutputLimit(provider: OcxProviderConfig, model: CatalogModel): number | undefined {
  return provider.modelMaxOutputTokens?.[model.id] ?? provider.defaultMaxOutputTokens;
}

function openCodeModelConfig(config: OcxConfig, model: CatalogModel): OpenCodeModelConfig {
  const provider = config.providers[model.provider];
  const context = model.contextWindow ?? provider?.modelContextWindows?.[model.id] ?? provider?.contextWindow;
  const output = provider ? modelOutputLimit(provider, model) : undefined;
  const efforts = provider ? providerReasoningEfforts(provider, model) : uniqueStrings(model.reasoningEfforts);
  const variants: Record<string, Record<string, unknown>> = {};
  for (const effort of efforts) variants[effort] = { reasoningEffort: effort };
  if (supportsFastVariant(config, model)) variants.fast = { serviceTier: "priority" };

  return {
    name: model.displayName ?? `${model.provider} · ${model.id}`,
    ...(context || output
      ? {
        limit: {
          ...(context ? { context } : {}),
          ...(output ? { output } : {}),
        },
      }
      : {}),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  };
}

function defaultRoutedModel(config: OcxConfig, modelIds: Set<string>): string | undefined {
  const provider = config.providers[config.defaultProvider];
  const preferred = provider?.defaultModel
    ? `${config.defaultProvider}/${provider.defaultModel}`
    : undefined;
  if (preferred && modelIds.has(preferred)) return preferred;
  return modelIds.values().next().value;
}

export function openCodeProxyBaseUrl(hostname: string | undefined, port: number): string {
  return `http://${probeHostname(hostname)}:${port}/v1`;
}

export function buildOpenCodeManagedConfig(
  config: OcxConfig,
  port: number,
  models: CatalogModel[],
  hostname: string | undefined = config.hostname,
): OpenCodeManagedConfig {
  const entries = new Map<string, OpenCodeModelConfig>();
  for (const model of models) {
    if (
      (model.provider !== COMBO_NAMESPACE && !config.providers[model.provider])
      || isMediaGenerationModelId(model.id)
    ) continue;
    entries.set(openCodeModelId(model), openCodeModelConfig(config, model));
  }
  const modelIds = new Set(entries.keys());
  const defaultModel = defaultRoutedModel(config, modelIds);
  const needsApiKey = !isLoopbackHostname(hostname);

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      opencodex: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCodex Universal",
        options: {
          baseURL: openCodeProxyBaseUrl(hostname, port),
          ...(needsApiKey ? { apiKey: "{env:OPENCODEX_API_AUTH_TOKEN}" } : {}),
        },
        models: Object.fromEntries(entries),
      },
    },
    ...(defaultModel ? { model: `${OPENCODE_MANAGED_PROVIDER_ID}/${defaultModel}` } : {}),
  };
}

export function getOpenCodeManagedConfigPath(): string {
  return join(getConfigDir(), "hosts", "opencode.json");
}

export function writeOpenCodeManagedConfig(
  config: OcxConfig,
  port: number,
  models: CatalogModel[],
  hostname: string | undefined = config.hostname,
): OpenCodeConfigWriteResult {
  const managed = buildOpenCodeManagedConfig(config, port, models, hostname);
  const path = getOpenCodeManagedConfigPath();
  const directory = join(getConfigDir(), "hosts");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* best effort on Windows */ }
  atomicWriteFile(path, `${JSON.stringify(managed, null, 2)}\n`);

  const modelEntries = Object.values(managed.provider.opencodex.models);
  return {
    path,
    modelCount: modelEntries.length,
    defaultModel: managed.model ?? null,
    fastVariantCount: modelEntries.filter(model => model.variants?.fast !== undefined).length,
  };
}
