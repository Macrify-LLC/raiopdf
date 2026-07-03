import { useMemo, useState, type FormEvent } from "react";
import { shouldConvertToPdfA } from "@raiopdf/rules";
import type {
  ConstraintEntry,
  JurisdictionPack,
  PreflightCheck,
  PreflightReport,
} from "@raiopdf/rules";
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
}

export interface CertificateOfServiceDraft {
  caseCaption: string;
  serviceList: string;
  date: string;
}

export interface PrepareOptions {
  /** The user saw the conversion-impact warning and chose to continue anyway. */
  acknowledgeImpact?: boolean;
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
  report: PreflightReport | null;
  loadingReport: boolean;
  progress: FilingProgressState;
  result: FilingResultState | null;
  impact: FilingImpactState | null;
  pdfAAvailable: boolean;
  compressAvailable: boolean;
  onPrepare: (certificate: CertificateOfServiceDraft | null, options?: PrepareOptions) => void;
  onDismissImpact: () => void;
  onCompressFirst: () => void;
}

export function PrepareForFilingWorkspace({
  document,
  pack,
  availablePacks = [pack],
  report,
  loadingReport,
  progress,
  result,
  impact,
  pdfAAvailable,
  compressAvailable,
  onPrepare,
  onDismissImpact,
  onCompressFirst,
}: PrepareForFilingWorkspaceProps) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [packSelectOpen, setPackSelectOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [certificateOpen, setCertificateOpen] = useState(false);
  const [certificate, setCertificate] = useState<CertificateOfServiceDraft>({
    caseCaption: "",
    serviceList: "",
    date: new Date().toISOString().slice(0, 10),
  });
  const latestVerified = useMemo(() => latestDate(pack.constraints), [pack.constraints]);
  const activeReport = result?.report ?? report;
  const convertsToPdfA = shouldConvertToPdfA(pack);
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
    !impact &&
    !(convertsToPdfA && !pdfAAvailable);

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

        <div className="filing-card__jurisdiction" title={`${pack.scopeNote} Last verified ${latestVerified}`}>
          <span>{pack.jurisdiction} — {pack.portal}</span>
          <span>{pack.courtSystem}</span>
          <button
            type="button"
            className="filing-card__change-button"
            aria-expanded={packSelectOpen}
            onClick={() => setPackSelectOpen((current) => !current)}
          >
            (change)
          </button>
          <label className="filing-card__pack-select">
            <span>Jurisdiction</span>
            <select value={pack.id} disabled aria-label="Jurisdiction pack">
              {availablePacks.map((availablePack) => (
                <option key={availablePack.id} value={availablePack.id}>
                  {availablePack.jurisdiction} — {availablePack.portal}
                </option>
              ))}
            </select>
          </label>
          <p className="filing-card__scope-note">{pack.scopeNote}</p>
        </div>

        <div className="filing-card__primary-row">
          <button
            type="button"
            className="filing-card__primary-button"
            disabled={!canPrepare}
            onClick={() => onPrepare(certificateOpen ? certificate : null)}
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
            onContinue={() => onPrepare(certificateOpen ? certificate : null, { acknowledgeImpact: true })}
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

        {!pdfAAvailable && convertsToPdfA ? (
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

function formatPageCount(pageCount: number): string {
  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
