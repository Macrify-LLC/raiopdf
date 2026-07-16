import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getHostPlatformId, platformPath } from "../installer/platforms.mjs";

const PROGRESS_PREFIX = "@@RAIOPDF_OCR_PROGRESS@@ ";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const args = parseArgs(process.argv.slice(2));
const payloadDir = path.resolve(
  args.payloadDir
    ?? process.env.RAIOPDF_PAYLOAD_DIR
    ?? platformPath(repoRoot, getHostPlatformId(), "payloadOutputDir"),
);
const fixture = path.resolve(args.fixture ?? path.join(
  repoRoot,
  "apps",
  "mcp",
  "eval",
  "fixtures",
  "three-pages.pdf",
));
const runner = path.join(payloadDir, "ocr", "raiopdf-ocr-progress.cmd");
const pythonExe = path.join(payloadDir, "ocr", "python", "python.exe");
const wrapper = path.join(payloadDir, "ocr", "raiopdf_ocr_progress.py");
const plugin = path.join(payloadDir, "ocr", "raiopdf_ocr_progress_plugin.py");

if (process.platform !== "win32") {
  throw new Error("The OCR progress wrapper smoke currently requires the windows-x64 payload on Windows.");
}

await assertFile(runner, "OCR progress runner");
await assertFile(pythonExe, "OCR payload Python");
await assertFile(wrapper, "OCR progress wrapper");
await assertFile(plugin, "OCR progress plugin");
await assertFile(fixture, "smoke PDF fixture");
await assertRunnerTemplate(runner);

const tempDir = path.join(os.tmpdir(), `raiopdf-ocr-progress-smoke-${process.pid}-${Date.now()}`);
await mkdir(tempDir, { recursive: true });

try {
  const output = path.join(tempDir, "ocr-progress-output.pdf");
  const result = await runOcr(pythonExe, wrapper, fixture, output, payloadDir);
  if (result.code !== 0) {
    throw new Error([
      `OCR progress wrapper exited with ${result.code}.`,
      "stderr:",
      result.stderr.trim(),
      "stdout:",
      result.stdout.trim(),
    ].join("\n"));
  }

  const records = parseProgressRecords(result.stderr);
  if (records.length === 0) {
    throw new Error(`No ${PROGRESS_PREFIX.trim()} records emitted by ${runner}`);
  }
  if (!records.some((record) => record.phase === "ocr" && record.total > 0)) {
    throw new Error("Progress records did not include page-counted OCR work.");
  }
  if (!records.some((record) => record.phase === "postprocess")) {
    throw new Error("Progress records did not include post-processing work.");
  }

  const outputStats = await stat(output);
  if (outputStats.size <= 0) {
    throw new Error("OCR progress wrapper produced an empty PDF.");
  }

  console.log(`OCR progress smoke passed: ${records.length} progress records, ${outputStats.size} output bytes.`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload-dir") {
      parsed.payloadDir = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--fixture") {
      parsed.fixture = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/smoke-ocr-progress-wrapper.mjs [--payload-dir PATH] [--fixture PDF]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function assertFile(filePath, label) {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`);
    }
    throw error;
  }
}

async function assertRunnerTemplate(filePath) {
  const content = await readFile(filePath, "utf8");
  if (!content.includes("%~dp0python\\python.exe") || !content.includes("%~dp0raiopdf_ocr_progress.py")) {
    throw new Error(`OCR progress runner does not launch the bundled wrapper: ${filePath}`);
  }
}

function runOcr(python, wrapperPath, input, output, payloadRoot) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PYTHONHOME: path.join(payloadRoot, "ocr", "python"),
      PYTHONPATH: path.join(payloadRoot, "ocr", "python", "Lib", "site-packages"),
      PYTHONDONTWRITEBYTECODE: "1",
      PATH: [
        path.join(payloadRoot, "ocr", "tesseract"),
        path.join(payloadRoot, "ocr", "gs", "bin"),
        path.join(payloadRoot, "ocr", "qpdf", "bin"),
        process.env.PATH ?? "",
      ].join(path.delimiter),
    };
    const child = spawn(python, [wrapperPath, "--mode", "force", "--output-type", "pdf", input, output], {
      cwd: repoRoot,
      env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function parseProgressRecords(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(PROGRESS_PREFIX))
    .map((line) => JSON.parse(line.slice(PROGRESS_PREFIX.length)));
}
