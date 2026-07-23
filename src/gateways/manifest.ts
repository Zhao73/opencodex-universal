import * as z from "zod/v4";
import {
  hasOwnProvider,
  isValidProviderName,
  providerBaseUrlConfigError,
} from "../config";
import {
  providerDestinationConfigError,
  providerDestinationResolvedError,
} from "../lib/destination-policy";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const GATEWAY_KINDS = [
  "one-api",
  "new-api",
  "sub2api",
  "openai-compatible",
] as const;

export const GATEWAY_PROTOCOLS = [
  "chat-completions",
  "responses",
] as const;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_GATEWAY_PROVIDER_IDS = new Set([
  "openai",
  "chatgpt",
  "openai-multi",
]);

const nonBlankString = z.string().trim().min(1);

const gatewayConnectionSchema = z.object({
  id: nonBlankString,
  label: nonBlankString.optional(),
  kind: z.enum(GATEWAY_KINDS).default("openai-compatible"),
  baseUrl: nonBlankString,
  protocol: z.enum(GATEWAY_PROTOCOLS).default("chat-completions"),
  apiKeyEnv: nonBlankString.optional(),
  keyOptional: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  liveModels: z.boolean().default(true),
  models: z.array(nonBlankString).optional(),
  selectedModels: z.array(nonBlankString).optional(),
  defaultModel: nonBlankString.optional(),
}).strict().superRefine((connection, ctx) => {
  if (!isValidProviderName(connection.id)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "must use letters, numbers, dots, underscores, or hyphens and cannot be a reserved JavaScript object key",
    });
  }
  if (RESERVED_GATEWAY_PROVIDER_IDS.has(connection.id.toLowerCase())) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "is reserved for OpenCodex built-in authentication and routing",
    });
  }
  const baseUrlError = providerBaseUrlConfigError(connection.baseUrl);
  if (baseUrlError) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: baseUrlError });
  }
  if (connection.apiKeyEnv && !ENV_NAME_PATTERN.test(connection.apiKeyEnv)) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKeyEnv"],
      message: "must be a valid environment variable name",
    });
  }
  if (!connection.apiKeyEnv && connection.keyOptional !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKeyEnv"],
      message: "is required unless keyOptional is true",
    });
  }
  const models = new Set(connection.models ?? []);
  for (const model of connection.selectedModels ?? []) {
    if (models.size > 0 && !models.has(model)) {
      ctx.addIssue({
        code: "custom",
        path: ["selectedModels"],
        message: `"${model}" must also appear in models when a static model list is supplied`,
      });
    }
  }
  if (connection.defaultModel && models.size > 0 && !models.has(connection.defaultModel)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultModel"],
      message: "must also appear in models when a static model list is supplied",
    });
  }
}).transform(connection => ({
  ...connection,
  baseUrl: connection.baseUrl.replace(/\/+$/, ""),
  models: unique(connection.models),
  selectedModels: unique(connection.selectedModels),
}));

export const gatewayManifestSchema = z.object({
  version: z.literal(1),
  connections: z.array(gatewayConnectionSchema).min(1),
  defaultProvider: nonBlankString.optional(),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  for (const [index, connection] of manifest.connections.entries()) {
    const normalized = connection.id.toLowerCase();
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        path: ["connections", index, "id"],
        message: "duplicates another connection id (case-insensitive)",
      });
    }
    seen.add(normalized);
  }
  if (
    manifest.defaultProvider
    && !manifest.connections.some(connection => connection.id === manifest.defaultProvider)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "must reference a connection in this manifest",
    });
  }
});

export type GatewayManifest = z.infer<typeof gatewayManifestSchema>;
export type GatewayConnection = GatewayManifest["connections"][number];

export interface GatewayImportResult {
  config: OcxConfig;
  imported: Array<{
    id: string;
    kind: GatewayConnection["kind"];
    adapter: "openai-chat" | "openai-responses";
    baseUrl: string;
    apiKeyEnv: string | null;
    models: string[];
    isDefault: boolean;
  }>;
}

function unique(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values)];
}

function issuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "manifest";
}

export function parseGatewayManifest(input: unknown): GatewayManifest {
  const parsed = gatewayManifestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map(issue => `${issuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid gateway manifest: ${details}`);
}

export function gatewayConnectionProviderConfig(connection: GatewayConnection): OcxProviderConfig {
  const provider: OcxProviderConfig = {
    adapter: connection.protocol === "responses" ? "openai-responses" : "openai-chat",
    baseUrl: connection.baseUrl,
    authMode: "key",
    liveModels: connection.liveModels,
    note: `Gateway profile: ${connection.label ?? connection.kind}`,
    ...(connection.apiKeyEnv ? { apiKey: `\${${connection.apiKeyEnv}}` } : {}),
    ...(connection.keyOptional !== undefined ? { keyOptional: connection.keyOptional } : {}),
    ...(connection.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: connection.allowPrivateNetwork }
      : {}),
    ...(connection.models?.length ? { models: connection.models } : {}),
    ...(connection.selectedModels?.length ? { selectedModels: connection.selectedModels } : {}),
    ...(connection.defaultModel ? { defaultModel: connection.defaultModel } : {}),
  };
  const destinationError = providerDestinationConfigError(connection.id, provider);
  if (destinationError) {
    throw new Error(`Invalid gateway connection "${connection.id}": ${destinationError}`);
  }
  return provider;
}

export async function validateGatewayManifestResolvedDestinations(
  manifest: GatewayManifest,
): Promise<void> {
  for (const connection of manifest.connections) {
    const provider = gatewayConnectionProviderConfig(connection);
    const error = await providerDestinationResolvedError(connection.id, provider);
    if (error) throw new Error(`Invalid gateway connection "${connection.id}": ${error}`);
  }
}

export function applyGatewayManifest(
  config: OcxConfig,
  manifest: GatewayManifest,
  options: { force?: boolean } = {},
): GatewayImportResult {
  const next: OcxConfig = {
    ...config,
    providers: { ...config.providers },
  };

  for (const connection of manifest.connections) {
    if (hasOwnProvider(next.providers, connection.id) && !options.force) {
      throw new Error(`Provider "${connection.id}" already exists. Re-run with --force to replace it.`);
    }
  }

  const imported: GatewayImportResult["imported"] = [];
  for (const connection of manifest.connections) {
    const provider = gatewayConnectionProviderConfig(connection);
    next.providers[connection.id] = provider;
    imported.push({
      id: connection.id,
      kind: connection.kind,
      adapter: provider.adapter as "openai-chat" | "openai-responses",
      baseUrl: provider.baseUrl,
      apiKeyEnv: connection.apiKeyEnv ?? null,
      models: provider.models ?? [],
      isDefault: manifest.defaultProvider === connection.id,
    });
  }

  if (manifest.defaultProvider) next.defaultProvider = manifest.defaultProvider;
  if (!hasOwnProvider(next.providers, next.defaultProvider)) {
    throw new Error(`defaultProvider "${next.defaultProvider}" does not exist after import`);
  }

  return { config: next, imported };
}

export function gatewayManifestSample(): GatewayManifest {
  return parseGatewayManifest({
    version: 1,
    connections: [
      {
        id: "mallow-gpt",
        label: "Sub2API GPT group",
        kind: "sub2api",
        baseUrl: "https://gateway.example.com/v1",
        protocol: "responses",
        apiKeyEnv: "MALLOW_GPT_API_KEY",
        models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
        defaultModel: "gpt-5.6-sol",
      },
      {
        id: "mallow-grok",
        label: "Sub2API Grok group",
        kind: "sub2api",
        baseUrl: "https://gateway.example.com/v1",
        protocol: "chat-completions",
        apiKeyEnv: "MALLOW_GROK_API_KEY",
        models: ["grok-4.5"],
        defaultModel: "grok-4.5",
      },
    ],
    defaultProvider: "mallow-gpt",
  });
}
