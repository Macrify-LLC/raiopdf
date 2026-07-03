import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENABLE_FLAG_RELATIVE_PATH, isEnabled } from "../src/gate.js";
import { withGate } from "../src/index.js";
import type { EngineHandle } from "../src/engine.js";
import type { StructuredToolResult } from "../src/format.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-gate-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("MCP enable gate", () => {
  it("documents the OS/user-scoped flag relative path", () => {
    expect(ENABLE_FLAG_RELATIVE_PATH).toBe(path.join("me.macrify.raiopdf", "mcp-enabled"));
  });

  it("is disabled when the flag file is absent", async () => {
    expect(await isEnabled(path.join(tempDir, "missing-flag"))).toBe(false);
  });

  it("is enabled when the persisted flag holds an enabled marker", async () => {
    const flagPath = path.join(tempDir, "enabled-flag");
    await fs.writeFile(flagPath, "enabled\n");
    expect(await isEnabled(flagPath)).toBe(true);
  });

  it("treats non-enabled flag contents as disabled", async () => {
    const flagPath = path.join(tempDir, "disabled-flag");
    await fs.writeFile(flagPath, "off\n");
    expect(await isEnabled(flagPath)).toBe(false);
  });

  it("returns an actionable MCP_DISABLED error and does no work when the gate is off", async () => {
    let handlerCalled = false;
    const guarded = withGate<Record<string, never>>(
      { engineHandle: {} as EngineHandle, isEnabled: async () => false },
      async (): Promise<StructuredToolResult> => {
        handlerCalled = true;
        return { content: [{ type: "text", text: "unreachable" }], structuredContent: { ok: true } };
      },
    );

    const result = await guarded({});

    expect(handlerCalled).toBe(false);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "MCP_DISABLED" } },
    });
    const firstBlock = result.content[0];
    expect(firstBlock?.type).toBe("text");
    if (firstBlock?.type === "text") {
      expect(firstBlock.text).toContain("Enable 'Open Raio to AI'");
    }
  });
});
