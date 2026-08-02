import { useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import type { PdfStampPlacement } from "@raiopdf/engine-api";
import { PageRangeError, parsePageRanges } from "@raiopdf/engine-api";
import type { OpenedFile } from "../lib/filePort";
import { useBatesPrefix } from "../hooks/useBatesPrefix";
import {
  fileAddBatchMessage,
  summarizeFileAddResults,
  type FileAddFailure,
  type FileAddResult,
  type FileAddSummary,
} from "../lib/readFileForAdd";
import {
  productionHintMessage,
  readProductionLastUsed,
} from "../lib/productionHints";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, HelpIcon, PlusIcon } from "../icons";
import { ErrorActions } from "./ErrorActions";
import { IconButton } from "./IconButton";
import { PackageRootPathField } from "./PackageRootPathField";
import "./ProductionSetWorkspace.css";

export interface ProductionSetFile {
  id: string;
  name: string;
  path: string | null;
  /**
   * Page count when known; `null` = deferred -- an above-threshold add whose
   * descriptor carried no `page_count(grant)` result (bytes are never loaded
   * for large files, so pdf-lib cannot count them). The production build
   * itself is path-based and does not need the count.
   */
  pages: number | null;
  designation: string;
  /**
   * 1-based page-range spec restricting the designation to part of THIS
   * file (e.g. "1-3,7"). Empty string = every page (default, unchanged).
   * Ignored while `designation` is empty.
   */
  designationPages: string;
  /**
   * Advisory SHA-256 (hex), computed at add time -- `null` while pending or
   * on a hashing failure (never blocks the add). ADVISORY ONLY: the build
   * re-groups duplicates authoritatively from its own planning-pass hashes,
   * so this only drives the "duplicate" badge and status line, never what
   * actually gets produced. See `ProductionSetRunInput.duplicateHandling`.
   */
  sourceSha256: string | null;
}

/** How the build handles two or more sources whose bytes hash identical.
 * Mirrors `@raiopdf/production-set`'s `ProductionDuplicateHandling`. */
export type ProductionDuplicateHandling = "produce-all" | "produce-once";

/** The six placements a Bates number or designation can take: header/footer
 * crossed with left/center/right. Shared by both "Stamp placement" selects. */
export const STAMP_PLACEMENT_OPTIONS: readonly {
  key: string;
  label: string;
  placement: PdfStampPlacement;
}[] = [
  { key: "header:left", label: "Header — Left", placement: { edge: "header", align: "left" } },
  { key: "header:center", label: "Header — Center", placement: { edge: "header", align: "center" } },
  { key: "header:right", label: "Header — Right", placement: { edge: "header", align: "right" } },
  { key: "footer:left", label: "Footer — Left", placement: { edge: "footer", align: "left" } },
  { key: "footer:center", label: "Footer — Center", placement: { edge: "footer", align: "center" } },
  { key: "footer:right", label: "Footer — Right", placement: { edge: "footer", align: "right" } },
];

const DEFAULT_BATES_PLACEMENT_KEY = "footer:right";
const DEFAULT_DESIGNATION_PLACEMENT_KEY = "header:center";
const DEFAULT_STAMP_FONT_SIZE_PT = 10;

function placementForKey(key: string): PdfStampPlacement {
  return (
    STAMP_PLACEMENT_OPTIONS.find((option) => option.key === key)?.placement ??
    STAMP_PLACEMENT_OPTIONS[0]!.placement
  );
}

export interface ProductionSetRunInput {
  files: readonly ProductionSetFile[];
  prefix: string;
  start: number;
  digits: number;
  outputDir: string;
  includeIndex: boolean;
  includeFilenameInIndex: boolean;
  combinedPdf: boolean;
  volumeSizeMb: number | null;
  batesPlacement: PdfStampPlacement;
  designationPlacement: PdfStampPlacement;
  stampFontSizePt: number;
  /** Directory grant of a prior production package, from `onContinueFromPriorProduction`. */
  continueFrom?: string | undefined;
  /** Set only when the user used "Adjust start…" with a reason. */
  continuationOverrideReason?: string | undefined;
  /** How to handle two or more sources whose bytes hash identical. */
  duplicateHandling: ProductionDuplicateHandling;
  /**
   * Writes a litigation load file (`production.dat`, "Relativity-compatible
   * Concordance DAT defaults") at the package root. Per-source custodian
   * (also part of that file) is a package/MCP-level input only -- there's no
   * per-file custodian control here in v1, so every row's CUSTODIAN column
   * is blank for a UI-built production.
   */
  includeLoadFiles: boolean;
}

export interface ProductionSetRunResult {
  packageRoot: string;
  indexLocation: string | null;
  nextNumber: number;
  fileCount: number;
  continuation?: { mode: "strict" | "override"; priorLastBates: string } | null | undefined;
  /** Occurrences beyond the first in each duplicate group; 0 when none were found. */
  duplicateCount: number;
  /** Package-root-relative location of the litigation load file, or `null`
   * when "Litigation load file (DAT)" wasn't checked. */
  loadFileDat: string | null;
}

/** UI-facing mirror of `@raiopdf/production-set`'s `ProductionContinuationSummary`. */
export interface ProductionContinuationSummaryView {
  prefix: string;
  digits: number;
  nextNumber: number;
  lastBates: string;
  createdAt: string;
  fileCount: number;
}

export interface ProductionContinuationPick {
  /** Directory grant of the picked prior package -- reused as `continueFrom` at run time. */
  grant: string;
  summary: ProductionContinuationSummaryView;
}

export type ProductionContinuationPickOutcome =
  | { status: "picked"; pick: ProductionContinuationPick }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface ProductionSetProgress {
  running: boolean;
  message: string | null;
  result: ProductionSetRunResult | null;
  /**
   * Correlation id of the failure shown here; null for a gate or nudge, which
   * record nothing and so offer no report. See `DiagnosticEntry.id`.
   */
  diagnosticId?: string | null;
}

/**
 * Bytes-free descriptor of the currently open document (mirrors
 * `BatchCleanupSourceFile`): a streamed large doc has no `document.bytes`, but
 * it has a name and a path/grant — which is all the path-based production
 * build needs, so it seeds the production order like any small doc.
 */
export interface ProductionSetSourceFile {
  name: string;
  path: string | null;
}

export interface ProductionSetWorkspaceProps {
  currentFile: ProductionSetSourceFile | null;
  /**
   * Why the open document was NOT seeded into the production order (e.g. it
   * has unsaved changes, so its on-disk bytes are stale). Shown as the
   * initial status message so the omission is visible, never silent.
   */
  currentFileNotice?: string | null | undefined;
  currentPageCount: number;
  progress: ProductionSetProgress;
  onAddFile: () => Promise<FileAddResult[] | null>;
  /**
   * Adds every PDF in a chosen folder. Same contract as `onAddFile` -- the
   * scan/confirm/claim flow happens above this component. Absent in the browser
   * build, which has no folder picker that yields readable paths.
   */
  onAddFolder?: (() => Promise<FileAddResult[] | null>) | undefined;
  /**
   * Picks a prior production package folder and reads its verified Bates
   * continuation, for the "Continue from prior production…" affordance.
   * Absent in the browser build, which has no folder picker.
   */
  onContinueFromPriorProduction?: (() => Promise<ProductionContinuationPickOutcome>) | undefined;
  /**
   * Advisory SHA-256 for an above-threshold (descriptor-kind) add, backing
   * the duplicate badge for sources whose bytes never load into the WebView
   * (a bytes-kind add hashes in-component via WebCrypto instead, needing no
   * callback). Absent in the browser build and any Tauri shell that
   * predates `hash_file_for_grant` -- those rows just never badge. A `null`
   * resolution (unsupported runtime, unresolved grant, I/O error) is the
   * same "skip the badge" outcome as never calling this at all.
   */
  onHashGrant?: ((grant: string) => Promise<string | null>) | undefined;
  onRun: (input: ProductionSetRunInput) => Promise<void>;
  /** Opens the finished package root in the system file manager (desktop only). */
  onOpenPackageRoot?: ((path: string) => void) | undefined;
  onHelpRequested?: (() => void) | undefined;
}

const DESIGNATION_OPTIONS = [
  "",
  "Confidential",
  "Confidential - Attorneys' Eyes Only",
  "Custom",
] as const;

export function ProductionSetWorkspace({
  currentFile,
  currentFileNotice,
  currentPageCount,
  progress,
  onAddFile,
  onAddFolder,
  onContinueFromPriorProduction,
  onHashGrant,
  onRun,
  onOpenPackageRoot,
  onHelpRequested,
}: ProductionSetWorkspaceProps) {
  const mountedRef = useRef(true);
  const addFilePendingRef = useRef(false);
  const [files, setFiles] = useState<ProductionSetFile[]>(() =>
    currentFile ? [fromSourceFile(currentFile, currentPageCount)] : [],
  );
  const {
    prefix,
    setPrefix,
    noPrefix,
    setNoPrefix,
    effectivePrefix,
    prefixMissing,
    gateMessage,
  } = useBatesPrefix();
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [outputDir, setOutputDir] = useState("");
  const [includeIndex, setIncludeIndex] = useState(true);
  const [includeFilenameInIndex, setIncludeFilenameInIndex] = useState(true);
  const [combinedPdf, setCombinedPdf] = useState(false);
  const [includeLoadFiles, setIncludeLoadFiles] = useState(false);
  const [useVolumeCap, setUseVolumeCap] = useState(false);
  const [volumeSizeMb, setVolumeSizeMb] = useState(25);
  const [addingFile, setAddingFile] = useState(false);
  const [pendingPageCountReads, setPendingPageCountReads] = useState(0);
  const [localMessage, setLocalMessage] = useState<string | null>(currentFileNotice ?? null);
  const [continuationPick, setContinuationPick] = useState<ProductionContinuationPick | null>(null);
  const [continuationPicking, setContinuationPicking] = useState(false);
  const [continuationError, setContinuationError] = useState<string | null>(null);
  const [continuationAdjusting, setContinuationAdjusting] = useState(false);
  const [continuationReason, setContinuationReason] = useState("");
  const [batesPlacementKey, setBatesPlacementKey] = useState(DEFAULT_BATES_PLACEMENT_KEY);
  const [designationPlacementKey, setDesignationPlacementKey] = useState(DEFAULT_DESIGNATION_PLACEMENT_KEY);
  const [stampFontSizePt, setStampFontSizePt] = useState(DEFAULT_STAMP_FONT_SIZE_PT);
  const [duplicateHandling, setDuplicateHandling] = useState<ProductionDuplicateHandling>("produce-all");
  const hint = useMemo(() => productionHintMessage(effectivePrefix), [effectivePrefix]);
  const totalPages = files.reduce((sum, file) => sum + (file.pages ?? 0), 0);
  const lastNumber = start + Math.max(0, totalPages - 1);
  const overflows = Number.isFinite(lastNumber) && lastNumber >= 10 ** digits;
  const addFileBusy = addingFile || pendingPageCountReads > 0;
  // While a continuation is active, the prefix is fixed to the prior series;
  // Start and Digits stay fixed too unless "Adjust start…" is in progress --
  // and even then, Build stays gated on a reason (see canRun below).
  const continuationActive = continuationPick !== null;
  const continuationReasonMissing = continuationAdjusting && continuationReason.trim().length === 0;
  const continuationStartDigitsLocked = continuationActive && !continuationAdjusting;
  // Same-edge Bates/designation placements are pre-output-rejected by the
  // package build too (`assertPlacementsDoNotShareEdge`); catching it here
  // avoids a round trip to the build-time error for the common accidental
  // case of picking the same edge for both.
  const placementsCollide = batesPlacementKey.split(":")[0] === designationPlacementKey.split(":")[0];
  const stampFontSizeOutOfRange = !Number.isFinite(stampFontSizePt) ||
    stampFontSizePt < 6 ||
    stampFontSizePt > 24;
  // Derived, not stored -- recomputed from `files` on every render so it can
  // never drift from what's actually about to be sent to the build. Empty
  // spec, no designation, or an unknown page count (`pages === null`, an
  // above-threshold add) all skip inline checking; an unknown page count is
  // still checked authoritatively at build time, package-side.
  const pageRangeErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const file of files) {
      if (file.designation === "" || file.designationPages.trim() === "" || file.pages === null) {
        continue;
      }
      try {
        parsePageRanges(file.designationPages, file.pages);
      } catch (error) {
        errors.set(file.id, error instanceof PageRangeError ? error.message : "Invalid page range.");
      }
    }
    return errors;
  }, [files]);
  // Advisory grouping by add-time hash -- purely for the UI badge/status
  // line. Files whose hash hasn't resolved yet (or failed) simply never
  // join a group; the build re-groups authoritatively from its own hashes.
  const duplicateFileIds = useMemo(() => {
    const bySha = new Map<string, string[]>();
    for (const file of files) {
      if (file.sourceSha256 === null) {
        continue;
      }
      const ids = bySha.get(file.sourceSha256) ?? [];
      ids.push(file.id);
      bySha.set(file.sourceSha256, ids);
    }
    const duplicateIds = new Set<string>();
    let groupCount = 0;
    for (const ids of bySha.values()) {
      if (ids.length < 2) {
        continue;
      }
      groupCount += 1;
      for (const id of ids) {
        duplicateIds.add(id);
      }
    }
    return { ids: duplicateIds, groupCount };
  }, [files]);
  const canRun = files.length > 0 &&
    outputDir.trim().length > 0 &&
    !prefixMissing &&
    !overflows &&
    !addFileBusy &&
    !continuationReasonMissing &&
    !placementsCollide &&
    !stampFontSizeOutOfRange &&
    pageRangeErrors.size === 0 &&
    !progress.running;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // The local last-used hint is a convenience for free-form entry only. While
    // a continuation is active, the verified number from the prior package is
    // authoritative — the hint must not overwrite it when the prefix changes.
    if (continuationActive) {
      return;
    }

    const lastUsed = readProductionLastUsed(effectivePrefix);
    if (lastUsed !== null) {
      setStart(lastUsed + 1);
    }
  }, [effectivePrefix, continuationActive]);

  async function addFiles(pick: () => Promise<FileAddResult[] | null> = onAddFile) {
    if (addFilePendingRef.current) {
      return;
    }

    addFilePendingRef.current = true;
    setAddingFile(true);

    try {
      const picked = await pick();
      if (!picked || picked.length === 0 || !mountedRef.current) {
        return;
      }

      // Build the new rows up front, in picker order, so the eventual
      // `setFiles` append preserves that order even though the bytes-kind
      // rows' page counts resolve concurrently and out of order below.
      const summary = summarizeFileAddResults(picked);
      const entries: (ProductionSetFile | null)[] = [];
      let deferredCount = 0;
      const uncountedNames: string[] = [];
      const pageCountReads: { index: number; bytes: Uint8Array }[] = [];
      // Above-threshold adds hash in the BACKGROUND (fired after this
      // function returns entries into state) since it round-trips to Rust
      // to stream a file that, by definition, is large -- unlike the
      // bytes-kind hash below, it must not hold up "files added."
      const descriptorHashTargets: { id: string; grant: string }[] = [];

      for (const result of picked) {
        if (result.kind === "tooLarge" || result.kind === "error") {
          continue;
        }

        if (result.kind === "descriptor") {
          // Above-threshold add: never load bytes. The page count comes from
          // page_count(grant) when the shell op exists; otherwise it stays
          // deferred (null) -- the path-based production build works either way.
          const { descriptor } = result;
          const id = productionSetFileId(descriptor.name);
          entries.push({
            id,
            name: descriptor.name,
            path: descriptor.grant,
            pages: descriptor.pageCount,
            designation: "",
            designationPages: "",
            sourceSha256: null,
          });
          if (descriptor.pageCount === null) {
            deferredCount += 1;
          }
          if (onHashGrant) {
            descriptorHashTargets.push({ id, grant: descriptor.grant });
          }
          continue;
        }

        const opened = result.file;
        pageCountReads.push({ index: entries.length, bytes: opened.bytes });
        entries.push(fromOpenedFile(opened, 0));
      }

      if (pageCountReads.length > 0) {
        setPendingPageCountReads((current) => current + pageCountReads.length);
        setLocalMessage(pageCountReads.length === 1
          ? "Reading page count..."
          : `Reading ${pageCountReads.length} page counts...`);

        await Promise.all(pageCountReads.map(async ({ index, bytes }) => {
          try {
            // Page count and the advisory hash both need the bytes this add
            // already has in memory -- read them together rather than a
            // second async pass. A hash failure (e.g. WebCrypto unavailable)
            // is swallowed to `null`: it only skips the duplicate badge, it
            // must never drop or fail the add.
            const [pages, sourceSha256] = await Promise.all([
              readProductionSetPageCount(bytes),
              sha256HexFromBytes(bytes).catch(() => null),
            ]);
            const entry = entries[index];
            if (entry) {
              entries[index] = { ...entry, pages, sourceSha256 };
            }
          } catch {
            uncountedNames.push(entries[index]?.name ?? "PDF");
            entries[index] = null;
          } finally {
            if (mountedRef.current) {
              setPendingPageCountReads((current) => Math.max(0, current - 1));
            }
          }
        }));
      }

      if (!mountedRef.current) {
        return;
      }

      const countedEntries = entries.filter((entry): entry is ProductionSetFile => entry !== null);
      if (countedEntries.length > 0) {
        setFiles((current) => [...current, ...countedEntries]);
      }

      setLocalMessage(addSummaryMessage(summary, deferredCount, uncountedNames));

      // Fire-and-forget: patches each row's badge in as its hash resolves,
      // without holding up "files added" for a round trip per large file.
      // `.catch(() => null)` is defense in depth -- `onHashGrant` itself
      // already resolves `null` on failure rather than rejecting (see
      // `hashFileForGrant`'s doc comment), but a hashing failure must never
      // surface as an unhandled rejection or block anything downstream
      // regardless of what the caller passed in.
      if (onHashGrant) {
        for (const target of descriptorHashTargets) {
          void onHashGrant(target.grant).catch(() => null).then((sourceSha256) => {
            if (!mountedRef.current || sourceSha256 === null) {
              return;
            }
            setFiles((current) => current.map((item) => (
              item.id === target.id ? { ...item, sourceSha256 } : item
            )));
          });
        }
      }
    } finally {
      if (mountedRef.current) {
        setAddingFile(false);
      }
      addFilePendingRef.current = false;
    }
  }

  function moveFile(index: number, delta: -1 | 1) {
    setFiles((current) => {
      const next = [...current];
      const target = index + delta;
      const file = next[index];
      if (!file || target < 0 || target >= next.length) {
        return current;
      }
      next.splice(index, 1);
      next.splice(target, 0, file);
      return next;
    });
  }

  async function pickContinuation() {
    if (!onContinueFromPriorProduction || continuationPicking) {
      return;
    }

    setContinuationPicking(true);
    setContinuationError(null);

    try {
      const outcome = await onContinueFromPriorProduction();
      if (!mountedRef.current || outcome.status === "cancelled") {
        return;
      }
      if (outcome.status === "error") {
        setContinuationError(outcome.message);
        return;
      }

      const { pick } = outcome;
      setContinuationPick(pick);
      setContinuationAdjusting(false);
      setContinuationReason("");
      setNoPrefix(pick.summary.prefix === "");
      setPrefix(pick.summary.prefix);
      setStart(pick.summary.nextNumber);
      setDigits(pick.summary.digits);
    } finally {
      if (mountedRef.current) {
        setContinuationPicking(false);
      }
    }
  }

  function detachContinuation() {
    setContinuationPick(null);
    setContinuationAdjusting(false);
    setContinuationReason("");
    setContinuationError(null);
  }

  function beginAdjustContinuation() {
    setContinuationAdjusting(true);
  }

  function cancelAdjustContinuation() {
    if (continuationPick) {
      setStart(continuationPick.summary.nextNumber);
      setDigits(continuationPick.summary.digits);
    }
    setContinuationAdjusting(false);
    setContinuationReason("");
  }

  async function run() {
    setLocalMessage(null);
    if (!canRun) {
      setLocalMessage(overflows
        ? "Increase the digit width or lower the start number."
        : continuationReasonMissing
          ? "Add a reason for adjusting the Bates continuation start or digits."
          : placementsCollide
            ? "Bates numbers and the designation can't share a page edge -- choose header for one and footer for the other."
            : stampFontSizeOutOfRange
              ? "Stamp font size must be between 6 and 24 points."
              : pageRangeErrors.size > 0
                ? "Fix the page range shown under each file before building."
                : "Add files and choose an empty package root folder.");
      return;
    }

    await onRun({
      files,
      prefix: effectivePrefix.trim(),
      start,
      digits,
      outputDir: outputDir.trim(),
      includeIndex,
      includeFilenameInIndex,
      combinedPdf,
      volumeSizeMb: useVolumeCap ? volumeSizeMb : null,
      batesPlacement: placementForKey(batesPlacementKey),
      designationPlacement: placementForKey(designationPlacementKey),
      stampFontSizePt,
      continueFrom: continuationPick?.grant,
      continuationOverrideReason: continuationAdjusting && continuationReason.trim().length > 0
        ? continuationReason.trim()
        : undefined,
      duplicateHandling,
      includeLoadFiles,
    });
  }

  return (
    <section className="production-workspace" aria-label="Production Set Builder">
      {/* The dialog chrome already shows "Legal / Production Set" -- repeating
          that title here stacked a second heading on the first. This section
          carries the thing the dialog title doesn't: the ordered file list,
          styled the same way as Prepare for Filing's packet order so the two
          "reorder documents, then run" flows read as the same control. */}
      <section className="production-workspace__section" aria-label="Production order">
        <div className="production-workspace__header">
          <div>
            <p className="production-workspace__title">Production order</p>
            <p className="production-workspace__subtitle">
              {files.length} document{files.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="production-workspace__header-actions">
            {onHelpRequested ? (
              <IconButton
                icon={<HelpIcon size={14} />}
                label="Help: Production Set"
                onClick={onHelpRequested}
              />
            ) : null}
            <button
              type="button"
              className="production-workspace__secondary-button"
              onClick={() => void addFiles()}
              disabled={addFileBusy || progress.running}
              title={addFileBusy ? "Wait for the current page counts to finish." : "Add one or more PDFs to the production order."}
            >
              <PlusIcon size={14} /> Add PDF
            </button>
            {onAddFolder ? (
              <button
                type="button"
                className="production-workspace__secondary-button"
                onClick={() => void addFiles(onAddFolder)}
                disabled={addFileBusy || progress.running}
                title={addFileBusy ? "Wait for the current page counts to finish." : "Add every PDF in a folder to the production order."}
              >
                <PlusIcon size={14} /> Add Folder
              </button>
            ) : null}
          </div>
        </div>
        <div className="production-workspace__file-list" role="list">
          {files.length === 0 ? (
            <p className="production-workspace__empty">Add PDFs to build the production order.</p>
          ) : null}
          {files.map((file, index) => (
            <div className="production-workspace__file-row" role="listitem" key={file.id}>
              <div className="production-workspace__file-body">
                <span className="production-workspace__file-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="production-workspace__file-name-row">
                    <p className="production-workspace__file-name">{file.name}</p>
                    {duplicateFileIds.ids.has(file.id) ? (
                      <span
                        className="production-workspace__file-badge"
                        title="Another file in this production has the same content -- see the duplicate options below."
                      >
                        duplicate
                      </span>
                    ) : null}
                  </div>
                  <p className="production-workspace__file-meta" title="Pages counted from the opened PDF.">
                    {file.pages === null
                      ? "page count pending"
                      : `${file.pages} page${file.pages === 1 ? "" : "s"}`}
                  </p>
                </div>
              </div>
              <label
                className="production-workspace__designation"
                title="Optional confidentiality text to include for this source in the production package."
              >
                <span>Designation</span>
                <select
                  value={designationSelectValue(file.designation)}
                  onChange={(event) => {
                    const next = event.target.value === "Custom" ? file.designation : event.target.value;
                    setFiles((current) => current.map((item) => (
                      item.id === file.id
                        ? {
                            ...item,
                            designation: next,
                            // No designation means no range: keep the disabled
                            // Pages input from holding a stale value the user
                            // can't reach but the build would still validate.
                            designationPages: next === "" ? "" : item.designationPages,
                          }
                        : item
                    )));
                  }}
                >
                  {DESIGNATION_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option || "None"}</option>
                  ))}
                </select>
              </label>
              <label
                className="production-workspace__pages"
                title={
                  file.designation === ""
                    ? "Set a designation before restricting it to specific pages."
                    : 'Which pages get the designation, e.g. "1-3,7". Leave blank for every page.'
                }
              >
                <span>Pages</span>
                <input
                  type="text"
                  placeholder="all"
                  value={file.designationPages}
                  disabled={file.designation === ""}
                  aria-invalid={pageRangeErrors.has(file.id)}
                  onChange={(event) => {
                    const next = event.target.value;
                    setFiles((current) => current.map((item) => (
                      item.id === file.id ? { ...item, designationPages: next } : item
                    )));
                  }}
                />
                {pageRangeErrors.has(file.id) ? (
                  <span className="production-workspace__pages-note production-workspace__pages-note--error" role="alert">
                    {pageRangeErrors.get(file.id)}
                  </span>
                ) : file.designation !== "" && file.designationPages.trim() !== "" && file.pages === null ? (
                  <span className="production-workspace__pages-note">
                    Page count isn't known yet -- checked when you build.
                  </span>
                ) : null}
              </label>
              <div className="production-workspace__file-actions">
                <button
                  type="button"
                  className="production-workspace__icon-button"
                  aria-label={`Move ${file.name} up`}
                  disabled={index === 0}
                  onClick={() => moveFile(index, -1)}
                >
                  <ArrowUpIcon size={15} />
                </button>
                <button
                  type="button"
                  className="production-workspace__icon-button"
                  aria-label={`Move ${file.name} down`}
                  disabled={index === files.length - 1}
                  onClick={() => moveFile(index, 1)}
                >
                  <ArrowDownIcon size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {duplicateFileIds.ids.size > 0 ? (
          <div className="production-workspace__duplicates" role="group" aria-label="Duplicate documents">
            <p className="production-workspace__status" role="status">
              {duplicateFileIds.ids.size} duplicate file{duplicateFileIds.ids.size === 1 ? "" : "s"} in this
              production{duplicateFileIds.groupCount > 1 ? ` (${duplicateFileIds.groupCount} groups)` : ""}
            </p>
            <div className="production-workspace__duplicates-options">
              <label
                className="production-workspace__radio-row"
                title="Bates-stamp and produce every duplicate occurrence, each with its own range -- the safe default for a discovery production."
              >
                <input
                  type="radio"
                  name="production-duplicate-handling"
                  checked={duplicateHandling === "produce-all"}
                  onChange={() => setDuplicateHandling("produce-all")}
                />
                <span>Produce all (cross-referenced)</span>
              </label>
              <label
                className="production-workspace__radio-row"
                title="Produce only the first occurrence of each duplicate; later ones are omitted and use no Bates numbers."
              >
                <input
                  type="radio"
                  name="production-duplicate-handling"
                  checked={duplicateHandling === "produce-once"}
                  onChange={() => setDuplicateHandling("produce-once")}
                />
                <span>Produce once</span>
              </label>
            </div>
          </div>
        ) : null}
      </section>

      <section className="production-workspace__section" aria-label="Bates numbering">
        <p className="production-workspace__title">Bates numbering</p>
        <div className="production-workspace__grid">
          <label title="Letters before the Bates number, for example SMITH000001.">
            <span>Prefix</span>
            <input
              value={prefix}
              placeholder="e.g. SMITH"
              disabled={noPrefix || continuationActive}
              onChange={(event) => setPrefix(event.target.value)}
            />
          </label>
          <label title="First Bates number to use for the first selected page.">
            <span>Start</span>
            <input
              type="number"
              min="0"
              value={start}
              disabled={continuationStartDigitsLocked}
              onChange={(event) => setStart(Number(event.target.value))}
            />
          </label>
          <label title="Minimum number of digits to pad after the prefix.">
            <span>Digits</span>
            <input
              type="number"
              min="1"
              max="12"
              value={digits}
              disabled={continuationStartDigitsLocked}
              onChange={(event) => setDigits(Number(event.target.value))}
            />
          </label>
          <label title="Choose an empty folder where RaioPDF can write the production package.">
            <span>Package root folder</span>
            <PackageRootPathField
              value={outputDir}
              onChange={setOutputDir}
              disabled={progress.running}
              browseButtonClassName="production-workspace__secondary-button"
            />
          </label>
        </div>
        <label
          className="production-workspace__checkbox-row"
          title="Stamp Bates numbers with no letter prefix — numbers only."
        >
          <input
            type="checkbox"
            checked={noPrefix}
            disabled={continuationActive}
            onChange={(event) => setNoPrefix(event.target.checked)}
          />
          <span>No prefix (numbers only)</span>
        </label>
        {hint ? <p className="production-workspace__status">{hint}</p> : null}
        {overflows ? (
          <p className="production-workspace__status">The last Bates number would exceed the configured digit width.</p>
        ) : null}
        {prefixMissing ? (
          <p className="production-workspace__status">{gateMessage}</p>
        ) : null}
        <details className="production-workspace__placement">
          <summary className="production-workspace__placement-summary">
            <span className="production-workspace__placement-chevron" aria-hidden="true">▸</span>
            Stamp placement
          </summary>
          <div className="production-workspace__placement-body">
            <div className="production-workspace__placement-grid">
              <label title="Which page edge and alignment the Bates number stamps to.">
                <span>Bates numbers</span>
                <select
                  value={batesPlacementKey}
                  onChange={(event) => setBatesPlacementKey(event.target.value)}
                >
                  {STAMP_PLACEMENT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label title="Which page edge and alignment the confidentiality designation stamps to.">
                <span>Designation</span>
                <select
                  value={designationPlacementKey}
                  onChange={(event) => setDesignationPlacementKey(event.target.value)}
                >
                  {STAMP_PLACEMENT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label
                className="production-workspace__number"
                title="Font size, in points, shared by both stamps. Between 6 and 24."
              >
                <span>Font size (pt)</span>
                <input
                  type="number"
                  min="6"
                  max="24"
                  value={stampFontSizePt}
                  onChange={(event) => setStampFontSizePt(Number(event.target.value))}
                />
              </label>
            </div>
            {placementsCollide ? (
              <p className="production-workspace__status" role="status">
                Bates numbers and the designation can't share a page edge -- put one in the header and the
                other in the footer.
              </p>
            ) : null}
            {stampFontSizeOutOfRange ? (
              <p className="production-workspace__status" role="status">
                Font size must be between 6 and 24 points.
              </p>
            ) : null}
          </div>
        </details>
        <div className="production-workspace__continuation" aria-label="Bates continuation">
          {onContinueFromPriorProduction && !continuationActive ? (
            <button
              type="button"
              className="production-workspace__secondary-button"
              onClick={() => void pickContinuation()}
              disabled={continuationPicking || progress.running}
            >
              {continuationPicking ? "Reading prior production…" : "Continue from prior production…"}
            </button>
          ) : null}
          {continuationActive && continuationPick ? (
            <div className="production-workspace__continuation-active">
              <p className="production-workspace__status" role="status">
                Continuing {continuationPick.summary.prefix || "(no prefix)"} from{" "}
                {formatBatesNumber(continuationPick.summary.prefix, continuationPick.summary.nextNumber, continuationPick.summary.digits)}{" "}
                (prior production ended at {continuationPick.summary.lastBates}, produced{" "}
                {formatShortDate(continuationPick.summary.createdAt)}) — verify against the served copy.
              </p>
              <div className="production-workspace__continuation-actions">
                {continuationAdjusting ? (
                  <>
                    <input
                      className="production-workspace__continuation-reason"
                      value={continuationReason}
                      placeholder="Reason (required), e.g. reserving a range"
                      aria-label="Reason for adjusting the Bates continuation"
                      onChange={(event) => setContinuationReason(event.target.value)}
                    />
                    <button
                      type="button"
                      className="production-workspace__secondary-button"
                      onClick={cancelAdjustContinuation}
                    >
                      Cancel adjust
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="production-workspace__secondary-button"
                    onClick={beginAdjustContinuation}
                    disabled={progress.running}
                  >
                    Adjust start…
                  </button>
                )}
                <IconButton
                  icon={<span aria-hidden="true">×</span>}
                  label="Detach from prior production"
                  onClick={detachContinuation}
                  disabled={progress.running}
                />
              </div>
            </div>
          ) : null}
          {continuationError ? (
            <p className="production-workspace__status" role="status">{continuationError}</p>
          ) : null}
        </div>
      </section>

      <section className="production-workspace__section" aria-label="Output options">
        <p className="production-workspace__title">Output options</p>
        <div className="production-workspace__checks">
          <label className="production-workspace__checkbox-row" title="Write PDF and CSV indexes listing produced files and Bates ranges.">
            <input
              type="checkbox"
              checked={includeIndex}
              onChange={(event) => setIncludeIndex(event.target.checked)}
            />
            <span>Production index PDF and CSV</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Include each source filename as a column in the production index.">
            <input
              type="checkbox"
              checked={includeFilenameInIndex}
              onChange={(event) => setIncludeFilenameInIndex(event.target.checked)}
            />
            <span>Filename column in index</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Also write one combined produced PDF alongside individual outputs.">
            <input
              type="checkbox"
              checked={combinedPdf}
              onChange={(event) => setCombinedPdf(event.target.checked)}
            />
            <span>Combined production PDF</span>
          </label>
          <label className="production-workspace__checkbox-row" title="Group production outputs into volume folders by size.">
            <input
              type="checkbox"
              checked={useVolumeCap}
              onChange={(event) => setUseVolumeCap(event.target.checked)}
            />
            <span>Volume folders</span>
          </label>
          <label
            className="production-workspace__checkbox-row"
            title="Write production.dat, a Relativity-compatible Concordance-style load file, alongside the production index -- for importing this production straight into a review platform."
          >
            <input
              type="checkbox"
              checked={includeLoadFiles}
              onChange={(event) => setIncludeLoadFiles(event.target.checked)}
            />
            <span>Litigation load file (DAT)</span>
          </label>
        </div>
        {useVolumeCap ? (
          <label className="production-workspace__number" title="Maximum size for each volume folder before starting the next volume.">
            <span>Volume cap MB</span>
            <input
              type="number"
              min="1"
              value={volumeSizeMb}
              onChange={(event) => setVolumeSizeMb(Number(event.target.value))}
            />
          </label>
        ) : null}
      </section>

      <div className="production-workspace__button-row">
        <button
          type="button"
          className="production-workspace__primary-button"
          disabled={!canRun}
          title={prefixMissing ? gateMessage : undefined}
          onClick={() => void run()}
        >
          Build Production
        </button>
        <p className="production-workspace__status" role="status">
          {localMessage ?? progress.message ?? `${totalPages} page${totalPages === 1 ? "" : "s"} selected`}
        </p>
      </div>

      {/* A finished run carries a `result`; a build that failed leaves a message
          with no result and isn't running — that's the only state that offers an
          email report. Local validation (localMessage) is a user-fixable nudge,
          not a failure, so it doesn't. */}
      {!localMessage && !progress.running && !progress.result && progress.message ? (
        <ErrorActions className="production-workspace__report" diagnosticId={progress.diagnosticId} />
      ) : null}

      {progress.result ? (
        <section className="production-workspace__result" aria-label="Production build result">
          <div className="production-workspace__result-header">
            <CheckIcon size={15} />
            <div>
              <p className="production-workspace__result-title">Production package built</p>
              <p className="production-workspace__result-subtitle">
                {progress.result.fileCount} file{progress.result.fileCount === 1 ? "" : "s"} Bates-stamped and written.
              </p>
              {progress.result.continuation ? (
                <p className="production-workspace__result-subtitle">
                  Continued from prior production (ended at {progress.result.continuation.priorLastBates}
                  {progress.result.continuation.mode === "override" ? ", start adjusted" : ""}).
                </p>
              ) : null}
              {progress.result.duplicateCount > 0 ? (
                <p className="production-workspace__result-subtitle">
                  {progress.result.duplicateCount} duplicate{progress.result.duplicateCount === 1 ? "" : "s"} detected
                  -- see the manifest for the cross-reference.
                </p>
              ) : null}
            </div>
          </div>
          <div className="production-workspace__result-parts">
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Package</span>
              <span className="production-workspace__result-part-value">{progress.result.packageRoot}</span>
            </div>
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Index</span>
              <span className="production-workspace__result-part-value">
                {progress.result.indexLocation ?? "not written"}
              </span>
            </div>
            <div className="production-workspace__result-part">
              <span className="production-workspace__result-part-label">Next Bates number</span>
              <span className="production-workspace__result-part-value">{progress.result.nextNumber}</span>
            </div>
            {progress.result.loadFileDat ? (
              <div className="production-workspace__result-part">
                <span className="production-workspace__result-part-label">Load file</span>
                <span className="production-workspace__result-part-value">{progress.result.loadFileDat}</span>
              </div>
            ) : null}
          </div>
          {onOpenPackageRoot ? (
            <div className="package-workflow-result-actions">
              <button
                type="button"
                className="production-workspace__secondary-button"
                onClick={() => onOpenPackageRoot(progress.result!.packageRoot)}
              >
                Open folder
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function formatBatesNumber(prefix: string, value: number, digits: number): string {
  return `${prefix}${String(value).padStart(digits, "0")}`;
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function fromSourceFile(file: ProductionSetSourceFile, pages: number): ProductionSetFile {
  return {
    id: productionSetFileId(file.name),
    name: file.name,
    path: file.path,
    pages,
    designation: "",
    designationPages: "",
    // The initially-seeded open document has neither in-memory bytes nor a
    // grant plumbed through this narrower `ProductionSetSourceFile` prop, so
    // it's never advisory-hashed -- it simply can't badge as a duplicate of
    // a later add. Cosmetic only: the build's own authoritative grouping
    // still covers it like any other source.
    sourceSha256: null,
  };
}

function fromOpenedFile(file: OpenedFile, pages: number): ProductionSetFile {
  return fromSourceFile({ name: file.name, path: file.path }, pages);
}

function productionSetFileId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Folds the pick-level `tooLarge`/`error` failures together with any page
 * counts that failed AFTER the pick succeeded (a bytes-kind file pdf-lib
 * could not parse) into one status line, and otherwise falls back to the
 * deferred-count note for above-threshold descriptor adds.
 */
function addSummaryMessage(
  summary: FileAddSummary,
  deferredCount: number,
  uncountedNames: readonly string[],
): string | null {
  const uncounted: FileAddFailure[] = uncountedNames.map((name) => ({
    name,
    reason: "its pages could not be counted",
  }));
  const failureMessage = fileAddBatchMessage(
    {
      addedCount: summary.addedCount - uncountedNames.length,
      totalCount: summary.totalCount,
      failures: [...summary.failures, ...uncounted],
    },
    "document",
  );
  if (failureMessage) {
    return failureMessage;
  }

  if (deferredCount === 0) {
    return null;
  }

  return deferredCount === 1
    ? "Added a large PDF; its page count will be determined during the production build."
    : `Added ${deferredCount} large PDFs; their page counts will be determined during the production build.`;
}

export async function readProductionSetPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPageCount();
}

/**
 * Advisory SHA-256 (hex) of already-in-memory bytes -- the bytes-kind half
 * of add-time duplicate detection (the descriptor-kind half round-trips to
 * Rust via `onHashGrant`; see its doc comment). Callers must treat a
 * rejection as "skip the badge," never as a reason to drop the file.
 */
export async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  // Cast needed under TS's stricter typed-array generics (`Uint8Array<ArrayBufferLike>`
  // isn't structurally a `BufferSource` there); harmless at runtime -- SubtleCrypto
  // accepts any `Uint8Array` view.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function designationSelectValue(value: string): string {
  return DESIGNATION_OPTIONS.includes(value as typeof DESIGNATION_OPTIONS[number])
    ? value
    : "Custom";
}
