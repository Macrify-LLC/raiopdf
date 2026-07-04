import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  action: z.string().optional(),
});

export const baseOutputSchema = {
  ok: z.boolean(),
  error: errorSchema.optional(),
};

export type ToolErrorCode =
  | "MCP_DISABLED"
  | "ENGINE_ERROR"
  | "PATH_POLICY"
  | "REDACTION_UNVERIFIED"
  | "OCR_UNVERIFIED"
  | "NO_MATCH"
  | "INVALID_ARGUMENT";

export type StructuredToolResult = CallToolResult & {
  structuredContent: Record<string, unknown>;
};

export function successResult(
  summary: string,
  structuredContent: Record<string, unknown>,
): StructuredToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: {
      ok: true,
      ...structuredContent,
    },
  };
}

export function errorResult(
  code: ToolErrorCode,
  message: string,
  action?: string,
): StructuredToolResult {
  const error = {
    code,
    message,
    ...(action ? { action } : {}),
  };

  return {
    isError: true,
    content: [{ type: "text", text: action ? `${message} ${action}` : message }],
    structuredContent: {
      ok: false,
      error,
    },
  };
}
