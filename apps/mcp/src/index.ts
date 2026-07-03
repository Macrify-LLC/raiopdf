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

import {
  batesFolderInputSchema,
  batesFolderOutputSchema,
  batesInputSchema,
  batesOutputSchema,
  binderInputSchema,
  binderOutputSchema,
  extractInputSchema,
  extractOutputSchema,
  handleBates,
  handleBatesFolder,
  handleBinder,
  handleExtract,
  handlePageNumbers,
  handleSplit,
  pageNumbersInputSchema,
  pageNumbersOutputSchema,
  splitInputSchema,
  splitOutputSchema,
  type BatesFolderInput,
  type BatesInput,
  type BinderInput,
  type ExtractInput,
  type PageNumbersInput,
  type SplitInput,
} from "./tools/legal.js";

import {
  handleRedact,
  redactInputSchema,
  redactOutputSchema,
  type RedactInput,
} from "./tools/redact.js";
import {
  filingInputSchema,
  filingOutputSchema,
  handlePrepareForFiling,
  type FilingInput,
} from "./tools/filing.js";

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

  server.registerTool(
    "build_exhibit_binder",
    {
      title: "Build exhibit binder",
      description:
        "Assembles a main document with ordered, labeled exhibits into one bookmarked binder (optional slip sheets + exhibit stamps). Writes a new file.",
      inputSchema: binderInputSchema,
      outputSchema: binderOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: BinderInput) => await handleBinder(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "bates_stamp",
    {
      title: "Bates stamp",
      description: "Stamps sequential Bates numbers across a single PDF. Writes a new file.",
      inputSchema: batesInputSchema,
      outputSchema: batesOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: BatesInput) => await handleBates(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "bates_stamp_folder",
    {
      title: "Bates stamp a document set",
      description:
        "Stamps one continuous Bates sequence across an ordered set of files, writing one stamped copy per input into an output directory.",
      inputSchema: batesFolderInputSchema,
      outputSchema: batesFolderOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: BatesFolderInput) =>
        await handleBatesFolder(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "page_numbers",
    {
      title: "Add page numbers",
      description: "Stamps page numbers on selected pages (or all). Writes a new file.",
      inputSchema: pageNumbersInputSchema,
      outputSchema: pageNumbersOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: PageNumbersInput) =>
        await handlePageNumbers(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "split_pdf",
    {
      title: "Split PDF by size",
      description:
        "Splits a PDF at page boundaries into parts under a byte cap, writing the parts into an output directory.",
      inputSchema: splitInputSchema,
      outputSchema: splitOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: SplitInput) => await handleSplit(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "extract_pages",
    {
      title: "Extract pages",
      description: "Keeps only the selected pages (in document order). Writes a new file.",
      inputSchema: extractInputSchema,
      outputSchema: extractOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: ExtractInput) => await handleExtract(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "redact_terms",
    {
      title: "Redact terms",
      description:
        "Redacts text terms by rasterizing the pages so the text is truly removed, then verifies no term remains extractable. Writes a new file only if verification passes.",
      inputSchema: redactInputSchema,
      outputSchema: redactOutputSchema,
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    withGate(
      dependencies,
      async (input: RedactInput) => await handleRedact(input, dependencies.engineHandle),
    ),
  );

  server.registerTool(
    "prepare_for_filing",
    {
      title: "E-filing preflight",
      description:
        "Checks a PDF against a jurisdiction's e-filing rules (page size, orientation, searchable text, file-size caps, PDF/A) and returns each check with its rule citation plus a guidance disclaimer. Read-only — does not modify the file.",
      inputSchema: filingInputSchema,
      outputSchema: filingOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withGate(
      dependencies,
      async (input: FilingInput) =>
        await handlePrepareForFiling(input, dependencies.engineHandle),
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
