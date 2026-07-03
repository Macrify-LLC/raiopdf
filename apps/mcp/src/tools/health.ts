import { z } from "zod";
import type { EngineHandle } from "../engine.js";
import { baseOutputSchema, successResult, type StructuredToolResult } from "../format.js";

export const healthInputSchema = {};

export const healthOutputSchema = {
  ...baseOutputSchema,
  version: z.string().optional(),
};

export async function handleHealth(engine: EngineHandle): Promise<StructuredToolResult> {
  const health = await engine.healthProbe();
  const version = health.version;

  return successResult(
    `RaioPDF engine health: ${health.ok ? "ok" : "unavailable"}${
      version ? ` (${version})` : ""
    }.`,
    {
      ok: health.ok,
      ...(version ? { version } : {}),
    },
  );
}
