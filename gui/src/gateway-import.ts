export type GatewayKind = "one-api" | "new-api" | "sub2api" | "openai-compatible";
export type GatewayProtocol = "chat-completions" | "responses";
export type GatewayCredentialMode = "stored" | "env" | "none";
export type GatewayReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface GatewayModelProfile {
  displayName?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  reasoningEfforts?: GatewayReasoningEffort[];
  defaultReasoningEffort?: GatewayReasoningEffort;
  serviceTiers?: Array<"priority">;
  supportsReasoningSummaries?: boolean;
}

export type GatewayModelProfiles = Record<string, GatewayModelProfile>;

export const MAX_GATEWAY_CONNECTIONS = 50;

export interface GatewayDraft {
  clientId: string;
  id: string;
  label: string;
  kind: GatewayKind;
  baseUrl: string;
  protocol: GatewayProtocol;
  costMultiplierText: string;
  credentialMode: GatewayCredentialMode;
  apiKey: string;
  apiKeyEnv: string;
  modelsText: string;
  modelProfilesText: string;
  defaultModel: string;
  liveModels: boolean;
  allowPrivateNetwork: boolean;
}

export interface GatewayImportPreview {
  success: true;
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
  diagnostics?: GatewayConnectionDiagnostic[];
  imported?: string[];
}

export type GatewayProbeStatus = "passed" | "failed" | "skipped";

export interface GatewayProbeResult {
  status: GatewayProbeStatus;
  code: string;
  latencyMs: number;
  message: string;
  httpStatus?: number;
  model?: string;
  models?: number;
  modelPresent?: boolean;
  priorityConfirmed?: boolean;
}

export interface GatewayConnectionDiagnostic {
  id: string;
  catalog: GatewayProbeResult;
  inference: GatewayProbeResult;
  fast: GatewayProbeResult;
}

export type GatewayDraftIssue =
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "missing-base-url"
  | "missing-api-key"
  | "missing-env"
  | "invalid-cost-multiplier"
  | "invalid-model-profiles";

let nextDraftId = 0;

export function createGatewayDraft(): GatewayDraft {
  nextDraftId += 1;
  return {
    clientId: `gateway-draft-${nextDraftId}`,
    id: "",
    label: "",
    kind: "openai-compatible",
    baseUrl: "",
    protocol: "chat-completions",
    costMultiplierText: "1",
    credentialMode: "stored",
    apiKey: "",
    apiKeyEnv: "",
    modelsText: "",
    modelProfilesText: "",
    defaultModel: "",
    liveModels: true,
    allowPrivateNetwork: false,
  };
}

export function parseGatewayModels(value: string): string[] {
  return [...new Set(
    value
      .split(/[\n,]/)
      .map(model => model.trim())
      .filter(Boolean),
  )];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseGatewayModelProfiles(value: string): GatewayModelProfiles {
  if (!value.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isPlainObject(parsed)) throw new Error("model profiles must be an object");
  for (const [modelId, profile] of Object.entries(parsed)) {
    if (!modelId.trim() || modelId !== modelId.trim() || !isPlainObject(profile)) {
      throw new Error("invalid model profile");
    }
  }
  return parsed as GatewayModelProfiles;
}

export function gatewayDraftIssue(drafts: GatewayDraft[]): GatewayDraftIssue | null {
  const ids = new Set<string>();
  for (const draft of drafts) {
    const id = draft.id.trim();
    if (!id) return "missing-id";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return "invalid-id";
    const normalized = id.toLowerCase();
    if (ids.has(normalized)) return "duplicate-id";
    ids.add(normalized);
    if (!draft.baseUrl.trim()) return "missing-base-url";
    const multiplier = Number(draft.costMultiplierText);
    if (
      !draft.costMultiplierText.trim()
      || !Number.isFinite(multiplier)
      || multiplier <= 0
      || multiplier > 1_000
    ) return "invalid-cost-multiplier";
    if (draft.credentialMode === "stored" && !draft.apiKey.trim()) return "missing-api-key";
    if (draft.credentialMode === "env" && !draft.apiKeyEnv.trim()) return "missing-env";
    try {
      parseGatewayModelProfiles(draft.modelProfilesText);
    } catch {
      return "invalid-model-profiles";
    }
  }
  return null;
}

export function buildGatewayImportRequest(
  drafts: GatewayDraft[],
  options: {
    currentDefaultProvider: string;
    defaultProvider: string;
    force: boolean;
    dryRun: boolean;
  },
) {
  const nextDefault = options.defaultProvider.trim();
  return {
    version: 2 as const,
    connections: drafts.map(draft => {
      const models = parseGatewayModels(draft.modelsText);
      const modelProfiles = parseGatewayModelProfiles(draft.modelProfilesText);
      return {
        id: draft.id.trim(),
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        kind: draft.kind,
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        costMultiplier: Number(draft.costMultiplierText),
        credential: draft.credentialMode === "stored"
          ? { mode: "stored" as const, apiKey: draft.apiKey }
          : draft.credentialMode === "env"
            ? { mode: "env" as const, env: draft.apiKeyEnv.trim() }
            : { mode: "none" as const },
        allowPrivateNetwork: draft.allowPrivateNetwork,
        liveModels: draft.liveModels,
        ...(models.length > 0 ? { models } : {}),
        ...(Object.keys(modelProfiles).length > 0 ? { modelProfiles } : {}),
        ...(draft.defaultModel.trim() ? { defaultModel: draft.defaultModel.trim() } : {}),
      };
    }),
    ...(nextDefault && nextDefault !== options.currentDefaultProvider
      ? { defaultProvider: nextDefault }
      : {}),
    force: options.force,
    dryRun: options.dryRun,
  };
}
