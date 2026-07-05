import { createRequire } from "node:module";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const payloadDir = process.env.RAIOPDF_PAYLOAD_DIR
  ? path.resolve(process.env.RAIOPDF_PAYLOAD_DIR)
  : path.join(repoRoot, "apps", "shell", "src-tauri", "payload");
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
if (process.platform === "win32") {
  await copyNodePackage(pdfjsRequire, "@napi-rs/canvas-win32-x64-msvc");
} else {
  await copyOptionalNodePackage(pdfjsRequire, "@napi-rs/canvas-win32-x64-msvc");
}

console.log(`Bundled MCP runtime at ${mcpPayloadDir}`);

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

async function copyOptionalNodePackage(resolver, name) {
  try {
    await copyNodePackage(resolver, name);
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
    console.warn(`Skipping optional MCP package not installed on ${process.platform}: ${name}`);
  }
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
