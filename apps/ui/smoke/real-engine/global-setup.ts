import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
// Repo-root helper that boots the REAL engine-host (auth-proxy -> Stirling ->
// offline OCR toolchain) — the exact stack the packaged app runs.
import { bootPayloadEngine, type EngineHandle } from "../../../../scripts/boot-payload-engine.mjs";
import { ENDPOINT_FILE } from "./endpoint";

/**
 * Playwright globalSetup for the real-engine canary. Boots the payload engine
 * once for the whole run, creates a timestamped output folder for human review,
 * publishes the endpoint for the workers, and returns a teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  process.stdout.write("[canary] booting real payload engine (proxy + Stirling + OCR)…\n");

  let engine: EngineHandle;
  try {
    engine = await bootPayloadEngine();
  } catch (error) {
    process.stderr.write(
      `[canary] engine failed to boot. Did you run \`pnpm prepare:shell-bundle\` first?\n` +
        `${(error as Error).message}\n`,
    );
    throw error;
  }

  process.stdout.write(`[canary] engine ready — proxy port ${engine.port}, token length ${engine.token.length}\n`);

  // A timestamped run folder for the artifacts a human confirms. Only created
  // when RAIOPDF_CANARY_OUTPUT_DIR points somewhere (e.g. the Drive folder).
  let outputDir: string | null = null;
  const outputRoot = process.env.RAIOPDF_CANARY_OUTPUT_DIR;
  if (outputRoot) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    outputDir = path.join(outputRoot, `run-${stamp}`);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "RESULT.md"),
      `# RaioPDF Canary run — ${stamp}\n\n` +
        `> Real output of each canary test, for human review. Open each PDF and confirm it\n` +
        `> looks correct. A row per saved artifact is appended as the run proceeds.\n\n` +
        `| Test | Artifact | Notes |\n|---|---|---|\n`,
    );
    process.stdout.write(`[canary] output folder for review: ${outputDir}\n`);
  } else {
    process.stdout.write("[canary] RAIOPDF_CANARY_OUTPUT_DIR not set — no review artifacts will be saved.\n");
  }

  writeFileSync(
    ENDPOINT_FILE,
    JSON.stringify({ port: engine.port, token: engine.token, baseUrl: engine.baseUrl, outputDir }),
  );

  return async () => {
    process.stdout.write("[canary] stopping engine…\n");
    await engine.stop();
    rmSync(ENDPOINT_FILE, { force: true });
    process.stdout.write("[canary] engine stopped.\n");
    if (outputDir) {
      process.stdout.write(`[canary] review artifacts saved to: ${outputDir}\n`);
    }
  };
}
