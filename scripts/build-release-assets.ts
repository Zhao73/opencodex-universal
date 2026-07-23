#!/usr/bin/env bun
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface PackEntry {
  filename: string;
}

interface PackageJson {
  name: string;
  version: string;
  engines?: { node?: string };
}

const root = resolve(import.meta.dir, "..");
const outputDir = join(root, "dist", "release");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;

if (pkg.name !== "opencodex-universal") {
  throw new Error(`refusing to package unexpected npm identity: ${pkg.name}`);
}
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version)) {
  throw new Error(`GitHub preview assets require a preview version, got ${pkg.version}`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const packed = Bun.spawnSync({
  cmd: ["npm", "pack", "--json"],
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
if (packed.exitCode !== 0) {
  throw new Error(`npm pack failed with exit code ${packed.exitCode}`);
}

const entries = JSON.parse(packed.stdout.toString()) as PackEntry[];
if (entries.length !== 1 || !entries[0]?.filename) {
  throw new Error(`npm pack returned an unexpected payload: ${packed.stdout.toString()}`);
}

const sourceArtifact = join(root, entries[0].filename);
const artifactName = basename(sourceArtifact);
const artifactPath = join(outputDir, artifactName);
renameSync(sourceArtifact, artifactPath);

const artifact = Bun.file(artifactPath);
const sha256 = new Bun.CryptoHasher("sha256").update(await artifact.arrayBuffer()).digest("hex");
const size = statSync(artifactPath).size;
const releaseTag = `v${pkg.version}`;
const releaseBase = `https://github.com/Zhao73/opencodex-universal/releases/download/${releaseTag}`;

const manifest = {
  schemaVersion: 1,
  packageName: pkg.name,
  version: pkg.version,
  releaseTag,
  minimumNode: pkg.engines?.node ?? ">=18",
  artifact: {
    name: artifactName,
    url: `${releaseBase}/${artifactName}`,
    sha256,
    size,
  },
  installers: {
    macos: `https://raw.githubusercontent.com/Zhao73/opencodex-universal/${releaseTag}/scripts/install.sh`,
    windows: `https://raw.githubusercontent.com/Zhao73/opencodex-universal/${releaseTag}/scripts/install.ps1`,
  },
  platforms: {
    macos: ["arm64", "x64"],
    windows: ["arm64", "x64"],
    linux: ["arm64", "x64"],
  },
};

writeFileSync(join(outputDir, `${artifactName}.sha256`), `${sha256}\n`, "utf8");
writeFileSync(join(outputDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ outputDir, artifactName, sha256, size, manifest: "release-manifest.json" }, null, 2));
