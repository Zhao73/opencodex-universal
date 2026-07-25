import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The suite needs the Bun the project pins, not whatever is first on PATH.
 * `Bun.Image` (used by the image-normalization tests) only exists from 1.3, so
 * an older runtime turns a dozen suites into `undefined is not a constructor`
 * and reads as a product regression. Fail loudly with the fix instead.
 */
export function bunVersionError(actual: string, required: string): string | null {
  const parse = (value: string) => value.split(".").map(part => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(actual);
  const [rMajor, rMinor, rPatch] = parse(required);
  const older = aMajor !== rMajor
    ? aMajor < rMajor
    : aMinor !== rMinor
      ? aMinor < rMinor
      : aPatch < rPatch;
  if (!older) return null;
  return [
    `This suite needs Bun ${required}+ but is running ${actual}.`,
    "",
    "Older runtimes lack Bun.Image, which turns the image, OAuth and Kiro suites",
    "into confusing constructor errors that look like product bugs.",
    "",
    "Use the runtime this repo already bundles:",
    "  ./node_modules/bun/bin/bun.exe scripts/test.ts",
  ].join("\n");
}

function requiredBunVersion(): string {
  try {
    const pkg = require("../package.json") as { dependencies?: Record<string, string> };
    return (pkg.dependencies?.bun ?? "1.3.14").replace(/^[\^~]/, "");
  } catch {
    return "1.3.14";
  }
}

if (import.meta.main) {
  const versionError = bunVersionError(Bun.version, requiredBunVersion());
  if (versionError) {
    console.error(versionError);
    process.exit(1);
  }
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    const child = Bun.spawnSync(
      [process.execPath, "test", "--isolate", ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exitCode = child.exitCode ?? 1;
  } finally {
    isolated.cleanup();
  }
}
