import { describe, expect, test } from "bun:test";
import {
  maskApiKey,
  normalizeGatewayRoot,
  parseConnectInput,
} from "../src/gateways/connect-parse";

describe("connect paste parsing", () => {
  test("accepts a bare key with no endpoint", () => {
    expect(parseConnectInput("sk-rawsentinel1011paste")).toEqual([
      { apiKey: "sk-rawsentinel1011paste" },
    ]);
  });

  test("binds key@url and url#key forms", () => {
    expect(parseConnectInput("sk-rawsentinel1011paste@https://mallowapi.com/v1")).toEqual([
      { apiKey: "sk-rawsentinel1011paste", baseUrl: "https://mallowapi.com" },
    ]);
    expect(parseConnectInput("https://mallowapi.com/v1#sk-rawsentinel1011paste")).toEqual([
      { apiKey: "sk-rawsentinel1011paste", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("pairs a dashboard block where the key sits under the base url", () => {
    const paste = [
      "Base URL: https://mallowapi.com/v1",
      "API Key:  sk-rawsentinel1011paste",
    ].join("\n");
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-rawsentinel1011paste", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads an exported env block", () => {
    const paste = [
      "export ANTHROPIC_BASE_URL=https://mallowapi.com",
      "export ANTHROPIC_AUTH_TOKEN=sk-rawsentinel1011paste",
    ].join("\n");
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-rawsentinel1011paste", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads a curl snippet and strips the endpoint tail", () => {
    const paste = 'curl https://mallowapi.com/v1/chat/completions -H "Authorization: Bearer sk-rawsentinel1011paste"';
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-rawsentinel1011paste", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads JSON, including an array of connections", () => {
    const paste = JSON.stringify([
      { name: "gpt", base_url: "https://mallowapi.com/v1", api_key: "sk-rawsentinel1001gpt" },
      { name: "claude", baseUrl: "https://mallowapi.com/v1", key: "sk-rawsentinel1002claude" },
    ]);
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-rawsentinel1001gpt", baseUrl: "https://mallowapi.com", label: "gpt" },
      { apiKey: "sk-rawsentinel1002claude", baseUrl: "https://mallowapi.com", label: "claude" },
    ]);
  });

  test("keeps several keys from one paste and dedupes repeats", () => {
    const paste = [
      "https://mallowapi.com/v1",
      "sk-rawsentinel1001gpt",
      "sk-rawsentinel1002claude",
      "sk-rawsentinel1001gpt",
      "https://one.example.com/v1  sk-rawsentinel1004oneapi",
    ].join("\n");
    const parsed = parseConnectInput(paste);
    expect(parsed.map(entry => entry.apiKey)).toEqual([
      "sk-rawsentinel1001gpt",
      "sk-rawsentinel1002claude",
      "sk-rawsentinel1004oneapi",
    ]);
    expect(parsed[2].baseUrl).toBe("https://one.example.com");
  });

  test("ignores placeholders and env-var references", () => {
    const paste = [
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "api_key: your-api-key-here",
      `key = sk-${"x".repeat(20)}`,
    ].join("\n");
    expect(parseConnectInput(paste)).toEqual([]);
  });

  test("caps a runaway paste", () => {
    const keys = Array.from({ length: 40 }, (_, index) => `sk-cg-${String(index).padStart(16, "0")}`);
    expect(parseConnectInput(keys.join("\n"))).toHaveLength(20);
  });
});

describe("gateway root normalization", () => {
  test.each([
    ["https://mallowapi.com/v1", "https://mallowapi.com"],
    ["https://mallowapi.com/v1/", "https://mallowapi.com"],
    ["https://mallowapi.com/v1/messages", "https://mallowapi.com"],
    ["https://mallowapi.com/v1/chat/completions", "https://mallowapi.com"],
    ["https://host.example.com/api/v1", "https://host.example.com/api"],
    ["mallowapi.com", "https://mallowapi.com"],
    ["http://127.0.0.1:3000/v1", "http://127.0.0.1:3000"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeGatewayRoot(input)).toBe(expected);
  });

  test("rejects non-http schemes", () => {
    expect(normalizeGatewayRoot("ftp://example.com")).toBeNull();
  });
});

describe("key masking", () => {
  test("keeps only the head and tail", () => {
    expect(maskApiKey("sk-rawsentinel1011paste")).toBe("sk-rawse…aste");
    expect(maskApiKey("sk-rawsentinel1011paste")).not.toContain("ntinel1011");
  });
});
