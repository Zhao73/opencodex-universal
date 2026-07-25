import { resolveModelsAuthToken, buildModelsRequest } from "../oauth";
import type { OcxProviderConfig } from "../types";
import type { PreparedGatewayManagementImport } from "./management";

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
  /** True only when the response explicitly echoes service_tier=priority. */
  priorityConfirmed?: boolean;
}

export interface GatewayConnectionPreflight {
  id: string;
  catalog: GatewayProbeResult;
  inference: GatewayProbeResult;
  fast: GatewayProbeResult;
}

export interface GatewayPreflightOptions {
  inference?: boolean;
  fast?: boolean;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

const MAX_PROBE_JSON_BYTES = 2_000_000;
const MAX_PARALLEL_CONNECTION_PROBES = 4;

function skipped(code: string, message: string): GatewayProbeResult {
  return { status: "skipped", code, latencyMs: 0, message };
}

function failed(
  code: string,
  message: string,
  latencyMs: number,
  httpStatus?: number,
  model?: string,
): GatewayProbeResult {
  return {
    status: "failed",
    code,
    latencyMs,
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(model ? { model } : {}),
  };
}

function responsePath(provider: OcxProviderConfig): string {
  if (provider.responsesPath !== undefined) {
    return `${provider.baseUrl.replace(/\/$/, "")}${provider.responsesPath}`;
  }
  const base = provider.baseUrl.replace(/\/v1\/?$/, "");
  return `${base}/v1/responses`;
}

function inferenceUrl(provider: OcxProviderConfig): string {
  return provider.adapter === "openai-responses"
    ? responsePath(provider)
    : `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PROBE_JSON_BYTES) {
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PROBE_JSON_BYTES) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

function modelIdsFromCatalog(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as { data?: unknown; models?: unknown };
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!rows) return null;
  return rows.flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const candidate = row as { id?: unknown; name?: unknown };
    const raw = typeof candidate.id === "string"
      ? candidate.id
      : typeof candidate.name === "string"
        ? candidate.name
        : "";
    if (!raw) return [];
    return [raw.replace(/^models\//, "")];
  });
}

function configuredModel(
  prepared: PreparedGatewayManagementImport,
  id: string,
): string | undefined {
  const request = prepared.request.connections.find(connection => connection.id === id);
  const provider = prepared.result.config.providers[id];
  return request?.defaultModel
    ?? request?.selectedModels?.[0]
    ?? request?.models?.[0]
    ?? (request?.modelProfiles ? Object.keys(request.modelProfiles)[0] : undefined)
    ?? provider?.defaultModel
    ?? provider?.selectedModels?.[0]
    ?? provider?.models?.[0];
}

function priorityModel(
  prepared: PreparedGatewayManagementImport,
  id: string,
): string | undefined {
  const request = prepared.request.connections.find(connection => connection.id === id);
  return Object.entries(request?.modelProfiles ?? {})
    .find(([, profile]) => profile.serviceTiers?.includes("priority"))?.[0];
}

function authHeaders(provider: OcxProviderConfig, apiKey: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(provider.headers ?? {}),
  };
}

function inferenceBody(
  provider: OcxProviderConfig,
  model: string,
  priority: boolean,
): Record<string, unknown> {
  if (provider.adapter === "openai-responses") {
    return {
      model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      stream: false,
      ...(priority ? { service_tier: "priority" } : {}),
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
    ...(priority ? { service_tier: "priority" } : {}),
  };
}

function validInferencePayload(provider: OcxProviderConfig, payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.error !== undefined) return false;
  return provider.adapter === "openai-responses"
    ? Array.isArray(record.output)
      || typeof record.output_text === "string"
      || typeof record.status === "string"
      || typeof record.id === "string"
    : Array.isArray(record.choices);
}

function responsePriorityTier(payload: unknown): boolean {
  return !!payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as { service_tier?: unknown }).service_tier === "priority";
}

function caughtProbeFailure(error: unknown, started: number, model?: string): GatewayProbeResult {
  const code = error instanceof Error ? error.message : "";
  if (
    code === "response_too_large"
    || code === "empty_response"
    || error instanceof SyntaxError
  ) {
    return failed(
      code === "response_too_large" ? "response_too_large" : "invalid_json",
      code === "response_too_large"
        ? "Upstream response exceeded the diagnostic size limit."
        : "Upstream returned an invalid JSON response.",
      Date.now() - started,
      undefined,
      model,
    );
  }
  if (
    (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    || (error instanceof Error && /timeout/i.test(error.name))
  ) {
    return failed(
      "timeout",
      "Upstream diagnostic timed out.",
      Date.now() - started,
      undefined,
      model,
    );
  }
  return failed(
    "network_error",
    "Upstream diagnostic could not establish a connection.",
    Date.now() - started,
    undefined,
    model,
  );
}

async function probeCatalog(
  id: string,
  provider: OcxProviderConfig,
  candidateModel: string | undefined,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<{ result: GatewayProbeResult; modelIds: string[] }> {
  if (provider.liveModels === false) {
    return {
      result: skipped("static_catalog", "Live model discovery is disabled for this connection."),
      modelIds: [],
    };
  }
  const apiKey = await resolveModelsAuthToken(id, provider);
  if (!provider.keyOptional && !apiKey) {
    return {
      result: failed("missing_credential", "No usable credential was available.", 0),
      modelIds: [],
    };
  }
  const { url, headers } = buildModelsRequest(provider, apiKey, id);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const latencyMs = Date.now() - started;
      await response.body?.cancel().catch(() => undefined);
      return {
        result: failed(
          `http_${response.status}`,
          `Catalog request returned HTTP ${response.status}.`,
          latencyMs,
          response.status,
        ),
        modelIds: [],
      };
    }
    const modelIds = modelIdsFromCatalog(await boundedJson(response));
    const latencyMs = Date.now() - started;
    if (!modelIds) {
      return {
        result: failed(
          "invalid_catalog_shape",
          "Catalog response did not contain an OpenAI- or Google-compatible model list.",
          latencyMs,
        ),
        modelIds: [],
      };
    }
    if (candidateModel && !modelIds.includes(candidateModel)) {
      return {
        result: {
          status: "failed",
          code: "configured_model_missing",
          latencyMs,
          message: `Catalog returned ${modelIds.length} model(s), but not the configured model.`,
          models: modelIds.length,
          model: candidateModel,
          modelPresent: false,
        },
        modelIds,
      };
    }
    return {
      result: {
        status: "passed",
        code: "catalog_ok",
        latencyMs,
        message: `Catalog returned ${modelIds.length} model(s).`,
        models: modelIds.length,
        ...(candidateModel ? { model: candidateModel, modelPresent: true } : {}),
      },
      modelIds,
    };
  } catch (error) {
    return { result: caughtProbeFailure(error, started), modelIds: [] };
  }
}

async function probeInference(
  id: string,
  provider: OcxProviderConfig,
  model: string | undefined,
  priority: boolean,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<GatewayProbeResult> {
  if (!model) {
    return skipped("model_required", "A concrete model is required for an inference diagnostic.");
  }
  const apiKey = await resolveModelsAuthToken(id, provider);
  if (!provider.keyOptional && !apiKey) {
    return failed("missing_credential", "No usable credential was available.", 0, undefined, model);
  }
  const started = Date.now();
  try {
    const response = await fetchImpl(inferenceUrl(provider), {
      method: "POST",
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify(inferenceBody(provider, model, priority)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const latencyMs = Date.now() - started;
      await response.body?.cancel().catch(() => undefined);
      return failed(
        `http_${response.status}`,
        `${priority ? "Fast inference" : "Inference"} returned HTTP ${response.status}.`,
        latencyMs,
        response.status,
        model,
      );
    }
    const payload = await boundedJson(response);
    const latencyMs = Date.now() - started;
    if (!validInferencePayload(provider, payload)) {
      return failed(
        "invalid_inference_shape",
        "Inference returned an unexpected JSON shape.",
        latencyMs,
        undefined,
        model,
      );
    }
    const priorityConfirmed = priority && responsePriorityTier(payload);
    return {
      status: "passed",
      code: priority
        ? priorityConfirmed
          ? "fast_confirmed"
          : "fast_accepted_unconfirmed"
        : "inference_ok",
      latencyMs,
      message: priority
        ? priorityConfirmed
          ? "Fast inference succeeded and the response confirmed priority service."
          : "Fast inference succeeded, but the response did not echo priority service."
        : "Minimal inference succeeded.",
      model,
      ...(priority ? { priorityConfirmed } : {}),
    };
  } catch (error) {
    return caughtProbeFailure(error, started, model);
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function preflightGatewayConnections(
  prepared: PreparedGatewayManagementImport,
  options: GatewayPreflightOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<GatewayConnectionPreflight[]> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 8_000, 1_000), 30_000);
  return mapWithConcurrency(
    prepared.preview.connections,
    MAX_PARALLEL_CONNECTION_PROBES,
    async connection => {
    const provider = prepared.result.config.providers[connection.id]!;
    const configured = configuredModel(prepared, connection.id);
    const catalog = await probeCatalog(
      connection.id,
      provider,
      configured,
      timeoutMs,
      fetchImpl,
    );
    const inferenceModel = configured ?? catalog.modelIds[0];
    const inference = options.inference
      ? await probeInference(
        connection.id,
        provider,
        inferenceModel,
        false,
        timeoutMs,
        fetchImpl,
      )
      : skipped("not_requested", "Minimal inference was not requested.");
    const declaredPriorityModel = priorityModel(prepared, connection.id);
    const fast = options.fast
      ? declaredPriorityModel
        ? await probeInference(
          connection.id,
          provider,
          declaredPriorityModel,
          true,
          timeoutMs,
          fetchImpl,
        )
        : skipped("not_declared", "No model in this connection declares priority service.")
      : skipped("not_requested", "Fast inference was not requested.");
    return { id: connection.id, catalog: catalog.result, inference, fast };
    },
  );
}
