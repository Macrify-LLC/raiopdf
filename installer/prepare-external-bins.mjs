import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const targetTriple = getTargetTriple();
const extension = process.platform === "win32" ? ".exe" : "";
const targetDir = path.join(repoRoot, "target", "release");
const binariesDir = path.join(repoRoot, "apps", "shell", "src-tauri", "binaries");
const shellTargetDir = path.join(repoRoot, "apps", "shell", "src-tauri", "target", "release");

await mkdir(binariesDir, { recursive: true });

await copyExternalBin("raiopdf-engine-host");
await copyExternalBin("raiopdf-mcp");
await removeStaleBundlerCopies();

console.log(`Prepared Tauri externalBin files for ${targetTriple}`);

async function copyExternalBin(name) {
  const source = path.join(targetDir, `${name}${extension}`);
  const destination = path.join(binariesDir, `${name}-${targetTriple}${extension}`);

  await requireFile(source, `built ${name} binary`);
  await removeGeneratedCopies(name);
  await copyFile(source, destination);
}

async function removeGeneratedCopies(name) {
  let entries;
  try {
    entries = await readdir(binariesDir);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${name}-`) && entry.endsWith(extension))
      .map((entry) => rm(path.join(binariesDir, entry), { force: true })),
  );
}

async function removeStaleBundlerCopies() {
  await Promise.all(
    ["raiopdf-engine-host", "raiopdf-mcp"].map((name) =>
      rm(path.join(shellTargetDir, `${name}${extension}`), { force: true }),
    ),
  );
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

  throw new Error(`Missing ${label}: ${file}. Run "cargo build --release" first.`);
}

function getTargetTriple() {
  const output = spawnSync("rustc", ["-Vv"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (output.status !== 0) {
    throw new Error(`failed to run rustc -Vv: ${output.stderr || output.error?.message}`);
  }

  const hostLine = output.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("host:"));

  if (!hostLine) {
    throw new Error("failed to find host target triple in rustc -Vv output");
  }

  return hostLine.slice("host:".length).trim();
}
