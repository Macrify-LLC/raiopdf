import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where global-setup writes the live engine's port/token so the worker
 * processes (which don't inherit runtime env mutations) can read it back.
 * Gitignored; recreated every canary run.
 */
export const ENDPOINT_FILE = path.join(here, ".engine-endpoint.json");

export interface EngineEndpoint {
  port: number;
  token: string;
  baseUrl: string;
  /** Timestamped run folder for human-review artifacts, or null if not configured. */
  outputDir?: string | null;
}

export function readEngineEndpoint(): EngineEndpoint {
  try {
    return JSON.parse(readFileSync(ENDPOINT_FILE, "utf8")) as EngineEndpoint;
  } catch (error) {
    throw new Error(
      `Live engine endpoint not found at ${ENDPOINT_FILE}. ` +
        `The canary global-setup should have booted the payload engine and written it.`,
      { cause: error },
    );
  }
}
