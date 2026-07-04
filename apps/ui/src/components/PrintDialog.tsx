import { useCallback, useEffect, useRef, useState } from "react";
import { PathOpsError, pathOpErrorMessage, type PathOpsFileGrant } from "../lib/pathOps";
import {
  cancelPrint,
  describePrintProgress,
  listenPrintProgress,
  listPrinters,
  newPrintJobToken,
  parseCopies,
  parsePrintSelection,
  printPdf,
  printStatus,
  sortPrintersForPicker,
  type PrinterInfo,
  type PrintResult,
} from "../lib/printPipeline";
import { FloatingDialog } from "./FloatingDialog";

/**
 * RaioPDF's own print dialog for streamed (large) documents — the native
 * pipeline prints any-size PDFs without the WebView ever holding the bytes,
 * so whole-document printing is un-gated here. Small documents keep the
 * untouched `window.print()` path; this dialog exists exactly where that
 * path cannot go.
 */
export function PrintDialog({
  grant,
  pageCount,
  fileName,
  onClose,
  onUseRangeFallback,
}: {
  grant: PathOpsFileGrant;
  pageCount: number;
  fileName: string | null;
  onClose: () => void;
  onUseRangeFallback: () => void;
}) {
  const [phase, setPhase] = useState<
    "probing" | "unavailable" | "ready" | "printing" | "done"
  >("probing");
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [printerName, setPrinterName] = useState("");
  const [pagesInput, setPagesInput] = useState("");
  const [copiesInput, setCopiesInput] = useState("1");
  const [message, setMessage] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [result, setResult] = useState<PrintResult | null>(null);

  const disposedRef = useRef(false);
  const runningJobRef = useRef<{ token: string; unlisten: (() => void) | null } | null>(
    null,
  );

  useEffect(() => {
    disposedRef.current = false;

    void Promise.all([printStatus(), listPrinters()])
      .then(([status, printerList]) => {
        if (disposedRef.current) {
          return;
        }
        if (!status.available) {
          setUnavailableReason(
            !status.platformSupported
              ? "Native printing isn't available on this platform yet."
              : "Native printing needs the bundled Ghostscript, which wasn't found.",
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
        if (disposedRef.current) {
          return;
        }
        setUnavailableReason(
          pathOpErrorMessage(error, "Printers could not be listed."),
        );
        setPhase("unavailable");
      });

    return () => {
      disposedRef.current = true;
      // Closing the dialog mid-job cancels it — no orphaned print jobs.
      const running = runningJobRef.current;
      if (running) {
        running.unlisten?.();
        void cancelPrint(running.token).catch(() => undefined);
        runningJobRef.current = null;
      }
    };
  }, []);

  const submit = useCallback(async () => {
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

    setMessage(null);
    setProgressText("Starting print job...");
    setPhase("printing");

    const token = newPrintJobToken();
    let unlisten: (() => void) | null = null;
    runningJobRef.current = { token, unlisten: null };
    try {
      unlisten = await listenPrintProgress(token, (event) => {
        if (!disposedRef.current) {
          setProgressText(describePrintProgress(event));
        }
      });
      if (runningJobRef.current?.token === token) {
        runningJobRef.current.unlisten = unlisten;
      }

      const printResult = await printPdf(
        grant,
        token,
        printerName,
        selection.pageIndexes,
        copies,
      );
      if (disposedRef.current) {
        return;
      }
      setResult(printResult);
      setPhase("done");
    } catch (error) {
      if (disposedRef.current) {
        return;
      }
      if (error instanceof PathOpsError && error.code === "PRINT_CANCELLED") {
        setMessage("Printing was cancelled.");
      } else if (
        error instanceof PathOpsError &&
        (error.code === "PRINT_NOT_SUPPORTED" ||
          error.code === "PRINT_FALLBACK_SELF_HANDLER")
      ) {
        setMessage(error.message);
      } else {
        setMessage(
          pathOpErrorMessage(error, "The document could not be printed."),
        );
      }
      setPhase("ready");
    } finally {
      unlisten?.();
      if (runningJobRef.current?.token === token) {
        runningJobRef.current = null;
      }
      if (!disposedRef.current) {
        setProgressText(null);
      }
    }
  }, [copiesInput, grant, pageCount, pagesInput, printerName]);

  const cancelRunning = useCallback(() => {
    const running = runningJobRef.current;
    if (running) {
      setProgressText("Cancelling after the current part...");
      void cancelPrint(running.token).catch(() => undefined);
    }
  }, []);

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

        {phase === "ready" || phase === "printing" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="tool-panel__note">
              Prints directly from disk — the whole document is available, no
              matter its size.
            </p>
            <div className="tool-panel__field">
              <label htmlFor="print-dialog-printer">Printer</label>
              <select
                id="print-dialog-printer"
                value={printerName}
                disabled={phase === "printing"}
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
                disabled={phase === "printing"}
                onChange={(event) => setPagesInput(event.target.value)}
              />
            </div>
            <div className="tool-panel__field">
              <label htmlFor="print-dialog-copies">Copies</label>
              <input
                id="print-dialog-copies"
                inputMode="numeric"
                value={copiesInput}
                disabled={phase === "printing"}
                onChange={(event) => setCopiesInput(event.target.value)}
              />
            </div>
            {message ? (
              <p className="tool-panel__status-line" role="status">
                {message}
              </p>
            ) : null}
            {phase === "printing" ? (
              <>
                <p className="tool-panel__status-line" role="status">
                  {progressText ?? "Printing..."}
                </p>
                <button
                  type="button"
                  className="tool-panel__secondary-button"
                  onClick={cancelRunning}
                >
                  Cancel Printing
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
          </form>
        ) : null}

        {phase === "done" && result ? (
          <>
            <p className="tool-panel__status-line" role="status">
              {result.method === "ghostscript"
                ? `Sent to ${printerName}.`
                : `Sent to ${printerName} in ${result.fallbackParts} part${
                    result.fallbackParts === 1 ? "" : "s"
                  } via the system print pipeline.`}
            </p>
            {result.inputChanged ? (
              <p className="tool-panel__note">
                Heads up: the file changed on disk while printing ran — the
                printed pages may mix revisions. Reopen the file to see its
                current state.
              </p>
            ) : null}
            <button
              type="button"
              className="tool-panel__primary-button"
              onClick={onClose}
            >
              Close
            </button>
          </>
        ) : null}
      </div>
    </FloatingDialog>
  );
}
