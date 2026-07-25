import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: `ocx start` + Ctrl-C must NOT orphan the Bun proxy.
 *
 * The bin/ocx.mjs launcher used a blocking spawnSync that did not forward signals,
 * so a signal delivered only to the launcher killed it and left the Bun child
 * serving forever (port bound, ocx.pid/runtime-port.json left behind, Codex config
 * not restored). The launcher now forwards SIGINT/SIGTERM/SIGHUP to the child and
 * waits for its graceful shutdown.
 *
 * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
 * on PATH to exercise the real launcher.
 */

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = !spawnSync("node", ["--version"], { stdio: "ignore" }).error;

/**
 * Some `node` entries on PATH are wrappers that re-exec the real runtime in a
 * *separate* process (pyenv's nodejs-wheel shim, some asdf/volta setups). A
 * signal sent to the wrapper never reaches the launcher, so this test would
 * report an orphaned proxy that does not exist in production. Detect it by
 * asking node for its own pid and comparing with the pid we spawned.
 */
function nodeReExecs(): boolean {
  const probe = spawnSync("node", ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  if (probe.error || typeof probe.stdout !== "string") return false;
  const reported = Number.parseInt(probe.stdout.trim(), 10);
  return Number.isFinite(reported) && probe.pid !== undefined && reported !== probe.pid;
}

const wrapperNode = nodeAvailable && nodeReExecs();
if (wrapperNode) {
  console.error(
    "shutdown-launcher: skipped — `node` on PATH re-execs in another process, "
    + "so it cannot forward signals to the launcher. Put a real node first on PATH.",
  );
}
const runnable = process.platform !== "win32" && nodeAvailable && !wrapperNode;

const spawned: ChildProcess[] = [];
const tmpHomes: string[] = [];

afterAll(() => {
  for (const c of spawned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of tmpHomes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(250);
  }
  return false;
}

describe.skipIf(!runnable)("ocx launcher graceful shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(
      `${signal} to the launcher tears down the Bun proxy and restores Codex config (no orphan)`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-"));
        tmpHomes.push(home);
        const port = await freePort();

        // Seed a native Codex config so the proxy actually injects on start (injectCodexConfig
        // no-ops when no config.toml exists) — this lets us prove the config is RESTORED.
        const codexConfig = join(home, "config.toml");
        writeFileSync(codexConfig, 'model = "gpt-5.1"\n');

        const child = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
          stdio: "ignore",
          env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home },
        });
        spawned.push(child);

        let exited = false;
        child.on("exit", () => { exited = true; });

        // 1. Proxy comes up + injected the Codex config (Design B root override on loopback).
        const up = await waitUntil(() => healthy(port), 20_000);
        expect(up).toBe(true);
        expect(existsSync(join(home, "ocx.pid"))).toBe(true);
        const injected = readFileSync(codexConfig, "utf8");
        expect(injected).toContain("# Auto-injected by opencodex");
        expect(injected).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
        expect(injected).not.toContain("model_providers.opencodex");

        // 2. Signal ONLY the launcher PID (the exact orphan trigger).
        child.kill(signal);

        // 3. Launcher exits...
        const launcherGone = await waitUntil(async () => exited, 15_000);
        expect(launcherGone).toBe(true);

        // 4. ...and the Bun proxy is gone (port freed) — the regression guard.
        const portFreed = await waitUntil(async () => !(await healthy(port)), 10_000);
        expect(portFreed).toBe(true);

        // 5. Graceful cleanup ran: pid + runtime-port removed, Codex config restored.
        expect(existsSync(join(home, "ocx.pid"))).toBe(false);
        expect(existsSync(join(home, "runtime-port.json"))).toBe(false);
        expect(readFileSync(codexConfig, "utf8")).not.toContain("opencodex");
      },
      45_000,
    );
  }
});
