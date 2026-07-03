import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const assembler = path.join(scriptDir, "assemble-payload.sh");
const bash = resolveBash();
const result = spawnSync(bash, [assembler, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function resolveBash() {
  if (process.env.BASH && existsSync(process.env.BASH)) {
    return process.env.BASH;
  }

  for (const candidate of candidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "bash";
}

function candidates() {
  if (process.platform !== "win32") {
    return ["/usr/bin/bash", "/bin/bash"];
  }

  return [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
  ];
}
