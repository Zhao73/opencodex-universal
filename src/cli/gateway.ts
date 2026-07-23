/**
 * `ocx gateway` — first-class onboarding for One API, New API, Sub2API, and
 * other OpenAI-compatible aggregators.
 *
 * Credentials are referenced by environment-variable name. The command never
 * accepts a raw key argument, which keeps secrets out of shell history and
 * generated manifests.
 */
import { readFileSync } from "node:fs";
import {
  applyGatewayManifest,
  GATEWAY_KINDS,
  GATEWAY_PROTOCOLS,
  gatewayManifestSample,
  parseGatewayManifest,
  validateGatewayManifestResolvedDestinations,
  type GatewayImportResult,
} from "../gateways/manifest";
import { loadConfig, saveConfig } from "../config";
import { syncModelsToCodex } from "../codex/sync";
import { findLiveProxy } from "../server/proxy-liveness";
import { hasHelpFlag } from "./help";

const ROOT_USAGE = "Usage: ocx gateway <add|import|sample> ...";
const ADD_USAGE = [
  "Usage: ocx gateway add <id> --base-url <url>",
  "  [--kind one-api|new-api|sub2api|openai-compatible]",
  "  [--protocol chat-completions|responses]",
  "  [--api-key-env <ENV_NAME>] [--model <id>]...",
  "  [--selected-model <id>]... [--default-model <id>]",
  "  [--label <text>] [--key-optional] [--allow-private-network]",
  "  [--no-live-models] [--set-default] [--force] [--sync] [--json]",
].join("\n");
const IMPORT_USAGE = "Usage: ocx gateway import <manifest.json> [--force] [--dry-run] [--sync] [--json]";
const SAMPLE_USAGE = "Usage: ocx gateway sample";

function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (index + 1 >= args.length || args[index + 1].startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function consumeRepeatedFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = consumeFlagValue(args, flag);
    if (value === undefined) return values;
    values.push(value);
  }
}

function rejectUnknownArgs(args: string[], usage: string): void {
  if (args.length === 0) return;
  const options = args.filter(value => value.startsWith("-"));
  if (options.length > 0) {
    // Only echo option names. A caller may have supplied a raw secret after an
    // unsupported flag; reflecting every token would leak it into terminal logs.
    throw new Error(`Unknown option(s): ${options.join(", ")}\n${usage}`);
  }
  throw new Error(`Unexpected argument count: ${args.length}\n${usage}`);
}

function readManifestFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new Error(`Could not read gateway manifest "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Gateway manifest "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncIfRequested(wantsSync: boolean): Promise<string> {
  if (!wantsSync) return "not-requested";
  const live = await findLiveProxy();
  if (!live) return "proxy-not-running";
  await syncModelsToCodex(live.port);
  return "completed";
}

function printImportResult(
  result: GatewayImportResult,
  options: { dryRun: boolean; json: boolean; sync: string },
): void {
  if (options.json) {
    console.log(JSON.stringify({
      action: options.dryRun ? "validated" : "imported",
      dryRun: options.dryRun,
      defaultProvider: result.config.defaultProvider,
      connections: result.imported,
      sync: options.sync,
    }, null, 2));
    return;
  }

  const verb = options.dryRun ? "Validated" : "Imported";
  console.log(`${verb} ${result.imported.length} gateway connection(s):`);
  for (const entry of result.imported) {
    const credential = entry.apiKeyEnv ? ` key=\${${entry.apiKeyEnv}}` : " key=(not configured)";
    const defaultMarker = entry.isDefault ? " (default)" : "";
    console.log(`  ${entry.id}${defaultMarker}  ${entry.kind}  ${entry.adapter}${credential}`);
  }
  if (options.dryRun) console.log("No files were changed.");
  if (options.sync === "proxy-not-running") {
    console.log("Model sync skipped because the proxy is not running.");
  }
}

async function handleAdd(args: string[]): Promise<void> {
  const id = args.shift();
  if (!id || id.startsWith("-")) throw new Error(ADD_USAGE);

  const force = consumeFlag(args, "--force");
  const wantsJson = consumeFlag(args, "--json");
  const wantsSync = consumeFlag(args, "--sync");
  const setDefault = consumeFlag(args, "--set-default");
  const keyOptional = consumeFlag(args, "--key-optional");
  const allowPrivateNetwork = consumeFlag(args, "--allow-private-network");
  const noLiveModels = consumeFlag(args, "--no-live-models");
  const baseUrl = consumeFlagValue(args, "--base-url");
  const kind = consumeFlagValue(args, "--kind") ?? "openai-compatible";
  const protocol = consumeFlagValue(args, "--protocol") ?? "chat-completions";
  const apiKeyEnv = consumeFlagValue(args, "--api-key-env");
  const defaultModel = consumeFlagValue(args, "--default-model");
  const label = consumeFlagValue(args, "--label");
  const models = consumeRepeatedFlagValues(args, "--model");
  const selectedModels = consumeRepeatedFlagValues(args, "--selected-model");
  rejectUnknownArgs(args, ADD_USAGE);

  if (!baseUrl) throw new Error(`--base-url is required\n${ADD_USAGE}`);
  if (!GATEWAY_KINDS.includes(kind as typeof GATEWAY_KINDS[number])) {
    throw new Error(`Unsupported --kind "${kind}". Expected: ${GATEWAY_KINDS.join(", ")}`);
  }
  if (!GATEWAY_PROTOCOLS.includes(protocol as typeof GATEWAY_PROTOCOLS[number])) {
    throw new Error(`Unsupported --protocol "${protocol}". Expected: ${GATEWAY_PROTOCOLS.join(", ")}`);
  }

  const manifest = parseGatewayManifest({
    version: 1,
    connections: [{
      id,
      ...(label ? { label } : {}),
      kind,
      baseUrl,
      protocol,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(keyOptional ? { keyOptional: true } : {}),
      ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      liveModels: !noLiveModels,
      ...(models.length > 0 ? { models } : {}),
      ...(selectedModels.length > 0 ? { selectedModels } : {}),
      ...(defaultModel ? { defaultModel } : {}),
    }],
    ...(setDefault ? { defaultProvider: id } : {}),
  });
  await validateGatewayManifestResolvedDestinations(manifest);
  const result = applyGatewayManifest(loadConfig(), manifest, { force });
  saveConfig(result.config);
  const sync = await syncIfRequested(wantsSync);
  printImportResult(result, { dryRun: false, json: wantsJson, sync });
}

async function handleImport(args: string[]): Promise<void> {
  const path = args.shift();
  if (!path || path.startsWith("-")) throw new Error(IMPORT_USAGE);
  const force = consumeFlag(args, "--force");
  const dryRun = consumeFlag(args, "--dry-run");
  const wantsJson = consumeFlag(args, "--json");
  const wantsSync = consumeFlag(args, "--sync");
  rejectUnknownArgs(args, IMPORT_USAGE);

  const manifest = parseGatewayManifest(readManifestFile(path));
  await validateGatewayManifestResolvedDestinations(manifest);
  const result = applyGatewayManifest(loadConfig(), manifest, { force });
  if (!dryRun) saveConfig(result.config);
  const sync = dryRun ? "not-requested" : await syncIfRequested(wantsSync);
  printImportResult(result, { dryRun, json: wantsJson, sync });
}

export async function handleGatewayCommand(input: string[]): Promise<void> {
  const args = [...input];
  if (hasHelpFlag(args)) {
    console.log(`${ROOT_USAGE}\n\n${ADD_USAGE}\n\n${IMPORT_USAGE}\n\n${SAMPLE_USAGE}`);
    return;
  }

  const command = args.shift();
  try {
    switch (command) {
      case "add":
        await handleAdd(args);
        return;
      case "import":
        await handleImport(args);
        return;
      case "sample":
        rejectUnknownArgs(args, SAMPLE_USAGE);
        console.log(JSON.stringify(gatewayManifestSample(), null, 2));
        return;
      default:
        throw new Error(ROOT_USAGE);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
