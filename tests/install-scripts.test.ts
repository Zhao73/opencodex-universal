import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("install scripts", () => {
  test("npm package main is a Node-safe wrapper while Bun keeps the TypeScript API", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      name?: string;
      version?: string;
      main?: string;
      exports?: { "."?: { bun?: string; default?: string } };
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.name).toBe("opencodex-universal");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+-preview\.\d+$/);
    expect(pkg.main).toBe("./bin/package-main.mjs");
    expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
    expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
    expect(pkg.dependencies?.zod).toBe("4.4.3");
    expect(pkg.devDependencies?.typescript).toBe("5.9.3");
    expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
    expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:proxy"]).toBe("bun run src/cli/index.ts start");
    expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
    expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
    expect(pkg.bin?.ocxu).toBe("./bin/ocx.mjs");
    expect(pkg.bin?.["opencodex-universal"]).toBe("./bin/ocx.mjs");
    expect(pkg.bin?.ocx).toBe("./bin/ocx.mjs");
    expect(pkg.files).toContain("assets/banner.png");
    expect(pkg.files).toContain("assets/architecture.png");
    expect(pkg.files).toContain("assets/codex-app-picker.png");
  });

  test("Node can import the package main without executing the CLI", () => {
    const result = spawnSync("node", [
      "-e",
      "import('./bin/package-main.mjs').then(m => { if (m.cliCommand !== 'ocx') process.exit(2); })",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  });

  test("npmignore keeps GUI development docs out of the package", async () => {
    const npmignore = await readText(".npmignore");
    const guiNpmignore = await readText("gui/.npmignore");
    const guiReadme = await readText("gui/README.md");

    expect(npmignore).toContain("gui/README.md");
    expect(guiNpmignore).toContain("README.md");
    expect(guiReadme).toContain("opencodex dashboard");
    expect(guiReadme).toContain("bun run dev:proxy");
    expect(guiReadme).toContain("bun run dev:gui");
    expect(guiReadme).not.toContain("This template provides a minimal setup");
  });

  test("POSIX installer is pinned, staged, rollback-safe, and collision-aware", async () => {
    const script = await readText("scripts/install.sh");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain('PACKAGE_NAME="opencodex-universal"');
    expect(script).toContain("OPENCODEX_PACKAGE_SHA256");
    expect(script).toContain('STATE_DIR="${OPENCODEX_HOME:-${HOME}/.opencodex}"');
    expect(script).toContain("shasum -a 256");
    expect(script).toContain("sha256sum");
    expect(script).toContain("--proto '=https'");
    expect(script).toContain("STAGING_PREFIX=");
    expect(script).toContain("ROLLBACK_PREFIX=");
    expect(script).toContain("restore_previous");
    expect(script).toContain("status --json");
    expect(script).toContain('"$FINAL_LAUNCHER" ensure');
    expect(script).toContain("command -v ocx");
    expect(script).toContain("ocxu");
    expect(script).toContain("x64|arm64");
    expect(script).not.toContain("sudo ");
    expect(script).not.toContain("bun install -g opencodex-universal");
    expect(script).not.toContain("bun.sh/install");
  });

  test("PowerShell installer is pinned, staged, rollback-safe, and resolves real executables", async () => {
    const script = await readText("scripts/install.ps1");

    expect(script).toContain("Node.js 18+ is required");
    expect(script).toContain('$PackageName = "opencodex-universal"');
    expect(script).toContain("OPENCODEX_PACKAGE_SHA256");
    expect(script).toContain("$env:OPENCODEX_HOME");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("Tls12");
    expect(script).toContain("stagingPrefix");
    expect(script).toContain("rollbackPrefix");
    expect(script).toContain("Restore-PreviousInstall");
    expect(script).toContain("status --json");
    expect(script).toContain('Arguments @("ensure")');
    expect(script).toContain("Get-ExternalApplication");
    expect(script).toContain("-CommandType Application");
    expect(script).toContain('"x64", "arm64"');
    expect(script).toContain("ocxu.cmd");
    expect(script).toContain("$LASTEXITCODE");
    expect(script).toContain("Get-Command ocx.cmd");
    expect(script).toContain("Remove-ShimDirectoryFromUserPath");
    expect(script).toContain(".opencodex-universal-path");
    expect(script).toContain("contains unmanaged files");
    expect(script).toContain(" -ine $normalizedShim");
    expect(script).toContain("previousUserPath");
    expect(script).toContain("$expectedInstalledPath");
    expect(script).toContain("$restoredExactPath");
    expect(script).not.toContain("bun install -g opencodex-universal");
    expect(script).not.toContain("bun.sh/install.ps1");
  });

  test("Node launcher handles npm self-update before starting Bun", async () => {
    const launcher = await readText("bin/ocx.mjs");

    expect(launcher).toContain('process.argv[2] === "update"');
    expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
    expect(launcher).toContain('return String(currentVersion).includes("-preview.") ? "preview" : "latest"');
    expect(launcher).toContain("!isBunGlobalInstall()");
    expect(launcher).toContain("repairCodexShimIfNeeded()");
    expect(launcher).toContain("runNpmSelfUpdate()");
  });

  test("release helper watches the workflow run it just dispatched", async () => {
    const script = await readText("scripts/release.ts");

    expect(script).toContain("waitForReleaseWorkflowRun");
    expect(script).toContain("gh run list --workflow release.yml --branch");
    expect(script).toContain("--commit");
    expect(script).toContain("createdAt,databaseId,headSha,status,url");
    expect(script).toContain("await watchRun(releaseRun.databaseId)");
  });
});
