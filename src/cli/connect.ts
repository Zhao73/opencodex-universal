/**
 * `ocx connect` — paste an API key, get working models in Codex, Claude Code
 * and OpenCode.
 *
 * The key is read from stdin by default so it never lands in shell history.
 * Detection, catalog discovery and provider naming all happen automatically;
 * the write itself reuses the audited gateway import path.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig } from "../config";
import { prepareGatewayManagementImport } from "../gateways/management";
import {
  buildConnectImportRequest,
  candidateRoots,
  detectGateways,
  type ConnectFailure,
  type DetectedGateway,
} from "../gateways/connect";
import { maskApiKey, parseConnectInput, MAX_CONNECT_CANDIDATES } from "../gateways/connect-parse";
import { syncModelsToCodex } from "../codex/sync";
import { findLiveProxy } from "../server/proxy-liveness";
import { hasHelpFlag } from "./help";

export const CONNECT_USAGE = [
  "Usage: ocx connect [--base-url <url>]... [options]",
  "",
  "Paste an API key (Sub2API, One API, New API, or any OpenAI-compatible",
  "gateway) and OpenCodex identifies the endpoint, loads the models that key",
  "is entitled to, and wires them into Codex, Claude Code and OpenCode.",
  "",
  "Input (pick one):",
  "  (default)              read the paste from stdin — keeps keys out of shell history",
  "  --file <path>          read the paste from a file",
  "  --key <value>          pass a single key inline (visible in shell history)",
  "",
  "Options:",
  "  --base-url <url>       try this gateway root first (repeatable)",
  "  --id <prefix>          provider id prefix instead of the derived one",
  "  --set-default          make the first detected connection the default provider",
  "  --allow-private-network  permit localhost / LAN gateways",
  "  --apply <targets>      configure clients after import: codex,opencode,all",
  "  --dry-run              detect and print, write nothing",
  "  --force                replace providers that already use these ids",
  "  --timeout <ms>         per-request probe timeout (default 12000)",
  "  --json                 machine-readable output",
].join("\n");

interface ConnectFlags {
  baseUrls: string[];
  file?: string;
  key?: string;
  idPrefix?: string;
  setDefault: boolean;
  allowPrivateNetwork: boolean;
  apply: string[];
  dryRun: boolean;
  force: boolean;
  timeoutMs?: number;
  json: boolean;
}

const APPLY_TARGETS = new Set(["codex", "opencode", "claude", "all", "none"]);

function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${flag} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function consumeRepeated(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = consumeFlagValue(args, flag);
    if (value === undefined) return values;
    values.push(value);
  }
}

export function parseConnectFlags(input: string[]): ConnectFlags {
  const args = [...input];
  const flags: ConnectFlags = {
    baseUrls: [],
    setDefault: consumeFlag(args, "--set-default"),
    allowPrivateNetwork: consumeFlag(args, "--allow-private-network"),
    apply: [],
    dryRun: consumeFlag(args, "--dry-run"),
    force: consumeFlag(args, "--force"),
    json: consumeFlag(args, "--json"),
  };
  flags.baseUrls = consumeRepeated(args, "--base-url");
  flags.file = consumeFlagValue(args, "--file");
  flags.key = consumeFlagValue(args, "--key");
  flags.idPrefix = consumeFlagValue(args, "--id");
  const timeoutText = consumeFlagValue(args, "--timeout");
  if (timeoutText !== undefined) {
    const timeout = Number(timeoutText);
    if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 120_000) {
      throw new Error("--timeout must be between 1000 and 120000 milliseconds");
    }
    flags.timeoutMs = timeout;
  }
  const applyText = consumeFlagValue(args, "--apply");
  if (applyText !== undefined) {
    flags.apply = applyText.split(",").map(target => target.trim().toLowerCase()).filter(Boolean);
    for (const target of flags.apply) {
      if (!APPLY_TARGETS.has(target)) {
        throw new Error(`Unknown --apply target "${target}". Expected: codex, opencode, claude, all, none`);
      }
    }
  }
  const leftovers = args.filter(value => value.startsWith("-"));
  if (leftovers.length > 0) {
    // Never echo bare arguments: one of them may be the secret itself.
    throw new Error(`Unknown option(s): ${leftovers.join(", ")}\n${CONNECT_USAGE}`);
  }
  if (args.length > 0) {
    throw new Error(`Unexpected argument(s). Pipe the key on stdin or use --key.\n${CONNECT_USAGE}`);
  }
  return flags;
}

async function readPaste(flags: ConnectFlags): Promise<string> {
  if (flags.key) return flags.key;
  if (flags.file) return readFileSync(flags.file, "utf8");
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  console.log("Paste your API key (or the whole Base URL + key block), then press Enter on an empty line:");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  try {
    for (;;) {
      const line = await rl.question("");
      if (line.trim() === "") break;
      lines.push(line);
      if (lines.length >= 200) break;
    }
  } finally {
    rl.close();
  }
  return lines.join("\n");
}

function describeGateway(gateway: DetectedGateway): string {
  const rate = gateway.costMultiplier !== undefined ? `  rate ×${gateway.costMultiplier}` : "";
  const replaced = gateway.replaces ? "  (refreshed)" : "";
  return [
    `  ${gateway.id}${replaced}`,
    `    endpoint  ${gateway.baseUrl}  [${gateway.kind} · ${gateway.protocol}]${rate}`,
    `    key       ${gateway.maskedKey}`,
    `    models    ${gateway.models.length} (${gateway.platform})  default: ${gateway.defaultModel ?? "(none)"}`,
    `    sample    ${gateway.models.slice(0, 6).join(", ")}${gateway.models.length > 6 ? ", …" : ""}`,
  ].join("\n");
}

function printFailures(failures: ConnectFailure[]): void {
  if (failures.length === 0) return;
  console.error(`\n${failures.length} key(s) could not be connected:`);
  for (const failure of failures) {
    console.error(`  ${failure.maskedKey}  ${failure.reason}: ${failure.message}`);
  }
}

async function applyToClients(targets: string[], json: boolean): Promise<Record<string, string>> {
  const wanted = new Set(targets.includes("all") ? ["codex", "opencode", "claude"] : targets);
  const outcome: Record<string, string> = {};
  if (wanted.size === 0 || targets.includes("none")) return outcome;

  const live = await findLiveProxy();
  if (!live) {
    for (const target of wanted) outcome[target] = "proxy-not-running";
    if (!json) console.log("\nProxy is not running — start it with `ocx start`, then re-run with --apply.");
    return outcome;
  }
  if (wanted.has("codex")) {
    try {
      await syncModelsToCodex(live.port);
      outcome.codex = "synced";
    } catch (error) {
      outcome.codex = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (wanted.has("opencode")) {
    try {
      const config = loadConfig();
      const { resolveOpenCodeModels, writeOpenCodeManagedConfig } = await import("../hosts/opencode");
      const resolution = await resolveOpenCodeModels(config);
      const written = writeOpenCodeManagedConfig(
        config,
        live.port,
        resolution.models,
        live.hostname ?? config.hostname,
      );
      outcome.opencode = `${written.modelCount} models → ${written.path}`;
    } catch (error) {
      outcome.opencode = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (wanted.has("claude")) {
    // Claude Code is wired at launch time (`ocx claude` injects the env), so
    // there is nothing to persist here beyond confirming the proxy is up.
    outcome.claude = "ready — launch with `ocx claude`";
  }
  return outcome;
}

export async function cmdConnect(input: string[]): Promise<number> {
  if (hasHelpFlag([...input])) {
    console.log(CONNECT_USAGE);
    return 0;
  }

  let flags: ConnectFlags;
  try {
    flags = parseConnectFlags(input);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let paste: string;
  try {
    paste = await readPaste(flags);
  } catch (error) {
    console.error(`Error: could not read the key: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const candidates = parseConnectInput(paste);
  if (candidates.length === 0) {
    console.error("Error: no API key found in the input. Paste the key itself, or the whole Base URL + key block.");
    return 1;
  }
  const config = loadConfig();
  if (!flags.json) {
    const plural = candidates.length === 1 ? "key" : "keys";
    console.log(`Found ${candidates.length} ${plural}: ${candidates.map(c => maskApiKey(c.apiKey)).join(", ")}`);
    if (candidates.length === MAX_CONNECT_CANDIDATES) {
      console.log(`(capped at ${MAX_CONNECT_CANDIDATES} keys per run)`);
    }
    // A key pasted without an endpoint is tried against known roots in order.
    // Say which ones out loud: sending a secret to a host the user never named
    // should never be a surprise.
    const blind = candidates.find(candidate => !candidate.baseUrl);
    if (blind && flags.baseUrls.length === 0) {
      const roots = candidateRoots(blind, { config });
      console.log(`No endpoint in the paste — trying, in order: ${roots.join(", ")}`);
      console.log("Pass --base-url to probe only your own gateway.");
    }
    console.log("Probing gateways…");
  }

  const { detected, failures } = await detectGateways(candidates, {
    baseUrls: flags.baseUrls,
    allowPrivateNetwork: flags.allowPrivateNetwork,
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    config,
    ...(flags.idPrefix ? { idPrefix: flags.idPrefix } : {}),
  });

  if (detected.length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ action: "connect", connected: [], failures }, null, 2));
    } else {
      printFailures(failures);
      console.error("\nNo gateway could be connected.");
    }
    return 1;
  }

  let importedIds: string[] = [];
  try {
    const request = buildConnectImportRequest(detected, {
      setDefault: flags.setDefault,
      dryRun: flags.dryRun,
      ...(flags.force ? { force: true } : {}),
    });
    const prepared = await prepareGatewayManagementImport(config, request);
    if (!flags.dryRun) {
      saveConfig(prepared.result.config);
      const { clearModelCache } = await import("../codex/model-cache");
      for (const connection of prepared.preview.connections) clearModelCache(connection.id);
      importedIds = prepared.preview.connections.map(connection => connection.id);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const applied = flags.dryRun ? {} : await applyToClients(flags.apply, flags.json);

  if (flags.json) {
    console.log(JSON.stringify({
      action: flags.dryRun ? "validated" : "connected",
      dryRun: flags.dryRun,
      connected: detected.map(gateway => ({
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
      })),
      imported: importedIds,
      applied,
      failures,
    }, null, 2));
    return failures.length > 0 && detected.length === 0 ? 1 : 0;
  }

  console.log(`\n${flags.dryRun ? "Detected" : "Connected"} ${detected.length} gateway(s):`);
  for (const gateway of detected) console.log(describeGateway(gateway));
  for (const [target, result] of Object.entries(applied)) {
    console.log(`\n${target}: ${result}`);
  }
  printFailures(failures);
  if (flags.dryRun) {
    console.log("\nNothing was written (--dry-run).");
  } else {
    console.log("\nNext:");
    console.log("  ocx start          # start the router (syncs the catalog into Codex CLI / Codex app)");
    console.log("  ocx claude         # launch Claude Code on these models");
    console.log("  ocx opencode       # launch OpenCode on these models");
    console.log("  ocx models         # list everything that is now routable");
  }
  return 0;
}
