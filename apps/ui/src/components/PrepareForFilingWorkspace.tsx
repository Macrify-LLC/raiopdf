import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ConstraintEntry,
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
import { BoltIcon, CheckIcon, ChevronDownIcon } from "../icons";
import { LoadingSun } from "./LoadingSun";
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
  skippedSteps: readonly string[];
  overrides: readonly string[];
}

export interface CertificateOfServiceDraft {
  caseCaption: string;
  serviceList: string;
  date: string;
}

export interface PrepareOptions {
  /** The user saw the conversion-impact warning and chose to continue anyway. */
  acknowledgeImpact?: boolean;
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
}

export interface PrepareForFilingWorkspaceProps {
  document: DocumentState;
  pack: JurisdictionPack;
  availablePacks?: readonly JurisdictionPack[];
  prepPlan: readonly PrepPlanStep[];
  courtProfiles: readonly CourtProfile[];
  selectedCourtProfile: CourtProfile | null;
  report: PreflightReport | null;
  loadingReport: boolean;
  progress: FilingProgressState;
  result: FilingResultState | null;
  impact: FilingImpactState | null;
  pdfAAvailable: boolean;
  compressAvailable: boolean;
  onPackChange: (packId: JurisdictionPackId) => void;
  onCourtProfileSelect: (profileId: string) => void;
  onCourtProfileSave: (profile: { name: string; maxMegabytes: number }) => void;
  onPrepare: (certificate: CertificateOfServiceDraft | null, options: PrepareOptions) => void;
  onDismissImpact: () => void;
  onCompressFirst: () => void;
}

export function PrepareForFilingWorkspace({
  document,
  pack,
  availablePacks = [pack],
  prepPlan,
  courtProfiles,
  selectedCourtProfile,
  report,
  loadingReport,
  progress,
  result,
  impact,
  pdfAAvailable,
  compressAvailable,
  onPackChange,
  onCourtProfileSelect,
  onCourtProfileSave,
  onPrepare,
  onDismissImpact,
  onCompressFirst,
}: PrepareForFilingWorkspaceProps) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [certificateOpen, setCertificateOpen] = useState(false);
  const [checkedSteps, setCheckedSteps] = useState<Set<PrepPlanStepId>>(() => defaultCheckedSteps(prepPlan));
  const [customSplitMegabytes, setCustomSplitMegabytes] = useState("");
  const [certificate, setCertificate] = useState<CertificateOfServiceDraft>({
    caseCaption: "",
    serviceList: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const latestVerified = useMemo(() => latestDate(pack.constraints), [pack.constraints]);
  const oldestVerified = useMemo(() => oldestPolicyDate(pack), [pack]);
  const activeReport = result?.report ?? report;
  const unavailableSteps = useMemo(
    () => resolveUnavailableSteps(prepPlan, {
      pdfAAvailable,
    }),
    [pdfAAvailable, prepPlan],
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
  // Gate on "this pack will convert", not on the report's pdfa status — an input
  // that already passes the PDF/A check still gets converted by the pipeline, so
  // the button must stay disabled wherever the conversion engine is unavailable.
  const canPrepare = Boolean(document.bytes && report) &&
    progress.phase !== "normalizing" &&
    progress.phase !== "splitting" &&
    progress.phase !== "converting" &&
    progress.phase !== "verifying" &&
    !impact;
  const prepareOptions = (): PrepareOptions => ({
    selectedStepIds: selectedAvailableStepIds,
    customSplitMegabytes: parsePositiveNumber(customSplitMegabytes),
  });

  useEffect(() => {
    setCheckedSteps(defaultCheckedSteps(prepPlan, unavailableSteps));
  }, [prepPlan, unavailableSteps]);

  function submitCertificate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCertificateOpen(false);
    setOverflowOpen(false);
  }

  return (
    <section className="filing-workspace" aria-label="Prepare for Filing">
      <div className="filing-card">
        <header className="filing-card__header">
          <div className="filing-card__title-row">
            <span className="filing-card__icon" aria-hidden="true">
              <BoltIcon variant="outline" size={17} />
            </span>
            <div>
              <p className="filing-card__eyebrow">Legal</p>
              <h2>Prepare for Filing</h2>
              <p className="filing-card__document-line">
                {document.fileName ?? "No document"} · {formatPageCount(document.pageCount)}
              </p>
            </div>
          </div>
          <div className="filing-card__overflow">
            <button
              type="button"
              className="filing-card__icon-button"
              aria-label="Prepare for Filing menu"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((current) => !current)}
            >
              ⋯
            </button>
            {overflowOpen ? (
              <div className="filing-card__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCertificateOpen(true);
                    setOverflowOpen(false);
                  }}
                >
                  Insert Certificate of Service page...
                </button>
              </div>
            ) : null}
          </div>
        </header>

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
          customSplitMegabytes={customSplitMegabytes}
          onCustomSplitMegabytesChange={setCustomSplitMegabytes}
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

        <div className="filing-card__primary-row">
          <button
            type="button"
            className="filing-card__primary-button"
            disabled={!canPrepare}
            onClick={() => onPrepare(certificateOpen ? certificate : null, prepareOptions())}
          >
            {primaryLabel}
          </button>
        </div>

        {!document.bytes ? (
          <p className="filing-card__empty">Open a PDF before preparing a filing copy.</p>
        ) : null}

        {impact ? (
          <ImpactWarning
            impact={impact}
            onContinue={() => onPrepare(certificateOpen ? certificate : null, {
              ...prepareOptions(),
              acknowledgeImpact: true,
            })}
            onCancel={onDismissImpact}
          />
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

        <div className="filing-checks" aria-label="Preflight checks">
          {loadingReport ? (
            <p className="filing-card__status" role="status">
              <LoadingSun size={14} label="Reading document facts" />
              Reading document facts...
            </p>
          ) : null}
          {activeReport?.checks.map((check) => (
            <PreflightRow key={check.checkId} check={check} />
          ))}
          {activeReport?.selectionChecks?.map((check) => (
            <PreflightRow key={check.checkId} check={check} />
          ))}
        </div>

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

        {progress.message ? (
          <div className="filing-progress" data-phase={progress.phase} role="status" aria-live="polite">
            <p className="filing-progress__label">
              {isFilingProgressActive(progress.phase) ? (
                <LoadingSun size={14} label="Preparing filing output" />
              ) : null}
              {formatProgressLabel(progress.phase)}
            </p>
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
}

function ImpactWarning({
  impact,
  onContinue,
  onCancel,
}: {
  impact: FilingImpactState;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const lines = describeImpact(impact);

  return (
    <div className="filing-impact" role="alertdialog" aria-label="Prepare for Filing will remove document features">
      <p className="filing-impact__title">Stopped before anything was changed</p>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="filing-impact__hint">
        {impact.unappliedRedactionMarks > 0
          ? "Apply your redactions first, then run Prepare for Filing again."
          : "If these features are load-bearing — an unsigned form, a signature you need intact — cancel and handle them first."}
      </p>
      <div className="filing-card__button-row">
        <button type="button" className="filing-card__secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="filing-card__ghost-button" onClick={onContinue}>
          Continue anyway
        </button>
      </div>
    </div>
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
    <div className="filing-card__jurisdiction" title={`${pack.scopeNote} Oldest rule verified ${oldestVerified}`}>
      <label className="filing-card__pack-select">
        <span>Jurisdiction</span>
        <select
          value={pack.id}
          aria-label="Jurisdiction pack"
          onChange={(event) => onPackChange(event.target.value as JurisdictionPackId)}
        >
          {availablePacks.map((availablePack) => (
            <option key={availablePack.id} value={availablePack.id}>
              {availablePack.jurisdiction} - {availablePack.portal} - {availablePack.scopeNote}
            </option>
          ))}
        </select>
      </label>
      <span>{pack.courtSystem}</span>
      {staleHint ? <span className="filing-card__stale">{staleHint}</span> : null}
      <p className="filing-card__scope-note">{pack.scopeNote}</p>
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
    <form
      className="filing-court-profile"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parsePositiveNumber(maxMegabytes);
        if (!name.trim() || parsed === null) {
          return;
        }
        onSave({ name: name.trim(), maxMegabytes: parsed });
      }}
    >
      <div>
        <p className="filing-court-profile__title">Court file-size cap</p>
        <p>Set your court's cap; without it, size checks stay unknown.</p>
      </div>
      {packProfiles.length > 0 ? (
        <label>
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
  );
}

function PrepChecklist({
  steps,
  checkedSteps,
  unavailableSteps,
  customSplitMegabytes,
  onCustomSplitMegabytesChange,
  onToggle,
}: {
  steps: readonly PrepPlanStep[];
  checkedSteps: ReadonlySet<PrepPlanStepId>;
  unavailableSteps: ReadonlyMap<PrepPlanStepId, string>;
  customSplitMegabytes: string;
  onCustomSplitMegabytesChange: (value: string) => void;
  onToggle: (stepId: PrepPlanStepId) => void;
}) {
  return (
    <section className="filing-prep" aria-label="Preparation checklist">
      <div className="filing-prep__header">
        <p>Prep checklist</p>
      </div>
      <div className="filing-prep__rows">
        {steps.map((step) => (
          <PrepStepRow
            key={step.id}
            step={step}
            checked={checkedSteps.has(step.id)}
            unavailableReason={unavailableSteps.get(step.id)}
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
  customSplitMegabytes,
  onCustomSplitMegabytesChange,
  onToggle,
}: {
  step: PrepPlanStep;
  checked: boolean;
  unavailableReason?: string | undefined;
  customSplitMegabytes: string;
  onCustomSplitMegabytesChange: (value: string) => void;
  onToggle: () => void;
}) {
  const disabledReason = step.disabledReason ?? unavailableReason;

  return (
    <article
      className="filing-prep-row"
      data-checked={checked ? "true" : "false"}
      data-disabled={disabledReason ? "true" : "false"}
    >
      <label className="filing-prep-row__toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={Boolean(disabledReason)}
          onChange={onToggle}
        />
        <span>
          <span className="filing-prep-row__title">{step.label}</span>
          <span className="filing-prep-row__detail">
            {formatStance(step.stance)}
            {step.condition ? ` - ${step.condition}` : ""}
            {disabledReason ? ` - ${disabledReason}` : ""}
          </span>
        </span>
      </label>
      <p className="filing-prep-row__impact">{step.impact}</p>
      <p className="filing-prep-row__authority">{step.authority}</p>
      {step.id === "split-by-size" && checked && !disabledReason ? (
        <label className="filing-prep-row__override">
          <span>Custom MB</span>
          <input
            inputMode="decimal"
            value={customSplitMegabytes}
            placeholder="Pack default"
            onChange={(event) => onCustomSplitMegabytesChange(event.target.value)}
          />
        </label>
      ) : null}
    </article>
  );
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
          <p>Verified after re-running preflight on the output.</p>
        </div>
      </div>
      <div className="filing-result__parts" role="list">
        {result.parts.map((part) => (
          <div key={part.fileName} className="filing-result__part" role="listitem">
            <span>{part.fileName}</span>
            <span>{formatBytes(part.byteLength)}</span>
          </div>
        ))}
      </div>
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
): Set<PrepPlanStepId> {
  return new Set(
    steps
      .filter((step) => step.defaultChecked && !step.disabledReason && !unavailableSteps.get(step.id))
      .map((step) => step.id),
  );
}

function resolveUnavailableSteps(
  steps: readonly PrepPlanStep[],
  availability: { pdfAAvailable: boolean },
): ReadonlyMap<PrepPlanStepId, string> {
  const unavailable = new Map<PrepPlanStepId, string>();

  for (const step of steps) {
    if (step.id === "remove-encryption") {
      unavailable.set(step.id, "not yet available in Raio");
    }

    if (
      !availability.pdfAAvailable &&
      (step.id === "sanitize-content" || step.id === "make-searchable" || step.id === "convert-pdfa")
    ) {
      unavailable.set(step.id, "available in the desktop app");
    }
  }

  return unavailable;
}

function formatStance(stance: PrepPlanStep["stance"]): string {
  if (stance === "standard") {
    return "standard prep";
  }

  return stance;
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
