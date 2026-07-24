import { describe, expect, test } from "bun:test";
import {
  applyGatewayManifest,
  gatewayManifestSample,
  parseGatewayManifest,
} from "../src/gateways/manifest";
import type { OcxConfig } from "../src/types";

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

describe("gateway manifest", () => {
  test("imports independent Sub2API groups with protocol-specific adapters", () => {
    const manifest = gatewayManifestSample();
    const result = applyGatewayManifest(baseConfig(), manifest);

    expect(result.config.defaultProvider).toBe("gateway-gpt");
    expect(result.config.providers["gateway-gpt"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://gateway.example.com/v1",
      authMode: "key",
      apiKey: "${GATEWAY_GPT_API_KEY}",
      defaultModel: "gpt-5.6-sol",
    });
    expect(result.config.providers["gateway-grok"]).toMatchObject({
      adapter: "openai-chat",
      apiKey: "${GATEWAY_GROK_API_KEY}",
      models: ["grok-4.5"],
    });
    expect(result.config.providers["gateway-gpt"].apiKeyPool).toBeUndefined();
    expect(result.config.providers["gateway-grok"].apiKeyPool).toBeUndefined();
  });

  test("maps manifest v2 model profiles into the native provider capability fields", () => {
    const manifest = parseGatewayManifest({
      version: 2,
      connections: [{
        id: "team-gpt",
        label: "Team GPT",
        kind: "sub2api",
        baseUrl: "https://gateway.example.com/v1",
        protocol: "responses",
        apiKeyEnv: "TEAM_GPT_KEY",
        models: ["gpt-5.6-sol"],
        modelProfiles: {
          "gpt-5.6-sol": {
            displayName: "GPT 5.6 Sol · Team",
            contextWindow: 400_000,
            maxInputTokens: 360_000,
            maxOutputTokens: 128_000,
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "high",
            serviceTiers: ["priority"],
            supportsReasoningSummaries: true,
          },
        },
        defaultModel: "gpt-5.6-sol",
      }],
      defaultProvider: "team-gpt",
    });

    const result = applyGatewayManifest(baseConfig(), manifest);
    expect(result.config.providers["team-gpt"]).toMatchObject({
      gateway: {
        kind: "sub2api",
        label: "Team GPT",
        manifestVersion: 2,
      },
      modelDisplayNames: { "gpt-5.6-sol": "GPT 5.6 Sol · Team" },
      modelContextWindows: { "gpt-5.6-sol": 400_000 },
      modelMaxInputTokens: { "gpt-5.6-sol": 360_000 },
      modelMaxOutputTokens: { "gpt-5.6-sol": 128_000 },
      modelInputModalities: { "gpt-5.6-sol": ["text", "image"] },
      modelReasoningEfforts: { "gpt-5.6-sol": ["low", "medium", "high", "xhigh"] },
      modelDefaultReasoningEfforts: { "gpt-5.6-sol": "high" },
      modelServiceTiers: { "gpt-5.6-sol": ["priority"] },
      modelSupportsReasoningSummaries: { "gpt-5.6-sol": true },
    });
    expect(result.imported[0]).toMatchObject({
      profiledModels: ["gpt-5.6-sol"],
      fastModels: ["gpt-5.6-sol"],
      reasoningModels: ["gpt-5.6-sol"],
    });
  });

  test("keeps v1 strict and validates v2 profile relationships", () => {
    const connection = {
      id: "group-a",
      baseUrl: "https://example.com/v1",
      apiKeyEnv: "GROUP_A_KEY",
      models: ["model-a"],
      modelProfiles: {
        "model-a": {
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "medium",
        },
      },
    };

    expect(() => parseGatewayManifest({
      version: 1,
      connections: [connection],
    })).toThrow("requires manifest version 2");

    expect(() => parseGatewayManifest({
      version: 2,
      connections: [connection],
    })).toThrow("must appear in reasoningEfforts");
  });

  test("rejects reserved and duplicate provider ids", () => {
    expect(() => parseGatewayManifest({
      version: 1,
      connections: [{
        id: "openai",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "OPENAI_KEY",
      }],
    })).toThrow("reserved");

    expect(() => parseGatewayManifest({
      version: 1,
      connections: [
        { id: "group-a", baseUrl: "https://example.com/v1", apiKeyEnv: "GROUP_A_KEY" },
        { id: "GROUP-A", baseUrl: "https://example.net/v1", apiKeyEnv: "GROUP_B_KEY" },
      ],
    })).toThrow("duplicates");
  });

  test("validates selected and default models against a static model list", () => {
    expect(() => parseGatewayManifest({
      version: 1,
      connections: [{
        id: "group-a",
        baseUrl: "https://example.com/v1",
        apiKeyEnv: "GROUP_A_KEY",
        models: ["model-a"],
        selectedModels: ["model-b"],
        defaultModel: "model-c",
      }],
    })).toThrow("must also appear in models");
  });

  test("requires an environment-backed key unless the gateway explicitly allows no key", () => {
    expect(() => parseGatewayManifest({
      version: 1,
      connections: [{
        id: "missing-key",
        baseUrl: "https://gateway.example.com/v1",
      }],
    })).toThrow("apiKeyEnv: is required unless keyOptional is true");

    const manifest = parseGatewayManifest({
      version: 1,
      connections: [{
        id: "local-no-key",
        baseUrl: "http://127.0.0.1:11434/v1",
        keyOptional: true,
        allowPrivateNetwork: true,
      }],
    });
    expect(manifest.connections[0].keyOptional).toBe(true);
  });

  test("does not mutate the source config when an existing provider blocks import", () => {
    const config = baseConfig();
    config.providers["group-a"] = {
      adapter: "openai-chat",
      baseUrl: "https://old.example.com/v1",
    };
    const before = JSON.stringify(config);
    const manifest = parseGatewayManifest({
      version: 1,
      connections: [{
        id: "group-a",
        baseUrl: "https://new.example.com/v1",
        apiKeyEnv: "GROUP_A_KEY",
      }],
    });

    expect(() => applyGatewayManifest(config, manifest)).toThrow("--force");
    expect(JSON.stringify(config)).toBe(before);
  });

  test("force replaces a custom provider without affecting unrelated providers", () => {
    const config = baseConfig();
    config.providers["group-a"] = {
      adapter: "openai-chat",
      baseUrl: "https://old.example.com/v1",
    };
    const manifest = parseGatewayManifest({
      version: 1,
      connections: [{
        id: "group-a",
        kind: "new-api",
        baseUrl: "https://new.example.com/v1/",
        protocol: "responses",
        apiKeyEnv: "NEW_API_KEY",
      }],
      defaultProvider: "group-a",
    });

    const result = applyGatewayManifest(config, manifest, { force: true });
    expect(result.config.providers.openai).toEqual(config.providers.openai);
    expect(result.config.providers["group-a"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "https://new.example.com/v1",
      apiKey: "${NEW_API_KEY}",
    });
    expect(config.providers["group-a"].baseUrl).toBe("https://old.example.com/v1");
  });

  test("requires explicit private-network opt-in", () => {
    expect(() => parseGatewayManifest({
      version: 1,
      connections: [{
        id: "local-gateway",
        baseUrl: "http://127.0.0.1:3000/v1",
        apiKeyEnv: "LOCAL_GATEWAY_KEY",
      }],
    })).not.toThrow();

    const manifest = parseGatewayManifest({
      version: 1,
      connections: [{
        id: "local-gateway",
        baseUrl: "http://127.0.0.1:3000/v1",
        apiKeyEnv: "LOCAL_GATEWAY_KEY",
      }],
    });
    expect(() => applyGatewayManifest(baseConfig(), manifest)).toThrow("allowPrivateNetwork");
  });
});
