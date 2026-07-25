import { saveConfig } from "../../config";
import {
  buildConnectImportRequest,
  detectGateways,
  type DetectedGateway,
} from "../../gateways/connect";
import { parseConnectInput } from "../../gateways/connect-parse";
import { prepareGatewayManagementImport } from "../../gateways/management";
import { preflightGatewayConnections } from "../../gateways/preflight";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

const GATEWAY_ROUTES = new Set([
  "/api/gateways/import",
  "/api/gateways/preflight",
  "/api/gateways/connect",
]);

/** Detected connections leave the server masked — the raw key is never echoed. */
function publicConnection(gateway: DetectedGateway) {
  return {
    id: gateway.id,
    label: gateway.label,
    kind: gateway.kind,
    protocol: gateway.protocol,
    platform: gateway.platform,
    baseUrl: gateway.baseUrl,
    maskedKey: gateway.maskedKey,
    costMultiplier: gateway.costMultiplier ?? null,
    models: gateway.models,
    defaultModel: gateway.defaultModel ?? null,
    refreshed: gateway.replaces !== undefined,
    notes: gateway.notes,
  };
}

/**
 * Validate or atomically import multiple independent OpenAI-compatible
 * gateways. Response payloads contain credential metadata only; submitted
 * stored secrets are never echoed after request parsing.
 */
export async function handleGatewayRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, refreshCodexCatalogBestEffort } = ctx;
  if (!GATEWAY_ROUTES.has(url.pathname) || req.method !== "POST") return null;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  try {
    if (url.pathname === "/api/gateways/connect") {
      const envelope = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? rawBody as Record<string, unknown>
        : {};
      const paste = typeof envelope.paste === "string" ? envelope.paste : "";
      if (!paste.trim()) return jsonResponse({ error: "paste is required" }, 400);
      const candidates = parseConnectInput(paste);
      if (candidates.length === 0) {
        return jsonResponse({ error: "no API key found in the pasted text" }, 400);
      }
      const baseUrls = Array.isArray(envelope.baseUrls)
        ? envelope.baseUrls.filter((value): value is string => typeof value === "string")
        : [];
      const dryRun = envelope.dryRun === true;
      const { detected, failures } = await detectGateways(candidates, {
        baseUrls,
        allowPrivateNetwork: envelope.allowPrivateNetwork === true,
        config,
        ...(typeof envelope.idPrefix === "string" && envelope.idPrefix.trim()
          ? { idPrefix: envelope.idPrefix }
          : {}),
      });
      if (detected.length === 0) {
        return jsonResponse({
          error: failures[0]?.message ?? "no gateway could be connected",
          failures,
        }, 400);
      }
      const prepared = await prepareGatewayManagementImport(config, buildConnectImportRequest(detected, {
        setDefault: envelope.setDefault === true,
        dryRun,
        ...(envelope.force === true ? { force: true } : {}),
      }));
      if (!dryRun) {
        saveConfig(prepared.result.config);
        config.providers = prepared.result.config.providers;
        config.defaultProvider = prepared.result.config.defaultProvider;
        const { clearModelCache } = await import("../../codex/model-cache");
        for (const connection of prepared.preview.connections) clearModelCache(connection.id);
        await refreshCodexCatalogBestEffort();
      }
      return jsonResponse({
        success: true,
        ...prepared.preview,
        dryRun,
        connected: detected.map(publicConnection),
        failures,
        ...(!dryRun ? { imported: prepared.preview.connections.map(connection => connection.id) } : {}),
      });
    }

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
