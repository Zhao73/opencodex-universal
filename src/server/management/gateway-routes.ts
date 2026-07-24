import { saveConfig } from "../../config";
import { prepareGatewayManagementImport } from "../../gateways/management";
import { preflightGatewayConnections } from "../../gateways/preflight";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

/**
 * Validate or atomically import multiple independent OpenAI-compatible
 * gateways. Response payloads contain credential metadata only; submitted
 * stored secrets are never echoed after request parsing.
 */
export async function handleGatewayRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, refreshCodexCatalogBestEffort } = ctx;
  if (
    (url.pathname !== "/api/gateways/import" && url.pathname !== "/api/gateways/preflight")
    || req.method !== "POST"
  ) return null;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  try {
    if (url.pathname === "/api/gateways/preflight") {
      const envelope = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? rawBody as { request?: unknown; inference?: unknown; fast?: unknown }
        : {};
      if (typeof envelope.inference !== "boolean" || typeof envelope.fast !== "boolean") {
        return jsonResponse({ error: "inference and fast booleans are required" }, 400);
      }
      const prepared = await prepareGatewayManagementImport(config, envelope.request);
      const diagnostics = await preflightGatewayConnections(prepared, {
        inference: envelope.inference,
        fast: envelope.fast,
      });
      return jsonResponse({
        success: true,
        ...prepared.preview,
        diagnostics,
      });
    }

    const prepared = await prepareGatewayManagementImport(config, rawBody);
    if (!prepared.request.dryRun) {
      // Persist the fully prepared config first. A failed write therefore
      // cannot leave a partially imported live in-memory configuration.
      saveConfig(prepared.result.config);
      config.providers = prepared.result.config.providers;
      config.defaultProvider = prepared.result.config.defaultProvider;

      const { clearModelCache } = await import("../../codex/model-cache");
      for (const connection of prepared.preview.connections) {
        clearModelCache(connection.id);
      }
      await refreshCodexCatalogBestEffort();
    }

    return jsonResponse({
      success: true,
      ...prepared.preview,
      ...(!prepared.request.dryRun
        ? { imported: prepared.preview.connections.map(connection => connection.id) }
        : {}),
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "gateway import failed",
    }, 400);
  }
}
