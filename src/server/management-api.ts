import { readFileSync } from "node:fs";
import type { OcxConfig } from "../types";
import { isAllowedRequestOrigin, jsonResponse } from "./auth-cors";
import { drainAndShutdown } from "./lifecycle";
import { handleAgentSettingsRoutes } from "./management/agent-settings-routes";
import { handleComboRoutes } from "./management/combo-routes";
import { handleConfigRoutes } from "./management/config-routes";
import type { ManagementApiDeps, ManagementContext } from "./management/context";
import { handleGatewayRoutes } from "./management/gateway-routes";
import { handleLogsUsageRoutes } from "./management/logs-usage-routes";
import { handleModelRoutes } from "./management/model-routes";
import { handleOauthAccountRoutes } from "./management/oauth-account-routes";
import { handleProviderRoutes } from "./management/provider-routes";
import { handleSystemRoutes } from "./management/system-routes";
import { fetchAllModels } from "./management/shared";

export type { ManagementApiDeps } from "./management/context";

// Single source of truth = package.json, so /healthz and the GUI badge match
// the installed package instead of a stale hardcoded version.
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

export async function handleManagementAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: ManagementApiDeps = {},
): Promise<Response | null> {
  if (!isAllowedRequestOrigin(req, config)) {
    return jsonResponse({ error: "cross-origin request blocked" }, 403, req, config);
  }

  // Management bodies are small JSON (provider names, key ids, settings).
  // Reject oversized payloads before any route handler buffers them.
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: "request body too large" }, 413, req, config);
    }
  }

  async function refreshCodexCatalogBestEffort(): Promise<void> {
    if (deps.refreshCodexCatalog) return deps.refreshCodexCatalog();
    try {
      const { refreshCodexModelCatalog } = await import("../codex/refresh");
      await refreshCodexModelCatalog(config);
    } catch {
      /* catalog absent */
    }
  }

  async function syncClaudeAgentDefsBestEffort(): Promise<void> {
    try {
      const { injectClaudeAgentDefs } = await import("../claude/agents-inject");
      if (config.claudeCode?.enabled === false || config.claudeCode?.injectAgents === false) {
        injectClaudeAgentDefs(config, {});
        return;
      }
      try {
        const [models, { buildClaudeContextWindows }, { visibleNativeSlugs }] = await Promise.all([
          fetchAllModels(config),
          import("../claude/context-windows"),
          import("../codex/catalog"),
        ]);
        injectClaudeAgentDefs(config, buildClaudeContextWindows([...visibleNativeSlugs(config)], models));
      } catch {
        // Keep routes available through a provider-discovery blip. A later
        // launch-time sync restores any context markers missing from this pass.
        injectClaudeAgentDefs(config, {});
      }
    } catch {
      /* best-effort */
    }
  }

  const ctx: ManagementContext = {
    req,
    url,
    config,
    deps,
    refreshCodexCatalogBestEffort,
    syncClaudeAgentDefsBestEffort,
  };
  const routed =
    (await handleConfigRoutes(ctx))
    ?? (await handleLogsUsageRoutes(ctx))
    ?? (await handleGatewayRoutes(ctx))
    ?? (await handleProviderRoutes(ctx))
    ?? (await handleModelRoutes(ctx))
    ?? (await handleAgentSettingsRoutes(ctx))
    ?? (await handleOauthAccountRoutes(ctx))
    ?? (await handleComboRoutes(ctx))
    ?? (await handleSystemRoutes(ctx));
  if (routed) return routed;

  if (url.pathname === "/api/stop" && req.method === "POST") {
    const { restoreNativeCodex } = await import("../codex/inject");
    const { stopServiceIfInstalled } = await import("../service");
    stopServiceIfInstalled();
    const restore = restoreNativeCodex();
    setTimeout(async () => {
      await drainAndShutdown(undefined, config.shutdownTimeoutMs ?? 5000);
      process.exit(0);
    }, 200);
    return jsonResponse(restore.success
      ? { success: true, message: "Proxy stopping, native Codex restored." }
      : { success: false, message: `Proxy stopping, but native Codex restore failed: ${restore.message}. Run \`ocx restore\`.` });
  }

  if (url.pathname.startsWith("/api/codex-auth/")) {
    const { handleCodexAuthAPI } = await import("../codex/auth-api");
    return handleCodexAuthAPI(req, url, config);
  }

  return null;
}

export { fetchAllModels } from "./management/shared";
