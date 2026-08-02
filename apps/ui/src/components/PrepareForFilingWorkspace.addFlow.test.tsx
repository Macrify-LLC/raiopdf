// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { getPack, resolvePrepPlan } from "@raiopdf/rules";
import {
  PrepareForFilingWorkspace,
  type FilingPacketFile,
} from "./PrepareForFilingWorkspace";
import type { DocumentState } from "../hooks/useDocument";

const MiB = 1024 * 1024;

// Coverage for the packet builder's multi-file add flow -- App.tsx's
// `openFilingPacketFile` conversion loop (FileAddResult[] -> FilingPacketFile[],
// bounded sequential page counts, partial-failure summary in
// `packetProgress.message`) is untested here on purpose: it lives in App.tsx,
// which has no unit-test harness in this repo. This file proves the piece the
// workspace itself owns -- appending every entry `onAddPacketFile` hands back,
// in order, on top of whatever was already seeded.
describe("PrepareForFilingWorkspace packet add flow", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  function render(onAddPacketFile: () => Promise<FilingPacketFile[] | null>) {
    const pack = getPack();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <PrepareForFilingWorkspace
          document={mockDocument}
          pack={pack}
          prepPlan={resolvePrepPlan(pack, mockFacts)}
          courtProfiles={[]}
          selectedCourtProfile={null}
          facts={mockFacts}
          report={null}
          loadingReport={false}
          progress={{ phase: "idle", message: null }}
          result={null}
          impact={null}
          pdfAAvailable
          compressAvailable
          onPackChange={() => undefined}
          onCourtProfileSelect={() => undefined}
          onCourtProfileSave={() => undefined}
          onPrepare={() => undefined}
          onAddPacketFile={onAddPacketFile}
          onBuildPacket={async () => undefined}
          onDismissImpact={() => undefined}
          onCompressFirst={() => undefined}
        />,
      );
    });
  }

  function openPacketMode() {
    const tab = Array.from(document.querySelectorAll("button[role='tab']")).find(
      (button) => button.textContent === "Filing packet",
    );
    if (!tab) {
      throw new Error("Filing packet tab not found");
    }
    act(() => {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function clickAddPdf() {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Add PDF"),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function packetFileNames(): string[] {
    return Array.from(
      document.querySelectorAll(".filing-packet__file-name"),
    ).map((element) => element.textContent ?? "");
  }

  it("seeds the packet order from the currently open document", () => {
    render(async () => null);
    openPacketMode();

    expect(packetFileNames()).toEqual(["motion.pdf"]);
  });

  it("appends every picked file in order on top of the seeded current document", async () => {
    render(async () => [
      { id: "a", name: "a-first.pdf", path: "grant-a", pages: 3 },
      { id: "b", name: "b-second.pdf", path: "grant-b", pages: 5 },
    ]);
    openPacketMode();

    await clickAddPdf();

    expect(packetFileNames()).toEqual(["motion.pdf", "a-first.pdf", "b-second.pdf"]);
  });

  it("does nothing when the pick is cancelled (null)", async () => {
    render(async () => null);
    openPacketMode();

    await clickAddPdf();

    expect(packetFileNames()).toEqual(["motion.pdf"]);
  });

  it("adds nothing when every picked file failed (empty array from a fully-failed batch)", async () => {
    render(async () => []);
    openPacketMode();

    await clickAddPdf();

    expect(packetFileNames()).toEqual(["motion.pdf"]);
  });
});

const mockDocument: DocumentState = {
  bytes: new Uint8Array([1]),
  source: { kind: "memory", bytes: new Uint8Array([1]) },
  generation: 1,
  engineHandle: null,
  pageCount: 2,
  currentPage: 1,
  zoom: 1,
  dirty: false,
  fitWidth: true,
  fileName: "motion.pdf",
  filePath: null,
  fileSizeBytes: 28 * MiB,
  hasTextLayer: true,
  textLayerCoverage: {
    imageOnlyPages: [],
    mixedPages: [],
    textPages: [0, 1],
    garbledPages: [],
  },
  pageSizeInches: null,
  outline: null,
  outlineStatus: null,
  signatureInvalidationNotice: null,
  protectionSource: null,
  protectionFacts: null,
  protectedSourceGrant: null,
  tempBackingGrant: null,
  error: null,
};

const mockFacts = {
  pages: [],
  fileBytes: 28 * MiB,
  filename: "motion.pdf",
};
