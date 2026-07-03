import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineHandle } from "../src/engine.js";
import { runSingleOutputOp } from "../src/ops.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-ops-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeEngineHandle(): { handle: EngineHandle; closed: unknown[] } {
  const closed: unknown[] = [];
  const engine = {
    open: async (bytes: Uint8Array) => ({ bytes }),
    saveToBytes: async () => new TextEncoder().encode("%PDF-result\n"),
    close: async (document: unknown) => {
      closed.push(document);
    },
  };
  return { handle: { getEngine: async () => engine } as unknown as EngineHandle, closed };
}

describe("runSingleOutputOp", () => {
  it("writes the produced document to the output and closes opened inputs", async () => {
    const input = path.join(dir, "in.pdf");
    await fs.writeFile(input, "%PDF-1.4\n");
    const output = path.join(dir, "out.pdf");
    const { handle, closed } = fakeEngineHandle();

    const result = await runSingleOutputOp(handle, input, output, async (_engine, document) => ({
      result: document,
      summary: "done",
    }));

    expect(await fs.readFile(output, "utf8")).toBe("%PDF-result\n");
    expect(result.structuredContent).toMatchObject({ ok: true, output });
    expect(closed).toHaveLength(1);
  });

  it("aborts the output (no leftover files) when the producer throws", async () => {
    const input = path.join(dir, "in.pdf");
    await fs.writeFile(input, "%PDF-1.4\n");
    const output = path.join(dir, "out.pdf");
    const { handle } = fakeEngineHandle();

    await expect(
      runSingleOutputOp(handle, input, output, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(fs.access(output)).rejects.toBeTruthy();
    const leftovers = (await fs.readdir(dir)).filter((entry) => entry !== "in.pdf");
    expect(leftovers).toEqual([]);
  });
});
