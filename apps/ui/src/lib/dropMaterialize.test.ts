// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: unknown; options?: unknown }>,
  handler: undefined as
    | ((command: string, args?: unknown, options?: unknown) => unknown)
    | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown, options?: unknown) => {
    const call: { command: string; args: unknown; options?: unknown } = { command, args };
    if (options !== undefined) {
      call.options = options;
    }
    invokeState.calls.push(call);

    if (!invokeState.handler) {
      throw new Error(`Unexpected invoke: ${command}`);
    }

    return invokeState.handler(command, args, options);
  },
}));

import { STREAMED_RANGE_CHUNK_SIZE } from "./streamedChunks";
import { materializeDroppedFileGrant, materializePdfBytesGrant } from "./dropMaterialize";

beforeEach(() => {
  invokeState.calls.length = 0;
  invokeState.handler = undefined;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("materializeDroppedFileGrant", () => {
  it("streams every File chunk and returns a rangeGrant", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    const file = new File([
      new Uint8Array(STREAMED_RANGE_CHUNK_SIZE),
      new Uint8Array(STREAMED_RANGE_CHUNK_SIZE),
      new Uint8Array([1, 2, 3]),
    ], "dropped.pdf", { type: "application/pdf" });
    invokeState.handler = (command) => {
      if (command === "dropped_pdf_begin") {
        return "upload-token";
      }
      if (command === "dropped_pdf_append") {
        return undefined;
      }
      if (command === "dropped_pdf_finish") {
        return {
          bytesToken: null,
          fileGrant: "temp-grant",
          name: "dropped.pdf",
          sizeBytes: file.size,
          thresholdBytes: 52_428_800,
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    };

    const source = await materializeDroppedFileGrant(file);

    expect(source).toEqual({
      kind: "rangeGrant",
      grant: "temp-grant",
      name: "dropped.pdf",
      sizeBytes: file.size,
    });
    expect(invokeState.calls.map((call) => call.command)).toEqual([
      "dropped_pdf_begin",
      "dropped_pdf_append",
      "dropped_pdf_append",
      "dropped_pdf_append",
      "dropped_pdf_finish",
    ]);
    expect((invokeState.calls[1]!.args as Uint8Array).byteLength).toBe(STREAMED_RANGE_CHUNK_SIZE);
    expect((invokeState.calls[2]!.args as Uint8Array).byteLength).toBe(STREAMED_RANGE_CHUNK_SIZE);
    expect((invokeState.calls[3]!.args as Uint8Array).byteLength).toBe(3);
  });

  it("aborts the shell upload when a mid-stream chunk fails", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    const file = new File([
      new Uint8Array(STREAMED_RANGE_CHUNK_SIZE),
      new Uint8Array([4]),
    ], "dropped.pdf", { type: "application/pdf" });
    let appendCount = 0;
    invokeState.handler = (command) => {
      if (command === "dropped_pdf_begin") {
        return "upload-token";
      }
      if (command === "dropped_pdf_append") {
        appendCount += 1;
        if (appendCount === 2) {
          throw new Error("append failed");
        }
        return undefined;
      }
      if (command === "dropped_pdf_abort") {
        return undefined;
      }
      throw new Error(`Unexpected invoke: ${command}`);
    };

    await expect(materializeDroppedFileGrant(file)).rejects.toThrow("append failed");

    expect(invokeState.calls.map((call) => call.command)).toEqual([
      "dropped_pdf_begin",
      "dropped_pdf_append",
      "dropped_pdf_append",
      "dropped_pdf_abort",
    ]);
  });

  it("returns null without invoking the shell in the browser runtime", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "browser.pdf");

    await expect(materializeDroppedFileGrant(file)).resolves.toBeNull();

    expect(invokeState.calls).toHaveLength(0);
  });
});

describe("materializePdfBytesGrant", () => {
  it("stages generated PDF bytes through the same chunked shell upload", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    invokeState.handler = (command) => {
      if (command === "dropped_pdf_begin") {
        return "generated-token";
      }
      if (command === "dropped_pdf_append") {
        return undefined;
      }
      if (command === "dropped_pdf_finish") {
        return {
          bytesToken: null,
          fileGrant: "generated-grant",
          name: "draft.pdf",
          sizeBytes: bytes.byteLength,
          thresholdBytes: 52_428_800,
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    };

    await expect(materializePdfBytesGrant(bytes, "draft.pdf")).resolves.toEqual({
      kind: "rangeGrant",
      grant: "generated-grant",
      name: "draft.pdf",
      sizeBytes: bytes.byteLength,
    });
    expect(invokeState.calls.map((call) => call.command)).toEqual([
      "dropped_pdf_begin",
      "dropped_pdf_append",
      "dropped_pdf_finish",
    ]);
    expect(invokeState.calls[1]?.args).toEqual(bytes);
  });
});
