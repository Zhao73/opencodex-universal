import * as z from "zod/v4";
import type { OcxConfig } from "../types";
import {
  applyGatewayManifest,
  parseGatewayManifest,
  validateGatewayManifestResolvedDestinations,
  type GatewayImportResult,
  type GatewayKind,
  gatewayModelProfileSchema,
  type GatewayProtocol,
} from "./manifest";

const nonBlankString = z.string().trim().min(1);
const storedCredentialSchema = z.object({
  mode: z.literal("stored"),
  apiKey: nonBlankString.max(65_536),
}).strict();
const environmentCredentialSchema = z.object({
  mode: z.literal("env"),
  env: nonBlankString,
}).strict();
const optionalCredentialSchema = z.object({
  mode: z.literal("none"),
}).strict();

const gatewayManagementConnectionSchema = z.object({
  id: nonBlankString,
  label: nonBlankString.optional(),
  kind: z.enum(["one-api", "new-api", "sub2api", "openai-compatible"]).default("openai-compatible"),
  baseUrl: nonBlankString,
  protocol: z.enum(["chat-completions", "responses"]).default("chat-completions"),
  costMultiplier: z.number().positive().max(1_000).optional(),
  credential: z.discriminatedUnion("mode", [
    storedCredentialSchema,
    environmentCredentialSchema,
    optionalCredentialSchema,
  ]),
  allowPrivateNetwork: z.boolean().optional(),
  liveModels: z.boolean().default(true),
  models: z.array(nonBlankString).max(2_000).optional(),
  modelProfiles: z.record(z.string(), gatewayModelProfileSchema).optional(),
  selectedModels: z.array(nonBlankString).max(2_000).optional(),
  defaultModel: nonBlankString.optional(),
}).strict();

export const gatewayManagementImportSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  connections: z.array(gatewayManagementConnectionSchema).min(1).max(50),
  defaultProvider: nonBlankString.optional(),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
}).strict();

export type GatewayCredentialMode = "stored" | "env" | "none";
export type GatewayManagementImportRequest = z.infer<typeof gatewayManagementImportSchema>;

export interface GatewayManagementImportPreview {
  dryRun: boolean;
  defaultProvider: string;
  replacements: string[];
  connections: Array<{
    id: string;
    label: string | null;
    kind: GatewayKind;
    protocol: GatewayProtocol;
    adapter: "openai-chat" | "openai-responses";
    baseUrl: string;
    costMultiplier: number;
    credentialMode: GatewayCredentialMode;
    apiKeyEnv: string | null;
    models: string[];
    profiledModels: string[];
    fastModels: string[];
    reasoningModels: string[];
    isDefault: boolean;
  }>;
}

export interface PreparedGatewayManagementImport {
  request: GatewayManagementImportRequest;
  result: GatewayImportResult;
  preview: GatewayManagementImportPreview;
}

function issuePath(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join(".") : "request";
}

export function parseGatewayManagementImportRequest(input: unknown): GatewayManagementImportRequest {
  const parsed = gatewayManagementImportSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map(issue => `${issuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid gateway import: ${details}`);
}

function syntheticCredentialEnvironmentName(index: number): string {
  return `OPENCODEX_STORED_GATEWAY_KEY_${index + 1}`;
}

export async function prepareGatewayManagementImport(
  config: OcxConfig,
  input: unknown,
): Promise<PreparedGatewayManagementImport> {
  const request = parseGatewayManagementImportRequest(input);
  const manifest = parseGatewayManifest({
    version: request.version,
    connections: request.connections.map((connection, index) => ({
      id: connection.id,
      ...(connection.label ? { label: connection.label } : {}),
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      protocol: connection.protocol,
      ...(connection.costMultiplier !== undefined
        ? { costMultiplier: connection.costMultiplier }
        : {}),
      ...(connection.credential.mode === "stored"
        ? { apiKeyEnv: syntheticCredentialEnvironmentName(index) }
        : connection.credential.mode === "env"
          ? { apiKeyEnv: connection.credential.env }
          : { keyOptional: true }),
      ...(connection.allowPrivateNetwork !== undefined
        ? { allowPrivateNetwork: connection.allowPrivateNetwork }
        : {}),
      liveModels: connection.liveModels,
      ...(connection.models?.length ? { models: connection.models } : {}),
      ...(connection.modelProfiles ? { modelProfiles: connection.modelProfiles } : {}),
      ...(connection.selectedModels?.length ? { selectedModels: connection.selectedModels } : {}),
      ...(connection.defaultModel ? { defaultModel: connection.defaultModel } : {}),
    })),
    ...(request.defaultProvider ? { defaultProvider: request.defaultProvider } : {}),
  });

  await validateGatewayManifestResolvedDestinations(manifest);
  const replacements = request.connections
    .filter(connection => Object.hasOwn(config.providers, connection.id))
    .map(connection => connection.id);
  const result = applyGatewayManifest(config, manifest, { force: request.force });

  for (const connection of request.connections) {
    if (connection.credential.mode !== "stored") continue;
    const provider = result.config.providers[connection.id];
    if (!provider) continue;
    provider.apiKey = connection.credential.apiKey;
    delete provider.apiKeyPool;
  }

  const byId = new Map(request.connections.map(connection => [connection.id, connection]));
  const preview: GatewayManagementImportPreview = {
    dryRun: request.dryRun,
    defaultProvider: result.config.defaultProvider,
    replacements,
    connections: result.imported.map(imported => {
      const connection = byId.get(imported.id)!;
      return {
        id: imported.id,
        label: connection.label ?? null,
        kind: imported.kind,
        protocol: connection.protocol,
        adapter: imported.adapter,
        baseUrl: imported.baseUrl,
        costMultiplier: imported.costMultiplier,
        credentialMode: connection.credential.mode,
        apiKeyEnv: connection.credential.mode === "env" ? connection.credential.env : null,
        models: imported.models,
        profiledModels: imported.profiledModels,
        fastModels: imported.fastModels,
        reasoningModels: imported.reasoningModels,
        isDefault: imported.isDefault,
      };
    }),
  };

  return { request, result, preview };
}
