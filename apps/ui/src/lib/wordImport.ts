import {
  getWordCapability,
  shouldRefuseWord,
  wordOperationGuidance,
  wordUnavailableMessage,
  type WordCapability,
} from "./wordCapability";
import { pickDocxForImport, type FileGrant, type PickedDocxForImport } from "./filePort";
import {
  buildDocxMarkupGate,
  promptDocxMarkupMode,
  type DocxMarkupMode,
} from "./readFileForAdd";
import { invokePathOp, pathOpErrorMessage } from "./pathOps";
import { WORD_REFLOW_EXPERIMENTAL_LABEL, type WordReflowStatus } from "./wordReflow";

/**
 * Import a Word (.docx) document as a PDF: convert it through the user's
 * installed Microsoft Word and hand the resulting PDF back for the caller to
 * open as a new (derived, unsaved) document. Mirrors `runPdfToWordReflow` — the
 * caller owns the actual open (React state), this owns the capability gate,
 * pick, tracked-changes gate, and conversion.
 */

export interface WordImportOutput {
  outputGrant: FileGrant;
  name: string;
  sizeBytes: number;
}

export type WordImportResult =
  | { status: "converted"; output: WordImportOutput; sourceName: string }
  | { status: "cancelled" }
  | { status: "unavailable"; message: string; capability: WordCapability }
  | { status: "failed"; message: string };

export interface RunWordImportOptions {
  onStatus?: (status: WordReflowStatus) => void;
}

export interface WordImportDeps {
  getCapability: (force: boolean) => Promise<WordCapability>;
  pickDocx: () => Promise<PickedDocxForImport | null>;
  chooseMarkup: (files: readonly PickedDocxForImport[]) => Promise<DocxMarkupMode>;
  convert: (grant: FileGrant, markup: DocxMarkupMode) => Promise<WordImportOutput>;
}

export async function runWordDocumentImport(
  options: RunWordImportOptions = {},
  deps: WordImportDeps = defaultWordImportDeps,
): Promise<WordImportResult> {
  const setStatus = options.onStatus ?? (() => undefined);

  try {
    setStatus({
      running: true,
      tone: "neutral",
      message: `Checking Word integration. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });

    const capability = await deps.getCapability(true);
    if (shouldRefuseWord(capability)) {
      const message = `${wordUnavailableMessage(capability)} The Word document was not imported.`;
      setStatus({ running: false, tone: "danger", message });
      return { status: "unavailable", message, capability };
    }

    const picked = await deps.pickDocx();
    if (!picked) {
      setStatus({ running: false, tone: "neutral", message: null });
      return { status: "cancelled" };
    }

    // Reuse the docx add-flow's tracked-changes gate: prompt final-vs-show-markup
    // only when the document actually carries revisions/comments.
    const markup = await deps.chooseMarkup([picked]);

    setStatus({
      running: true,
      tone: "neutral",
      message: `Converting ${picked.name} with Microsoft Word. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    const output = await deps.convert(picked.grant, markup);

    setStatus({
      running: true,
      tone: "neutral",
      message: `Opening ${picked.name}. ${WORD_REFLOW_EXPERIMENTAL_LABEL}`,
    });
    return { status: "converted", output, sourceName: picked.name };
  } catch (error: unknown) {
    const message = wordOperationGuidance(error)
      ?? pathOpErrorMessage(error, "This Word document could not be imported.");
    setStatus({ running: false, tone: "danger", message: `${message} ${WORD_REFLOW_EXPERIMENTAL_LABEL}` });
    return { status: "failed", message };
  }
}

export async function chooseImportMarkupMode(
  files: readonly PickedDocxForImport[],
): Promise<DocxMarkupMode> {
  const gate = buildDocxMarkupGate(
    files.map((file) => ({
      grant: file.grant,
      name: file.name,
      sizeBytes: file.sizeBytes,
      source: "docx" as const,
      markupScan: file.markupScan,
    })),
  );

  return gate ? promptDocxMarkupMode(gate) : "final";
}

async function convertDocxToPdf(
  grant: FileGrant,
  markup: DocxMarkupMode,
): Promise<WordImportOutput> {
  return invokePathOp<WordImportOutput>("word_convert_docx", { grant, markup });
}

const defaultWordImportDeps: WordImportDeps = {
  getCapability: getWordCapability,
  pickDocx: pickDocxForImport,
  chooseMarkup: chooseImportMarkupMode,
  convert: convertDocxToPdf,
};
