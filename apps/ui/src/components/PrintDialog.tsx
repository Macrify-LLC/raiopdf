import { useCallback, useEffect, useState } from "react";
import { pathOpErrorMessage } from "../lib/pathOps";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  listPrinters,
  parseCopies,
  parsePrintSelection,
  printStatus,
  sortPrintersForPicker,
  type PrinterInfo,
  type PrintOptions,
} from "../lib/printPipeline";
import { runtimePlatform } from "../lib/runtimePlatform";
import { FloatingDialog } from "./FloatingDialog";
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

interface OptionChoice {
  value: string;
  label: string;
}

const PAPER_SIZES: readonly OptionChoice[] = [
  { value: "", label: "Printer default" },
  { value: "Letter", label: "Letter (8.5 × 11 in)" },
  { value: "Legal", label: "Legal (8.5 × 14 in)" },
  { value: "A4", label: "A4" },
];

const DUPLEX: readonly OptionChoice[] = [
  { value: "", label: "Printer default" },
  { value: "one-sided", label: "Single-sided" },
  { value: "two-sided-long-edge", label: "Double-sided (flip on long edge)" },
  { value: "two-sided-short-edge", label: "Double-sided (flip on short edge)" },
];

const ORIENTATIONS: readonly OptionChoice[] = [
  { value: "", label: "Printer default" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

/** A labeled dropdown for one print option (paper size / sides / orientation).
 * The three CUPS-only option fields are the same field markup over different
 * choice lists, so they share this. */
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
  choices: readonly OptionChoice[];
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
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerName, setPrinterName] = useState("");
  const [pagesInput, setPagesInput] = useState("");
  const [copiesInput, setCopiesInput] = useState("1");
  const [paperSize, setPaperSize] = useState("");
  const [duplex, setDuplex] = useState("");
  const [orientation, setOrientation] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // Paper size / duplex / orientation reach the printer through CUPS `lp` on
  // macOS; the Windows Ghostscript path doesn't consume them yet, so the
  // controls only appear where they actually take effect.
  const supportsOptions = runtimePlatform() === "macos";

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
        setPrinterName(sorted[0]?.name ?? "");
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setUnavailableReason(pathOpErrorMessage(error, "Printers could not be listed."));
        setPhase("unavailable");
      });

    return () => {
      disposed = true;
    };
  }, []);

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

    const options: PrintOptions = supportsOptions
      ? {
          ...(paperSize ? { media: paperSize } : {}),
          ...(duplex ? { sides: duplex } : {}),
          ...(orientation ? { orientation } : {}),
        }
      : {};

    onStartPrint({
      printer: printerName,
      pageIndexes: selection.pageIndexes,
      copies,
      options,
    });
    onClose();
  }, [
    copiesInput,
    duplex,
    onClose,
    onStartPrint,
    orientation,
    pageCount,
    pagesInput,
    paperSize,
    printerName,
    supportsOptions,
  ]);

  return (
    <FloatingDialog title="Print" eyebrow={fileName ?? undefined} onClose={onClose}>
      <div className="tool-panel__inline-card">
        {phase === "probing" ? (
          <p className="tool-panel__note" role="status">
            Checking printers...
          </p>
        ) : null}

        {phase === "unavailable" ? (
          <>
            <p className="tool-panel__note">{unavailableReason}</p>
            <p className="tool-panel__note">
              A page range can still be extracted and printed as a small
              document instead.
            </p>
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
              onClick={onClose}
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
                onChange={(event) => setPrinterName(event.target.value)}
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
            {supportsOptions ? (
              <>
                <OptionSelect
                  id="print-dialog-paper"
                  label="Paper size"
                  value={paperSize}
                  choices={PAPER_SIZES}
                  onChange={setPaperSize}
                />
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
              onClick={onClose}
            >
              Cancel
            </button>
          </form>
        ) : null}
      </div>
    </FloatingDialog>
  );
}
