import { getWordCapability, type WordCapability } from "./wordCapability";
import {
  pickPdfForWord,
  saveDocxGrant,
  type FileGrant,
  type PickedPdfForWord,
  type SavedFile,
} from "./filePort";
import {
  invokePathOp,
  pathOpErrorMessage,
  type PathOpReport,
} from "./pathOps";

export const WORD_REFLOW_EXPERIMENTAL_LABEL =
  "Experimental — formatting may be approximate.";

export type WordReflowStatusTone = "neutral" | "ok" | "danger";

export interface WordReflowStatus {
  running: boolean;
  message: string | null;
  tone: WordReflowStatusTone;
}

export interface WordReflowInput {
  grant: FileGrant;
  name: string;
}

export interface WordReflowOutput {
  outputGrant: FileGrant;
  name: string;
  sizeBytes: number;
  opReport: PathOpReport;
}

export type ScannedPdfChoice = "ocrFirst" | "convertAnyway";

export type WordReflowResult =
  | { status: "saved"; saved: SavedFile; output: WordReflowOutput; ocrFirst: boolean }
  | { status: "cancelled" }
  | { status: "refused"; reason: "word-unavailable"; message: string; capability: WordCapability }
  | { status: "failed"; message: string };

export interface RunWordReflowOptions {
  getInput: () => Promise<WordReflowInput | null>;
  getTextLayer: (input: WordReflowInput) => Promise<boolean | null>;
  onStatus?: (status: WordReflowStatus) => void;
  onWordUnavailable?: (message: string, capability: WordCapability) => void;
  suggestedName?: (input: WordReflowInput, output: WordReflowOutput) => string;
}

export interface WordReflowDeps {
  getCapability: (force: boolean) => Promise<WordCapability>;
  promptScannedPdf: () => Promise<ScannedPdfChoice>;
  reflowPdfToDocx: (grant: FileGrant, ocrFirst: boolean) => Promise<WordReflowOutput>;
  saveDocx: (sourceGrant: FileGrant, suggestedName: string) => Promise<SavedFile | null>;
  showWordUnavailable: (message: string, capability: WordCapability) => void;
}

export function shouldRefuseWordReflow(capability: WordCapability): boolean {
  return capability.state !== "available";
}

export function wordReflowUnavailableMessage(capability: WordCapability): string {
  if (capability.state === "notApplicable") {
    return "Word integration is not available on this computer. PDF was not converted to Word.";
  }

  if (capability.reason) {
    return `Word integration not available: ${capability.reason}`;
  }

  return "Word integration not available. PDF was not converted to Word.";
}

export function resolveWordReflowOcrFirst(
  hasTextLayer: boolean | null,
  scannedChoice: ScannedPdfChoice | null,
): boolean {
  if (hasTextLayer !== false) {
    return false;
  }

  return scannedChoice !== "convertAnyway";
}

export async function runPdfToWordReflow(
  options: RunWordReflowOptions,
  deps: WordReflowDeps = defaultWordReflowDeps,
): Promise<WordReflowResult> {
  const setStatus = options.onStatus ?? (() => undefined);

  try {
    setStatus({
      running: true,
      tone: "neutral",
      message: `Checking Word integration. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });

    const input = await options.getInput();
    if (!input) {
      setStatus({ running: false, tone: "neutral", message: null });
      return { status: "cancelled" };
    }

    const capability = await deps.getCapability(true);
    if (shouldRefuseWordReflow(capability)) {
      const message = wordReflowUnavailableMessage(capability);
      options.onWordUnavailable?.(message, capability);
      deps.showWordUnavailable(message, capability);
      setStatus({ running: false, tone: "danger", message });
      return { status: "refused", reason: "word-unavailable", message, capability };
    }

    setStatus({
      running: true,
      tone: "neutral",
      message: `Checking whether the PDF is scanned. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    const hasTextLayer = await options.getTextLayer(input);
    const scannedChoice = hasTextLayer === false ? await deps.promptScannedPdf() : null;
    const ocrFirst = resolveWordReflowOcrFirst(hasTextLayer, scannedChoice);

    setStatus({
      running: true,
      tone: "neutral",
      message: ocrFirst
        ? `Running OCR, then converting to editable Word. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`
        : `Converting to editable Word. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    const output = await deps.reflowPdfToDocx(input.grant, ocrFirst);
    const suggestedName = options.suggestedName?.(input, output) ?? output.name;

    setStatus({
      running: true,
      tone: "neutral",
      message: `Choose where to save the Word document. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    const saved = await deps.saveDocx(output.outputGrant, suggestedName);
    if (!saved) {
      setStatus({
        running: false,
        tone: "neutral",
        message: "Word conversion finished, but Save As was cancelled.",
      });
      return { status: "cancelled" };
    }

    setStatus({
      running: false,
      tone: "ok",
      message: `Saved ${saved.name}. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    return { status: "saved", saved, output, ocrFirst };
  } catch (error: unknown) {
    const message = pathOpErrorMessage(error, "This PDF could not be converted to editable Word.");
    setStatus({
      running: false,
      tone: "danger",
      message: `${message} ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    return { status: "failed", message };
  }
}

export async function pickStandalonePdfForWord(): Promise<PickedPdfForWord | null> {
  return pickPdfForWord();
}

export async function pdfGrantHasTextLayer(grant: FileGrant): Promise<boolean> {
  const response = await invokePathOp<{ hasTextLayer: boolean }>("word_pdf_has_text_layer", {
    grant,
  });
  return response.hasTextLayer;
}

async function reflowPdfToDocx(
  grant: FileGrant,
  ocrFirst: boolean,
): Promise<WordReflowOutput> {
  return invokePathOp<WordReflowOutput>("word_reflow_pdf_to_docx", {
    grant,
    ocrFirst,
  });
}

const defaultWordReflowDeps: WordReflowDeps = {
  getCapability: getWordCapability,
  promptScannedPdf: promptScannedPdfOcr,
  reflowPdfToDocx,
  saveDocx: saveDocxGrant,
  showWordUnavailable: showWordUnavailableExplainer,
};

export function promptScannedPdfOcr(): Promise<ScannedPdfChoice> {
  if (typeof document === "undefined") {
    return Promise.resolve("ocrFirst");
  }

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "word-reflow-gate";
    host.innerHTML = `
      <div class="word-reflow-gate__panel" role="dialog" aria-modal="true" aria-labelledby="word-reflow-gate-title">
        <h2 id="word-reflow-gate-title">This PDF looks scanned.</h2>
        <p>Run OCR first so the Word document is editable?</p>
        <div class="word-reflow-gate__actions">
          <button type="button" data-action="ocr">OCR &amp; convert <span class="word-reflow-gate__recommended">(recommended)</span></button>
          <button type="button" data-action="convert">Convert anyway</button>
        </div>
      </div>
    `;
    ensureWordReflowGateStyles();
    document.body.append(host);
    const ocrButton = host.querySelector<HTMLButtonElement>("[data-action='ocr']");
    const convertButton = host.querySelector<HTMLButtonElement>("[data-action='convert']");
    ocrButton?.focus();
    ocrButton?.addEventListener("click", () => {
      host.remove();
      resolve("ocrFirst");
    }, { once: true });
    convertButton?.addEventListener("click", () => {
      host.remove();
      resolve("convertAnyway");
    }, { once: true });
  });
}

function showWordUnavailableExplainer(message: string) {
  if (typeof document === "undefined") {
    return;
  }

  const host = document.createElement("div");
  host.className = "word-reflow-gate";
  host.innerHTML = `
    <div class="word-reflow-gate__panel" role="dialog" aria-modal="true" aria-labelledby="word-reflow-word-unavailable-title">
      <h2 id="word-reflow-word-unavailable-title">Word integration is not available</h2>
      <p>${escapeHtml(message)}</p>
      <div class="word-reflow-gate__actions">
        <button type="button" data-action="close">OK</button>
      </div>
    </div>
  `;
  ensureWordReflowGateStyles();
  document.body.append(host);
  const button = host.querySelector<HTMLButtonElement>("[data-action='close']");
  button?.focus();
  button?.addEventListener("click", () => host.remove(), { once: true });
}

function ensureWordReflowGateStyles() {
  if (document.getElementById("word-reflow-gate-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "word-reflow-gate-styles";
  style.textContent = `
    .word-reflow-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(15,23,42,.28)}
    .word-reflow-gate__panel{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #d8dee8;border-radius:8px;box-shadow:0 18px 60px rgba(15,23,42,.22);padding:18px;color:#172033;font:14px system-ui,sans-serif}
    .word-reflow-gate__panel h2{font-size:16px;line-height:1.35;margin:0 0 10px}
    .word-reflow-gate__panel p{margin:8px 0;color:#4a5568}
    .word-reflow-gate__actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    .word-reflow-gate__actions button{border:1px solid #d8dee8;border-radius:6px;background:#fff;color:#172033;padding:8px 12px;font-weight:600}
    .word-reflow-gate__actions button:first-child{border-color:#172033;background:#172033;color:#fff}
    .word-reflow-gate__recommended{font-weight:500}
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
