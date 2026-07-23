import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCodeLaunchEnv } from "../src/cli/opencode";
import {
  buildOpenCodeManagedConfig,
  getOpenCodeManagedConfigPath,
  openCodeProxyBaseUrl,
  writeOpenCodeManagedConfig,
} from "../src/hosts/opencode";
import type { CatalogModel } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";

let testHome = "";

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

function config(fastMode?: boolean): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mallow-gpt",
    ...(fastMode !== undefined ? { fastMode } : {}),
    providers: {
      "mallow-gpt": {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example.com/v1",
        authMode: "key",
        apiKey: "${MALLOW_GPT_API_KEY}",
        defaultModel: "gpt-5.6-sol",
        models: ["gpt-5.6-sol"],
        modelContextWindows: { "gpt-5.6-sol": 400_000 },
        modelMaxOutputTokens: { "gpt-5.6-sol": 128_000 },
        modelReasoningEfforts: { "gpt-5.6-sol": ["low", "high", "xhigh"] },
      },
      "mallow-grok": {
        adapter: "openai-chat",
        baseUrl: "https://gateway.example.com/v1",
        authMode: "key",
        apiKey: "${MALLOW_GROK_API_KEY}",
        models: ["grok-4.5"],
      },
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "key",
        models: ["anthropic/claude-sonnet-5"],
      },
    },
  };
}

const models: CatalogModel[] = [
  {
    provider: "mallow-gpt",
    id: "gpt-5.6-sol",
    contextWindow: 400_000,
    reasoningEfforts: ["low", "high", "xhigh"],
  },
  { provider: "mallow-grok", id: "grok-4.5" },
  { provider: "openrouter", id: "anthropic/claude-sonnet-5" },
  { provider: "combo", id: "primary", alias: "smart-route", contextWindow: 200_000 },
];

describe("OpenCode host integration", () => {
  test("renders routed provider/model ids and an eligible fast variant", () => {
    const managed = buildOpenCodeManagedConfig(config(), 10100, models);
    const provider = managed.provider.opencodex;

    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options).toEqual({ baseURL: "http://127.0.0.1:10100/v1" });
    expect(Object.keys(provider.models)).toEqual([
      "mallow-gpt/gpt-5.6-sol",
      "mallow-grok/grok-4.5",
      "openrouter/anthropic/claude-sonnet-5",
      "smart-route",
    ]);
    expect(managed.model).toBe("opencodex/mallow-gpt/gpt-5.6-sol");
    expect(provider.models["mallow-gpt/gpt-5.6-sol"]).toMatchObject({
      limit: { context: 400_000, output: 128_000 },
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
        xhigh: { reasoningEffort: "xhigh" },
        fast: { serviceTier: "priority" },
      },
    });
    expect(provider.models["mallow-grok/grok-4.5"].variants?.fast).toBeUndefined();
  });

  test("honors an explicit global fast-mode off switch", () => {
    const managed = buildOpenCodeManagedConfig(config(false), 10100, models);
    expect(managed.provider.opencodex.models["mallow-gpt/gpt-5.6-sol"].variants?.fast).toBeUndefined();
  });

  test("uses an environment-backed admission key only for non-loopback binds", () => {
    const managed = buildOpenCodeManagedConfig(config(), 10100, models, "0.0.0.0");
    expect(managed.provider.opencodex.options).toEqual({
      baseURL: "http://127.0.0.1:10100/v1",
      apiKey: "{env:OPENCODEX_API_AUTH_TOKEN}",
    });
    expect(openCodeProxyBaseUrl("::1", 10100)).toBe("http://[::1]:10100/v1");
  });

  test("writes only the isolated managed config with restrictive permissions", () => {
    const result = writeOpenCodeManagedConfig(config(), 10100, models);
    expect(result.path).toBe(getOpenCodeManagedConfigPath());
    expect(result.modelCount).toBe(4);
    expect(result.fastVariantCount).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  test("launcher preserves user env, owns OPENCODE_CONFIG, and fails closed for remote auth", () => {
    const loopback = buildOpenCodeLaunchEnv(config(), "127.0.0.1", {
      CUSTOM_SETTING: "kept",
      OPENCODE_CONFIG: "/tmp/user-config.json",
    });
    expect(loopback.CUSTOM_SETTING).toBe("kept");
    expect(loopback.OPENCODE_CONFIG).toBe(getOpenCodeManagedConfigPath());

    expect(() => buildOpenCodeLaunchEnv(config(), "192.168.1.5", {}))
      .toThrow("OPENCODEX_API_AUTH_TOKEN");
    const remote = buildOpenCodeLaunchEnv(config(), "192.168.1.5", {
      OPENCODEX_API_AUTH_TOKEN: "proxy-admission-token",
    });
    expect(remote.OPENCODEX_API_AUTH_TOKEN).toBe("proxy-admission-token");
  });
});
