import { createRequire } from "node:module";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { getHostPlatformId, getPlatform, platformPath } from "./platforms.mjs";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const platformId = parsePlatform(process.argv.slice(2));
const platform = getPlatform(platformId);
const hostPlatformId = getHostPlatformId();
if (platformId !== hostPlatformId) {
  throw new Error(
    `MCP runtime ${platformId} must be built on its native host (current host: ${hostPlatformId}).`,
  );
}
const payloadDir = process.env.RAIOPDF_PAYLOAD_DIR
  ? path.resolve(process.env.RAIOPDF_PAYLOAD_DIR)
  : platformPath(repoRoot, platformId, "payloadOutputDir");
const mcpPayloadDir = path.join(payloadDir, "mcp");
const appDir = path.join(mcpPayloadDir, "app");
const nodeModulesDir = path.join(mcpPayloadDir, "node_modules");
const pdfjsAssetDir = path.join(mcpPayloadDir, "pdfjs");
const mcpEntry = path.join(repoRoot, "apps", "mcp", "dist", "index.js");
const bundledEntry = path.join(appDir, "index.mjs");

await requireFile(mcpEntry, "MCP build output");

await rm(appDir, { force: true, recursive: true });
await rm(nodeModulesDir, { force: true, recursive: true });
await rm(pdfjsAssetDir, { force: true, recursive: true });
await mkdir(appDir, { recursive: true });

await build({
  absWorkingDir: repoRoot,
  bundle: true,
  entryPoints: [mcpEntry],
  external: ["canvas"],
  format: "esm",
  logLevel: "info",
  outfile: bundledEntry,
  platform: "node",
  sourcemap: false,
  target: ["node24"],
});

const pdfjsRoot = path.dirname(
  require.resolve("pdfjs-dist/package.json", {
    paths: [path.join(repoRoot, "apps", "mcp")],
  }),
);
const pdfjsRequire = createRequire(path.join(pdfjsRoot, "package.json"));

await copyPdfjsAssetDir(pdfjsRoot, "cmaps");
await copyPdfjsAssetDir(pdfjsRoot, "standard_fonts");
await copyPdfjsAssetDir(pdfjsRoot, "wasm");
await copyNodePackage(pdfjsRequire, "@napi-rs/canvas");
await copyNodePackage(pdfjsRequire, nativeCanvasPackage(platform.nodePlatform));

console.log(`Bundled MCP runtime at ${mcpPayloadDir}`);

function parsePlatform(argv) {
  let selected = process.env.RAIOPDF_PLATFORM || process.env.PAYLOAD_PLATFORM;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      selected = argv[++index];
      if (!selected || selected.startsWith("--")) {
        throw new Error("--platform requires a platform id.");
      }
    } else if (arg.startsWith("--platform=")) {
      selected = arg.slice("--platform=".length);
    } else {
      throw new Error(`Unknown build-mcp-runtime argument: ${arg}`);
    }
  }
  return selected || getHostPlatformId();
}

function nativeCanvasPackage(nodePlatform) {
  if (nodePlatform === "win32-x64") return "@napi-rs/canvas-win32-x64-msvc";
  if (nodePlatform === "darwin-arm64") return "@napi-rs/canvas-darwin-arm64";
  throw new Error(`Unsupported canvas platform ${nodePlatform}.`);
}

async function copyPdfjsAssetDir(pdfjsRoot, name) {
  const source = path.join(pdfjsRoot, name);
  const destination = path.join(pdfjsAssetDir, name);

  await requireDirectory(source, `pdf.js ${name} assets`);
  await cp(source, destination, { recursive: true });
}

async function copyNodePackage(resolver, name) {
  const packageJson = resolver.resolve(`${name}/package.json`);
  const source = path.dirname(packageJson);
  const destination = path.join(nodeModulesDir, ...name.split("/"));

  await cp(source, destination, { recursive: true });
}

async function requireFile(file, label) {
  try {
    const stats = await stat(file);
    if (stats.isFile()) {
      return;
    }
  } catch {
    // Report a clearer error below.
  }

  throw new Error(
    `Missing ${label}: ${file}. Run "pnpm --filter @raiopdf/mcp build" first.`,
  );
}

async function requireDirectory(directory, label) {
  try {
    const stats = await stat(directory);
    if (stats.isDirectory()) {
      return;
    }
  } catch {
    // Report a clearer error below.
  }

  throw new Error(`Missing ${label}: ${directory}`);
}
