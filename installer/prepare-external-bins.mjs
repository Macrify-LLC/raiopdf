import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const stubMode = args.delete("--stub");
if (args.size > 0) {
  throw new Error(`Unknown argument(s): ${[...args].join(", ")}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const targetTriple = getTargetTriple();
const extension = process.platform === "win32" ? ".exe" : "";
const targetDir = path.join(repoRoot, "target", "release");
const binariesDir = path.join(repoRoot, "apps", "shell", "src-tauri", "binaries");
const shellTargetDir = path.join(repoRoot, "apps", "shell", "src-tauri", "target", "release");

await mkdir(binariesDir, { recursive: true });

await prepareExternalBin("raiopdf-engine-host");
await prepareExternalBin("raiopdf-mcp");
await removeStaleBundlerCopies();

console.log(`Prepared Tauri externalBin ${stubMode ? "stubs" : "files"} for ${targetTriple}`);

async function prepareExternalBin(name) {
  const source = path.join(targetDir, `${name}${extension}`);
  const destination = path.join(binariesDir, `${name}-${targetTriple}${extension}`);

  await removeGeneratedCopies(name);

  if (stubMode) {
    await writeStub(destination, name);
  } else {
    await requireFile(source, `built ${name} binary`);
    await copyFile(source, destination);
  }
}

async function writeStub(destination, name) {
  if (process.platform === "win32") {
    await writeFile(destination, `Stub ${name} binary for Tauri compile-time checks.\r\n`);
    return;
  }

  await writeFile(
    destination,
    `#!/bin/sh\nprintf '%s\\n' 'Stub ${name} binary for Tauri compile-time checks.' >&2\nexit 1\n`,
  );
  await chmod(destination, 0o755);
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
