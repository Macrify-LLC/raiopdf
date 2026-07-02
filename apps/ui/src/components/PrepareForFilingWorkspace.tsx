import { useMemo, useState, type FormEvent } from "react";
import type {
  ConstraintEntry,
  JurisdictionPack,
  PreflightCheck,
  PreflightReport,
} from "../../../../packages/rules/src/types";
import type { DocumentState } from "../hooks/useDocument";
import { BoltIcon, CheckIcon, ChevronDownIcon } from "../icons";
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

export interface PrepareForFilingWorkspaceProps {
  document: DocumentState;
  pack: JurisdictionPack;
  report: PreflightReport | null;
  loadingReport: boolean;
  progress: FilingProgressState;
  result: FilingResultState | null;
  pdfAAvailable: boolean;
  onPrepare: (certificate: CertificateOfServiceDraft | null) => void;
}

export function PrepareForFilingWorkspace({
  document,
  pack,
  report,
  loadingReport,
  progress,
  result,
  pdfAAvailable,
  onPrepare,
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
  const hasFixes = Boolean(report?.checks.some((check) => check.kind === "portal" && check.status === "fix"));
  const needsPdfA = Boolean(report?.checks.some((check) => check.checkId === "pdfa" && check.status !== "pass"));
  const needsMechanicalWork = Boolean(report?.checks.some((check) => check.status !== "pass"));
  const primaryLabel = hasFixes || needsMechanicalWork
    ? "Make Filing-Ready"
    : "Export PDF/A for ePortal";
  const canPrepare = Boolean(document.bytes && report) &&
    progress.phase !== "normalizing" &&
    progress.phase !== "splitting" &&
    progress.phase !== "converting" &&
    progress.phase !== "verifying" &&
    !(needsPdfA && !pdfAAvailable);

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

        <div className="filing-card__jurisdiction" title={`Last verified ${latestVerified}`}>
          <span>{pack.name} — Rule 2.520/2.525 + ePortal</span>
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
              <option value={pack.id}>{pack.name}</option>
            </select>
          </label>
        </div>

        {!document.bytes ? (
          <p className="filing-card__empty">Open a PDF before preparing a filing copy.</p>
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
            <p className="filing-card__status" role="status">Reading document facts...</p>
          ) : null}
          {activeReport?.checks.map((check) => (
            <PreflightRow key={check.checkId} check={check} />
          ))}
        </div>

        {!pdfAAvailable && needsPdfA ? (
          <p className="filing-card__unavailable" role="status">
            PDF/A export runs in the desktop app. Normalize and split remain available here.
          </p>
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
          <button
            type="button"
            className="filing-card__primary-button"
            disabled={!canPrepare}
            onClick={() => onPrepare(certificateOpen ? certificate : null)}
          >
            {primaryLabel}
          </button>
        </footer>
      </div>
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

  if (check.kind === "portal" && check.status === "fix") {
    return "WILL FIX";
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
