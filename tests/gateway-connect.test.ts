import { describe, expect, test } from "bun:test";
import {
  allocateProviderId,
  buildConnectImportRequest,
  candidateRoots,
  detectGateways,
  providerIdFromRoot,
} from "../src/gateways/connect";
import { buildModelProfile, inferGatewayPlatform, pickDefaultModel } from "../src/gateways/connect-profiles";
import { prepareGatewayManagementImport } from "../src/gateways/management";
import type { OcxConfig } from "../src/types";

const GPT_KEY = "sk-rawsentinel1001gpt";
const CLAUDE_KEY = "sk-rawsentinel1002claude";

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stands in for a Sub2API deployment with one GPT group and one Claude group. */
function sub2apiFetch(overrides: { rate?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = typeof input === "object" && "headers" in input
      ? (input as Request).headers.get("authorization")
      : null;
    void auth;
    if (url.pathname === "/v1/sub2api/billing") {
      return json({
        object: "sub2api.key_billing",
        schema_version: 1,
        billing_scope: "token",
        group_rate_multiplier: overrides.rate ?? 0.2,
        resolved_rate_multiplier: overrides.rate ?? 0.2,
        effective_rate_multiplier: overrides.rate ?? 0.2,
      });
    }
    if (url.pathname === "/v1/models" && url.searchParams.get("client_version")) {
      return json({
        data: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            default_reasoning_level: "low",
            supported_reasoning_levels: [
              { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
            ],
            additional_speed_tiers: ["fast"],
          },
        ],
      });
    }
    if (url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [
          { id: "gpt-5.6-sol", object: "model", owned_by: "openai" },
          { id: "gpt-5.5", object: "model", owned_by: "openai" },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
}

function claudeGroupFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v1/sub2api/billing") {
      return json({ object: "sub2api.key_billing", effective_rate_multiplier: 0.3 });
    }
    if (url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [
          { id: "claude-opus-4-5-20260101", type: "model", display_name: "Claude Opus 4.5" },
          { id: "claude-sonnet-4-5-20260101", type: "model", display_name: "Claude Sonnet 4.5" },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
}

describe("gateway detection", () => {
  test("identifies a Sub2API GPT group and keeps its billing rate", async () => {
    const { detected, failures } = await detectGateways(
      [{ apiKey: GPT_KEY, baseUrl: "https://mallowapi.com" }],
      { fetchImpl: sub2apiFetch(), config: baseConfig() },
    );
    expect(failures).toEqual([]);
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      id: "mallowapi-gpt",
      kind: "sub2api",
      baseUrl: "https://mallowapi.com/v1",
      protocol: "responses",
      platform: "openai",
      costMultiplier: 0.2,
      defaultModel: "gpt-5.6-sol",
    });
    expect(detected[0].models).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    // The Codex manifest probe supplies the reasoning ladder and speed tier.
    expect(detected[0].modelProfiles["gpt-5.6-sol"]).toMatchObject({
      displayName: "GPT-5.6-Sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "low",
      serviceTiers: ["priority"],
    });
    expect(detected[0].maskedKey).not.toContain("00112233");
  });

  test("routes a Claude group over chat-completions", async () => {
    const { detected } = await detectGateways(
      [{ apiKey: CLAUDE_KEY, baseUrl: "https://mallowapi.com" }],
      { fetchImpl: claudeGroupFetch(), config: baseConfig() },
    );
    expect(detected[0]).toMatchObject({
      id: "mallowapi-claude",
      protocol: "chat-completions",
      platform: "anthropic",
      costMultiplier: 0.3,
    });
    // Claude context windows differ per snapshot, so none is invented.
    expect(detected[0].modelProfiles["claude-opus-4-5-20260101"]?.contextWindow).toBeUndefined();
  });

  test("keeps the reasoning ladder a Grok group reports", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/v1/sub2api/billing") {
        return json({ object: "sub2api.key_billing", effective_rate_multiplier: 0.2 });
      }
      if (url.pathname === "/v1/models") {
        // Shape returned by Sub2API for a Grok group (xAI list + effort options).
        return json({
          object: "list",
          data: [
            {
              id: "grok-4.5",
              object: "model",
              owned_by: "xai",
              display_name: "Grok 4.5",
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High", default: true },
              ],
            },
            { id: "grok-4.3", object: "model", owned_by: "xai", display_name: "Grok 4.3" },
          ],
        });
      }
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;

    const { detected } = await detectGateways(
      [{ apiKey: "sk-rawsentinel1003grok", baseUrl: "https://mallowapi.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected[0]).toMatchObject({
      id: "mallowapi-grok",
      platform: "grok",
      protocol: "chat-completions",
      defaultModel: "grok-4.5",
      costMultiplier: 0.2,
    });
    expect(detected[0].modelProfiles["grok-4.5"]).toEqual({
      displayName: "Grok 4.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
    });
    // No context window is invented for a family that does not report one.
    expect(detected[0].modelProfiles["grok-4.3"]).toEqual({ displayName: "Grok 4.3" });
  });

  test("two keys on one host become two independent providers", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("authorization") ?? "";
      const impl = header.includes("claude") ? claudeGroupFetch() : sub2apiFetch();
      return impl(input as never, init as never);
    }) as unknown as typeof fetch;

    const { detected } = await detectGateways(
      [
        { apiKey: GPT_KEY, baseUrl: "https://mallowapi.com" },
        { apiKey: CLAUDE_KEY, baseUrl: "https://mallowapi.com" },
      ],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected.map(gateway => gateway.id)).toEqual(["mallowapi-gpt", "mallowapi-claude"]);
    expect(detected[0].models[0]).toBe("gpt-5.6-sol");
    expect(detected[1].models[0]).toBe("claude-opus-4-5-20260101");
  });

  test("reports a rejected key at an explicit endpoint without retrying elsewhere", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({ code: "INVALID_API_KEY", message: "Invalid API key" }, 401);
    }) as unknown as typeof fetch;
    const { detected, failures } = await detectGateways(
      [{ apiKey: GPT_KEY, baseUrl: "https://mallowapi.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected).toEqual([]);
    expect(failures[0]).toMatchObject({ reason: "key-rejected" });
    expect(failures[0].message).toContain("mallowapi.com");
    expect(calls).toBeLessThanOrEqual(3);
  });

  test("falls back to a generic OpenAI-compatible endpoint", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/v1/models") {
        return json({ data: [{ id: "deepseek-chat" }, { id: "qwen3-max" }] });
      }
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    const { detected } = await detectGateways(
      [{ apiKey: "sk-rawsentinel1005generic", baseUrl: "https://gw.example.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected[0]).toMatchObject({
      kind: "openai-compatible",
      protocol: "chat-completions",
      platform: "unknown",
      id: "gw-example-models",
    });
    expect(detected[0].costMultiplier).toBeUndefined();
  });

  test("labels a One API deployment from its status endpoint", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/api/status") {
        return json({ data: { version: "v0.6.10", system_name: "New API" } });
      }
      if (url.pathname === "/v1/models") return json({ data: [{ id: "gpt-4o" }] });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    const { detected } = await detectGateways(
      [{ apiKey: "sk-rawsentinel1006newapi", baseUrl: "https://newapi.example.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected[0]).toMatchObject({ kind: "new-api", label: "New API" });
  });
});

describe("provider id allocation", () => {
  test("derives an id from host and platform", () => {
    expect(providerIdFromRoot("https://mallowapi.com", "openai")).toBe("mallowapi-gpt");
    expect(providerIdFromRoot("https://api.example.co", "anthropic")).toBe("api-example-claude");
    expect(providerIdFromRoot("https://mallowapi.com", "grok", "house")).toBe("house");
  });

  test("re-pasting the same connection refreshes it in place", () => {
    const config = baseConfig();
    config.providers["mallowapi-gpt"] = {
      adapter: "openai-responses",
      baseUrl: "https://mallowapi.com/v1",
      authMode: "key",
      gateway: { kind: "sub2api" },
    };
    expect(allocateProviderId("mallowapi-gpt", "https://mallowapi.com/v1", config, new Set()))
      .toEqual({ id: "mallowapi-gpt", replaces: "mallowapi-gpt" });
  });

  test("never overwrites an unrelated provider", () => {
    const config = baseConfig();
    config.providers["mallowapi-gpt"] = {
      adapter: "openai-chat",
      baseUrl: "https://other.example.com/v1",
      authMode: "key",
    };
    expect(allocateProviderId("mallowapi-gpt", "https://mallowapi.com/v1", config, new Set()))
      .toEqual({ id: "mallowapi-gpt-2" });
  });

  test("keeps ids unique inside one batch", () => {
    const used = new Set(["mallowapi-gpt"]);
    expect(allocateProviderId("mallowapi-gpt", "https://mallowapi.com/v1", baseConfig(), used).id)
      .toBe("mallowapi-gpt-2");
  });
});

describe("connect import request", () => {
  test("imports detected gateways through the audited manifest path", async () => {
    const { detected } = await detectGateways(
      [{ apiKey: GPT_KEY, baseUrl: "https://mallowapi.com" }],
      { fetchImpl: sub2apiFetch(), config: baseConfig() },
    );
    const request = buildConnectImportRequest(detected, { setDefault: true });
    const prepared = await prepareGatewayManagementImport(baseConfig(), request);

    expect(prepared.preview.defaultProvider).toBe("mallowapi-gpt");
    const provider = prepared.result.config.providers["mallowapi-gpt"];
    expect(provider).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://mallowapi.com/v1",
      authMode: "key",
      apiKey: GPT_KEY,
      costMultiplier: 0.2,
      defaultModel: "gpt-5.6-sol",
    });
    expect(provider.gateway).toMatchObject({ kind: "sub2api", manifestVersion: 2 });
    expect(provider.modelServiceTiers?.["gpt-5.6-sol"]).toEqual(["priority"]);
    // Both GPT-5.x models advertise the priority speed tier, so both get a
    // `fast` variant in every client that supports one.
    expect(prepared.preview.connections[0].fastModels).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  test("forces replacement only when a connection is being refreshed", async () => {
    const { detected } = await detectGateways(
      [{ apiKey: GPT_KEY, baseUrl: "https://mallowapi.com" }],
      { fetchImpl: sub2apiFetch(), config: baseConfig() },
    );
    expect(buildConnectImportRequest(detected).force).toBe(false);
    detected[0].replaces = detected[0].id;
    expect(buildConnectImportRequest(detected).force).toBe(true);
  });
});

describe("candidate roots", () => {
  test("prefers the pasted url, then configured gateways, then built-ins", () => {
    const config = baseConfig();
    config.providers["house"] = {
      adapter: "openai-chat",
      baseUrl: "https://house.example.com/v1",
      authMode: "key",
      gateway: { kind: "one-api" },
    };
    const roots = candidateRoots({ apiKey: GPT_KEY, baseUrl: "https://paste.example.com" }, { config });
    expect(roots[0]).toBe("https://paste.example.com");
    expect(roots).toContain("https://house.example.com");
    expect(roots.at(-1)).toBe("https://mallowapi.com");
  });
});

describe("model profiles", () => {
  test("classifies a catalog into one platform", () => {
    expect(inferGatewayPlatform(["gpt-5.6-sol", "gpt-5.5"])).toBe("openai");
    expect(inferGatewayPlatform(["claude-opus-4-5"])).toBe("anthropic");
    expect(inferGatewayPlatform(["gpt-5.5", "claude-opus-4-5"])).toBe("mixed");
    expect(inferGatewayPlatform(["deepseek-chat"])).toBe("unknown");
  });

  test("reported capabilities beat the family table", () => {
    const profile = buildModelProfile("gpt-5.6-sol", {
      reasoningEfforts: ["low", "high"],
      contextWindow: 400_000,
    });
    expect(profile.reasoningEfforts).toEqual(["low", "high"]);
    expect(profile.contextWindow).toBe(400_000);
  });

  test("drops a default effort that is not in the ladder", () => {
    const profile = buildModelProfile("gpt-5.6-sol", {
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "ultra",
    });
    expect(profile.defaultReasoningEffort).toBeUndefined();
  });

  test("prefers a frontier reasoning model as the default", () => {
    expect(pickDefaultModel(["text-embedding-3-large", "gpt-5.5", "gpt-5.6-sol"])).toBe("gpt-5.6-sol");
    expect(pickDefaultModel(["dall-e-3"])).toBe("dall-e-3");
  });
});

describe("context windows are never invented", () => {
  test("a GPT catalog gets capabilities but no window unless the gateway reports one", () => {
    const inferred = buildModelProfile("gpt-5.6-sol");
    expect(inferred.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(inferred.serviceTiers).toEqual(["priority"]);
    // A Sub2API GPT group relayed through Codex accounts honors the 372K Codex
    // contract, not the 1.05M OpenAI-API number; guessing either one here would
    // silently break compaction in Claude Code and the Codex app.
    expect(inferred.contextWindow).toBeUndefined();
    expect(inferred.maxOutputTokens).toBeUndefined();

    const reported = buildModelProfile("gpt-5.6-sol", { contextWindow: 372_000, maxOutputTokens: 128_000 });
    expect(reported.contextWindow).toBe(372_000);
    expect(reported.maxOutputTokens).toBe(128_000);
  });

  test("no family invents a window", () => {
    for (const id of ["claude-opus-4-5", "grok-4.5", "gemini-3-pro", "deepseek-chat"]) {
      expect(buildModelProfile(id).contextWindow).toBeUndefined();
    }
  });
});

describe("simple-mode Sub2API", () => {
  test("is identified from the correlation header when billing is unavailable", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-client-request-id": "9f2b-4c1a" },
        });
      }
      // Simple mode: the billing endpoint is not served.
      return json({ error: { type: "not_found_error", message: "not supported in simple mode" } }, 404);
    }) as unknown as typeof fetch;

    const { detected } = await detectGateways(
      [{ apiKey: "sk-rawsentinel1007simple", baseUrl: "https://simple.example.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected[0]).toMatchObject({ kind: "sub2api", platform: "openai" });
    expect(detected[0].costMultiplier).toBeUndefined();
    expect(detected[0].notes.join(" ")).toContain("fingerprint");
  });

  test("a plain OpenAI-compatible endpoint is not mislabelled", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      if (url.pathname === "/v1/models") return json({ data: [{ id: "deepseek-chat" }] });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    const { detected } = await detectGateways(
      [{ apiKey: "sk-rawsentinel1008plain", baseUrl: "https://plain.example.com" }],
      { fetchImpl, config: baseConfig() },
    );
    expect(detected[0].kind).toBe("openai-compatible");
  });
});
