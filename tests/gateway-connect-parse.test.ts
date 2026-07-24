import { describe, expect, test } from "bun:test";
import {
  maskApiKey,
  normalizeGatewayRoot,
  parseConnectInput,
} from "../src/gateways/connect-parse";

describe("connect paste parsing", () => {
  test("accepts a bare key with no endpoint", () => {
    expect(parseConnectInput("sk-cg-9f2ba71c4d0e8a63")).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63" },
    ]);
  });

  test("binds key@url and url#key forms", () => {
    expect(parseConnectInput("sk-cg-9f2ba71c4d0e8a63@https://mallowapi.com/v1")).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63", baseUrl: "https://mallowapi.com" },
    ]);
    expect(parseConnectInput("https://mallowapi.com/v1#sk-cg-9f2ba71c4d0e8a63")).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("pairs a dashboard block where the key sits under the base url", () => {
    const paste = [
      "Base URL: https://mallowapi.com/v1",
      "API Key:  sk-cg-9f2ba71c4d0e8a63",
    ].join("\n");
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads an exported env block", () => {
    const paste = [
      "export ANTHROPIC_BASE_URL=https://mallowapi.com",
      "export ANTHROPIC_AUTH_TOKEN=sk-cg-9f2ba71c4d0e8a63",
    ].join("\n");
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads a curl snippet and strips the endpoint tail", () => {
    const paste = 'curl https://mallowapi.com/v1/chat/completions -H "Authorization: Bearer sk-cg-9f2ba71c4d0e8a63"';
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-cg-9f2ba71c4d0e8a63", baseUrl: "https://mallowapi.com" },
    ]);
  });

  test("reads JSON, including an array of connections", () => {
    const paste = JSON.stringify([
      { name: "gpt", base_url: "https://mallowapi.com/v1", api_key: "sk-cg-gpt00112233445566" },
      { name: "claude", baseUrl: "https://mallowapi.com/v1", key: "sk-cg-claude00112233445" },
    ]);
    expect(parseConnectInput(paste)).toEqual([
      { apiKey: "sk-cg-gpt00112233445566", baseUrl: "https://mallowapi.com", label: "gpt" },
      { apiKey: "sk-cg-claude00112233445", baseUrl: "https://mallowapi.com", label: "claude" },
    ]);
  });

  test("keeps several keys from one paste and dedupes repeats", () => {
    const paste = [
      "https://mallowapi.com/v1",
      "sk-cg-gpt00112233445566",
      "sk-cg-claude00112233445",
      "sk-cg-gpt00112233445566",
      "https://one.example.com/v1  sk-one-9911223344556677",
    ].join("\n");
    const parsed = parseConnectInput(paste);
    expect(parsed.map(entry => entry.apiKey)).toEqual([
      "sk-cg-gpt00112233445566",
      "sk-cg-claude00112233445",
      "sk-one-9911223344556677",
    ]);
    expect(parsed[2].baseUrl).toBe("https://one.example.com");
  });

  test("ignores placeholders and env-var references", () => {
    const paste = [
      "OPENAI_API_KEY=${OPENAI_API_KEY}",
      "api_key: your-api-key-here",
      "key = sk-xxxxxxxxxxxxxxxxxxxx",
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
    expect(maskApiKey("sk-cg-9f2ba71c4d0e8a63")).toBe("sk-cg-9f…8a63");
    expect(maskApiKey("sk-cg-9f2ba71c4d0e8a63")).not.toContain("2ba71c4d");
  });
});
