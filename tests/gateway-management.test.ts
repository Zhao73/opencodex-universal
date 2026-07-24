import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGatewayManagementImport } from "../src/gateways/management";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const previousOpenCodexHome = process.env.OPENCODEX_HOME;
let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocxu-gateway-management-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  rmSync(testHome, { recursive: true, force: true });
});

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

  test("previews v2 model capabilities without echoing credentials", async () => {
    const secret = "profile-secret-value";
    const prepared = await prepareGatewayManagementImport(baseConfig(), {
      version: 2,
      connections: [{
        id: "team-gpt",
        kind: "sub2api",
        baseUrl: "http://127.0.0.1:3001/v1",
        protocol: "responses",
        costMultiplier: 0.3,
        credential: { mode: "stored", apiKey: secret },
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["gpt-5.6-sol", "gpt-5.6-terra"],
        modelProfiles: {
          "gpt-5.6-sol": {
            reasoningEfforts: ["low", "high"],
            serviceTiers: ["priority"],
          },
          "gpt-5.6-terra": {
            reasoningEfforts: ["medium", "high"],
          },
        },
      }],
      dryRun: true,
    });

    expect(prepared.preview.connections[0]).toMatchObject({
      costMultiplier: 0.3,
      profiledModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      fastModels: ["gpt-5.6-sol"],
      reasoningModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    });
    expect(JSON.stringify(prepared.preview)).not.toContain(secret);
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
        version: 2,
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

  test("management route persists an atomic import after the upstream API split", async () => {
    const config = baseConfig();
    let refreshCount = 0;
    const secret = "route-secret-value";
    const url = new URL("http://127.0.0.1:10100/api/gateways/import");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 2,
        connections: [{
          id: "team-grok",
          label: "Team Grok",
          kind: "sub2api",
          baseUrl: "http://127.0.0.1:3002/v1",
          protocol: "responses",
          costMultiplier: 0.2,
          credential: { mode: "stored", apiKey: secret },
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["grok-4.5"],
          defaultModel: "grok-4.5",
        }],
        defaultProvider: "team-grok",
      }),
    }), url, config, {
      refreshCodexCatalog: async () => {
        refreshCount += 1;
      },
    });

    expect(response?.status).toBe(200);
    const payload = await response!.json();
    expect(payload).toMatchObject({
      success: true,
      imported: ["team-grok"],
      defaultProvider: "team-grok",
      connections: [{
        id: "team-grok",
        costMultiplier: 0.2,
        credentialMode: "stored",
        apiKeyEnv: null,
      }],
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(config.defaultProvider).toBe("team-grok");
    expect(config.providers["team-grok"]).toMatchObject({
      adapter: "openai-responses",
      apiKey: secret,
      defaultModel: "grok-4.5",
      costMultiplier: 0.2,
    });
    expect(refreshCount).toBe(1);

    const saved = JSON.parse(readFileSync(join(testHome, "config.json"), "utf8")) as OcxConfig;
    expect(saved.defaultProvider).toBe("team-grok");
    expect(saved.providers["team-grok"]?.apiKey).toBe(secret);
    expect(saved.providers["team-grok"]?.costMultiplier).toBe(0.2);
  });

  test("preflight route validates each connection without persisting its prepared config", async () => {
    const config = baseConfig();
    const secret = "preflight-secret-value";
    const url = new URL("http://127.0.0.1:10100/api/gateways/preflight");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          version: 2,
          connections: [{
            id: "team-static",
            kind: "sub2api",
            baseUrl: "http://127.0.0.1:3003/v1",
            protocol: "responses",
            costMultiplier: 0.3,
            credential: { mode: "stored", apiKey: secret },
            allowPrivateNetwork: true,
            liveModels: false,
            models: ["gpt-5.6-sol"],
            modelProfiles: {
              "gpt-5.6-sol": { serviceTiers: ["priority"] },
            },
          }],
          dryRun: true,
        },
        inference: false,
        fast: false,
      }),
    }), url, config);

    expect(response?.status).toBe(200);
    const payload = await response!.json();
    expect(payload).toMatchObject({
      success: true,
      connections: [{ id: "team-static", costMultiplier: 0.3 }],
      diagnostics: [{
        id: "team-static",
        catalog: { status: "skipped", code: "static_catalog" },
        inference: { status: "skipped", code: "not_requested" },
        fast: { status: "skipped", code: "not_requested" },
      }],
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(config.providers["team-static"]).toBeUndefined();
    expect(existsSync(join(testHome, "config.json"))).toBe(false);
  });
});
