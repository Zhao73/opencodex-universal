import { describe, expect, test } from "bun:test";
import {
  buildGatewayImportRequest,
  createGatewayDraft,
  gatewayDraftIssue,
  parseGatewayModelProfiles,
  parseGatewayModels,
} from "../src/gateway-import";

describe("gateway import form", () => {
  test("normalizes comma and line-separated model ids", () => {
    expect(parseGatewayModels("gpt-5.6-sol,\ngrok-4.5\n gpt-5.6-sol ")).toEqual([
      "gpt-5.6-sol",
      "grok-4.5",
    ]);
  });

  test("builds independent stored and environment credential payloads", () => {
    const first = {
      ...createGatewayDraft(),
      id: "team-gpt",
      baseUrl: "https://one.example.com/v1",
      protocol: "responses" as const,
      apiKey: "stored-key",
      modelsText: "gpt-5.6-sol",
      modelProfilesText: JSON.stringify({
        "gpt-5.6-sol": {
          reasoningEfforts: ["low", "high"],
          serviceTiers: ["priority"],
        },
      }),
    };
    const second = {
      ...createGatewayDraft(),
      id: "team-grok",
      baseUrl: "https://two.example.com/v1",
      credentialMode: "env" as const,
      apiKeyEnv: "TEAM_GROK_API_KEY",
      modelsText: "grok-4.5",
    };

    expect(gatewayDraftIssue([first, second])).toBeNull();
    expect(buildGatewayImportRequest([first, second], {
      currentDefaultProvider: "openai",
      defaultProvider: "team-gpt",
      force: false,
      dryRun: true,
    })).toMatchObject({
      version: 2,
      defaultProvider: "team-gpt",
      dryRun: true,
      connections: [
        {
          id: "team-gpt",
          credential: { mode: "stored", apiKey: "stored-key" },
          modelProfiles: {
            "gpt-5.6-sol": {
              reasoningEfforts: ["low", "high"],
              serviceTiers: ["priority"],
            },
          },
        },
        { id: "team-grok", credential: { mode: "env", env: "TEAM_GROK_API_KEY" } },
      ],
    });
  });

  test("rejects case-insensitive duplicate ids before sending", () => {
    const first = {
      ...createGatewayDraft(),
      id: "Team-GPT",
      baseUrl: "https://one.example.com/v1",
      apiKey: "first-key",
    };
    const second = {
      ...createGatewayDraft(),
      id: "team-gpt",
      baseUrl: "https://two.example.com/v1",
      apiKey: "second-key",
    };
    expect(gatewayDraftIssue([first, second])).toBe("duplicate-id");
  });

  test("parses capability profiles and rejects malformed JSON before sending", () => {
    expect(parseGatewayModelProfiles(JSON.stringify({
      "grok-4.5": {
        displayName: "Grok 4.5",
        reasoningEfforts: ["low", "medium", "high"],
      },
    }))).toEqual({
      "grok-4.5": {
        displayName: "Grok 4.5",
        reasoningEfforts: ["low", "medium", "high"],
      },
    });

    const draft = {
      ...createGatewayDraft(),
      id: "team-grok",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "stored-key",
      modelProfilesText: "{not-json",
    };
    expect(gatewayDraftIssue([draft])).toBe("invalid-model-profiles");
  });
});
