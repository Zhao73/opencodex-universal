import { afterEach, describe, expect, test } from "bun:test";
import { buildAnthropicModelInfos } from "../src/claude/model-info";
import { claudeCodeAlias } from "../src/claude/alias";
import { AUTO_CONTEXT_OFF } from "../src/claude/context-windows";
import {
  buildCatalogEntries,
  gatherRoutedModels,
  resetCatalogRuntimeStateForTests,
} from "../src/codex/catalog";
import { applyGatewayManifest, parseGatewayManifest } from "../src/gateways/manifest";
import { buildOpenCodeManagedConfig } from "../src/hosts/opencode";
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

afterEach(() => resetCatalogRuntimeStateForTests());

describe("gateway catalog export across supported clients", () => {
  test("one imported batch exposes independent GPT and Grok rows to Codex, OpenCode, and Claude Code", async () => {
    const manifest = parseGatewayManifest({
      version: 2,
      connections: [
        {
          id: "gateway-gpt",
          baseUrl: "https://gateway.example.com/v1",
          protocol: "responses",
          apiKeyEnv: "GATEWAY_GPT_API_KEY",
          liveModels: false,
          models: ["gpt-5.6-sol"],
          modelProfiles: {
            "gpt-5.6-sol": {
              displayName: "GPT 5.6 Sol · Gateway",
              reasoningEfforts: ["low", "high", "xhigh"],
              serviceTiers: ["priority"],
            },
          },
          defaultModel: "gpt-5.6-sol",
        },
        {
          id: "gateway-grok",
          baseUrl: "https://gateway.example.com/v1",
          protocol: "chat-completions",
          apiKeyEnv: "GATEWAY_GROK_API_KEY",
          liveModels: false,
          models: ["grok-4.5"],
          modelProfiles: {
            "grok-4.5": {
              displayName: "Grok 4.5 · Gateway",
              reasoningEfforts: ["low", "medium", "high"],
            },
          },
        },
      ],
      defaultProvider: "gateway-gpt",
    });
    const config = applyGatewayManifest(baseConfig(), manifest).config;
    const routed = await gatherRoutedModels(config);

    expect(routed.map(model => `${model.provider}/${model.id}`)).toEqual([
      "gateway-gpt/gpt-5.6-sol",
      "gateway-grok/grok-4.5",
    ]);

    const codex = buildCatalogEntries(null, [], routed);
    expect(codex).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: "gateway-gpt/gpt-5.6-sol",
        display_name: "GPT 5.6 Sol · Gateway",
        service_tiers: [
          {
            id: "priority",
            name: "Fast",
            description: "Priority service declared by the configured gateway.",
          },
        ],
        additional_speed_tiers: ["fast"],
      }),
      expect.objectContaining({
        slug: "gateway-grok/grok-4.5",
        display_name: "Grok 4.5 · Gateway",
      }),
    ]));

    const openCode = buildOpenCodeManagedConfig(config, 10100, routed);
    expect(openCode.provider.opencodex.models["gateway-gpt/gpt-5.6-sol"].variants)
      .toMatchObject({
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
        fast: { serviceTier: "priority" },
      });
    expect(openCode.provider.opencodex.models["gateway-grok/grok-4.5"]).toMatchObject({
      name: "Grok 4.5 · Gateway",
      variants: {
        low: { reasoningEffort: "low" },
        medium: { reasoningEffort: "medium" },
        high: { reasoningEffort: "high" },
      },
    });

    const claude = buildAnthropicModelInfos(
      [],
      routed,
      AUTO_CONTEXT_OFF,
      "readable",
    );
    expect(claude).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: claudeCodeAlias("gateway-gpt", "gpt-5.6-sol"),
        display_name: "GPT 5.6 Sol · Gateway (gateway-gpt)",
      }),
      expect.objectContaining({
        id: claudeCodeAlias("gateway-grok", "grok-4.5"),
        display_name: "Grok 4.5 · Gateway (gateway-grok)",
      }),
    ]));
  });
});
