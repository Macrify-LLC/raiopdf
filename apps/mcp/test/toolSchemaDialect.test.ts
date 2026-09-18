// Pins the JSON Schema dialect advertised in `tools/list`.
//
// Why this file exists: MCP clients validate a tool's `structuredContent`
// against the advertised `outputSchema`, and the claude.ai cloud client accepts
// JSON Schema 2020-12 only — it rejected every RaioPDF tool with
//   "JSON Schema declares an unsupported dialect ($schema: draft-07)"
// before the tool ran, while the same tools listed fine. The SDK's stock
// listing converts zod shapes with a hard-coded draft-07 target, so the
// listing is produced by `installToolListing` instead. These tests read the
// schemas back the way a client does, over a real `tools/list`, and then drive
// a real `tools/call` through the SDK client so its own output validation runs
// against the advertised schema too.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import { registerTools } from "../src/index.js";
import { JSON_SCHEMA_DIALECT } from "../src/toolListing.js";

const DRAFT_07 = "draft-07";

/** Listing and in-process tools must never start the sidecar. */
function inertEngineHandle(): EngineHandle {
  return {
    async getEngine() {
      throw new Error("this test must not start the engine");
    },
  } as unknown as EngineHandle;
}

async function connectedClient(): Promise<Client> {
  const server = new McpServer({ name: "raiopdf-test", version: "0.0.0" });
  registerTools(server, { engineHandle: inertEngineHandle(), isEnabled: async () => true });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "dialect-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("advertised tool schemas", () => {
  let tools: Tool[];

  beforeAll(async () => {
    ({ tools } = await (await connectedClient()).listTools());
  });

  it("lists every registered tool with both an input and an output schema", () => {
    expect(tools.length).toBeGreaterThanOrEqual(28);
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("declares JSON Schema 2020-12 on every input and output schema", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.$schema, `${tool.name} inputSchema`).toBe(JSON_SCHEMA_DIALECT);
      expect(tool.outputSchema?.$schema, `${tool.name} outputSchema`).toBe(JSON_SCHEMA_DIALECT);
    }
  });

  it("never mentions draft-07 anywhere in the listing", () => {
    expect(JSON.stringify(tools)).not.toContain(DRAFT_07);
  });

  it("keeps the object shape clients rely on (type, properties, required)", () => {
    const pageCount = tools.find((tool) => tool.name === "pdf_page_count");
    expect(pageCount?.inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(pageCount?.outputSchema).toMatchObject({
      type: "object",
      properties: { ok: { type: "boolean" }, pageCount: { type: "integer" } },
      required: ["ok"],
    });
  });
});

describe("tools/call against the advertised schemas", () => {
  let tempDir: string;
  let fixture: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-dialect-"));
    fixture = path.join(tempDir, "fixture.pdf");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([300, 200]).drawText("Arbitration clause.", { x: 30, y: 150, size: 12, font });
    await fs.writeFile(fixture, await pdf.save());
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("passes the SDK client's output validation on a successful in-process call", async () => {
    // The SDK client compiles the advertised outputSchema and validates
    // structuredContent against it — a dialect it could not compile, or a
    // result that drifted from the schema, would throw here.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "locate_text",
      arguments: { input: fixture, query: "arbitration" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, matchCount: 1 });
  });

  it("reaches the tool (a path-policy error, not a schema rejection) for a bad path", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "pdf_page_count",
      arguments: { path: path.join(tempDir, "missing.pdf") },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "PATH_POLICY" } });
  });
});
