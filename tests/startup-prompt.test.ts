import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("startup star prompt", () => {
  test("does not ship a package-manager postinstall lifecycle prompt", async () => {
    const pkg = JSON.parse(await readText("package.json")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.files ?? []).not.toContain("scripts/postinstall.mjs");
  });

  test("ocx start waits for the interactive prompt before sync/injection", async () => {
    const cli = await readText("src/cli/index.ts");
    const promptIndex = cli.indexOf("await maybeShowStarPrompt()");
    const syncIndex = cli.indexOf("await syncModelsToCodex(port)");

    expect(cli).not.toContain("void maybeShowStarPrompt()");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(syncIndex);
  });

  test("the one-time prompt stars the OpenCodex Universal repository", async () => {
    const prompt = await readText("src/cli/star-prompt.ts");

    expect(prompt).toContain('const REPO = "Zhao73/opencodex-universal"');
    expect(prompt).toContain("/user/starred/${REPO}");
    expect(prompt).toContain(".star-prompted-opencodex-universal-v1");
    expect(prompt).toContain("Star OpenCodex Universal here: ${REPO_URL}");
    expect(prompt).not.toContain("if (!ghAvailable()) return");
    expect(prompt).not.toContain('const REPO = "lidge-jun/opencodex"');
  });

  test("ocx init offers the Codex autostart shim by default", async () => {
    const init = await readText("src/cli/init.ts");

    expect(init).toContain("Install Codex autostart shim? [Y/n]");
    expect(init).toContain("installCodexShim");
  });
});
