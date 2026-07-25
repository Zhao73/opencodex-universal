/**
 * Model capability inference for `ocx connect`.
 *
 * Two sources, in priority order:
 *   1. what the gateway itself reported in `/v1/models` (Codex manifest rows,
 *      Grok reasoning-effort rows, Anthropic display names) — authoritative;
 *   2. a small family table for the fields no gateway reports — a display-time
 *      hint only, and always overridable by the live catalog later.
 */
import * as z from "zod/v4";
import { GATEWAY_REASONING_EFFORTS, gatewayModelProfileSchema } from "./manifest";

/**
 * Pre-validation shape of a model profile: every field optional, matching what
 * a caller hands to the manifest schema (the exported `GatewayModelProfile` is
 * the post-transform type and marks the normalized arrays as present).
 */
export type GatewayModelProfileInput = z.input<typeof gatewayModelProfileSchema>;

export type ModelFamily = "gpt" | "claude" | "grok" | "gemini" | "other";
export type GatewayPlatform = "openai" | "anthropic" | "grok" | "gemini" | "mixed" | "unknown";

const REASONING_EFFORTS = new Set<string>(GATEWAY_REASONING_EFFORTS);

export function classifyModelFamily(modelId: string): ModelFamily {
  const id = modelId.trim().toLowerCase();
  if (/^(?:gpt|chatgpt|o[134]|codex|text-embedding|dall-e|sora)/.test(id)) return "gpt";
  if (/^claude/.test(id)) return "claude";
  if (/^grok/.test(id)) return "grok";
  if (/^(?:gemini|imagen|veo)/.test(id)) return "gemini";
  return "other";
}

/**
 * A Sub2API key belongs to exactly one group, so its catalog is normally one
 * family. Composite groups return a union — those report "mixed" and route over
 * chat-completions, the only protocol every family accepts.
 */
export function inferGatewayPlatform(modelIds: string[]): GatewayPlatform {
  const families = new Set(modelIds.map(classifyModelFamily));
  families.delete("other");
  if (families.size === 0) return "unknown";
  if (families.size > 1) return "mixed";
  const [family] = [...families];
  return family === "gpt"
    ? "openai"
    : family === "claude"
      ? "anthropic"
      : family === "grok"
        ? "grok"
        : "gemini";
}

/**
 * ponytail: family table, not a spec. Only fields that materially change client
 * behavior and that no gateway reports are listed; anything uncertain is left
 * undefined so the live catalog stays the source of truth.
 */
interface FamilyDefaults {
  reasoningEfforts?: GatewayModelProfileInput["reasoningEfforts"];
  defaultReasoningEffort?: GatewayModelProfileInput["defaultReasoningEffort"];
  serviceTiers?: GatewayModelProfileInput["serviceTiers"];
  inputModalities?: string[];
}

function gptDefaults(modelId: string): FamilyDefaults | undefined {
  const id = modelId.toLowerCase();
  if (!/^gpt-5\.(?:4|5|6)/.test(id)) return undefined;
  const isFrontier = /^gpt-5\.6/.test(id);
  return {
    reasoningEfforts: isFrontier
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    serviceTiers: ["priority"],
    inputModalities: ["text", "image"],
  };
}

/**
 * No context window is ever invented here, for any family. The same model id
 * has different windows depending on what backs the gateway — a GPT-5.x group
 * relayed through Codex accounts honors the 372K Codex contract while the same
 * id on an OpenAI API key is 1.05M, and Claude windows differ per snapshot.
 * From outside the gateway those cases are indistinguishable, and asserting the
 * larger number would silently disable client-side compaction. A window is
 * therefore only ever taken from what the gateway itself reported.
 */
function familyDefaults(modelId: string): FamilyDefaults | undefined {
  switch (classifyModelFamily(modelId)) {
    case "gpt":
      return gptDefaults(modelId);
    case "grok":
      // Grok rows already carry their own reasoning ladder and default effort.
    case "claude":
    case "gemini":
    case "other":
    default:
      return undefined;
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function effortList(value: unknown): GatewayModelProfileInput["reasoningEfforts"] {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.flatMap(entry => {
    const raw = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? (entry as { effort?: unknown; value?: unknown }).effort ?? (entry as { value?: unknown }).value
        : undefined;
    return typeof raw === "string" && REASONING_EFFORTS.has(raw.toLowerCase())
      ? [raw.toLowerCase()]
      : [];
  });
  const unique = [...new Set(efforts)] as NonNullable<GatewayModelProfileInput["reasoningEfforts"]>;
  return unique.length > 0 ? unique : undefined;
}

/**
 * Read whatever a `/v1/models` row already tells us. Handles the three shapes a
 * Sub2API deployment can return: the ChatGPT Codex manifest, the xAI Grok list,
 * and the plain OpenAI/Anthropic list.
 */
export function profileFromCatalogRow(row: unknown): GatewayModelProfileInput {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const record = row as Record<string, unknown>;
  const displayName = typeof record.display_name === "string"
    ? record.display_name
    : typeof record.displayName === "string"
      ? record.displayName
      : undefined;
  const reasoningEfforts = effortList(record.supported_reasoning_levels)
    ?? effortList(record.reasoningEfforts)
    ?? effortList(record.supported_reasoning_efforts);
  const defaultRaw = typeof record.default_reasoning_level === "string"
    ? record.default_reasoning_level
    : typeof record.reasoningEffort === "string"
      ? record.reasoningEffort
      : undefined;
  const defaultReasoningEffort = defaultRaw && REASONING_EFFORTS.has(defaultRaw.toLowerCase())
    ? defaultRaw.toLowerCase() as NonNullable<GatewayModelProfileInput["defaultReasoningEffort"]>
    : undefined;
  const tiers = Array.isArray(record.service_tiers)
    ? record.service_tiers.some(tier => {
      const id = tier && typeof tier === "object" ? (tier as { id?: unknown }).id : tier;
      return id === "priority";
    })
    : Array.isArray(record.additional_speed_tiers)
      ? record.additional_speed_tiers.includes("fast")
      : false;
  const contextWindow = positiveInt(record.context_window)
    ?? positiveInt(record.contextWindow)
    ?? positiveInt((record.limit as { context?: unknown } | undefined)?.context);
  const maxOutputTokens = positiveInt(record.max_output_tokens)
    ?? positiveInt(record.maxOutputTokens)
    ?? positiveInt((record.limit as { output?: unknown } | undefined)?.output);

  return {
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(tiers ? { serviceTiers: ["priority" as const] } : {}),
  };
}

function withoutUndefined(profile: GatewayModelProfileInput): GatewayModelProfileInput {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined),
  ) as GatewayModelProfileInput;
}

/**
 * Reported data wins; family defaults only fill gaps. `defaultReasoningEffort`
 * is dropped when it would fall outside the effective ladder (the manifest
 * schema rejects that pairing).
 */
export function buildModelProfile(modelId: string, reported: GatewayModelProfileInput = {}): GatewayModelProfileInput {
  const defaults = familyDefaults(modelId) ?? {};
  const merged = withoutUndefined({
    displayName: reported.displayName,
    // Token limits are reported-only on purpose — see familyDefaults().
    contextWindow: reported.contextWindow,
    maxInputTokens: reported.maxInputTokens,
    maxOutputTokens: reported.maxOutputTokens,
    inputModalities: reported.inputModalities ?? defaults.inputModalities,
    reasoningEfforts: reported.reasoningEfforts ?? defaults.reasoningEfforts,
    defaultReasoningEffort: reported.defaultReasoningEffort ?? defaults.defaultReasoningEffort,
    serviceTiers: reported.serviceTiers ?? defaults.serviceTiers,
  });
  if (
    merged.defaultReasoningEffort
    && merged.reasoningEfforts
    && !merged.reasoningEfforts.includes(merged.defaultReasoningEffort)
  ) {
    delete merged.defaultReasoningEffort;
  }
  if (merged.defaultReasoningEffort && !merged.reasoningEfforts) {
    delete merged.defaultReasoningEffort;
  }
  return merged;
}

/** Prefer a frontier reasoning model as the connection default. */
export function pickDefaultModel(modelIds: string[]): string | undefined {
  const ranked = [...modelIds].filter(id => !/embedding|dall-e|imagen|veo|sora|image|tts|whisper/i.test(id));
  if (ranked.length === 0) return modelIds[0];
  const priority = [
    /^gpt-5\.6-sol/i,
    /^gpt-5\.6/i,
    /^gpt-5\.5/i,
    /^claude-(?:opus|sonnet)/i,
    /^grok-4/i,
    /^gemini-.*pro/i,
  ];
  for (const pattern of priority) {
    const hit = ranked.find(id => pattern.test(id));
    if (hit) return hit;
  }
  return ranked[0];
}
