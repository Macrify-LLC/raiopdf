import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { EngineHandle } from "../src/engine.js";

const runEngineSmoke = process.env.RAIOPDF_MCP_ENGINE_SMOKE === "1";
const handle = new EngineHandle();

describe.runIf(runEngineSmoke)("engine-backed MCP smoke", () => {
  afterAll(async () => {
    await handle.dispose();
  });

  it("probes health and counts pages through raiopdf-engine-host", async () => {
    const health = await handle.healthProbe();
    expect(health).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));

    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    const bytes = await pdf.save();

    const engine = await handle.getEngine();
    const document = await engine.open(bytes);
    try {
      await expect(engine.pageCount(document)).resolves.toBe(2);
    } finally {
      await engine.close(document);
    }
  });
});
