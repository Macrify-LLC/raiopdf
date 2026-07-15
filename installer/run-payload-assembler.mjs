import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertOutsideForeignPlatformRoots,
  getPlatform,
  platformPath,
} from "./platforms.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const options = parseArgs(process.argv.slice(2));
const descriptor = getPlatform(options.platform);
const payloadDir = process.env.RAIOPDF_PAYLOAD_DIR
  ? path.resolve(process.env.RAIOPDF_PAYLOAD_DIR)
  : platformPath(repoRoot, descriptor.payloadId, "payloadOutputDir");
const cacheDir = process.env.RAIOPDF_PAYLOAD_CACHE
  ? path.resolve(process.env.RAIOPDF_PAYLOAD_CACHE)
  : platformPath(repoRoot, descriptor.payloadId, "payloadCacheDir");
const pinsFile = process.env.RAIOPDF_PINS_FILE
  ? path.resolve(process.env.RAIOPDF_PINS_FILE)
  : path.resolve(repoRoot, descriptor.pinsFile);
const assembler = path.join(scriptDir, descriptor.assembler);

assertOutsideForeignPlatformRoots(repoRoot, descriptor.payloadId, "payloadOutputDir", payloadDir);
assertOutsideForeignPlatformRoots(repoRoot, descriptor.payloadId, "payloadCacheDir", cacheDir);
assertOutsideForeignPlatformRoots(repoRoot, descriptor.payloadId, "pinsFile", pinsFile);

if (options.printConfig) {
  console.log(
    JSON.stringify(
      {
        platform: descriptor.payloadId,
        assembler,
        payloadDir,
        cacheDir,
        pinsFile,
        rustTarget: descriptor.rustTarget,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (options.prepareEmpty) {
  assertSafePlatformDirectory(payloadDir, descriptor.payloadId);
  rmSync(payloadDir, { recursive: true, force: true });
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(
    path.join(payloadDir, "RAIOPDF-PAYLOAD-NOT-ASSEMBLED"),
    "Compile-only placeholder. Release packaging must run the platform payload assembler.\n",
  );
  console.log(`Prepared compile-only ${descriptor.payloadId} payload directory at ${payloadDir}`);
  process.exit(0);
}

function assertSafePlatformDirectory(directory, platformId) {
  const relative = path.relative(repoRoot, directory);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    path.basename(directory) !== platformId
  ) {
    throw new Error(
      `Refusing to clean payload directory outside the ${platformId} repository namespace: ${directory}`,
    );
  }
}

const bash = resolveBash();
const result = spawnSync(bash, [assembler, ...options.forwardArgs], {
  cwd: repoRoot,
  env: {
    ...process.env,
    RAIOPDF_PLATFORM: descriptor.payloadId,
    PAYLOAD_PLATFORM: descriptor.payloadId,
    RAIOPDF_PAYLOAD_DIR: payloadDir,
    RAIOPDF_PAYLOAD_CACHE: cacheDir,
    RAIOPDF_PINS_FILE: pinsFile,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);

function parseArgs(argv) {
  const args = {
    platform: process.env.RAIOPDF_PLATFORM || process.env.PAYLOAD_PLATFORM || "windows-x64",
    printConfig: false,
    prepareEmpty: false,
    forwardArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--platform requires a platform id.");
      args.platform = value;
    } else if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length);
    } else if (arg === "--print-config") {
      args.printConfig = true;
    } else if (arg === "--prepare-empty") {
      args.prepareEmpty = true;
    } else {
      args.forwardArgs.push(arg);
    }
  }
  if (args.prepareEmpty && args.forwardArgs.length > 0) {
    throw new Error("--prepare-empty cannot be combined with assembler arguments.");
  }
  return args;
}

function resolveBash() {
  if (process.env.BASH && existsSync(process.env.BASH)) return process.env.BASH;
  for (const candidate of candidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
}

function candidates() {
  if (process.platform !== "win32") return ["/usr/bin/bash", "/bin/bash"];
  return [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
  ];
}
