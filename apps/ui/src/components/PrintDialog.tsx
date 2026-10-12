import { useCallback, useEffect, useRef, useState } from "react";
import { pathOpErrorMessage } from "../lib/pathOps";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  listPrinters,
  parseCopies,
  parsePrintSelection,
  printStatus,
  printerCapabilities,
  sortPrintersForPicker,
  type PrinterCapabilities,
  type PrinterInfo,
  type PrintOptionChoice,
  type PrintOptions,
} from "../lib/printPipeline";
import { runtimePlatform } from "../lib/runtimePlatform";
import { FloatingDialog } from "./FloatingDialog";
import { ErrorActions } from "./ErrorActions";
import { logWorkflowFailure } from "../lib/diagnostics";
import { PdfMiniThumb } from "./PdfMiniThumb";
import "./PrintDialog.css";

/** What the dialog hands back when the user commits a print. The document
 * grant and job lifecycle live in the caller so printing runs in the docked
 * loader — the app stays usable and the job survives closing this dialog. */
export interface StartPrintParams {
  printer: string;
  pageIndexes: number[] | null;
  copies: number;
  options: PrintOptions;
}

type CapabilityRequest = {
  printer: string;
  generation: number;
  state: "loading" | "ready" | "error";
  capabilities: PrinterCapabilities | null;
  error: string | null;
};

const PRINTER_DEFAULT: PrintOptionChoice = { value: "", label: "Printer default" };
const DUPLEX: readonly PrintOptionChoice[] = [
  { value: "", label: "Printer default" },
  { value: "one-sided", label: "Single-sided" },
  { value: "two-sided-long-edge", label: "Double-sided (flip on long edge)" },
  { value: "two-sided-short-edge", label: "Double-sided (flip on short edge)" },
];

const ORIENTATIONS: readonly PrintOptionChoice[] = [
  { value: "", label: "Printer default" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

/** A labeled dropdown for one printer-advertised paper or semantic option. */
function OptionSelect({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  choices: readonly PrintOptionChoice[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="tool-panel__field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * RaioPDF's own print dialog for streamed (large) documents — the native
 * pipeline prints any-size PDFs without the WebView ever holding the bytes,
 * so whole-document printing is un-gated here. Small documents keep the
 * untouched `window.print()` path; this dialog exists exactly where that
 * path cannot go.
 *
 * Setup only: once the user commits, the caller drives the job in the docked
 * loader (see App.tsx), so this dialog closes and printing continues in the
 * background — completion and cancellation live at the bottom of the app.
 */
export function PrintDialog({
  pageCount,
  fileName,
  pdfDocument,
  onStartPrint,
  onClose,
  onUseRangeFallback,
}: {
  pageCount: number;
  fileName: string | null;
  pdfDocument: PDFDocumentProxy | null;
  onStartPrint: (params: StartPrintParams) => void;
  onClose: () => void;
  onUseRangeFallback: () => void;
}) {
  const [phase, setPhase] = useState<"probing" | "unavailable" | "ready">("probing");
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [unavailableDiagnosticId, setUnavailableDiagnosticId] = useState<string | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerName, setPrinterName] = useState("");
  const [pagesInput, setPagesInput] = useState("");
  const [copiesInput, setCopiesInput] = useState("1");
  const [paperSize, setPaperSize] = useState("");
  const [paperSource, setPaperSource] = useState("");
  const [duplex, setDuplex] = useState("");
  const [orientation, setOrientation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [capabilityRequest, setCapabilityRequest] = useState<CapabilityRequest>({
    printer: "",
    generation: 0,
    state: "loading",
    capabilities: null,
    error: null,
  });
  const capabilityGeneration = useRef(0);
  const selectedPrinter = useRef("");
  const activeCapabilityRequest = useRef(capabilityRequest);

  const platform = runtimePlatform();
  const supportsPaperOptions = platform === "macos" || platform === "windows";
  const supportsSemanticOptions = platform === "macos";

  const selectPrinter = useCallback((printer: string) => {
    selectedPrinter.current = printer;
    const generation = ++capabilityGeneration.current;
    const pending: CapabilityRequest = {
      printer,
      generation,
      state: "loading",
      capabilities: null,
      error: null,
    };
    // Update the authoritative request synchronously with the selection. A
    // submit event in this turn cannot observe a stale ready response.
    activeCapabilityRequest.current = pending;
    setCapabilityRequest(pending);
    setPaperSize("");
    setPaperSource("");
    setMessage(null);

    if (!printer) {
      return;
    }

    void printerCapabilities(printer).then((capabilities) => {
      if (
        capabilityGeneration.current !== generation
        || selectedPrinter.current !== printer
        || activeCapabilityRequest.current !== pending
      ) {
        return;
      }
      const ready: CapabilityRequest = {
        printer,
        generation,
        state: "ready",
        capabilities,
        error: null,
      };
      activeCapabilityRequest.current = ready;
      setCapabilityRequest(ready);
    }).catch((error: unknown) => {
      if (
        capabilityGeneration.current !== generation
        || selectedPrinter.current !== printer
        || activeCapabilityRequest.current !== pending
      ) {
        return;
      }
      const failed: CapabilityRequest = {
        printer,
        generation,
        state: "error",
        capabilities: null,
        error: pathOpErrorMessage(
          error,
          "Printer options could not be loaded. Printer defaults can still be used for paper size and source.",
        ),
      };
      activeCapabilityRequest.current = failed;
      setCapabilityRequest(failed);
    });
  }, []);

  const close = useCallback(() => {
    capabilityGeneration.current += 1;
    onClose();
  }, [onClose]);

  useEffect(() => {
    let disposed = false;

    void Promise.all([printStatus(), listPrinters()])
      .then(([status, printerList]) => {
        if (disposed) {
          return;
        }
        if (!status.available) {
          setUnavailableReason(
            !status.platformSupported
              ? "Native printing isn't available on this platform yet."
              : "Printing isn't available right now — your RaioPDF installation may be incomplete; reinstalling should fix it. You can still print a page range instead.",
          );
          setPhase("unavailable");
          return;
        }
        if (printerList.length === 0) {
          setUnavailableReason("No printers are installed.");
          setPhase("unavailable");
          return;
        }
        const sorted = sortPrintersForPicker(printerList);
        setPrinters(sorted);
        const initialPrinter = sorted[0]?.name ?? "";
        setPrinterName(initialPrinter);
        selectPrinter(initialPrinter);
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setUnavailableReason(pathOpErrorMessage(error, "Printers could not be listed."));
        // Failing to enumerate printers is an OS/driver integration problem, which
        // is exactly the class worth a report — unlike the page-range validation
        // messages elsewhere in this dialog.
        setUnavailableDiagnosticId(logWorkflowFailure("print.list-printers-failed", error));
        setPhase("unavailable");
      });

    return () => {
      disposed = true;
    };
  }, [selectPrinter]);

  const submit = useCallback(() => {
    const selection = parsePrintSelection(pagesInput, pageCount);
    if (!selection.ok) {
      setMessage(selection.error);
      return;
    }
    const copies = parseCopies(copiesInput);
    if (copies === null) {
      setMessage("Copies must be a whole number between 1 and 99.");
      return;
    }
    if (!printerName) {
      setMessage("Choose a printer.");
      return;
    }

    const request = activeCapabilityRequest.current;
    if (
      selectedPrinter.current !== printerName
      || request.printer !== printerName
      || request.generation !== capabilityGeneration.current
      || request.state === "loading"
    ) {
      setMessage("Wait for this printer's options to finish loading.");
      return;
    }

    const options: PrintOptions = supportsPaperOptions
      ? {
          ...(paperSize ? { media: paperSize } : {}),
          ...(paperSource ? { paperSource } : {}),
          ...(supportsSemanticOptions && duplex ? { sides: duplex } : {}),
          ...(supportsSemanticOptions && orientation ? { orientation } : {}),
        }
      : {};

    onStartPrint({
      printer: printerName,
      pageIndexes: selection.pageIndexes,
      copies,
      options,
    });
    close();
  }, [
    copiesInput,
    close,
    duplex,
    onStartPrint,
    orientation,
    pageCount,
    pagesInput,
    paperSize,
    paperSource,
    printerName,
    supportsPaperOptions,
    supportsSemanticOptions,
  ]);

  useEffect(() => () => {
    capabilityGeneration.current += 1;
  }, []);

  const capabilityRequestIsCurrent = capabilityRequest.printer === printerName
    && capabilityRequest.generation === capabilityGeneration.current;
  const paperCapabilities = capabilityRequestIsCurrent
    ? capabilityRequest.capabilities
    : null;
  const paperChoices = [PRINTER_DEFAULT, ...(paperCapabilities?.media ?? [])];
  const sourceChoices = [PRINTER_DEFAULT, ...(paperCapabilities?.paperSources ?? [])];

  return (
    <FloatingDialog title="Print" eyebrow={fileName ?? undefined} onClose={close}>
      <div className="tool-panel__inline-card">
        {phase === "probing" ? (
          <p className="tool-panel__note" role="status">
            Checking printers...
          </p>
        ) : null}

        {phase === "unavailable" ? (
          <>
            <p className="tool-panel__note" role="alert">{unavailableReason}</p>
            <p className="tool-panel__note">
              A page range can still be extracted and printed as a small
              document instead.
            </p>
            <ErrorActions
              className="print-dialog__report"
              diagnosticId={unavailableDiagnosticId}
              compact
            />
            <button
              type="button"
              className="tool-panel__primary-button"
              onClick={onUseRangeFallback}
            >
              Print a Page Range Instead
            </button>
            <button
              type="button"
              className="tool-panel__secondary-button"
              onClick={close}
            >
              Cancel
            </button>
          </>
        ) : null}

        {phase === "ready" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="print-dialog__preview">
              <PdfMiniThumb
                bytes={null}
                pdfDocument={pdfDocument}
                label="Preview of the first page"
                targetWidth={92}
                targetHeight={119}
              />
              <p className="tool-panel__note print-dialog__preview-note">
                Prints directly from disk — the whole document is available, no
                matter its size.
              </p>
            </div>
            <div className="tool-panel__field">
              <label htmlFor="print-dialog-printer">Printer</label>
              <select
                id="print-dialog-printer"
                value={printerName}
                onChange={(event) => {
                  const printer = event.target.value;
                  setPrinterName(printer);
                  selectPrinter(printer);
                }}
              >
                {printers.map((printer) => (
                  <option key={printer.name} value={printer.name}>
                    {printer.isDefault ? `${printer.name} (default)` : printer.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="tool-panel__field">
              <label htmlFor="print-dialog-pages">
                Pages (1-{Math.max(pageCount, 1)})
              </label>
              <input
                id="print-dialog-pages"
                inputMode="numeric"
                placeholder="All pages"
                value={pagesInput}
                onChange={(event) => setPagesInput(event.target.value)}
              />
            </div>
            <div className="tool-panel__field">
              <label htmlFor="print-dialog-copies">Copies</label>
              <input
                id="print-dialog-copies"
                inputMode="numeric"
                value={copiesInput}
                onChange={(event) => setCopiesInput(event.target.value)}
              />
            </div>
            {supportsPaperOptions ? (
              <>
                <OptionSelect
                  id="print-dialog-paper"
                  label="Paper size"
                  value={paperSize}
                  choices={paperChoices}
                  onChange={setPaperSize}
                />
                <OptionSelect
                  id="print-dialog-paper-source"
                  label="Paper source"
                  value={paperSource}
                  choices={sourceChoices}
                  onChange={setPaperSource}
                />
              </>
            ) : null}
            {supportsSemanticOptions ? (
              <>
                <OptionSelect
                  id="print-dialog-duplex"
                  label="Sides"
                  value={duplex}
                  choices={DUPLEX}
                  onChange={setDuplex}
                />
                <OptionSelect
                  id="print-dialog-orientation"
                  label="Orientation"
                  value={orientation}
                  choices={ORIENTATIONS}
                  onChange={setOrientation}
                />
              </>
            ) : null}
            {supportsPaperOptions && capabilityRequestIsCurrent && capabilityRequest.state === "loading" ? (
              <p className="tool-panel__note" role="status">Checking paper options...</p>
            ) : null}
            {supportsPaperOptions && capabilityRequestIsCurrent && capabilityRequest.state === "error" ? (
              <p className="tool-panel__note" role="status">
                {capabilityRequest.error ?? "Printer options could not be loaded. Printer defaults can still be used for paper size and source."}
              </p>
            ) : null}
            {message ? (
              <p className="tool-panel__status-line" role="status">
                {message}
              </p>
            ) : null}
            <button type="submit" className="tool-panel__primary-button">
              Print
            </button>
            <button
              type="button"
              className="tool-panel__secondary-button"
              onClick={close}
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
    </FloatingDialog>
  );
}
