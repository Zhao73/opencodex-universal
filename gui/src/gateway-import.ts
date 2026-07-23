export type GatewayKind = "one-api" | "new-api" | "sub2api" | "openai-compatible";
export type GatewayProtocol = "chat-completions" | "responses";
export type GatewayCredentialMode = "stored" | "env" | "none";

export const MAX_GATEWAY_CONNECTIONS = 50;

export interface GatewayDraft {
  clientId: string;
  id: string;
  label: string;
  kind: GatewayKind;
  baseUrl: string;
  protocol: GatewayProtocol;
  credentialMode: GatewayCredentialMode;
  apiKey: string;
  apiKeyEnv: string;
  modelsText: string;
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
    credentialMode: GatewayCredentialMode;
    apiKeyEnv: string | null;
    models: string[];
    isDefault: boolean;
  }>;
  imported?: string[];
}

export type GatewayDraftIssue =
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "missing-base-url"
  | "missing-api-key"
  | "missing-env";

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
    credentialMode: "stored",
    apiKey: "",
    apiKeyEnv: "",
    modelsText: "",
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
    if (draft.credentialMode === "stored" && !draft.apiKey.trim()) return "missing-api-key";
    if (draft.credentialMode === "env" && !draft.apiKeyEnv.trim()) return "missing-env";
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
    version: 1 as const,
    connections: drafts.map(draft => {
      const models = parseGatewayModels(draft.modelsText);
      return {
        id: draft.id.trim(),
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        kind: draft.kind,
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        credential: draft.credentialMode === "stored"
          ? { mode: "stored" as const, apiKey: draft.apiKey }
          : draft.credentialMode === "env"
            ? { mode: "env" as const, env: draft.apiKeyEnv.trim() }
            : { mode: "none" as const },
        allowPrivateNetwork: draft.allowPrivateNetwork,
        liveModels: draft.liveModels,
        ...(models.length > 0 ? { models } : {}),
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
