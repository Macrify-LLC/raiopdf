// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPrinters: vi.fn(),
  printStatus: vi.fn(),
  printerCapabilities: vi.fn(),
  platform: "windows" as "windows" | "macos",
}));

vi.mock("../lib/printPipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/printPipeline")>();
  return {
    ...actual,
    listPrinters: mocks.listPrinters,
    printStatus: mocks.printStatus,
    printerCapabilities: mocks.printerCapabilities,
  };
});
vi.mock("../lib/runtimePlatform", () => ({ runtimePlatform: () => mocks.platform }));
vi.mock("../lib/diagnostics", () => ({ logWorkflowFailure: () => null }));
vi.mock("./ErrorActions", () => ({ ErrorActions: () => null }));
vi.mock("./PdfMiniThumb", () => ({ PdfMiniThumb: () => null }));

import type { PrinterCapabilities, PrinterInfo } from "../lib/printPipeline";
import { PrintDialog, type StartPrintParams } from "./PrintDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DeferredCapabilityRequest = {
  printer: string;
  resolve: (value: PrinterCapabilities) => void;
  reject: (error: unknown) => void;
};

const printerList: PrinterInfo[] = [
  { name: "Printer A", isDefault: true },
  { name: "Printer B", isDefault: false },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onStartPrint: ReturnType<typeof vi.fn<(params: StartPrintParams) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;
const requests: DeferredCapabilityRequest[] = [];

function renderDialog(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onStartPrint = vi.fn<(params: StartPrintParams) => void>();
  onClose = vi.fn();
  act(() => {
    root!.render(
      <PrintDialog
        pageCount={8}
        fileName="brief.pdf"
        pdfDocument={null}
        onStartPrint={onStartPrint}
        onClose={onClose}
        onUseRangeFallback={vi.fn()}
      />,
    );
  });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function mountDialog(): Promise<void> {
  renderDialog();
  await act(async () => tick());
}

async function settleRequest(index: number, capabilities: PrinterCapabilities): Promise<void> {
  await act(async () => {
    requests[index]!.resolve(capabilities);
    await tick();
  });
}

async function rejectRequest(index: number, error: unknown): Promise<void> {
  await act(async () => {
    requests[index]!.reject(error);
    await tick();
  });
}

function select(id: string): HTMLSelectElement {
  const element = container?.querySelector<HTMLSelectElement>(`#${id}`);
  if (!element) {
    throw new Error(`Missing select ${id}`);
  }
  return element;
}

async function changeSelect(id: string, value: string): Promise<void> {
  await act(async () => {
    const element = select(id);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submitForm(): Promise<void> {
  await act(async () => {
    const form = container?.querySelector("form");
    if (!form) {
      throw new Error("Missing print form");
    }
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function optionValues(id: string): string[] {
  return Array.from(select(id).options, (option) => option.value);
}

const capabilities = (
  media: PrinterCapabilities["media"],
  paperSources: PrinterCapabilities["paperSources"],
): PrinterCapabilities => ({ media, paperSources });

beforeEach(() => {
  requests.length = 0;
  mocks.platform = "windows";
  mocks.listPrinters.mockReset().mockResolvedValue(printerList);
  mocks.printStatus.mockReset().mockResolvedValue({
    platformSupported: true,
    ghostscript: true,
    available: true,
  });
  mocks.printerCapabilities.mockReset().mockImplementation((printer: string) => new Promise(
    (resolve, reject) => requests.push({ printer, resolve, reject }),
  ));
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe("PrintDialog printer capabilities", () => {
  it("shows only advertised Windows paper choices and submits the selected media and source", async () => {
    await mountDialog();
    expect(requests.map((request) => request.printer)).toEqual(["Printer A"]);
    expect(optionValues("print-dialog-paper")).toEqual([""]);
    expect(container?.querySelector("#print-dialog-duplex")).toBeNull();
    expect(container?.querySelector("#print-dialog-orientation")).toBeNull();

    await settleRequest(0, capabilities(
      [{ value: "DMPAPER:1", label: "Letter" }, { value: "DMPAPER:9", label: "A4" }],
      [{ value: "DMBIN:1", label: "Upper tray" }],
    ));
    expect(optionValues("print-dialog-paper")).toEqual(["", "DMPAPER:1", "DMPAPER:9"]);
    expect(optionValues("print-dialog-paper-source")).toEqual(["", "DMBIN:1"]);

    await changeSelect("print-dialog-paper", "DMPAPER:9");
    await changeSelect("print-dialog-paper-source", "DMBIN:1");
    await submitForm();

    expect(onStartPrint).toHaveBeenCalledWith(expect.objectContaining({
      printer: "Printer A",
      options: { media: "DMPAPER:9", paperSource: "DMBIN:1" },
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clears old choices on selection and refuses submit while the new printer is loading", async () => {
    await mountDialog();
    await settleRequest(0, capabilities(
      [{ value: "A-LETTER", label: "Letter" }],
      [{ value: "A-TRAY", label: "Tray A" }],
    ));
    await changeSelect("print-dialog-paper", "A-LETTER");
    await changeSelect("print-dialog-paper-source", "A-TRAY");

    await changeSelect("print-dialog-printer", "Printer B");
    expect(select("print-dialog-paper").value).toBe("");
    expect(select("print-dialog-paper-source").value).toBe("");
    expect(optionValues("print-dialog-paper")).toEqual([""]);
    expect(optionValues("print-dialog-paper-source")).toEqual([""]);
    await submitForm();
    expect(onStartPrint).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Wait for this printer's options to finish loading.");

    await settleRequest(1, capabilities(
      [{ value: "B-LEGAL", label: "Legal" }],
      [{ value: "B-TRAY", label: "Tray B" }],
    ));
    await submitForm();
    expect(onStartPrint).toHaveBeenCalledWith(expect.objectContaining({
      printer: "Printer B",
      options: {},
    }));
  });

  it("ignores stale A-to-B-to-A replies even when an old request has the selected printer name", async () => {
    await mountDialog();
    await changeSelect("print-dialog-printer", "Printer B");
    await changeSelect("print-dialog-printer", "Printer A");
    expect(requests.map((request) => request.printer)).toEqual([
      "Printer A",
      "Printer B",
      "Printer A",
    ]);

    await settleRequest(0, capabilities(
      [{ value: "STALE-A", label: "Stale A paper" }],
      [{ value: "STALE-A-TRAY", label: "Stale A tray" }],
    ));
    await settleRequest(1, capabilities(
      [{ value: "STALE-B", label: "Stale B paper" }],
      [{ value: "STALE-B-TRAY", label: "Stale B tray" }],
    ));
    expect(optionValues("print-dialog-paper")).toEqual([""]);
    expect(optionValues("print-dialog-paper-source")).toEqual([""]);

    await settleRequest(2, capabilities(
      [{ value: "CURRENT-A", label: "Current A paper" }],
      [{ value: "CURRENT-A-TRAY", label: "Current A tray" }],
    ));
    expect(optionValues("print-dialog-paper")).toEqual(["", "CURRENT-A"]);
    expect(optionValues("print-dialog-paper-source")).toEqual(["", "CURRENT-A-TRAY"]);
  });

  it("allows defaults after discovery failure while keeping macOS duplex and orientation options", async () => {
    mocks.platform = "macos";
    await mountDialog();
    await rejectRequest(0, new Error("queue options unavailable"));

    expect(container?.textContent).toContain("Printer defaults can still be used");
    expect(optionValues("print-dialog-paper")).toEqual([""]);
    expect(optionValues("print-dialog-paper-source")).toEqual([""]);
    expect(optionValues("print-dialog-duplex")).toContain("two-sided-long-edge");
    expect(optionValues("print-dialog-orientation")).toContain("landscape");

    await changeSelect("print-dialog-duplex", "two-sided-long-edge");
    await changeSelect("print-dialog-orientation", "landscape");
    await submitForm();
    expect(onStartPrint).toHaveBeenCalledWith(expect.objectContaining({
      options: { sides: "two-sided-long-edge", orientation: "landscape" },
    }));
  });

  it("invalidates a pending query when the dialog unmounts and reopens", async () => {
    await mountDialog();
    expect(requests).toHaveLength(1);
    act(() => {
      root!.unmount();
      root = null;
    });
    container?.remove();
    container = null;

    await mountDialog();
    expect(requests).toHaveLength(2);
    await settleRequest(0, capabilities(
      [{ value: "CLOSED-DIALOG", label: "Old dialog paper" }],
      [],
    ));
    expect(optionValues("print-dialog-paper")).toEqual([""]);
    await settleRequest(1, capabilities(
      [{ value: "REOPENED", label: "Reopened paper" }],
      [],
    ));
    expect(optionValues("print-dialog-paper")).toEqual(["", "REOPENED"]);
  });
});
