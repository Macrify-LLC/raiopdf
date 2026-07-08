import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type {
  ConstraintEntry,
  DocumentFacts,
  JurisdictionPack,
  JurisdictionPackId,
  PrepPlanStep,
  PrepPlanStepId,
  PreflightCheck,
  PreflightReport,
} from "@raiopdf/rules";
import type { CourtProfile } from "../lib/filingPreferences";
import type { PdfAConversionImpact } from "@raiopdf/engine-pdf-lib";
import type { DocumentState } from "../hooks/useDocument";
import { ArrowDownIcon, ArrowUpIcon, BoltIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "../icons";
import { LoadingSun } from "./LoadingSun";
import { LongProcessLoader, type LongProcessStep } from "./LongProcessLoader";
import "./PrepareForFilingWorkspace.css";

export type FilingProgressPhase =
  | "idle"
  | "normalizing"
  | "splitting"
  | "converting"
  | "verifying"
  | "done"
  | "error";

export interface FilingProgressState {
  phase: FilingProgressPhase;
  message: string | null;
}

export interface FilingOutputPart {
  fileName: string;
  byteLength: number;
  pageIndexes: readonly number[];
  oversized: boolean;
}

export interface FilingResultState {
  parts: readonly FilingOutputPart[];
  report: PreflightReport;
  verifiedAt: string;
  savedDirectoryPath?: string | null;
  skippedSteps: readonly string[];
  overrides: readonly string[];
}

export type FilingPacketLayoutMode = "separate-files" | "combined-pdf";

export interface FilingPacketFile {
  id: string;
  name: string;
  path: string | null;
  pages: number;
}

export interface FilingPacketBuildInput {
  files: readonly FilingPacketFile[];
  outputDir: string;
  layoutMode: FilingPacketLayoutMode;
  prefixFilenames: boolean;
  selectedStepIds: readonly PrepPlanStepId[];
  customSplitMegabytes: number | null;
}

export interface FilingPacketProgress {
  running: boolean;
  message: string | null;
  result: {
    packageRoot: string;
    manifestPdf: string;
    packetJson: string;
    combinedPdf: string | null;
    outputs: readonly string[];
  } | null;
}

export interface CertificateOfServiceDraft {
  caseCaption: string;
  serviceList: string;
  date: string;
}

export interface PrepareOptions {
  /** The user saw the conversion-impact warning and chose to continue anyway. */
  acknowledgeImpact?: boolean;
  /** User choice for RaioPDF-owned markup annotations in the filing copy. */
  markupAnnotations?: "flatten" | "keep";
  /** Current PDF open password for this one prepare run. Never persisted. */
  removeEncryptionPassword?: string;
  selectedStepIds: readonly PrepPlanStepId[];
  customSplitMegabytes?: number | null;
}

/**
 * What running Prepare for Filing would silently lose, surfaced for an explicit
 * go-ahead before anything is destroyed.
 */
export interface FilingImpactState {
  /** Features PDF/A conversion would strip; null when this pack skips conversion. */
  conversionImpact: PdfAConversionImpact | null;
  /** In-app redaction marks that have not been applied and will NOT redact the output. */
  unappliedRedactionMarks: number;
  /** RaioPDF-owned markup annotations in the PDF that need a filing choice. */
  markupAnnotationCount: number;
  /** Whether Normalize pages was selected for the run that raised this warning. */
  normalizePagesSelected: boolean;
}

export interface PrepareForFilingWorkspaceProps {
  document: DocumentState;
  pack: JurisdictionPack;
  availablePacks?: readonly JurisdictionPack[];
  prepPlan: readonly PrepPlanStep[];
  /**
   * Steps unavailable for reasons the plan itself doesn't know — for
   * streamed (large) documents this is the closed-form PathOpsEngine rule
   * [R7-1]: a step with no registered path op renders as a disabled
   * checkbox with an honest reason, never as silently runnable.
   */
  extraUnavailableSteps?: ReadonlyMap<PrepPlanStepId, string> | undefined;
  courtProfiles: readonly CourtProfile[];
  selectedCourtProfile: CourtProfile | null;
  facts: DocumentFacts | null;
  report: PreflightReport | null;
  loadingReport: boolean;
  reportError?: string | null;
  progress: FilingProgressState;
  result: FilingResultState | null;
  impact: FilingImpactState | null;
  pdfAAvailable: boolean;
  compressAvailable: boolean;
  onPackChange: (packId: JurisdictionPackId) => void;
  onCourtProfileSelect: (profileId: string) => void;
  onCourtProfileSave: (profile: { name: string; maxMegabytes: number }) => void;
  onPrepare: (certificate: CertificateOfServiceDraft | null, options: PrepareOptions) => void;
  onAddPacketFile?: () => Promise<FilingPacketFile | null>;
  onBuildPacket?: (input: FilingPacketBuildInput) => Promise<void>;
  packetProgress?: FilingPacketProgress | undefined;
  defaultPacketLayoutMode?: FilingPacketLayoutMode | undefined;
  defaultPacketPrefixFilenames?: boolean | undefined;
  onPacketPreferencesChange?: (
    preferences: { layoutMode: FilingPacketLayoutMode; prefixFilenames: boolean },
  ) => void;
  stepDefaultOverrides?: Partial<Record<PrepPlanStepId, boolean>> | undefined;
  onStepDefaultOverridesChange?: (overrides: Partial<Record<PrepPlanStepId, boolean>>) => void;
  onDismissImpact: () => void;
  onCompressFirst: () => void;
}

/**
 * Imperative bridge for chrome that now lives outside this component. Item 8
 * flattens Prepare for Filing to one chrome: the "..." overflow menu moved up
 * into the outer FloatingDialog's header (see `FilingOverflowMenu` below and
 * App.tsx's `getFloatingDialog`), but the Certificate of Service form it opens
 * is still this workspace's own state -- this handle is the one method that
 * bridges the two without lifting the whole form up.
 */
export interface PrepareForFilingWorkspaceHandle {
  openCertificateOfService: () => void;
}

export const PrepareForFilingWorkspace = forwardRef<
  PrepareForFilingWorkspaceHandle,
  PrepareForFilingWorkspaceProps
>(function PrepareForFilingWorkspace(
  {
    document,
    pack,
    availablePacks = [pack],
    prepPlan,
    extraUnavailableSteps,
    courtProfiles,
    selectedCourtProfile,
    facts,
    report,
    loadingReport,
    reportError = null,
    progress,
    result,
    impact,
    pdfAAvailable,
    compressAvailable,
    onPackChange,
    onCourtProfileSelect,
    onCourtProfileSave,
    onPrepare,
    onAddPacketFile,
    onBuildPacket,
    packetProgress = { running: false, message: null, result: null },
    defaultPacketLayoutMode = "separate-files",
    defaultPacketPrefixFilenames = true,
    onPacketPreferencesChange,
    stepDefaultOverrides,
    onStepDefaultOverridesChange,
    onDismissImpact,
    onCompressFirst,
  }: PrepareForFilingWorkspaceProps,
  ref,
) {
  const [mode, setMode] = useState<"single" | "packet">("single");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [certificateOpen, setCertificateOpen] = useState(false);
  const [checkedSteps, setCheckedSteps] = useState<Set<PrepPlanStepId>>(() => (
    defaultCheckedSteps(prepPlan, undefined, stepDefaultOverrides)
  ));
  const [stepDefaultsMessage, setStepDefaultsMessage] = useState<string | null>(null);
  const [customSplitMegabytes, setCustomSplitMegabytes] = useState("");
  const [packetFiles, setPacketFiles] = useState<FilingPacketFile[]>(() => (
    document.bytes
      ? [{
          id: `current-${document.fileName ?? "document"}`,
          name: document.fileName ?? "Untitled.pdf",
          path: document.filePath,
          pages: document.pageCount,
        }]
      : []
  ));
  const [packetOutputDir, setPacketOutputDir] = useState("");
  const [packetLayoutMode, setPacketLayoutMode] = useState<FilingPacketLayoutMode>(defaultPacketLayoutMode);
  const [packetPrefixFilenames, setPacketPrefixFilenames] = useState(defaultPacketPrefixFilenames);
  const [packetMessage, setPacketMessage] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [passwordValue, setPasswordValue] = useState("");
  // Kept for the duration of one prepare run (through any impact-confirmation
  // retry), separate from the input field above. Codex flagged that clearing
  // the password on submit left the ImpactWarning continue action with
  // nothing to resend, re-tripping the remove-encryption gate.
  const [activeUnlockPassword, setActiveUnlockPassword] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<CertificateOfServiceDraft>({
    caseCaption: "",
    serviceList: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const latestVerified = useMemo(() => latestDate(pack.constraints), [pack.constraints]);
  const oldestVerified = useMemo(() => oldestPolicyDate(pack), [pack]);
  const activeReport = result?.report ?? report;
  const hasFilingResult = Boolean(result) || Boolean(packetProgress.result);
  const unavailableSteps = useMemo(
    () => resolveUnavailableSteps(prepPlan, {
      pdfAAvailable,
    }, extraUnavailableSteps),
    [extraUnavailableSteps, pdfAAvailable, prepPlan],
  );
  const selectedAvailableStepIds = useMemo(
    () => prepPlan
      .filter((step) => checkedSteps.has(step.id) && !step.disabledReason && !unavailableSteps.get(step.id))
      .map((step) => step.id),
    [checkedSteps, prepPlan, unavailableSteps],
  );
  const convertsToPdfA = selectedAvailableStepIds.includes("convert-pdfa");
  const needsMechanicalWork = Boolean(report?.checks.some((check) => check.status !== "pass"));
  const overPortalSize = Boolean(
    document.fileSizeBytes &&
      pack.recommendedMaxFileBytes !== undefined &&
      document.fileSizeBytes > pack.recommendedMaxFileBytes,
  );
  const primaryLabel = needsMechanicalWork || !convertsToPdfA
    ? "Make Filing-Ready"
    : "Export PDF/A for ePortal";
  // Streamed (large) documents run the reduced path-based pipeline: the run
  // is available once the facts-based preflight loaded — bytes present OR
  // (streamed AND facts loaded).
  const streamedDocument = document.source !== null && document.source.kind !== "memory";
  const hasPreparableDocument = Boolean(document.bytes) || (streamedDocument && facts !== null);
  // Gate on "this pack will convert", not on the report's pdfa status -- an input
  // that already passes the PDF/A check still gets converted by the pipeline, so
  // the button must stay disabled wherever the conversion engine is unavailable.
  const canPrepare = hasPreparableDocument &&
    Boolean(report) &&
    progress.phase !== "normalizing" &&
    progress.phase !== "splitting" &&
    progress.phase !== "converting" &&
    progress.phase !== "verifying" &&
    !impact;
  const prepareOptions = (): PrepareOptions => ({
    selectedStepIds: selectedAvailableStepIds,
    customSplitMegabytes: parsePositiveNumber(customSplitMegabytes),
  });
  const canBuildPacket = packetFiles.length > 0 &&
    packetOutputDir.trim().length > 0 &&
    Boolean(onBuildPacket) &&
    !packetProgress.running;
  const removeEncryptionSelected = selectedAvailableStepIds.includes("remove-encryption");
  // Only a genuinely encrypted document needs an open password. Owner-
  // restricted ("usage_restricted") files decrypt with an empty password in
  // both pipelines — never force a prompt for a password the user never set.
  const needsUnlockPassword = removeEncryptionSelected && facts?.encryptionState === "encrypted";

  useEffect(() => {
    setCheckedSteps(defaultCheckedSteps(prepPlan, unavailableSteps, stepDefaultOverrides));
  }, [prepPlan, stepDefaultOverrides, unavailableSteps]);

  useEffect(() => {
    setStepDefaultsMessage(null);
  }, [prepPlan, unavailableSteps]);

  useImperativeHandle(ref, () => ({
    openCertificateOfService: () => setCertificateOpen(true),
  }), []);

  function submitCertificate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCertificateOpen(false);
  }

  function runSinglePrepare() {
    if (needsUnlockPassword) {
      setPasswordPromptOpen(true);
      return;
    }

    setActiveUnlockPassword(null);
    onPrepare(certificateOpen ? certificate : null, prepareOptions());
  }

  function saveCurrentStepDefaults() {
    const overrides = Object.fromEntries(
      prepPlan
        .filter((step) => !step.disabledReason && !unavailableSteps.get(step.id))
        .map((step) => [step.id, checkedSteps.has(step.id)]),
    ) as Partial<Record<PrepPlanStepId, boolean>>;

    onStepDefaultOverridesChange?.(overrides);
    setStepDefaultsMessage("Saved as your defaults for this pack.");
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = passwordValue;
    if (!password) {
      return;
    }
    setPasswordPromptOpen(false);
    setPasswordValue("");
    setActiveUnlockPassword(password);
    onPrepare(certificateOpen ? certificate : null, {
      ...prepareOptions(),
      removeEncryptionPassword: password,
    });
  }

  async function addPacketFile() {
    if (!onAddPacketFile) {
      return;
    }
    const file = await onAddPacketFile();
    if (!file) {
      return;
    }
    setPacketFiles((current) => [...current, file]);
  }

  function movePacketFile(index: number, delta: -1 | 1) {
    setPacketFiles((current) => {
      const target = index + delta;
      const file = current[index];
      if (!file || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      next.splice(index, 1);
      next.splice(target, 0, file);
      return next;
    });
  }

  async function buildPacket() {
    setPacketMessage(null);
    if (!onBuildPacket || !canBuildPacket) {
      setPacketMessage("Add packet PDFs and choose an empty package root folder.");
      return;
    }
    if (packetFiles.some((file) => !file.path)) {
      setPacketMessage("Packet builder needs PDFs opened from local desktop paths.");
      return;
    }
    onPacketPreferencesChange?.({ layoutMode: packetLayoutMode, prefixFilenames: packetPrefixFilenames });
    await onBuildPacket({
      files: packetFiles,
      outputDir: packetOutputDir.trim(),
      layoutMode: packetLayoutMode,
      prefixFilenames: packetPrefixFilenames,
      selectedStepIds: selectedAvailableStepIds,
      customSplitMegabytes: parsePositiveNumber(customSplitMegabytes),
    });
  }

  // While a single-document filing run is in flight, take the whole workspace
  // over with the shared long-process loader -- the same treatment OCR and the
  // other engine jobs get -- instead of leaving an inline loader buried at the
  // bottom of the checklist where the screen reads as "nothing is happening".
  if (isFilingProgressActive(progress.phase)) {
    return (
      <section className="filing-workspace" aria-label="Prepare for Filing">
        <div className="filing-card">
          <p className="filing-card__document-line">
            <BoltIcon variant="outline" size={14} />
            <span className="filing-card__document-name">{document.fileName ?? "No document"}</span>
            <span className="filing-card__document-meta">{formatPageCount(document.pageCount)}</span>
          </p>
          <div
            className="filing-progress filing-progress--running"
            data-phase={progress.phase}
            aria-live="polite"
          >
            <LongProcessLoader
              phaseLabel={formatProgressLabel(progress.phase)}
              message={progress.message ?? formatProgressLabel(progress.phase)}
              steps={filingProgressSteps(progress.phase)}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="filing-workspace" aria-label="Prepare for Filing">
      <div className="filing-card">
        {/* The dialog chrome (outer FloatingDialog, see App.tsx) already shows
            the "Legal / Prepare for Filing" title, ? and the (new, item 8)
            overflow menu -- repeating any of that here was the second chrome
            item 8 flattens away. This line carries the one thing the dialog
            title doesn't: which document is in play. */}
        <p className="filing-card__document-line">
          <BoltIcon variant="outline" size={14} />
          <span className="filing-card__document-name">{document.fileName ?? "No document"}</span>
          <span className="filing-card__document-meta">{formatPageCount(document.pageCount)}</span>
        </p>

        <div className="filing-mode-toggle" role="tablist" aria-label="Prepare mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "single"}
            className="filing-mode-toggle__button"
            onClick={() => setMode("single")}
          >
            Single document
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "packet"}
            className="filing-mode-toggle__button"
            onClick={() => setMode("packet")}
          >
            Filing packet
          </button>
        </div>

        <PackPicker
          pack={pack}
          availablePacks={availablePacks}
          oldestVerified={oldestVerified}
          onPackChange={onPackChange}
        />

        <CourtProfilePrompt
          pack={pack}
          profiles={courtProfiles}
          selectedProfile={selectedCourtProfile}
          onSelect={onCourtProfileSelect}
          onSave={onCourtProfileSave}
        />

        <PrepChecklist
          steps={prepPlan}
          checkedSteps={checkedSteps}
          unavailableSteps={unavailableSteps}
          hasResult={hasFilingResult}
          customSplitMegabytes={customSplitMegabytes}
          onCustomSplitMegabytesChange={setCustomSplitMegabytes}
          stepDefaultsMessage={stepDefaultsMessage}
          canSaveStepDefaults={Boolean(onStepDefaultOverridesChange)}
          onSaveStepDefaults={saveCurrentStepDefaults}
          onToggle={(stepId) => {
            setCheckedSteps((current) => {
              const next = new Set(current);
              if (next.has(stepId)) {
                next.delete(stepId);
              } else {
                next.add(stepId);
              }
              return next;
            });
          }}
        />

        {mode === "packet" ? (
          <PacketBuilderPanel
            files={packetFiles}
            outputDir={packetOutputDir}
            layoutMode={packetLayoutMode}
            prefixFilenames={packetPrefixFilenames}
            progress={packetProgress}
            localMessage={packetMessage}
            canBuild={canBuildPacket}
            onOutputDirChange={setPacketOutputDir}
            onLayoutModeChange={setPacketLayoutMode}
            onPrefixFilenamesChange={setPacketPrefixFilenames}
            onAddFile={addPacketFile}
            onMoveFile={movePacketFile}
            onRemoveFile={(id) => setPacketFiles((current) => current.filter((file) => file.id !== id))}
            onBuild={() => void buildPacket()}
          />
        ) : (
          <div className="filing-card__primary-row">
            <button
              type="button"
              className="filing-card__primary-button"
              disabled={!canPrepare}
              title={reportError ?? (canPrepare ? "Build a filing copy using the checks shown below." : "Run is available after RaioPDF reads the filing checks.")}
              onClick={runSinglePrepare}
            >
              {primaryLabel}
            </button>
          </div>
        )}

        {document.source === null ? (
          <p className="filing-card__empty" role="status">Open a PDF before preparing a filing copy.</p>
        ) : null}

        {impact ? (
          <ImpactWarning
            impact={impact}
            onContinue={(markupAnnotations) => onPrepare(certificateOpen ? certificate : null, {
              ...prepareOptions(),
              acknowledgeImpact: true,
              ...(markupAnnotations ? { markupAnnotations } : {}),
              ...(activeUnlockPassword ? { removeEncryptionPassword: activeUnlockPassword } : {}),
            })}
            onCancel={() => {
              setActiveUnlockPassword(null);
              onDismissImpact();
            }}
          />
        ) : null}

        {passwordPromptOpen ? (
          <form className="filing-password" role="dialog" aria-label="PDF password" onSubmit={submitPassword}>
            <p className="filing-password__title">PDF password</p>
            <label>
              <span>Open password</span>
              <input
                autoFocus
                type="password"
                value={passwordValue}
                onChange={(event) => setPasswordValue(event.currentTarget.value)}
              />
            </label>
            <p className="filing-password__hint">
              Used once to remove encryption for this filing copy. RaioPDF does not save it.
            </p>
            <div className="filing-card__button-row">
              <button type="submit" className="filing-card__secondary-button" disabled={!passwordValue}>
                Remove Encryption
              </button>
              <button
                type="button"
                className="filing-card__ghost-button"
                onClick={() => {
                  setPasswordPromptOpen(false);
                  setPasswordValue("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {certificateOpen ? (
          <form className="filing-certificate" onSubmit={submitCertificate}>
            <p className="filing-certificate__title">Certificate of Service page</p>
            <label>
              <span>Case caption</span>
              <input
                value={certificate.caseCaption}
                onChange={(event) => setCertificate((current) => ({
                  ...current,
                  caseCaption: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>Service list</span>
              <textarea
                rows={4}
                value={certificate.serviceList}
                onChange={(event) => setCertificate((current) => ({
                  ...current,
                  serviceList: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>Date</span>
              <input
                type="date"
                value={certificate.date}
                onChange={(event) => setCertificate((current) => ({
                  ...current,
                  date: event.target.value,
                }))}
              />
            </label>
            <div className="filing-card__button-row">
              <button type="submit" className="filing-card__secondary-button">
                Add to Export
              </button>
              <button
                type="button"
                className="filing-card__ghost-button"
                onClick={() => setCertificateOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <PrefilingCheckSection
          loadingReport={loadingReport}
          reportError={reportError}
          checks={activeReport?.checks}
          selectionChecks={activeReport?.selectionChecks}
          defaultOpen={Boolean(result)}
        />

        {!pdfAAvailable && prepPlan.some((step) => step.id === "convert-pdfa" && checkedSteps.has(step.id)) ? (
          <p className="filing-card__unavailable" role="status">
            PDF/A export is available in the desktop app. Normalize and split remain available here.
          </p>
        ) : null}

        {overPortalSize ? (
          <div className="filing-progress" data-phase="idle" role="status">
            <p className="filing-progress__label">Size cap</p>
            <p>Compress first, then re-run preflight before splitting.</p>
            <button
              type="button"
              className="filing-card__secondary-button"
              disabled={!compressAvailable || progress.phase !== "idle"}
              onClick={onCompressFirst}
            >
              Compress first
            </button>
          </div>
        ) : null}

        <GuidanceNote note={pack.guidanceNote} />

        <button
          type="button"
          className="filing-card__rules-button"
          aria-expanded={rulesOpen}
          onClick={() => setRulesOpen((current) => !current)}
        >
          <ChevronDownIcon size={13} />
          View the rules applied
        </button>
        {rulesOpen ? (
          <RulesApplied pack={pack} />
        ) : null}

        {/* Active runs take the workspace over above (shared loader); this block
            only carries the terminal done/error status back inline. */}
        {progress.message ? (
          <div className="filing-progress" data-phase={progress.phase} aria-live="polite">
            <p className="filing-progress__label">{formatProgressLabel(progress.phase)}</p>
            <p>{progress.message}</p>
          </div>
        ) : null}

        {result ? (
          <ResultCard result={result} pack={pack} />
        ) : null}

        <footer className="filing-card__footer">
          <p>
            Checks cite the rules in force when this pack was verified ({latestVerified}) — confirm current requirements.
          </p>
        </footer>
      </div>
    </section>
  );
});

export interface FilingOverflowMenuProps {
  onInsertCertificate: () => void;
}

/**
 * Item 8's "gains the ... menu" -- rendered into the outer FloatingDialog's
 * header via its `actions` slot (see App.tsx's getFloatingDialog), not inside
 * this workspace, so Prepare for Filing has exactly one chrome. The single
 * menu action still needs to reach state that lives inside the workspace
 * (the Certificate of Service form); `onInsertCertificate` is wired to
 * `PrepareForFilingWorkspaceHandle.openCertificateOfService` for that.
 */
export function FilingOverflowMenu({ onInsertCertificate }: FilingOverflowMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="filing-header-menu">
      <button
        type="button"
        className="icon-button"
        aria-label="Prepare for Filing menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {open ? (
        <div className="filing-header-menu__panel" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onInsertCertificate();
              setOpen(false);
            }}
          >
            Insert Certificate of Service page...
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ImpactWarning({
  impact,
  onContinue,
  onCancel,
}: {
  impact: FilingImpactState;
  onContinue: (markupAnnotations?: "flatten" | "keep") => void;
  onCancel: () => void;
}) {
  const lines = describeImpact(impact);
  const hasMarkupChoice = impact.markupAnnotationCount > 0;

  return (
    <div className="filing-impact" role="alertdialog" aria-label="Prepare for Filing needs a markup choice">
      <p className="filing-impact__title">Stopped before anything was changed</p>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="filing-impact__hint">
        {hasMarkupChoice
          ? impact.normalizePagesSelected
            ? "Flattening makes your RaioPDF markup permanent in the filing copy. Keeping leaves it as live annotations — but Normalize pages will bake kept markup into the filing copy."
            : "Flattening makes your RaioPDF markup permanent in the filing copy. Keeping leaves it as live annotations."
          : impact.unappliedRedactionMarks > 0
          ? "Apply your redactions first, then run Prepare for Filing again."
          : "If these features are load-bearing — an unsigned form, a signature you need intact — cancel and handle them first."}
      </p>
      <div className="filing-card__button-row">
        <button type="button" className="filing-card__secondary-button" onClick={onCancel}>
          Cancel
        </button>
        {hasMarkupChoice ? (
          <>
            <button
              type="button"
              className="filing-card__secondary-button"
              onClick={() => onContinue("keep")}
            >
              Keep them
            </button>
            <button
              type="button"
              className="filing-card__ghost-button"
              onClick={() => onContinue("flatten")}
            >
              Flatten them
            </button>
          </>
        ) : (
          <button type="button" className="filing-card__ghost-button" onClick={() => onContinue()}>
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}

function PacketBuilderPanel({
  files,
  outputDir,
  layoutMode,
  prefixFilenames,
  progress,
  localMessage,
  canBuild,
  onOutputDirChange,
  onLayoutModeChange,
  onPrefixFilenamesChange,
  onAddFile,
  onMoveFile,
  onRemoveFile,
  onBuild,
}: {
  files: readonly FilingPacketFile[];
  outputDir: string;
  layoutMode: FilingPacketLayoutMode;
  prefixFilenames: boolean;
  progress: FilingPacketProgress;
  localMessage: string | null;
  canBuild: boolean;
  onOutputDirChange: (value: string) => void;
  onLayoutModeChange: (value: FilingPacketLayoutMode) => void;
  onPrefixFilenamesChange: (value: boolean) => void;
  onAddFile: () => void;
  onMoveFile: (index: number, delta: -1 | 1) => void;
  onRemoveFile: (id: string) => void;
  onBuild: () => void;
}) {
  return (
    <section className="filing-packet" aria-label="Filing packet builder">
      <div className="filing-packet__header">
        <div>
          <p className="filing-packet__title">Packet order</p>
          <p className="filing-packet__subtitle">{files.length} document{files.length === 1 ? "" : "s"}</p>
        </div>
        <button type="button" className="filing-card__secondary-button" onClick={onAddFile}>
          <PlusIcon size={14} /> Add PDF
        </button>
      </div>
      <div className="filing-packet__files" role="list">
        {files.length === 0 ? (
          <p className="filing-card__empty">Add PDFs to build the filing packet order.</p>
        ) : null}
        {files.map((file, index) => (
          <article className="filing-packet__file" key={file.id} role="listitem">
            <div className="filing-packet__file-body">
              <span className="filing-packet__file-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="filing-packet__file-name">{file.name}</p>
                <p className="filing-packet__file-meta">
                  {file.path ? "Local file" : "Path unavailable"} · {formatPageCount(file.pages)}
                </p>
              </div>
            </div>
            <div className="filing-packet__file-actions">
              <button
                type="button"
                className="filing-card__icon-button"
                aria-label={`Move ${file.name} up`}
                disabled={index === 0}
                onClick={() => onMoveFile(index, -1)}
              >
                <ArrowUpIcon size={14} />
              </button>
              <button
                type="button"
                className="filing-card__icon-button"
                aria-label={`Move ${file.name} down`}
                disabled={index === files.length - 1}
                onClick={() => onMoveFile(index, 1)}
              >
                <ArrowDownIcon size={14} />
              </button>
              <button
                type="button"
                className="filing-card__ghost-button"
                onClick={() => onRemoveFile(file.id)}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="filing-packet__grid">
        <label>
          <span>Package root folder</span>
          <input
            value={outputDir}
            onChange={(event) => onOutputDirChange(event.currentTarget.value)}
            placeholder="/absolute/path/to/empty-folder"
          />
        </label>
        <label>
          <span>Layout</span>
          <select
            value={layoutMode}
            onChange={(event) => onLayoutModeChange(event.currentTarget.value as FilingPacketLayoutMode)}
          >
            <option value="separate-files">Separate upload files</option>
            <option value="combined-pdf">Single combined PDF</option>
          </select>
        </label>
      </div>
      <label className="filing-packet__toggle">
        <input
          type="checkbox"
          checked={prefixFilenames}
          onChange={(event) => onPrefixFilenamesChange(event.currentTarget.checked)}
        />
        <span>Prefix upload filenames with packet order</span>
      </label>
      <div className="filing-card__primary-row">
        <button
          type="button"
          className="filing-card__primary-button"
          disabled={!canBuild}
          onClick={onBuild}
        >
          {progress.running ? "Building Packet..." : "Build Filing Packet"}
        </button>
      </div>
      {progress.running ? (
        <div className="filing-progress" data-phase="active" aria-live="polite">
          <LongProcessLoader
            phaseLabel="Building packet"
            message={localMessage ?? progress.message ?? "Writing packet files..."}
          />
        </div>
      ) : localMessage || progress.message ? (
        <p className="filing-card__status" role="status">{localMessage ?? progress.message}</p>
      ) : null}
      {progress.result ? (
        <section className="filing-result" aria-label="Filing packet result">
          <div className="filing-result__header">
            <CheckIcon size={15} />
            <div>
              <p className="filing-result__title">Filing packet built</p>
              <p className="filing-result__subtitle">
                {formatCount(progress.result.outputs.length, "upload file")} written to the package root.
              </p>
            </div>
          </div>
          {progress.result.outputs.length > 0 ? (
            <div className="filing-result__parts" role="list">
              {progress.result.outputs.map((output) => (
                <div key={output} className="filing-result__part" role="listitem">
                  <span className="filing-result__part-name">{output}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="filing-result__footer">
            <p className="filing-result__fine">Package: {progress.result.packageRoot}</p>
            <p className="filing-result__fine">
              Manifest: {progress.result.manifestPdf} · Packet data: {progress.result.packetJson}
            </p>
            {progress.result.combinedPdf ? (
              <p className="filing-result__fine">Combined upload: {progress.result.combinedPdf}</p>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function describeImpact(impact: FilingImpactState): string[] {
  const lines: string[] = [];
  const conversion = impact.conversionImpact;

  if (impact.unappliedRedactionMarks > 0) {
    lines.push(
      `${formatCount(impact.unappliedRedactionMarks, "redaction mark")} you made in RaioPDF ${impact.unappliedRedactionMarks === 1 ? "has" : "have"} not been applied — the filing copy would keep that content readable.`,
    );
  }

  if (impact.markupAnnotationCount > 0) {
    lines.push(
      `${formatCount(impact.markupAnnotationCount, "RaioPDF markup annotation")} can be flattened into the filing copy or kept as a live annotation.`,
    );
  }

  if (conversion?.pendingRedactionAnnotations) {
    lines.push(
      `${formatCount(conversion.pendingRedactionAnnotations, "pending redaction mark")} from another PDF tool ${conversion.pendingRedactionAnnotations === 1 ? "was" : "were"} never applied — PDF/A conversion discards the marks and files the content un-redacted.`,
    );
  }

  if (conversion?.overlayAnnotations) {
    lines.push(
      `${formatCount(conversion.overlayAnnotations, "annotation")} (highlights, boxes, notes) would be removed by PDF/A conversion. A box drawn over text does not redact it — the text underneath becomes visible.`,
    );
  }

  if (conversion?.formFields) {
    lines.push(
      `${formatCount(conversion.formFields, "interactive form field")} would be flattened or removed by PDF/A conversion.`,
    );
  }

  if (conversion?.signedSignatureFields) {
    lines.push(
      `${formatCount(conversion.signedSignatureFields, "digital signature")} would be invalidated by PDF/A conversion.`,
    );
  }

  return lines;
}

function PackPicker({
  pack,
  availablePacks,
  oldestVerified,
  onPackChange,
}: {
  pack: JurisdictionPack;
  availablePacks: readonly JurisdictionPack[];
  oldestVerified: string;
  onPackChange: (packId: JurisdictionPackId) => void;
}) {
  const staleHint = packStalenessHint(oldestVerified);

  return (
    // The outer class name stays `filing-card__jurisdiction` -- the smoke
    // suite locates the combobox through it.
    <div className="filing-card__jurisdiction">
      <div className="filing-pack__select-row">
        <label className="filing-pack__select">
          <span className="filing-pack__eyebrow">Jurisdiction</span>
          <span className="filing-pack__select-control">
            <select
              value={pack.id}
              aria-label="Jurisdiction pack"
              onChange={(event) => onPackChange(event.target.value as JurisdictionPackId)}
            >
              {availablePacks.map((availablePack) => (
                <option key={availablePack.id} value={availablePack.id}>
                  {availablePack.jurisdiction} - {availablePack.portal}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={12} />
          </span>
        </label>
        {staleHint ? (
          <span className="filing-pack__stale" title={`Oldest rule verified ${oldestVerified}`}>
            {staleHint}
          </span>
        ) : null}
      </div>
      <div className="filing-pack__summary">
        <p className="filing-pack__portal">{pack.portal}</p>
        <p className="filing-pack__court-system">{pack.courtSystem}</p>
        <p className="filing-pack__scope-note">{pack.scopeNote}</p>
      </div>
    </div>
  );
}

function CourtProfilePrompt({
  pack,
  profiles,
  selectedProfile,
  onSelect,
  onSave,
}: {
  pack: JurisdictionPack;
  profiles: readonly CourtProfile[];
  selectedProfile: CourtProfile | null;
  onSelect: (profileId: string) => void;
  onSave: (profile: { name: string; maxMegabytes: number }) => void;
}) {
  const needsProfile = pack.userConfigurable?.maxFileBytes === true && pack.maxFileBytes === undefined;
  const packProfiles = profiles.filter((profile) => profile.packId === pack.id);
  const [name, setName] = useState("");
  const [maxMegabytes, setMaxMegabytes] = useState("");

  useEffect(() => {
    setName("");
    setMaxMegabytes("");
  }, [pack.id]);

  if (!needsProfile) {
    return null;
  }

  return (
    <div className="filing-court-profile">
      <div className="filing-court-profile__intro">
        <p className="filing-court-profile__title">Court file-size cap</p>
        <p className="filing-court-profile__hint">Set your court's cap; without it, size checks stay unknown.</p>
      </div>
      {packProfiles.length > 0 ? (
        <label className="filing-court-profile__saved">
          <span>Saved profile</span>
          <select
            value={selectedProfile?.id ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="" disabled>Choose a profile</option>
            {packProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} - {formatBytes(profile.maxFileBytes)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <form
        className="filing-court-profile__form"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parsePositiveNumber(maxMegabytes);
          if (!name.trim() || parsed === null) {
            return;
          }
          onSave({ name: name.trim(), maxMegabytes: parsed });
        }}
      >
        <label>
          <span>Name</span>
          <input
            value={name}
            placeholder="S.D. Fla. - 50 MB"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          <span>Cap MB</span>
          <input
            inputMode="decimal"
            value={maxMegabytes}
            onChange={(event) => setMaxMegabytes(event.target.value)}
          />
        </label>
        <button type="submit" className="filing-card__secondary-button">
          Save profile
        </button>
      </form>
    </div>
  );
}

type StepRunStatus = "will-run" | "idle" | "done";

const STEP_RUN_STATUS_LABEL: Record<StepRunStatus, string> = {
  "will-run": "Will run",
  idle: "",
  done: "Done",
};

function computeStepRunStatus(checked: boolean, hasResult: boolean): StepRunStatus {
  if (!checked) {
    return "idle";
  }

  return hasResult ? "done" : "will-run";
}

function StepRunStatusChip({ status }: { status: StepRunStatus }) {
  if (status === "idle") {
    return null;
  }

  return (
    <span className="filing-prep-row__status" data-status={status}>
      {STEP_RUN_STATUS_LABEL[status]}
    </span>
  );
}

function PrepChecklist({
  steps,
  checkedSteps,
  unavailableSteps,
  hasResult,
  customSplitMegabytes,
  onCustomSplitMegabytesChange,
  stepDefaultsMessage,
  canSaveStepDefaults,
  onSaveStepDefaults,
  onToggle,
}: {
  steps: readonly PrepPlanStep[];
  checkedSteps: ReadonlySet<PrepPlanStepId>;
  unavailableSteps: ReadonlyMap<PrepPlanStepId, string>;
  hasResult: boolean;
  customSplitMegabytes: string;
  onCustomSplitMegabytesChange: (value: string) => void;
  stepDefaultsMessage: string | null;
  canSaveStepDefaults: boolean;
  onSaveStepDefaults: () => void;
  onToggle: (stepId: PrepPlanStepId) => void;
}) {
  const runnableSteps = steps.filter((step) => !step.disabledReason && !unavailableSteps.get(step.id));
  const activeCount = runnableSteps.filter((step) => checkedSteps.has(step.id)).length;
  // Item 6/7: one line per rule, default collapsed. Independent per-row
  // state (not a single-open accordion) -- comparing two rules' detail at
  // once is a reasonable thing to want, and there's no shared real estate
  // being fought over the way there is with the sidebar's tool groups.
  const [expandedStepIds, setExpandedStepIds] = useState<ReadonlySet<PrepPlanStepId>>(() => new Set());

  useEffect(() => {
    setExpandedStepIds(new Set());
  }, [steps]);

  function toggleExpanded(stepId: PrepPlanStepId) {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  }

  return (
    <section className="filing-prep" aria-label="Preparation checklist">
      <div className="filing-prep__header">
        <div>
          <p className="filing-prep__title">Prep checklist</p>
          <p className="filing-prep__subtitle">
            {activeCount} of {runnableSteps.length} step{runnableSteps.length === 1 ? "" : "s"} will run
          </p>
        </div>
        {canSaveStepDefaults ? (
          <div className="filing-prep__defaults">
            <button
              type="button"
              className="filing-prep__defaults-button"
              onClick={onSaveStepDefaults}
            >
              Set current selections as my defaults for this pack
            </button>
            {stepDefaultsMessage ? (
              <span className="filing-prep__defaults-message" role="status">
                {stepDefaultsMessage}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="filing-prep__rows" role="list">
        {steps.map((step) => (
          <PrepStepRow
            key={step.id}
            step={step}
            checked={checkedSteps.has(step.id)}
            unavailableReason={unavailableSteps.get(step.id)}
            hasResult={hasResult}
            expanded={expandedStepIds.has(step.id)}
            onToggleExpanded={() => toggleExpanded(step.id)}
            customSplitMegabytes={customSplitMegabytes}
            onCustomSplitMegabytesChange={onCustomSplitMegabytesChange}
            onToggle={() => onToggle(step.id)}
          />
        ))}
      </div>
    </section>
  );
}

function PrepStepRow({
  step,
  checked,
  unavailableReason,
  hasResult,
  expanded,
  onToggleExpanded,
  customSplitMegabytes,
  onCustomSplitMegabytesChange,
  onToggle,
}: {
  step: PrepPlanStep;
  checked: boolean;
  unavailableReason?: string | undefined;
  hasResult: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  customSplitMegabytes: string;
  onCustomSplitMegabytesChange: (value: string) => void;
  onToggle: () => void;
}) {
  // Product or engine availability can still lock a row. Jurisdiction-pack
  // stance is advisory and appears as the small flag beside the label.
  const planBlockedReason = step.disabledReason;
  const productUnavailableReason = unavailableReason;
  const blockedReason = planBlockedReason ?? productUnavailableReason;
  const disabled = Boolean(blockedReason);
  const descriptionId = `filing-step-${step.id}-body`;
  const showCustomSplit = step.id === "split-by-size" && checked && !disabled;
  const runStatus = computeStepRunStatus(checked, hasResult);
  const guidanceFlag = disabled ? null : getStepGuidanceFlag(step, checked);

  return (
    <article
      className="filing-prep-row"
      role="listitem"
      data-checked={checked ? "true" : "false"}
      data-disabled={disabled ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="filing-prep-row__main">
        <div className="filing-prep-row__toggle">
          <label className="filing-prep-row__checkbox-label">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              aria-describedby={expanded ? descriptionId : undefined}
              onChange={onToggle}
            />
            <span className="filing-prep-row__title">{step.label}</span>
          </label>
          {guidanceFlag ? <StepGuidanceFlag flag={guidanceFlag} stepLabel={step.label} /> : null}
        </div>
        <div className="filing-prep-row__meta">
          <StepRunStatusChip status={runStatus} />
          <button
            type="button"
            className="filing-prep-row__expand"
            aria-expanded={expanded}
            aria-controls={descriptionId}
            aria-label={`${expanded ? "Hide" : "Show"} details for ${step.label}`}
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon size={14} />
          </button>
        </div>
      </div>

      {expanded ? (
        <div id={descriptionId} className="filing-prep-row__body">
          <div className="filing-prep-row__stance-row">
            <StepStanceBadge stance={step.actionStance} />
          </div>
          {step.condition ? <p className="filing-prep-row__condition">{step.condition}</p> : null}
          {step.note ? <p className="filing-prep-row__note">{step.note}</p> : null}
          {planBlockedReason ? (
            <p className="filing-prep-row__blocked" data-tone="product">{capitalize(planBlockedReason)}.</p>
          ) : productUnavailableReason ? (
            <p className="filing-prep-row__blocked" data-tone="product">{capitalize(productUnavailableReason)}.</p>
          ) : null}
          {step.destructive ? (
            <div className="filing-prep-row__warning" data-tone={checked ? "active" : "quiet"}>
              <p className="filing-prep-row__warning-label">Detected impact</p>
              <p className="filing-prep-row__warning-text">{step.impact}</p>
            </div>
          ) : (
            <p className="filing-prep-row__impact">{step.impact}</p>
          )}
          {showCustomSplit ? (
            <label className="filing-prep-row__override">
              <span>Custom split size</span>
              <span className="filing-prep-row__override-input">
                <input
                  inputMode="decimal"
                  value={customSplitMegabytes}
                  placeholder="Pack default"
                  onChange={(event) => onCustomSplitMegabytesChange(event.target.value)}
                />
                <span>MB</span>
              </span>
            </label>
          ) : null}
          <p className="filing-prep-row__authority">{formatStepAuthority(step)}</p>
        </div>
      ) : null}
    </article>
  );
}

type StepGuidanceFlagModel = {
  tone: "warning" | "danger";
  summary: string;
  detail: string;
};

function StepGuidanceFlag({
  flag,
  stepLabel,
}: {
  flag: StepGuidanceFlagModel;
  stepLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();

  return (
    <span
      className="filing-prep-row__flag-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="filing-prep-row__flag"
        data-tone={flag.tone}
        aria-label={`${flag.summary} for ${stepLabel}`}
        aria-expanded={open}
        aria-describedby={open ? descriptionId : undefined}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span className="filing-prep-row__flag-shape" aria-hidden="true" />
      </button>
      {open ? (
        <span
          id={descriptionId}
          className="filing-prep-row__flag-popover"
          role="tooltip"
          data-tone={flag.tone}
        >
          <strong>{flag.summary}</strong>
          <span>{flag.detail}</span>
        </span>
      ) : null}
    </span>
  );
}

function getStepGuidanceFlag(step: PrepPlanStep, checked: boolean): StepGuidanceFlagModel | null {
  if (checked && step.actionStance === "prohibited") {
    return {
      tone: "danger",
      summary: "Pack guidance differs from this selection",
      detail: `Raio research indicates this step is not preferred in this jurisdiction. ${formatStepGuidanceCitation(step)}`,
    };
  }

  if (!checked && step.actionStance === "required") {
    return {
      tone: "warning",
      summary: "Expected by this jurisdiction",
      detail: `This jurisdiction expects this step. ${formatStepGuidanceCitation(step)}`,
    };
  }

  if (!checked && step.actionStance === "preferred") {
    return {
      tone: "warning",
      summary: "Recommended by this jurisdiction",
      detail: `Recommended for this jurisdiction. ${formatStepGuidanceCitation(step)}`,
    };
  }

  return null;
}

function StepStanceBadge({ stance }: { stance: PrepPlanStep["stance"] }) {
  return (
    <span className="filing-prep-row__stance" data-stance={stance}>
      {STANCE_LABEL[stance]}
    </span>
  );
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Item 6/7: the preflight report collapses into a "Prefiling check" section,
 * default-closed so a fresh dialog opens uncluttered. It opens itself once
 * there's already a completed result (the user just ran Prepare for Filing
 * and almost certainly wants to see the verification) -- a one-time initial
 * default, not a live subscription, so a manual collapse afterward sticks.
 * Loading/error status stays outside the collapse: those are live signals,
 * not detail to look up on demand.
 */
function PrefilingCheckSection({
  loadingReport,
  reportError,
  checks,
  selectionChecks,
  defaultOpen,
}: {
  loadingReport: boolean;
  reportError?: string | null;
  checks: readonly PreflightCheck[] | undefined;
  selectionChecks: readonly PreflightCheck[] | undefined;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(() => defaultOpen);
  const panelId = useId();
  const allChecks = [...(checks ?? []), ...(selectionChecks ?? [])];
  const flaggedCount = allChecks.filter((check) => check.status !== "pass").length;
  const summary = allChecks.length === 0
    ? null
    : flaggedCount === 0
      ? "All clear"
      : `${flaggedCount} to review`;

  return (
    <section className="filing-checks" aria-label="Preflight checks">
      <div className="filing-checks__header">
        <div className="filing-checks__title-row">
          <button
            type="button"
            className="filing-checks__toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDownIcon size={13} />
            Prefiling check
          </button>
          {summary ? <span className="filing-checks__summary">{summary}</span> : null}
        </div>
        <p className="filing-checks__subtitle">
          What a clerk might flag -- none of it blocks your export.
        </p>
      </div>
      {loadingReport ? (
        <p className="filing-card__status" role="status">
          <LoadingSun size={14} label="Reading document facts" />
          Reading document facts...
        </p>
      ) : null}
      {reportError ? (
        <p className="filing-card__status" role="status">
          {reportError}
        </p>
      ) : null}
      {open ? (
        <div id={panelId} className="filing-checks__rows" role="list">
          {checks?.map((check) => (
            <PreflightRow key={check.checkId} check={check} />
          ))}
          {selectionChecks?.map((check) => (
            <PreflightRow key={check.checkId} check={check} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PreflightRow({ check }: { check: PreflightCheck }) {
  const title = check.kind === "rule"
    ? `Checks page format against ${check.authority}`
    : check.authority;

  return (
    <article
      className="filing-row"
      data-kind={check.kind}
      data-status={check.status}
      title={title}
    >
      <div>
        <p className="filing-row__label">{check.label}</p>
        <p className="filing-row__detail">{check.detail}</p>
      </div>
      <span className="filing-row__chip">
        {formatStatus(check)}
      </span>
    </article>
  );
}

function GuidanceNote({ note }: { note: string }) {
  const email = "support@macrify.me";
  const [before, after = ""] = note.split(email);

  return (
    <p className="filing-card__guidance">
      {before}
      {note.includes(email) ? (
        <a href={`mailto:${email}`}>{email}</a>
      ) : null}
      {after}
    </p>
  );
}

function RulesApplied({ pack }: { pack: JurisdictionPack }) {
  return (
    <div className="filing-rules">
      <p>Pack version {pack.packVersion}</p>
      <dl>
        {pack.constraints.map((constraint) => (
          <div key={constraint.id}>
            <dt>{constraint.label}</dt>
            <dd>
              {constraint.authority} · last verified {constraint.lastVerified}
              {constraint.applicability.note ? ` · ${constraint.applicability.note}` : ""}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ResultCard({
  result,
  pack,
}: {
  result: FilingResultState;
  pack: JurisdictionPack;
}) {
  return (
    <section className="filing-result" aria-label="Filing output result">
      <div className="filing-result__header">
        <CheckIcon size={15} />
        <div>
          <p className="filing-result__title">Output preflight re-run complete</p>
          <p className="filing-result__subtitle">Verified after re-running preflight on the output.</p>
        </div>
      </div>
      <div className="filing-result__parts" role="list">
        {result.parts.map((part) => (
          <div key={part.fileName} className="filing-result__part" role="listitem">
            <span className="filing-result__part-name">{part.fileName}</span>
            <span className="filing-result__part-size">{formatBytes(part.byteLength)}</span>
          </div>
        ))}
      </div>
      <div className="filing-result__footer">
        {result.savedDirectoryPath ? (
          <p className="filing-result__fine filing-result__saved-path">
            Saved to {result.savedDirectoryPath}.
          </p>
        ) : null}
        <p className="filing-result__fine">
          Pack {pack.packVersion}; final report generated {result.verifiedAt}.
        </p>
        {result.skippedSteps.length > 0 ? (
          <p className="filing-result__fine">
            Skipped: {result.skippedSteps.join("; ")}.
          </p>
        ) : null}
        {result.overrides.length > 0 ? (
          <p className="filing-result__fine">
            Overrides: {result.overrides.join("; ")}.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function formatStatus(check: PreflightCheck): string {
  if (check.status === "unknown") {
    return "not checked";
  }

  if (check.kind === "portal" && check.status === "warn") {
    return "warning";
  }

  if (check.kind === "rule" && check.status === "warn") {
    return "review";
  }

  return "OK";
}

function formatProgressLabel(phase: FilingProgressPhase): string {
  if (phase === "normalizing") {
    return "Normalizing";
  }

  if (phase === "splitting") {
    return "Splitting";
  }

  if (phase === "converting") {
    return "Converting";
  }

  if (phase === "verifying") {
    return "Verifying";
  }

  if (phase === "done") {
    return "Verified";
  }

  if (phase === "error") {
    return "Needs attention";
  }

  return "Ready";
}

function isFilingProgressActive(phase: FilingProgressPhase): boolean {
  return phase === "normalizing" ||
    phase === "splitting" ||
    phase === "converting" ||
    phase === "verifying";
}

function latestDate(constraints: readonly ConstraintEntry[]): string {
  return constraints
    .map((constraint) => constraint.lastVerified)
    .sort()
    .at(-1) ?? "unknown";
}

function oldestPolicyDate(pack: JurisdictionPack): string {
  const dates = [
    ...pack.constraints.map((constraint) => constraint.lastVerified),
    pack.pdfa.lastVerified,
    pack.activeContent.lastVerified,
    pack.encryption.lastVerified,
    pack.embeddedFiles.lastVerified,
    pack.metadataScrub.lastVerified,
    pack.ocr.lastVerified,
    pack.flattenForms.lastVerified,
  ].filter((date): date is string => Boolean(date)).sort();

  return dates[0] ?? "unknown";
}

function packStalenessHint(oldestVerified: string): string | null {
  const verifiedDate = new Date(`${oldestVerified}T00:00:00.000Z`);

  if (Number.isNaN(verifiedDate.getTime())) {
    return null;
  }

  const months = Math.floor((Date.now() - verifiedDate.getTime()) / (1000 * 60 * 60 * 24 * 30));

  return months > 6 ? `verified ${months} months ago` : null;
}

function defaultCheckedSteps(
  steps: readonly PrepPlanStep[],
  unavailableSteps: ReadonlyMap<PrepPlanStepId, string> = new Map(),
  overrides: Partial<Record<PrepPlanStepId, boolean>> | undefined = undefined,
): Set<PrepPlanStepId> {
  return new Set(
    steps
      .filter((step) => (overrides?.[step.id] ?? step.defaultChecked) && !step.disabledReason && !unavailableSteps.get(step.id))
      .map((step) => step.id),
  );
}

function resolveUnavailableSteps(
  steps: readonly PrepPlanStep[],
  availability: { pdfAAvailable: boolean },
  extraUnavailableSteps?: ReadonlyMap<PrepPlanStepId, string>,
): ReadonlyMap<PrepPlanStepId, string> {
  // Caller-supplied reasons (the streamed closed-form rule [R7-1]) win over
  // the generic engine-availability reason below.
  const unavailable = new Map<PrepPlanStepId, string>(extraUnavailableSteps ?? []);

  for (const step of steps) {
    if (
      !availability.pdfAAvailable &&
      !unavailable.has(step.id) &&
      (step.id === "sanitize-content" || step.id === "make-searchable" || step.id === "convert-pdfa")
    ) {
      unavailable.set(step.id, "available in the desktop app");
    }
  }

  return unavailable;
}

const STANCE_LABEL: Record<PrepPlanStep["stance"], string> = {
  required: "Required",
  preferred: "Preferred",
  accepted: "Accepted",
  prohibited: "Not preferred",
  unknown: "Unknown",
  standard: "Standard prep",
};

// Mirrors packages/rules/src/prepPlan.ts's internal UNKNOWN_LAST_VERIFIED
// sentinel -- that module doesn't export it, so a genuinely-unverified date
// never surfaces as a fake 1970 timestamp in the UI.
const UNVERIFIED_SENTINEL = "1970-01-01";

function formatStepAuthority(step: PrepPlanStep): string {
  if (!step.lastVerified || step.lastVerified === UNVERIFIED_SENTINEL) {
    return step.authority;
  }

  return `${step.authority} - verified ${step.lastVerified}`;
}

function formatStepGuidanceCitation(step: PrepPlanStep): string {
  const verified = !step.lastVerified || step.lastVerified === UNVERIFIED_SENTINEL
    ? ""
    : `, verified ${step.lastVerified}`;
  const note = step.note ? ` ${step.note}` : "";

  return `${step.authority}${verified}.${note}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

const PHASE_SEQUENCE = ["normalizing", "splitting", "converting", "verifying"] as const;

const PHASE_STEP_LABEL: Record<(typeof PHASE_SEQUENCE)[number], string> = {
  normalizing: "Normalize",
  splitting: "Split",
  converting: "Convert",
  verifying: "Verify",
};

function filingProgressSteps(phase: FilingProgressPhase): LongProcessStep[] {
  const currentIndex = PHASE_SEQUENCE.findIndex((step) => step === phase);

  return PHASE_SEQUENCE.map((step, index) => ({
    id: step,
    label: PHASE_STEP_LABEL[step],
    state: index < currentIndex ? "done" : index === currentIndex ? "active" : "pending",
  }));
}

function parsePositiveNumber(value: string): number | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatPageCount(pageCount: number): string {
  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
