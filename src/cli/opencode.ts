/**
 * `ocx opencode` — launch OpenCode against the local OpenCodex proxy without
 * overwriting the user's global or project OpenCode configuration.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import {
  getOpenCodeManagedConfigPath,
  resolveOpenCodeModels,
  writeOpenCodeManagedConfig,
} from "../hosts/opencode";
import { commandInvocation } from "../lib/win-exec";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { isLoopbackHostname } from "../server/auth-cors";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

const OPENCODE_INSTALL_HINT = "❌ `opencode` CLI not found. Install it first: npm install -g opencode-ai";

async function ensureProxyForOpenCode(): Promise<LiveProxy | null> {
  const live = await findLiveProxy();
  if (live) return live;
  const config = loadConfig();
  const port = typeof config.port === "number" && config.port > 0 ? config.port : 10100;
  const child = spawn(process.execPath, [process.argv[1], "start", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

export function buildOpenCodeLaunchEnv(
  config: OcxConfig,
  hostname: string | undefined,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    OPENCODE_CONFIG: getOpenCodeManagedConfigPath(),
  };
  if (!isLoopbackHostname(hostname)) {
    const fileToken = loadServiceTokenFromFile(env);
    if (fileToken) env.OPENCODEX_API_AUTH_TOKEN = fileToken;
    const token = env.OPENCODEX_API_AUTH_TOKEN?.trim();
    if (!token) {
      throw new Error("OPENCODEX_API_AUTH_TOKEN is required to launch OpenCode against a non-loopback OpenCodex bind");
    }
  }
  void config;
  return env;
}

export function openCodeNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? OPENCODE_INSTALL_HINT : null;
}

async function configureOpenCode(
  wantsJson: boolean,
): Promise<{ config: OcxConfig; live: LiveProxy; env: NodeJS.ProcessEnv } | null> {
  const live = await ensureProxyForOpenCode();
  if (!live) {
    console.error("❌ Proxy did not become healthy after starting.");
    return null;
  }
  const config = loadConfig();
  let env: NodeJS.ProcessEnv;
  try {
    env = buildOpenCodeLaunchEnv(config, live.hostname ?? config.hostname, process.env);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const resolution = await resolveOpenCodeModels(config);
  const written = writeOpenCodeManagedConfig(
    config,
    live.port,
    resolution.models,
    live.hostname ?? config.hostname,
  );
  if (written.modelCount === 0) {
    console.error("❌ No routed models are configured. Import a gateway or add a provider model first.");
    return null;
  }

  if (wantsJson) {
    console.log(JSON.stringify({
      action: "configured",
      path: written.path,
      models: written.modelCount,
      defaultModel: written.defaultModel,
      fastVariants: written.fastVariantCount,
      modelSource: resolution.source,
      proxy: {
        port: live.port,
        hostname: live.hostname ?? config.hostname ?? "127.0.0.1",
      },
    }, null, 2));
  } else {
    console.log(`OpenCode managed config: ${written.path}`);
    console.log(`Models: ${written.modelCount} (${resolution.source})`);
    console.log(`Default: ${written.defaultModel ?? "(none)"}`);
    console.log(`Fast variants: ${written.fastVariantCount}`);
  }
  return { config, live, env };
}

export async function cmdOpenCode(input: string[]): Promise<number> {
  const args = [...input];
  if (args[0] === "configure") {
    const configureArgs = args.slice(1);
    const wantsJson = configureArgs[0] === "--json";
    if (wantsJson) configureArgs.shift();
    if (configureArgs.length > 0) {
      console.error("Usage: ocx opencode configure [--json]");
      return 1;
    }
    return (await configureOpenCode(wantsJson)) ? 0 : 1;
  }

  const configured = await configureOpenCode(false);
  if (!configured) return 1;
  return await new Promise<number>(resolve => {
    const invocation = commandInvocation("opencode", args);
    const child = spawn(invocation.file, invocation.args, {
      stdio: "inherit",
      env: configured.env,
      ...invocation.options,
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") console.error(OPENCODE_INSTALL_HINT);
      else console.error(`❌ Failed to launch opencode: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = openCodeNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
