#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EngineHandle, defaultEngineHandle } from "./engine.js";
import { ENABLE_ACTION, enableFlagPath, isEnabled } from "./gate.js";
import { errorResult, type StructuredToolResult } from "./format.js";
import { PathPolicyError } from "./paths.js";
import {
  handleHealth,
  healthInputSchema,
  healthOutputSchema,
} from "./tools/health.js";
import {
  handlePageCount,
  pageCountInputSchema,
  pageCountOutputSchema,
  type PageCountInput,
} from "./tools/pageCount.js";
import {
  compressInputSchema,
  compressOutputSchema,
  handleCompress,
  handleMerge,
  handleOcr,
  handleRotate,
  handleSanitize,
  handleScrubMetadata,
  mergeInputSchema,
  mergeOutputSchema,
  ocrInputSchema,
  ocrOutputSchema,
  rotateInputSchema,
  rotateOutputSchema,
  sanitizeInputSchema,
  sanitizeOutputSchema,
  scrubMetadataInputSchema,
  scrubMetadataOutputSchema,
  type CompressInput,
  type MergeInput,
  type OcrInput,
  type RotateInput,
  type SanitizeInput,
  type ScrubMetadataInput,
} from "./tools/core.js";

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const SERVER_NAME = "raiopdf-mcp";
const SERVER_VERSION = "0.0.0-p1b";

export type ToolDependencies = {
  engineHandle: EngineHandle;
  isEnabled: () => Promise<boolean>;
};

export function createDefaultDependencies(): ToolDependencies {
  return {
    engineHandle: defaultEngineHandle,
    isEnabled,
  };
}

export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
  server.registerTool(
    "raiopdf_health",
    {
      title: "RaioPDF health",
      description: "Checks the RaioPDF engine host health endpoint.",
      inputSchema: healthInputSchema,
      outputSchema: healthOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withGate(dependencies, async () => await handleHealth(dependencies.engineHandle)),
  );

  server.registerTool(
    "pdf_page_count",
    {
      title: "PDF page count",
      description: "Counts pages in an absolute local PDF path.",
      inputSchema: pageCountInputSchema,
      outputSchema: pageCountOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withGate(
      dependencies,
      async (input: PageCountInput) => await handlePageCount(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "ocr_pdf",
    {
      title: "OCR PDF",
      description: "Makes a scanned PDF searchable via on-device OCR. Writes a new file.",
      inputSchema: ocrInputSchema,
      outputSchema: ocrOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: OcrInput) => await handleOcr(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "merge_pdfs",
    {
      title: "Merge PDFs",
      description: "Concatenates two or more PDFs, in order, into one new file.",
      inputSchema: mergeInputSchema,
      outputSchema: mergeOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: MergeInput) => await handleMerge(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "rotate_pages",
    {
      title: "Rotate pages",
      description: "Rotates selected pages (or all) by a multiple of 90°. Writes a new file.",
      inputSchema: rotateInputSchema,
      outputSchema: rotateOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: RotateInput) => await handleRotate(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "compress_pdf",
    {
      title: "Compress PDF",
      description: "Creates a smaller copy of a PDF. Writes a new file.",
      inputSchema: compressInputSchema,
      outputSchema: compressOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: CompressInput) => await handleCompress(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "sanitize_pdf",
    {
      title: "Sanitize PDF",
      description:
        "Removes active/embedded content (JavaScript, attachments, external links). Writes a new file.",
      inputSchema: sanitizeInputSchema,
      outputSchema: sanitizeOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: SanitizeInput) => await handleSanitize(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "scrub_metadata",
    {
      title: "Scrub metadata",
      description: "Removes document metadata (author, title, producer, etc.). Writes a new file.",
      inputSchema: scrubMetadataInputSchema,
      outputSchema: scrubMetadataOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: ScrubMetadataInput) =>
        await handleScrubMetadata(input, dependencies.engineHandle),
    ),
  );
}

export function withGate<Args>(
  dependencies: ToolDependencies,
  handler: (args: Args) => Promise<StructuredToolResult>,
): (args: Args) => Promise<StructuredToolResult> {
  return async (args: Args) => {
    if (!(await dependencies.isEnabled())) {
      return errorResult(
        "MCP_DISABLED",
        `RaioPDF MCP is disabled. Flag path: ${enableFlagPath()}.`,
        ENABLE_ACTION,
      );
    }

    try {
      return await handler(args);
    } catch (error) {
      return toolError(error);
    }
  };
}

export function createServer(dependencies = createDefaultDependencies()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, dependencies);

  return server;
}

async function main(): Promise<void> {
  const dependencies = createDefaultDependencies();
  const server = createServer(dependencies);
  const transport = new StdioServerTransport();

  installShutdownHandlers(server, transport, dependencies.engineHandle);
  await server.connect(transport);
}

function toolError(error: unknown): StructuredToolResult {
  if (error instanceof PathPolicyError) {
    return errorResult("PATH_POLICY", error.message, error.action);
  }

  const message = error instanceof Error ? error.message : "Unknown RaioPDF engine error.";

  return errorResult(
    "ENGINE_ERROR",
    message,
    "Confirm RaioPDF's engine payload is installed and try again.",
  );
}

function installShutdownHandlers(
  server: McpServer,
  transport: StdioServerTransport,
  engineHandle: EngineHandle,
): void {
  const dispose = (): void => {
    void engineHandle.dispose();
  };
  const shutdown = (): void => {
    void server.close().finally(() => {
      void engineHandle.dispose().finally(() => {
        process.exit(0);
      });
    });
  };
  const previousClose = transport.onclose;

  transport.onclose = () => {
    previousClose?.();
    dispose();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", dispose);
  process.once("exit", dispose);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  // When launched via the declared `raiopdf-mcp` bin, argv[1] is usually a
  // symlink into node_modules/.bin; dereference it so the CLI actually starts.
  try {
    return realpathSync(entry) === modulePath;
  } catch {
    return path.resolve(entry) === modulePath;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
