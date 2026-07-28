import { execFile } from "node:child_process";
import { z } from "zod";
import { resolveEngineHostBinary } from "../engine.js";
import { baseOutputSchema, errorResult, successResult, type StructuredToolResult } from "../format.js";

/**
 * Read RaioPDF's own diagnostics, already scrubbed.
 *
 * Deliberately shells out to the bundled `raiopdf-engine-host --diagnostics`
 * rather than reading the log files here. Redaction is a confidentiality control
 * on a product used by attorneys, so there is exactly ONE implementation of it —
 * the Rust one the desktop app itself uses. A second copy in Node would drift,
 * and the weaker of the two would silently become the guarantee.
 *
 * There is no path parameter, by design: the only readable location is RaioPDF's
 * own app-data directory, resolved inside the host. Accepting a path would turn a
 * diagnostics reader into an arbitrary-file reader.
 */
const DIAGNOSTICS_TIMEOUT_MS = 15_000;
// Generous: a payload is capped at ~48 KB per log plus rotations and provenance.
const DIAGNOSTICS_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Correlation ids are `d-` plus 8 hex, per the UI's `newDiagnosticId`. */
const REFERENCE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const diagnosticsInputSchema = {
  reference: z
    .string()
    .regex(REFERENCE_PATTERN, "reference may contain only letters, digits, dot, dash or underscore")
    .optional()
    .describe(
      "Optional correlation id from a RaioPDF error message (e.g. d-1a2b3c4d). Echoed back so you can find the matching id= line in the log tail.",
    ),
};

export const diagnosticsOutputSchema = {
  ...baseOutputSchema,
  appVersion: z.string().optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  reference: z.string().nullable().optional(),
  sanitized: z.boolean().optional(),
  residualRiskNote: z.string().optional(),
  telemetryNote: z.string().optional(),
  logs: z
    .array(z.object({ name: z.string(), present: z.boolean(), tail: z.string() }))
    .optional(),
};

export async function handleDiagnostics(reference?: string): Promise<StructuredToolResult> {
  const args = ["--diagnostics", ...(reference ? ["--reference", reference] : [])];

  let stdout: string;
  try {
    stdout = await runEngineHost(args);
  } catch (error: unknown) {
    // Deliberately NOT `error.message`. Node builds it as
    // "Command failed: <resolved path> <args>\n<stderr>" — that carries the
    // install path (on Windows, under the user's own name) and raw stderr, the one
    // channel that never passes through the scrubber. Report only the code.
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    return errorResult(
      "ENGINE_ERROR",
      `Could not read RaioPDF diagnostics (${code}).`,
      "Confirm RaioPDF is installed. Diagnostics are read from its own app-data directory.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return errorResult("ENGINE_ERROR", "RaioPDF diagnostics returned unreadable output.");
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return errorResult("ENGINE_ERROR", "RaioPDF diagnostics returned an unexpected shape.");
  }

  const present = parsed.data.logs.filter((log) => log.present).map((log) => log.name);
  const summary = present.length
    ? `RaioPDF diagnostics (scrubbed) for ${parsed.data.appVersion} on ${parsed.data.os}/${parsed.data.arch}: ${present.join(", ")}.`
    : `RaioPDF diagnostics (scrubbed) for ${parsed.data.appVersion} on ${parsed.data.os}/${parsed.data.arch}: no logs found yet.`;

  return successResult(summary, { ...parsed.data });
}

const payloadSchema = z.object({
  appVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  reference: z.string().nullable(),
  sanitized: z.boolean(),
  residualRiskNote: z.string(),
  telemetryNote: z.string(),
  logs: z.array(z.object({ name: z.string(), present: z.boolean(), tail: z.string() })),
});

function runEngineHost(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveEngineHostBinary(),
      [...args],
      { timeout: DIAGNOSTICS_TIMEOUT_MS, maxBuffer: DIAGNOSTICS_MAX_BUFFER_BYTES },
      (error, stdout) => {
        // A non-zero exit that still printed a payload is usable: prefer the
        // answer we have over discarding it and reporting a bare failure.
        if (error && !stdout.trim()) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
