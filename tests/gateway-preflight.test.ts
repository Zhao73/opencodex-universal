import { describe, expect, test } from "bun:test";
import { prepareGatewayManagementImport } from "../src/gateways/management";
import { preflightGatewayConnections } from "../src/gateways/preflight";
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

describe("gateway connection preflight", () => {
  test("proves catalog, minimal inference, and declared Fast capability independently", async () => {
    const gptSecret = "gpt-preflight-secret";
    const grokSecret = "grok-preflight-secret";
    const prepared = await prepareGatewayManagementImport(baseConfig(), {
      version: 2,
      connections: [
        {
          id: "team-gpt",
          kind: "sub2api",
          baseUrl: "http://127.0.0.1:3001/v1",
          protocol: "responses",
          credential: { mode: "stored", apiKey: gptSecret },
          allowPrivateNetwork: true,
          liveModels: true,
          models: ["gpt-5.6-sol"],
          modelProfiles: {
            "gpt-5.6-sol": { serviceTiers: ["priority"] },
          },
        },
        {
          id: "team-grok",
          kind: "sub2api",
          baseUrl: "http://127.0.0.1:3002/v1",
          protocol: "chat-completions",
          credential: { mode: "stored", apiKey: grokSecret },
          allowPrivateNetwork: true,
          liveModels: true,
          models: ["grok-4.5"],
        },
      ],
      dryRun: true,
    });

    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ url, authorization: headers.get("authorization"), body });

      if (init?.method === "GET") {
        const model = url.includes(":3001") ? "gpt-5.6-sol" : "grok-4.5";
        return Response.json({ object: "list", data: [{ id: model }] });
      }
      if (url.includes(":3001")) {
        return Response.json({
          id: "resp_test",
          status: "completed",
          output: [],
          ...(body?.service_tier === "priority" ? { service_tier: "priority" } : {}),
        });
      }
      return Response.json({
        id: "chatcmpl_test",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
      });
    }) as typeof fetch;

    const diagnostics = await preflightGatewayConnections(
      prepared,
      { inference: true, fast: true, timeoutMs: 2_000 },
      fetchMock,
    );

    expect(diagnostics).toMatchObject([
      {
        id: "team-gpt",
        catalog: {
          status: "passed",
          code: "catalog_ok",
          model: "gpt-5.6-sol",
          modelPresent: true,
        },
        inference: { status: "passed", code: "inference_ok", model: "gpt-5.6-sol" },
        fast: {
          status: "passed",
          code: "fast_confirmed",
          model: "gpt-5.6-sol",
          priorityConfirmed: true,
        },
      },
      {
        id: "team-grok",
        catalog: {
          status: "passed",
          code: "catalog_ok",
          model: "grok-4.5",
          modelPresent: true,
        },
        inference: { status: "passed", code: "inference_ok", model: "grok-4.5" },
        fast: { status: "skipped", code: "not_declared" },
      },
    ]);
    expect(requests).toHaveLength(5);
    expect(requests.some(request => request.authorization === `Bearer ${gptSecret}`)).toBe(true);
    expect(requests.some(request => request.authorization === `Bearer ${grokSecret}`)).toBe(true);
    expect(requests.some(request => (
      request.body as { service_tier?: unknown } | null
    )?.service_tier === "priority")).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(gptSecret);
    expect(JSON.stringify(diagnostics)).not.toContain(grokSecret);
  });

  test("missing environment credential fails closed and never calls the upstream", async () => {
    const missingEnv = "OPENCODEX_TEST_DEFINITELY_MISSING_GATEWAY_KEY";
    const previous = process.env[missingEnv];
    delete process.env[missingEnv];
    try {
      const prepared = await prepareGatewayManagementImport(baseConfig(), {
        version: 2,
        connections: [{
          id: "missing-key",
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:3004/v1",
          protocol: "responses",
          credential: { mode: "env", env: missingEnv },
          allowPrivateNetwork: true,
          liveModels: true,
          models: ["gpt-5.6-sol"],
          modelProfiles: {
            "gpt-5.6-sol": { serviceTiers: ["priority"] },
          },
        }],
        dryRun: true,
      });
      let calls = 0;
      const diagnostics = await preflightGatewayConnections(
        prepared,
        { inference: true, fast: true },
        (async () => {
          calls += 1;
          throw new Error("fetch must not run");
        }) as typeof fetch,
      );
      expect(calls).toBe(0);
      expect(diagnostics[0]).toMatchObject({
        catalog: { status: "failed", code: "missing_credential" },
        inference: { status: "failed", code: "missing_credential" },
        fast: { status: "failed", code: "missing_credential" },
      });
      expect(JSON.stringify(diagnostics)).not.toContain(missingEnv);
    } finally {
      if (previous === undefined) delete process.env[missingEnv];
      else process.env[missingEnv] = previous;
    }
  });

  test("reports a configured model missing from the live catalog without hiding inference evidence", async () => {
    const prepared = await prepareGatewayManagementImport(baseConfig(), {
      version: 2,
      connections: [{
        id: "catalog-mismatch",
        kind: "openai-compatible",
        baseUrl: "https://example.test/v1",
        protocol: "responses",
        credential: { mode: "stored", apiKey: "catalog-mismatch-secret" },
        liveModels: true,
        models: ["gpt-configured"],
      }],
      dryRun: true,
    });
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") {
        return Response.json({ object: "list", data: [{ id: "gpt-other" }] });
      }
      return Response.json({ id: "resp_test", status: "completed", output: [] });
    }) as typeof fetch;

    const diagnostics = await preflightGatewayConnections(
      prepared,
      { inference: true },
      fetchMock,
    );

    expect(diagnostics[0]).toMatchObject({
      catalog: {
        status: "failed",
        code: "configured_model_missing",
        models: 1,
        model: "gpt-configured",
        modelPresent: false,
      },
      inference: {
        status: "passed",
        code: "inference_ok",
        model: "gpt-configured",
      },
    });
  });

  test("bounds connection concurrency while preserving diagnostic order", async () => {
    const prepared = await prepareGatewayManagementImport(baseConfig(), {
      version: 2,
      connections: Array.from({ length: 7 }, (_, index) => ({
        id: `bounded-${index}`,
        kind: "openai-compatible" as const,
        baseUrl: "https://example.com/v1",
        protocol: "responses" as const,
        credential: { mode: "none" as const },
        liveModels: true,
        models: [`model-${index}`],
      })),
      dryRun: true,
    });
    let active = 0;
    let maximumActive = 0;
    const fetchMock = (async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({
        object: "list",
        data: Array.from({ length: 7 }, (_, index) => ({ id: `model-${index}` })),
      });
    }) as typeof fetch;

    const diagnostics = await preflightGatewayConnections(prepared, {}, fetchMock);

    expect(maximumActive).toBe(4);
    expect(diagnostics.map(result => result.id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `bounded-${index}`),
    );
    expect(diagnostics.every(result => result.catalog.status === "passed")).toBe(true);
  });
});
