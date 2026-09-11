import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape, type ZodType } from "zod";

/**
 * The JSON Schema dialect every advertised tool schema declares.
 *
 * Why this module exists: MCP clients validate a tool's `structuredContent`
 * against the `outputSchema` the server advertises in `tools/list`, and some of
 * them (the claude.ai cloud client among them) accept only JSON Schema
 * 2020-12 — a schema that declares any other dialect is rejected before the
 * tool is ever called. The MCP SDK converts our zod shapes with a hard-coded
 * draft-07 target, so with its stock `tools/list` handler every RaioPDF tool
 * listed fine and then failed on every call with "unsupported dialect".
 *
 * The SDK's `registerTool` only takes zod schemas, so the listing is produced
 * here instead: the same zod shapes, converted with zod's own 2020-12 target.
 * For RaioPDF's schemas the two targets differ only in the `$schema` line, so
 * clients that were already working (the SDK's AJV validator tolerates the
 * declaration) see identical schemas. `tools/call` is untouched — the SDK still
 * parses input and validates output against the zod shapes.
 */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** A zod raw shape (the form every tool here is registered with) or a zod schema. */
export type ToolShape = ZodRawShape | ZodType;

export type ToolListingEntry = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: ToolShape | undefined;
  outputSchema?: ToolShape | undefined;
  annotations?: ToolAnnotations | undefined;
};

type ObjectJsonSchema = Tool["inputSchema"];

function isZodSchema(value: unknown): value is ZodType {
  return value instanceof z.ZodType;
}

/** Convert a zod raw shape to a 2020-12 object schema, as the client will see it. */
export function toolJsonSchema(shape: ToolShape, io: "input" | "output"): ObjectJsonSchema {
  const object = isZodSchema(shape) ? shape : z.object(shape);
  const schema = z.toJSONSchema(object, { target: "draft-2020-12", io });
  if (schema.type !== "object") {
    throw new Error(`tool ${io} schema must be an object schema, got ${String(schema.type)}`);
  }
  return schema as ObjectJsonSchema;
}

/**
 * Replace the SDK's `tools/list` handler with one that advertises the given
 * tools in the 2020-12 dialect. Call it after every `registerTool` — the SDK
 * installs its own handler on the first registration, and this one supersedes
 * it. Schemas are converted eagerly so an unrepresentable shape fails at
 * startup rather than on a client's first listing.
 */
export function installToolListing(server: McpServer, entries: readonly ToolListingEntry[]): void {
  const tools: Tool[] = entries.map((entry) => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    inputSchema: toolJsonSchema(entry.inputSchema ?? {}, "input"),
    ...(entry.outputSchema
      ? { outputSchema: toolJsonSchema(entry.outputSchema, "output") }
      : {}),
    annotations: entry.annotations,
    // Mirrors what the SDK advertises for `registerTool`-registered tools.
    execution: { taskSupport: "forbidden" },
  }));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
}
