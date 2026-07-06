import { describe, expect, it } from "vitest";

import type { FileGrant } from "./filePort";
import { resolveEngineOpRoute, type EngineOpRouteInputs } from "./engineOpRoute";

const grant = (value: string) => value as FileGrant;

const base: EngineOpRouteInputs = {
  isTauriRuntime: true,
  sourceKind: "memory",
  streamedGrant: null,
  memoryFilePath: "grant-abc",
  dirty: false,
  hasUnsavedEdits: false,
};

describe("resolveEngineOpRoute", () => {
  it("routes a clean memory doc opened from a file through path_ops", () => {
    expect(resolveEngineOpRoute(base)).toEqual({
      via: "path-ops",
      grant: grant("grant-abc"),
    });
  });

  it("routes a streamed doc through its existing path-ops grant unchanged", () => {
    expect(
      resolveEngineOpRoute({
        ...base,
        sourceKind: "rangeGrant",
        streamedGrant: grant("streamed-grant"),
        memoryFilePath: null,
      }),
    ).toEqual({ via: "path-ops", grant: grant("streamed-grant") });
  });

  it("prefers the streamed grant even if a memory filePath is present", () => {
    expect(
      resolveEngineOpRoute({ ...base, streamedGrant: grant("streamed-grant") }),
    ).toEqual({ via: "path-ops", grant: grant("streamed-grant") });
  });

  it("requires save-first when the memory doc has an in-place mutation pending", () => {
    expect(resolveEngineOpRoute({ ...base, dirty: true })).toEqual({
      via: "save-first",
    });
  });

  it("requires save-first when the memory doc has unsaved overlay edits", () => {
    expect(resolveEngineOpRoute({ ...base, hasUnsavedEdits: true })).toEqual({
      via: "save-first",
    });
  });

  it("falls back to loopback for a browser open (no grant)", () => {
    expect(
      resolveEngineOpRoute({ ...base, isTauriRuntime: false }),
    ).toEqual({ via: "loopback" });
  });

  it("falls back to loopback for a memory doc with no file path (derived in-app)", () => {
    expect(
      resolveEngineOpRoute({ ...base, memoryFilePath: null }),
    ).toEqual({ via: "loopback" });
  });

  it("never treats a non-memory source without a streamed grant as path-ops", () => {
    expect(
      resolveEngineOpRoute({
        ...base,
        sourceKind: "rangeFile",
        memoryFilePath: null,
      }),
    ).toEqual({ via: "loopback" });
  });

  it("does not route a dirty doc through the stale on-disk grant", () => {
    // Guard: a dirty memory doc's on-disk file is the pre-edit content, so it
    // must NOT resolve to path-ops with the current grant.
    const route = resolveEngineOpRoute({ ...base, dirty: true });
    expect(route.via).not.toBe("path-ops");
  });
});
