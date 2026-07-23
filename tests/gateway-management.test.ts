import { describe, expect, test } from "bun:test";
import { prepareGatewayManagementImport } from "../src/gateways/management";
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

describe("gateway management import", () => {
  test("prepares multiple credential boundaries without exposing stored secrets", async () => {
    const config = baseConfig();
    const prepared = await prepareGatewayManagementImport(config, {
      version: 1,
      connections: [
        {
          id: "team-gpt",
          label: "Team GPT",
          kind: "one-api",
          baseUrl: "http://127.0.0.1:3001/v1/",
          protocol: "responses",
          credential: { mode: "stored", apiKey: "stored-secret-value" },
          allowPrivateNetwork: true,
          liveModels: true,
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
        },
        {
          id: "team-grok",
          kind: "sub2api",
          baseUrl: "http://127.0.0.1:3002/v1",
          protocol: "chat-completions",
          credential: { mode: "env", env: "TEAM_GROK_API_KEY" },
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["grok-4.5"],
        },
      ],
      defaultProvider: "team-gpt",
      dryRun: true,
    });

    expect(prepared.result.config.defaultProvider).toBe("team-gpt");
    expect(prepared.result.config.providers["team-gpt"]).toMatchObject({
      adapter: "openai-responses",
      baseUrl: "http://127.0.0.1:3001/v1",
      apiKey: "stored-secret-value",
      gateway: { kind: "one-api", label: "Team GPT" },
    });
    expect(prepared.result.config.providers["team-grok"]).toMatchObject({
      adapter: "openai-chat",
      apiKey: "${TEAM_GROK_API_KEY}",
      gateway: { kind: "sub2api" },
    });
    expect(prepared.preview.connections[0]?.credentialMode).toBe("stored");
    expect(prepared.preview.connections[0]?.apiKeyEnv).toBeNull();
    expect(JSON.stringify(prepared.preview)).not.toContain("stored-secret-value");
    expect(config.providers["team-gpt"]).toBeUndefined();
  });

  test("requires explicit replacement and clears a replaced key pool", async () => {
    const config = baseConfig();
    config.providers["team-gpt"] = {
      adapter: "openai-chat",
      baseUrl: "https://old.example.com/v1",
      apiKey: "old-key",
      apiKeyPool: [{ id: "old", key: "old-key" }],
    };
    const request = {
      version: 1 as const,
      connections: [{
        id: "team-gpt",
        kind: "new-api",
        baseUrl: "http://127.0.0.1:3001/v1",
        protocol: "responses",
        credential: { mode: "stored" as const, apiKey: "new-key" },
        allowPrivateNetwork: true,
        liveModels: true,
      }],
      dryRun: true,
    };

    await expect(prepareGatewayManagementImport(config, request)).rejects.toThrow("--force");
    const prepared = await prepareGatewayManagementImport(config, { ...request, force: true });
    expect(prepared.preview.replacements).toEqual(["team-gpt"]);
    expect(prepared.result.config.providers["team-gpt"].apiKey).toBe("new-key");
    expect(prepared.result.config.providers["team-gpt"].apiKeyPool).toBeUndefined();
    expect(config.providers["team-gpt"].apiKey).toBe("old-key");
  });

  test("validation errors never include the submitted API key", async () => {
    const secret = "do-not-reflect-this-key";
    try {
      await prepareGatewayManagementImport(baseConfig(), {
        version: 1,
        connections: [{
          id: "bad provider id",
          baseUrl: "http://127.0.0.1:3001/v1",
          credential: { mode: "stored", apiKey: secret },
          allowPrivateNetwork: true,
        }],
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("Invalid gateway manifest");
    }
  });
});
