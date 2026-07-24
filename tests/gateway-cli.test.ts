import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runGateway(home: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, "gateway", ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    encoding: "utf8",
  });
}

describe("ocx gateway CLI", () => {
  test("imports multiple groups and persists environment references, not key values", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gateway-"));
    try {
      const manifestPath = join(home, "groups.json");
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        connections: [
          {
            id: "gpt-group",
            kind: "sub2api",
            baseUrl: "http://127.0.0.1:5100/v1",
            protocol: "responses",
            apiKeyEnv: "TEST_GPT_GROUP_KEY",
            allowPrivateNetwork: true,
            models: ["gpt-5.6-sol"],
          },
          {
            id: "grok-group",
            kind: "sub2api",
            baseUrl: "http://127.0.0.1:5100/v1",
            apiKeyEnv: "TEST_GROK_GROUP_KEY",
            allowPrivateNetwork: true,
            models: ["grok-4.5"],
          },
        ],
        defaultProvider: "gpt-group",
      }), "utf8");

      const result = runGateway(home, ["import", manifestPath, "--json"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('"action": "imported"');
      const config = readFileSync(join(home, "config.json"), "utf8");
      expect(config).toContain('"apiKey": "${TEST_GPT_GROUP_KEY}"');
      expect(config).toContain('"apiKey": "${TEST_GROK_GROUP_KEY}"');
      expect(config).not.toContain("actual-secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dry-run validates without creating a config file", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gateway-"));
    try {
      const manifestPath = join(home, "groups.json");
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        connections: [{
          id: "new-api",
          kind: "new-api",
          baseUrl: "https://example.com/v1",
          apiKeyEnv: "NEW_API_KEY",
        }],
        defaultProvider: "new-api",
      }), "utf8");

      const result = runGateway(home, ["import", manifestPath, "--dry-run", "--json"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"action": "validated"');
      expect(result.stdout).toContain('"dryRun": true');
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("add supports repeated models and never accepts a raw key option", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gateway-"));
    try {
      const result = runGateway(home, [
        "add",
        "local-group",
        "--kind",
        "one-api",
        "--base-url",
        "http://127.0.0.1:5200/v1",
        "--allow-private-network",
        "--api-key-env",
        "ONE_API_KEY",
        "--model",
        "model-a",
        "--model",
        "model-b",
        "--default-model",
        "model-a",
        "--cost-multiplier",
        "0.2",
        "--set-default",
        "--json",
      ]);
      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(config.providers["local-group"].models).toEqual(["model-a", "model-b"]);
      expect(config.providers["local-group"].costMultiplier).toBe(0.2);
      expect(config.defaultProvider).toBe("local-group");

      const rejected = runGateway(home, [
        "add",
        "unsafe-group",
        "--base-url",
        "https://example.com/v1",
        "--api-key",
        "actual-secret",
      ]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("Unknown option");
      expect(rejected.stderr).not.toContain("actual-secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preflight is non-persisting and reports each diagnostic gate separately", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gateway-"));
    try {
      const manifestPath = join(home, "static.json");
      writeFileSync(manifestPath, JSON.stringify({
        version: 2,
        connections: [{
          id: "local-static",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:5300/v1",
          protocol: "responses",
          keyOptional: true,
          allowPrivateNetwork: true,
          liveModels: false,
          models: ["model-a"],
          costMultiplier: 0.3,
        }],
      }), "utf8");

      const result = runGateway(home, ["preflight", manifestPath, "--json"]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('"action": "preflight"');
      expect(result.stdout).toContain('"persisted": false');
      expect(result.stdout).toContain('"code": "static_catalog"');
      expect(result.stdout.match(/"code": "not_requested"/g)?.length).toBe(2);
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preflight exits distinctly when a required environment credential is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gateway-"));
    try {
      const manifestPath = join(home, "missing-key.json");
      writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        connections: [{
          id: "missing-key",
          baseUrl: "https://example.com/v1",
          apiKeyEnv: "OPENCODEX_TEST_MISSING_PREFLIGHT_KEY",
          models: ["model-a"],
        }],
      }), "utf8");

      const result = runGateway(home, ["preflight", manifestPath, "--json"]);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('"code": "missing_credential"');
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
