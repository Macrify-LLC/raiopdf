import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { PdfBinderOptions, PdfCoverStyle } from "@raiopdf/engine-api";
import { PDFDocument } from "pdf-lib";
import type { BinderExhibitInput, DocumentState } from "../hooks/useDocument";
import type { FileGrant } from "../lib/filePort";
import type { PDFDocumentProxy } from "../lib/pdfjs";
import {
  pickPdfsForAdd,
  readFileForAdd,
  tooLargeToAddMessage,
  type DocxConversionProgressRow,
  type FileAddInput,
  type PickPdfsForAddOptions,
} from "../lib/readFileForAdd";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CombineExhibitsIcon,
  DeleteIcon,
  DragHandleIcon,
  HelpIcon,
  OpenIcon,
  PlusIcon,
  SaveIcon,
  SlipSheetIcon,
} from "../icons";
import { PdfMiniThumb } from "./PdfMiniThumb";
import { IconButton } from "./IconButton";
import { CoverStylePicker } from "./CoverStylePicker";
import { ExperimentalFeatureLock } from "./ExperimentalFeatureLock";
import { LongProcessLoader } from "./LongProcessLoader";
import "./BinderWorkspace.css";

type IdentifierStyle = "letters" | "numbers";
type PlacementEdge = "header" | "footer";
type PlacementAlign = "left" | "center" | "right";
type StampPages = "first" | "all";

const ADD_FILE_ACCEPT = "application/pdf,.pdf";

interface BinderPresetV1 {
  version: 1;
  identifierStyle: IdentifierStyle;
  prefix: string;
  placementEdge: PlacementEdge;
  placementAlign: PlacementAlign;
  stampPages: StampPages;
  slipSheets: boolean;
  coverStyle?: PdfCoverStyle | undefined;
  indexEnabled: boolean;
  indexIncludeSourceFileName: boolean;
}

interface ExhibitFileBase {
  id: string;
  name: string;
  description: string;
  pageCount: number | null;
}

export type ExhibitFile =
  | (ExhibitFileBase & {
    kind: "bytes";
    bytes: Uint8Array;
  })
  | (ExhibitFileBase & {
    kind: "grant";
    grant: FileGrant;
    sizeBytes: number;
  });

export interface BinderWorkspaceProps {
  document: DocumentState;
  pdfDocument?: PDFDocumentProxy | null | undefined;
  onBuildBinder: (
    exhibits: readonly BinderExhibitInput[],
    options: PdfBinderOptions,
    fileName: string,
  ) => Promise<boolean>;
  onOpenRequested: () => void;
  onCancel: () => void;
  onHelpRequested?: (() => void) | undefined;
  defaultCoverStyle?: PdfCoverStyle | undefined;
  onCaptionRequested?: (() => void) | undefined;
  experimentalFeaturesEnabled?: boolean;
}

export function BinderWorkspace({
  document,
  pdfDocument = null,
  onBuildBinder,
  onOpenRequested,
  onCancel,
  onHelpRequested,
  defaultCoverStyle,
  onCaptionRequested,
  experimentalFeaturesEnabled = false,
}: BinderWorkspaceProps) {
  const addInputRef = useRef<HTMLInputElement>(null);
  const [exhibits, setExhibits] = useState<ExhibitFile[]>([]);
  const initialPreset = useMemo(loadBinderPreset, []);
  const [identifierStyle, setIdentifierStyle] = useState<IdentifierStyle>(
    initialPreset.identifierStyle,
  );
  const [prefix, setPrefix] = useState(initialPreset.prefix);
  const [placementEdge, setPlacementEdge] = useState<PlacementEdge>(initialPreset.placementEdge);
  const [placementAlign, setPlacementAlign] = useState<PlacementAlign>(
    initialPreset.placementAlign,
  );
  const [stampPages, setStampPages] = useState<StampPages>(initialPreset.stampPages);
  const [slipSheets, setSlipSheets] = useState(initialPreset.slipSheets);
  const [coverStyle, setCoverStyle] = useState<PdfCoverStyle>(
    initialPreset.coverStyle ?? defaultCoverStyle ?? "minimal",
  );
  const [indexEnabled, setIndexEnabled] = useState(initialPreset.indexEnabled);
  const [indexIncludeSourceFileName, setIndexIncludeSourceFileName] = useState(
    initialPreset.indexIncludeSourceFileName,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [docxRows, setDocxRows] = useState<readonly DocxConversionProgressRow[]>([]);
  const [building, setBuilding] = useState(false);
  const mainName = document.fileName ?? "Untitled.pdf";
  const mainPages = document.pageCount;
  const hasMainDocument = document.source !== null;
  const allowGrantExhibits = document.source?.kind === "rangeGrant";
  const labels = useMemo(
    () => exhibits.map((_, index) => formatExhibitLabel(prefix, identifierStyle, index)),
    [exhibits, identifierStyle, prefix],
  );
  const totalPagesExact = exhibits.every((exhibit) => exhibit.pageCount !== null);
  const totalPages = mainPages + (indexEnabled ? 1 : 0) + exhibits.reduce(
    (total, exhibit) => total + (exhibit.pageCount ?? 0) + (slipSheets ? 1 : 0),
    0,
  );
  const totalPagesLabel = totalPagesExact
    ? `${totalPages} ${totalPages === 1 ? "page" : "pages"}`
    : `${totalPages}+ pages`;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  async function addExhibitInputs(inputs: readonly FileAddInput[]) {
    if (inputs.length === 0 || building) {
      return;
    }

    setStatus("Reading exhibit files...");

    try {
      const outcomes = await Promise.all(inputs.map((input) => readExhibitFile(input, allowGrantExhibits)));
      const added = outcomes.flatMap((outcome) => (outcome.status === "ok" ? [outcome.exhibit] : []));
      const rejected = outcomes.flatMap((outcome) => (outcome.status === "tooLarge" ? [outcome.name] : []));

      if (added.length > 0) {
        setExhibits((current) => [...current, ...added]);
      }

      setStatus(
        rejected.length === 0
          ? null
          : rejected.length === 1 && rejected[0] !== undefined
            ? tooLargeToAddMessage(rejected[0])
            : `${rejected.length} exhibit PDFs are too large to add here.`,
      );
    } catch {
      setStatus("One of the exhibit PDFs could not be opened. Check the file and try again.");
    }
  }

  async function handleAddFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    await addExhibitInputs(files);
  }

  async function addExhibits() {
    // Tauri: grant-returning picker (no eager byte read); browser or a shell
    // without pick_pdfs_for_add falls back to the DOM file input.
    setDocxRows([]);
    const picks = await pickPdfsForAdd(docxAddOptions(setStatus, setDocxRows));

    if (picks === null) {
      addInputRef.current?.click();
      return;
    }

    await addExhibitInputs(picks);
  }

  function moveExhibit(index: number, direction: -1 | 1) {
    setExhibits((current) => {
      const targetIndex = index + direction;

      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(index, 1);

      if (!moved) {
        return current;
      }

      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function removeExhibit(id: string) {
    setExhibits((current) => current.filter((exhibit) => exhibit.id !== id));
  }

  function updateExhibitDescription(id: string, description: string) {
    setExhibits((current) =>
      current.map((exhibit) => exhibit.id === id ? { ...exhibit, description } : exhibit),
    );
  }

  function currentPreset(): BinderPresetV1 {
    return {
      version: 1,
      identifierStyle,
      prefix,
      placementEdge,
      placementAlign,
      stampPages,
      slipSheets,
      coverStyle,
      indexEnabled,
      indexIncludeSourceFileName,
    };
  }

  function applyPreset(preset: BinderPresetV1) {
    setIdentifierStyle(preset.identifierStyle);
    setPrefix(preset.prefix);
    setPlacementEdge(preset.placementEdge);
    setPlacementAlign(preset.placementAlign);
    setStampPages(preset.stampPages);
    setSlipSheets(preset.slipSheets);
    setCoverStyle(preset.coverStyle ?? defaultCoverStyle ?? "minimal");
    setIndexEnabled(preset.indexEnabled);
    setIndexIncludeSourceFileName(preset.indexIncludeSourceFileName);
  }

  function savePreset() {
    if (persistBinderPreset(currentPreset())) {
      setStatus("Binder preset saved.");
    } else {
      setStatus("Binder preset could not be saved.");
    }
  }

  function applySavedPreset() {
    applyPreset(loadBinderPreset());
    setStatus("Binder preset applied.");
  }

  async function buildBinder() {
    if (!hasMainDocument || exhibits.length === 0 || building) {
      return;
    }

    setBuilding(true);
    setStatus("Building binder...");

    try {
      const built = await onBuildBinder(
        exhibits.map((exhibit, index) => ({
          ...(exhibit.kind === "bytes"
            ? { kind: "bytes" as const, bytes: exhibit.bytes }
            : {
              kind: "grant" as const,
              grant: exhibit.grant,
              sizeBytes: exhibit.sizeBytes,
              pageCount: exhibit.pageCount,
            }),
          label: labels[index]!,
          description: exhibit.description,
          sourceFileName: exhibit.name,
        })),
        {
          slipSheets,
          coverStyle,
          index: {
            enabled: indexEnabled,
            includeSourceFileName: indexIncludeSourceFileName,
          },
          placement: {
            edge: placementEdge,
            align: placementAlign,
          },
          stampPages: stampPages === "first" ? "first" : "all",
          fontSizePt: 11,
          marginIn: 0.5,
        },
        `${stripPdfExtension(mainName)} Binder.pdf`,
      );

      if (built) {
        setStatus("Binder built. The bookmarks panel will show each exhibit.");
        onCancel();
      } else {
        setStatus("The binder could not be built. Check the exhibit files and try again.");
      }
    } catch {
      setStatus("The binder could not be built. Check the exhibit files and try again.");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <section className="binder-workspace" aria-label="Combine with Exhibits workspace">
      <header className="binder-workspace__header">
        <div>
          <p className="binder-workspace__eyebrow">Legal</p>
          <h2>Combine with Exhibits</h2>
        </div>
        <div className="binder-workspace__header-actions">
          {onHelpRequested ? (
            <IconButton
              icon={<HelpIcon size={14} />}
              label="Help: Combine with Exhibits"
              onClick={onHelpRequested}
            />
          ) : null}
          <button type="button" className="binder-workspace__ghost" onClick={onCancel}>
            Back to document
          </button>
        </div>
      </header>

      <div className="binder-workspace__grid">
        <section className="binder-card" aria-label="Main document">
          <p className="binder-card__label">Main document</p>
          <div className="binder-main">
            <PdfMiniThumb
              bytes={document.bytes}
              pdfDocument={pdfDocument}
              label={`${mainName} thumbnail`}
            />
            <div>
              <p className="binder-main__name">{mainName}</p>
              <p className="binder-main__meta">{mainPages} {mainPages === 1 ? "page" : "pages"}</p>
            </div>
          </div>
          <button
            type="button"
            className="binder-workspace__secondary"
            onClick={onOpenRequested}
            disabled={building}
            title="Replace the main document that appears before the exhibits."
          >
            <OpenIcon size={15} />
            Replace via Open
          </button>
        </section>

        <section className="binder-card binder-card--list" aria-label="Exhibits list">
          <div className="binder-card__title-row">
            <p className="binder-card__label">Exhibits</p>
            <span>{exhibits.length}</span>
          </div>

          <div className="binder-exhibits" role="list">
            {exhibits.length === 0 ? (
              <p className="binder-exhibits__empty">Add exhibit PDFs to build the ordered binder.</p>
            ) : null}

            {exhibits.map((exhibit, index) => (
              <article className="binder-exhibit" key={exhibit.id} role="listitem">
                <span className="binder-exhibit__handle" aria-hidden="true">
                  <DragHandleIcon size={16} />
                </span>
                <PdfMiniThumb
                  bytes={exhibit.kind === "bytes" ? exhibit.bytes : null}
                  label={`${exhibit.name} thumbnail`}
                />
                <div className="binder-exhibit__body">
                  <p className="binder-exhibit__name">{exhibit.name}</p>
                  <p className="binder-exhibit__meta">{formatExhibitPageCount(exhibit.pageCount)}</p>
                  <span className="binder-exhibit__chip">{labels[index]}</span>
                  <label className="binder-exhibit__description">
                    <span>Description</span>
                    <input
                      value={exhibit.description}
                      onChange={(event) =>
                        updateExhibitDescription(exhibit.id, event.currentTarget.value)}
                      disabled={building}
                    />
                  </label>
                </div>
                <div className="binder-exhibit__actions">
                  <button
                    type="button"
                    aria-label={`Move ${exhibit.name} up`}
                    onClick={() => moveExhibit(index, -1)}
                    disabled={building || index === 0}
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${exhibit.name} down`}
                    onClick={() => moveExhibit(index, 1)}
                    disabled={building || index === exhibits.length - 1}
                  >
                    <ArrowDownIcon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${exhibit.name}`}
                    onClick={() => removeExhibit(exhibit.id)}
                    disabled={building}
                  >
                    <DeleteIcon size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <input
            ref={addInputRef}
            className="binder-workspace__file-input"
            type="file"
            accept={ADD_FILE_ACCEPT}
            multiple
            aria-label="Add exhibits"
            onChange={handleAddFiles}
            disabled={building}
          />
          <button
            type="button"
            className="binder-workspace__secondary binder-workspace__add"
            onClick={() => void addExhibits()}
            disabled={building}
            title="Add one or more exhibit PDFs after the main document."
          >
            <PlusIcon size={15} />
            Add exhibits...
          </button>
          {onCaptionRequested ? (
            <div className="experimental-feature-lock">
              <button
                type="button"
                className={`binder-workspace__secondary binder-workspace__add${experimentalFeaturesEnabled ? "" : " binder-workspace__experimental-locked"}`}
                onClick={onCaptionRequested}
                disabled={building}
                title={experimentalFeaturesEnabled ? "Create a caption or cover page before assembling the binder." : undefined}
                aria-describedby={experimentalFeaturesEnabled ? undefined : "binder-caption-experimental-description"}
                aria-disabled={!experimentalFeaturesEnabled || undefined}
              >
                <SlipSheetIcon size={15} />
                Add caption / cover page
                <span className="binder-workspace__experimental-badge">Experimental</span>
              </button>
              {!experimentalFeaturesEnabled ? (
                <ExperimentalFeatureLock
                  descriptionId="binder-caption-experimental-description"
                />
              ) : null}
            </div>
          ) : null}
          <DocxConversionRows rows={docxRows} />
        </section>

        <section className="binder-card binder-card--settings" aria-label="Binder settings">
          <p className="binder-card__label">Settings</p>
          <fieldset className="binder-fieldset" title="Choose whether exhibits are labeled A, B, C or 1, 2, 3.">
            <legend>Identifier style</legend>
            <label><input type="radio" name="identifier" checked={identifierStyle === "letters"} onChange={() => setIdentifierStyle("letters")} disabled={building} /> Letters</label>
            <label><input type="radio" name="identifier" checked={identifierStyle === "numbers"} onChange={() => setIdentifierStyle("numbers")} disabled={building} /> Numbers</label>
          </fieldset>

          <label className="binder-field" title="Text before each exhibit identifier, for example Exhibit A.">
            <span>Prefix</span>
            <input value={prefix} placeholder="Plaintiff's Exhibit" onChange={(event) => setPrefix(event.currentTarget.value)} disabled={building} />
          </label>

          <fieldset className="binder-fieldset" title="Choose whether exhibit labels are stamped in the page header or footer.">
            <legend>Placement</legend>
            <label><input type="radio" name="placement-edge" checked={placementEdge === "header"} onChange={() => setPlacementEdge("header")} disabled={building} /> Header</label>
            <label><input type="radio" name="placement-edge" checked={placementEdge === "footer"} onChange={() => setPlacementEdge("footer")} disabled={building} /> Footer</label>
          </fieldset>

          <fieldset className="binder-fieldset" title="Choose where the exhibit label sits across the page width.">
            <legend>Position</legend>
            <label><input type="radio" name="placement-align" checked={placementAlign === "left"} onChange={() => setPlacementAlign("left")} disabled={building} /> Left</label>
            <label><input type="radio" name="placement-align" checked={placementAlign === "center"} onChange={() => setPlacementAlign("center")} disabled={building} /> Center</label>
            <label><input type="radio" name="placement-align" checked={placementAlign === "right"} onChange={() => setPlacementAlign("right")} disabled={building} /> Right</label>
          </fieldset>

          <fieldset className="binder-fieldset" title="Choose whether exhibit labels appear on the first page of each exhibit or every exhibit page.">
            <legend>Stamp pages</legend>
            <label><input type="radio" name="stamp-pages" checked={stampPages === "first"} onChange={() => setStampPages("first")} disabled={building} /> First page only</label>
            <label><input type="radio" name="stamp-pages" checked={stampPages === "all"} onChange={() => setStampPages("all")} disabled={building} /> Every page</label>
          </fieldset>

          <label className="binder-toggle" title="Insert a separator page before each exhibit.">
            <input type="checkbox" checked={slipSheets} onChange={(event) => setSlipSheets(event.currentTarget.checked)} disabled={building} />
            <span><SlipSheetIcon size={15} /> Slip sheets</span>
          </label>
          {slipSheets ? (
            <div className="binder-cover-style">
              <p className="binder-card__label">Cover style</p>
              <CoverStylePicker
                value={coverStyle}
                onChange={setCoverStyle}
                sampleLabel={labels[0] ?? "Exhibit A"}
                sampleDescription={exhibits[0]?.description || "Deposition transcript of Jane Doe"}
                size="sm"
                disabled={building}
              />
            </div>
          ) : null}
          <label className="binder-toggle" title="Add a generated exhibit index near the front of the binder.">
            <input type="checkbox" checked={indexEnabled} onChange={(event) => setIndexEnabled(event.currentTarget.checked)} disabled={building} />
            <span>Exhibit Index</span>
          </label>
          <label className="binder-toggle" title="Include the original exhibit filename in the generated index.">
            <input
              type="checkbox"
              checked={indexIncludeSourceFileName}
              onChange={(event) => setIndexIncludeSourceFileName(event.currentTarget.checked)}
              disabled={building || !indexEnabled}
            />
            <span>Source filename column</span>
          </label>
          <div className="binder-preset-actions">
            <button type="button" className="binder-workspace__secondary" onClick={savePreset} disabled={building} title="Save these binder settings on this computer.">
              <SaveIcon size={15} />
              Save preset
            </button>
            <button type="button" className="binder-workspace__secondary" onClick={applySavedPreset} disabled={building} title="Restore the last saved binder settings.">
              <OpenIcon size={15} />
              Apply preset
            </button>
          </div>
          <p className="binder-card__hint">Each exhibit is bookmarked automatically.</p>
        </section>
      </div>

      {building ? (
        <section className="binder-workspace__process" aria-label="Binder build progress">
          <LongProcessLoader
            phaseLabel="Building binder"
            message={status ?? "Building binder..."}
            detail={`${stripPdfExtension(mainName)} + ${exhibits.length} ${
              exhibits.length === 1 ? "exhibit" : "exhibits"
            }`}
          />
        </section>
      ) : null}

      <footer className="binder-workspace__footer">
        <div className="binder-workspace__footer-summary">
          <p>
            {stripPdfExtension(mainName)} + {exhibits.length} {exhibits.length === 1 ? "exhibit" : "exhibits"} · {totalPagesLabel}
          </p>
          {status && !building ? (
            <p className="binder-workspace__status" role="status">
              {status}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="binder-workspace__primary"
          onClick={buildBinder}
          disabled={!hasMainDocument || exhibits.length === 0 || building}
        >
          <CombineExhibitsIcon size={16} />
          {building ? "Building Binder" : "Build Binder"}
        </button>
      </footer>
    </section>
  );
}

type ExhibitAddOutcome =
  | { status: "ok"; exhibit: ExhibitFile }
  | { status: "tooLarge"; name: string };

function DocxConversionRows({ rows }: { rows: readonly DocxConversionProgressRow[] }) {
  return rows.length > 0 ? (
    <div className="binder-exhibits" role="list" aria-label="Word conversion progress">
      {rows.map((row) => (
        <p key={row.id} className="binder-exhibits__empty" role="listitem">
          {row.name} · {row.message}
        </p>
      ))}
    </div>
  ) : null;
}

function docxAddOptions(
  setStatus: (message: string | null) => void,
  setRows: (rows: readonly DocxConversionProgressRow[]) => void,
): PickPdfsForAddOptions {
  return {
    onDocxRowsChange: setRows,
    onWordUnavailable: (message) => setStatus(message || "Word integration not available. Word documents were not added."),
    onDocxErrors: (errors) => {
      if (errors.length === 1 && errors[0]) {
        setStatus(`"${errors[0].name}" could not be converted from Word.`);
      } else if (errors.length > 1) {
        setStatus(`${errors.length} Word documents could not be converted.`);
      }
    },
  };
}

async function readExhibitFile(input: FileAddInput, allowGrantExhibits: boolean): Promise<ExhibitAddOutcome> {
  const result = await readFileForAdd(input);

  if (result.kind === "descriptor" && allowGrantExhibits) {
    return {
      status: "ok",
      exhibit: {
        id: `${result.descriptor.name}-${crypto.randomUUID()}`,
        name: result.descriptor.name,
        description: stripPdfExtension(result.descriptor.name),
        kind: "grant",
        grant: result.descriptor.grant as FileGrant,
        sizeBytes: result.descriptor.sizeBytes,
        pageCount: result.descriptor.pageCount,
      },
    };
  }

  if (result.kind !== "bytes") {
    return {
      status: "tooLarge",
      name: result.kind === "descriptor" ? result.descriptor.name : result.name,
    };
  }

  const opened = result.file;
  const pdf = await PDFDocument.load(opened.bytes);

  return {
    status: "ok",
    exhibit: {
      id: `${opened.name}-${crypto.randomUUID()}`,
      name: opened.name,
      description: stripPdfExtension(opened.name),
      kind: "bytes",
      bytes: opened.bytes,
      pageCount: pdf.getPageCount(),
    },
  };
}

function formatExhibitPageCount(pageCount: number | null): string {
  if (pageCount === null) {
    return "Page count pending";
  }

  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

const BINDER_PRESET_STORAGE_KEY = "raiopdf:binder-preset:v1";

function defaultBinderPreset(): BinderPresetV1 {
  return {
    version: 1,
    identifierStyle: "letters",
    prefix: "Exhibit",
    placementEdge: "footer",
    placementAlign: "center",
    stampPages: "first",
    slipSheets: false,
    indexEnabled: true,
    indexIncludeSourceFileName: false,
  };
}

function loadBinderPreset(): BinderPresetV1 {
  if (typeof window === "undefined") {
    return defaultBinderPreset();
  }

  try {
    const raw = window.localStorage.getItem(BINDER_PRESET_STORAGE_KEY);

    if (!raw) {
      return defaultBinderPreset();
    }

    const parsed: unknown = JSON.parse(raw);

    if (!isBinderPreset(parsed)) {
      return defaultBinderPreset();
    }

    return parsed;
  } catch {
    return defaultBinderPreset();
  }
}

function persistBinderPreset(preset: BinderPresetV1): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(BINDER_PRESET_STORAGE_KEY, JSON.stringify(preset));
    return true;
  } catch {
    return false;
  }
}

function isBinderPreset(value: unknown): value is BinderPresetV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const preset = value as BinderPresetV1;

  return preset.version === 1 &&
    (preset.identifierStyle === "letters" || preset.identifierStyle === "numbers") &&
    typeof preset.prefix === "string" &&
    (preset.placementEdge === "header" || preset.placementEdge === "footer") &&
    (
      preset.placementAlign === "left" ||
      preset.placementAlign === "center" ||
      preset.placementAlign === "right"
    ) &&
    (preset.stampPages === "first" || preset.stampPages === "all") &&
    typeof preset.slipSheets === "boolean" &&
    (
      preset.coverStyle === undefined ||
      preset.coverStyle === "minimal" ||
      preset.coverStyle === "labeled" ||
      preset.coverStyle === "bordered"
    ) &&
    typeof preset.indexEnabled === "boolean" &&
    typeof preset.indexIncludeSourceFileName === "boolean";
}

function formatExhibitLabel(
  prefix: string,
  identifierStyle: IdentifierStyle,
  index: number,
): string {
  const cleanPrefix = prefix.trim() || "Exhibit";
  const identifier = identifierStyle === "letters"
    ? toLetters(index)
    : String(index + 1);

  return `${cleanPrefix} ${identifier}`;
}

function toLetters(index: number): string {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
}

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}
