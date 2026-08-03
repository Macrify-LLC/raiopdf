// Pins the public, AI-client-facing description of `build_production_set`'s
// withhold surface — on BOTH surfaces that drifted.
//
// Why this file exists: these descriptions are the only thing an AI client
// reads to decide how to call the tool, and two of them fell out of sync with
// the implementation when slip sheets landed. Both said a withheld document
// "never appears in upload/, the index, or the DAT and consumes no Bates
// number" — which is the `withheldHandling: "omit"` behaviour, not the default.
// The default is "slip-sheet": a Bates-stamped placeholder that DOES appear in
// all three and consumes exactly one number
// (packages/production-set/src/index.ts:97-113, docs/PRODUCTION-SETS.md).
//
// A description that confidently states the wrong contract is worse than a
// vague one, because a client acts on it.
//
// The two surfaces need different reach:
//   - the per-field `status` / `withheldHandling` text lives on the zod schema
//     and is read directly;
//   - the tool's own top-level description is an inline literal inside
//     `registerTools`, so it is read back the way a client sees it — over a real
//     tools/list on an in-memory transport. Reading it any other way would let
//     the exact text that regressed drift again unnoticed.
//
// Assertions are semantic rather than exact-string, so rewording stays free
// while re-introducing the specific contradiction does not.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { EngineHandle } from "../src/engine.js";
import { registerTools } from "../src/index.js";
import { productionSetInputSchema } from "../src/tools/legal.js";

const schema = z.object(productionSetInputSchema);

/** Description text for a field on the `sources[]` element. */
function sourceFieldDescription(field: "status" | "privilegeAsserted" | "basis"): string {
  return described(schema.shape.sources.element.shape[field]?.description, `sources[].${field}`);
}

/** Description text for a top-level field on the tool's input schema. */
function topLevelDescription(field: "withheldHandling" | "duplicateHandling"): string {
  return described(schema.shape[field]?.description, field);
}

function described(text: string | undefined, label: string): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`${label} has no description to pin`);
  }
  return text;
}

/** The engine must never be started just to list tool metadata. */
function inertEngineHandle(): EngineHandle {
  return {
    async getEngine() {
      throw new Error("listing tools must not start the sidecar");
    },
  } as unknown as EngineHandle;
}

describe("build_production_set withhold metadata", () => {
  let advertisedDescription: string;

  beforeAll(async () => {
    const server = new McpServer({ name: "raiopdf-test", version: "0.0.0" });
    registerTools(server, {
      engineHandle: inertEngineHandle(),
      isEnabled: async () => true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "metadata-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "build_production_set");
    if (!tool?.description) {
      throw new Error("build_production_set must advertise a description");
    }
    advertisedDescription = tool.description;
    await client.close();
  });

  it("advertises withhold as depending on withheldHandling, not as an unconditional omission", () => {
    // This is the exact text that regressed. It is read back over tools/list
    // because that is the only form an AI client ever sees.
    expect(advertisedDescription).toMatch(/withheldHandling/);
    expect(advertisedDescription).toMatch(/slip-sheet/i);
    expect(advertisedDescription).toMatch(/\bomit\b/);
  });

  it("does not tell clients a withheld document is excluded entirely", () => {
    // The specific pre-fix phrasing, and its close relatives.
    expect(advertisedDescription).not.toMatch(/excluded entirely/i);
  });

  it("ties the per-source status field to withheldHandling", () => {
    const status = sourceFieldDescription("status");
    expect(status).toMatch(/withheldHandling/);
    expect(status).toMatch(/\bomit\b/);
  });

  it("documents the slip-sheet default and what it consumes", () => {
    const handling = topLevelDescription("withheldHandling");
    expect(handling).toMatch(/slip-sheet/i);
    expect(handling, "the default must be stated").toMatch(/default/i);
    // The load-bearing half: the placeholder is produced and consumes a number.
    expect(handling).toMatch(/one\s+bates\s+number|exactly\s+one/i);
    expect(handling).toMatch(/upload\//);
  });

  it("still documents omit as the pure-omission escape hatch", () => {
    const handling = topLevelDescription("withheldHandling");
    expect(handling).toMatch(/\bomit\b/);
    expect(handling).toMatch(/no\s+bates\s+number|consuming\s+no/i);
  });

  it("keeps produce-redacted honest about performing no redaction", () => {
    // Separate promise, same blast radius: a caller must not believe this tool
    // redacts anything on their behalf.
    expect(sourceFieldDescription("status")).toMatch(/no\s+redaction/i);
  });
});
