import { useEffect, useMemo, useState } from "react";
import type { AuthorityKind, DetectedAuthority, PageTextByPage } from "@raiopdf/rules";
import { detectAuthorities, reporterTable } from "@raiopdf/rules";
import type { DocumentFileInput, DocumentState } from "../hooks/useDocument";
import {
  buildTableOfAuthoritiesOptions,
  saveToaPdf,
  type ReviewedAuthorityEntry,
} from "../lib/toaActions";
import { generateToaPdf } from "../lib/toaPreview";
import {
  HelpIcon,
  InsertIcon,
  OcrSearchIcon,
  PlusIcon,
  SaveIcon,
  ScaleIcon,
} from "../icons";
import { IconButton } from "./IconButton";
import { LoadingSun } from "./LoadingSun";
import { PdfMiniThumb } from "./PdfMiniThumb";
import "./TableOfAuthoritiesWorkspace.css";

type DetectionPhase = "idle" | "detecting" | "ready" | "garbled" | "unavailable" | "error";

interface AuthorityReviewRow {
  id: string;
  kind: AuthorityKind;
  citation: string;
  pageIndexes: readonly number[];
  excluded: boolean;
  source: "detected" | "manual";
}

interface ManualAuthorityDraft {
  kind: AuthorityKind;
  citation: string;
  pages: string;
}

export interface TableOfAuthoritiesWorkspaceProps {
  document: DocumentState;
  extractPageTextByPage: (bytes: Uint8Array) => Promise<PageTextByPage>;
  onPrependTable: (file: DocumentFileInput, insertAtPageIndex: number) => Promise<boolean>;
  onForceOcr: () => void;
  onCancel: () => void;
  onHelpRequested?: (() => void) | undefined;
}

const AUTHORITY_GROUPS: ReadonlyArray<{ kind: AuthorityKind; label: string }> = [
  { kind: "case", label: "Cases" },
  { kind: "statute", label: "Statutes" },
  { kind: "rule", label: "Rules" },
  { kind: "constitutional", label: "Constitutional Provisions" },
  { kind: "other", label: "Other" },
];

const DEFAULT_MANUAL_DRAFT: ManualAuthorityDraft = {
  kind: "case",
  citation: "",
  pages: "",
};

export function TableOfAuthoritiesWorkspace({
  document,
  extractPageTextByPage,
  onPrependTable,
  onForceOcr,
  onCancel,
  onHelpRequested,
}: TableOfAuthoritiesWorkspaceProps) {
  const [phase, setPhase] = useState<DetectionPhase>("idle");
  const [rows, setRows] = useState<AuthorityReviewRow[]>([]);
  const [passimThreshold, setPassimThreshold] = useState("5");
  const [manualDraft, setManualDraft] = useState<ManualAuthorityDraft>(DEFAULT_MANUAL_DRAFT);
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const passimValue = parseInteger(passimThreshold);
  const reviewedEntries = useMemo<ReviewedAuthorityEntry[]>(
    () => rows.map((row) => ({
      kind: row.kind,
      citation: row.citation,
      pageIndexes: row.pageIndexes,
      excluded: row.excluded,
    })),
    [rows],
  );
  const includedRows = rows.filter((row) => !row.excluded && row.citation.trim() && row.pageIndexes.length > 0);
  const canOutput = includedRows.length > 0 && passimValue !== null && !working;
  const canPrepend = canOutput && document.source?.kind === "memory" && Boolean(document.bytes);
  const garbledPages = document.textLayerCoverage?.garbledPages ?? [];

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  useEffect(() => {
    let disposed = false;
    const sourceBytes = document.bytes;

    setPreviewBytes(null);
    setStatus(null);
    setRows([]);
    setMergeTargets({});

    if (!sourceBytes) {
      setPhase("unavailable");
      setStatus(document.source ? "Table of Authorities needs a standard in-memory PDF." : "Open a PDF to build a Table of Authorities.");
      return () => {
        disposed = true;
      };
    }

    if (garbledPages.length > 0) {
      setPhase("garbled");
      setStatus("Hidden text looks garbled. Redo searchable text before scanning citations.");
      return () => {
        disposed = true;
      };
    }

    setPhase("detecting");
    setStatus("Scanning citations in the open PDF...");

    void extractPageTextByPage(sourceBytes)
      .then((pages) => {
        if (disposed) {
          return;
        }

        const detected = detectAuthorities(pages, reporterTable);
        setRows(detected.map(rowFromDetectedAuthority));
        setPhase("ready");
        setStatus(detected.length > 0
          ? `Found ${detected.length} cited ${detected.length === 1 ? "authority" : "authorities"}.`
          : "No citations were detected. Add missed authorities manually.");
      })
      .catch(() => {
        if (!disposed) {
          setPhase("error");
          setStatus("RaioPDF could not read the page text. Try reopening or repairing the PDF.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [document.bytes, document.generation, document.source, extractPageTextByPage, garbledPages.length]);

  useEffect(() => {
    if (!canOutput || passimValue === null) {
      setPreviewBytes(null);
      return;
    }

    let disposed = false;
    const timeout = window.setTimeout(() => {
      setPreviewBytes(null);
      void generateToaPdf(buildTableOfAuthoritiesOptions(reviewedEntries, passimValue))
        .then((bytes) => {
          if (!disposed) {
            setPreviewBytes(bytes);
          }
        })
        .catch(() => {
          if (!disposed) {
            setPreviewBytes(null);
          }
        });
    }, 180);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [canOutput, passimValue, reviewedEntries]);

  function updateRow(id: string, patch: Partial<AuthorityReviewRow>) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  function mergeRow(sourceId: string) {
    const targetId = mergeTargets[sourceId];
    if (!targetId || targetId === sourceId) {
      return;
    }

    setRows((current) => {
      const source = current.find((row) => row.id === sourceId);
      const target = current.find((row) => row.id === targetId);

      if (!source || !target) {
        return current;
      }

      return current
        .filter((row) => row.id !== sourceId)
        .map((row) => row.id === targetId
          ? {
            ...row,
            pageIndexes: normalizePageIndexes([...row.pageIndexes, ...source.pageIndexes]),
            excluded: row.excluded && source.excluded,
          }
          : row);
    });
    setMergeTargets((current) => {
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
    setStatus("Authorities merged.");
  }

  function addManualAuthority() {
    const citation = manualDraft.citation.trim();
    const pageIndexes = parsePageList(manualDraft.pages, document.pageCount);

    if (!citation) {
      setStatus("Citation text is required.");
      return;
    }

    if (pageIndexes.length === 0) {
      setStatus("Add at least one valid page number.");
      return;
    }

    setRows((current) => [
      ...current,
      {
        id: makeId("manual-authority"),
        kind: manualDraft.kind,
        citation,
        pageIndexes,
        excluded: false,
        source: "manual",
      },
    ]);
    setManualDraft(DEFAULT_MANUAL_DRAFT);
    setStatus("Authority added.");
  }

  async function savePdf() {
    if (!canOutput || passimValue === null) {
      setStatus(outputValidationMessage(passimValue));
      return;
    }

    setWorking(true);
    setStatus("Rendering Table of Authorities...");

    try {
      const saved = await saveToaPdf(reviewedEntries, passimValue, toaFileName(document.fileName));
      setStatus(saved ? `Saved ${saved.name}.` : "Save cancelled.");
    } catch {
      setStatus("The Table of Authorities PDF could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function prependTable() {
    if (!canOutput || passimValue === null) {
      setStatus(outputValidationMessage(passimValue));
      return;
    }

    if (!canPrepend) {
      setStatus(document.source ? "Prepend is available for standard in-memory documents." : "Open a PDF before prepending a Table of Authorities.");
      return;
    }

    setWorking(true);
    setStatus("Rendering Table of Authorities...");

    try {
      const bytes = await generateToaPdf(buildTableOfAuthoritiesOptions(reviewedEntries, passimValue));
      const inserted = await onPrependTable(
        { bytes, name: toaFileName(document.fileName), path: null },
        0,
      );
      setStatus(inserted ? "Table of Authorities prepended to the open PDF." : "The Table of Authorities could not be prepended.");
      if (inserted) {
        onCancel();
      }
    } catch {
      setStatus("The Table of Authorities could not be prepended.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="toa-workspace" aria-label="Table of Authorities workspace">
      <header className="toa-workspace__header">
        <div>
          <p className="toa-workspace__eyebrow">Legal</p>
          <h2>Table of Authorities</h2>
        </div>
        <div className="toa-workspace__header-actions">
          {onHelpRequested ? (
            <IconButton
              icon={<HelpIcon size={14} />}
              label="Help: Table of Authorities"
              onClick={onHelpRequested}
            />
          ) : null}
          <button type="button" className="toa-workspace__ghost" onClick={onCancel}>
            Back to document
          </button>
        </div>
      </header>

      {phase === "garbled" ? (
        <GarbledGate garbledPages={garbledPages} onForceOcr={onForceOcr} />
      ) : phase === "unavailable" ? (
        <EmptyState title="Open a standard PDF" detail={status ?? "Table of Authorities needs PDF bytes from the open document."} />
      ) : (
        <div className="toa-workspace__grid">
          <section className="toa-card toa-card--review" aria-label="Detected authorities">
            <div className="toa-card__title-row">
              <p className="toa-card__label">Review citations</p>
              <span>{includedRows.length} included / {rows.length} found</span>
            </div>

            {phase === "detecting" ? (
              <DetectingState />
            ) : rows.length === 0 ? (
              <EmptyState title="No detected citations" detail="Add missed authorities below, then save or prepend the finished table." />
            ) : (
              <div className="toa-groups">
                {AUTHORITY_GROUPS.map((group) => (
                  <AuthorityGroup
                    key={group.kind}
                    group={group}
                    rows={rows.filter((row) => row.kind === group.kind)}
                    allRows={rows}
                    mergeTargets={mergeTargets}
                    onRowChange={updateRow}
                    onMergeTargetChange={(rowId, targetId) =>
                      setMergeTargets((current) => ({ ...current, [rowId]: targetId }))}
                    onMerge={mergeRow}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="toa-card toa-card--controls" aria-label="Table of Authorities controls">
            <p className="toa-card__label">Build table</p>
            <label className="toa-field toa-field--compact">
              <span>Passim threshold</span>
              <input
                type="number"
                min={0}
                step={1}
                value={passimThreshold}
                onChange={(event) => setPassimThreshold(event.currentTarget.value)}
              />
            </label>
            <p className="toa-card__hint">
              Authorities cited on more than this many pages render as passim.
            </p>

            <div className="toa-add" aria-label="Add missed authority">
              <div className="toa-card__title-row">
                <p className="toa-card__label">Add missed authority</p>
              </div>
              <label className="toa-field">
                <span>Kind</span>
                <select
                  value={manualDraft.kind}
                  onChange={(event) => {
                    const kind = event.currentTarget.value as AuthorityKind;
                    setManualDraft((current) => ({ ...current, kind }));
                  }}
                >
                  {AUTHORITY_GROUPS.map((group) => (
                    <option key={group.kind} value={group.kind}>{group.label}</option>
                  ))}
                </select>
              </label>
              <label className="toa-field">
                <span>Citation</span>
                <input
                  value={manualDraft.citation}
                  placeholder="123 So. 3d 456"
                  onChange={(event) => {
                    const citation = event.currentTarget.value;
                    setManualDraft((current) => ({ ...current, citation }));
                  }}
                />
              </label>
              <label className="toa-field">
                <span>Pages</span>
                <input
                  value={manualDraft.pages}
                  placeholder="1, 4-6"
                  onChange={(event) => {
                    const pages = event.currentTarget.value;
                    setManualDraft((current) => ({ ...current, pages }));
                  }}
                />
              </label>
              <button type="button" className="toa-workspace__secondary" onClick={addManualAuthority}>
                <PlusIcon size={15} />
                Add authority
              </button>
            </div>
          </section>

          <section className="toa-card toa-card--preview" aria-label="Table of Authorities preview">
            <div className="toa-card__title-row">
              <p className="toa-card__label">Preview</p>
              <span>{includedRows.length} rows</span>
            </div>
            <div className="toa-preview">
              <PdfMiniThumb
                bytes={previewBytes}
                label="Table of Authorities preview"
                targetWidth={260}
                targetHeight={336}
              />
            </div>
            <p className="toa-card__hint">
              The preview and saved PDF are rendered by the same local Table of Authorities engine.
            </p>
          </section>
        </div>
      )}

      <footer className="toa-workspace__footer">
        <div className="toa-workspace__footer-summary">
          <p>{summaryText(rows, passimValue)}</p>
          {status ? (
            <p className="toa-workspace__status" role="status">{status}</p>
          ) : null}
        </div>
        <div className="toa-workspace__footer-actions">
          <button type="button" className="toa-workspace__secondary" onClick={prependTable} disabled={!canPrepend}>
            <InsertIcon size={15} />
            Prepend to current PDF
          </button>
          <button type="button" className="toa-workspace__primary" onClick={savePdf} disabled={!canOutput}>
            <SaveIcon size={16} />
            {working ? "Rendering..." : "Save as PDF"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function AuthorityGroup({
  group,
  rows,
  allRows,
  mergeTargets,
  onRowChange,
  onMergeTargetChange,
  onMerge,
}: {
  group: { kind: AuthorityKind; label: string };
  rows: readonly AuthorityReviewRow[];
  allRows: readonly AuthorityReviewRow[];
  mergeTargets: Record<string, string>;
  onRowChange: (id: string, patch: Partial<AuthorityReviewRow>) => void;
  onMergeTargetChange: (rowId: string, targetId: string) => void;
  onMerge: (sourceId: string) => void;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="toa-group" aria-label={group.label}>
      <div className="toa-group__header">
        <h3>{group.label}</h3>
        <span className="toa-group__count">{rows.length}</span>
      </div>
      <div className="toa-group__rows" role="list">
        {rows.map((row) => {
          const mergeOptions = allRows.filter((candidate) => candidate.id !== row.id);
          const selectedMergeTarget = mergeTargets[row.id] ?? "";

          return (
            <article className="toa-row" role="listitem" key={row.id} data-excluded={row.excluded ? "true" : undefined}>
              <div className="toa-row__main">
                <label className="toa-toggle">
                  <input
                    type="checkbox"
                    checked={!row.excluded}
                    onChange={(event) => onRowChange(row.id, { excluded: !event.currentTarget.checked })}
                  />
                  <span>Include</span>
                </label>
                <label className="toa-field toa-field--citation">
                  <span>Citation</span>
                  <input
                    value={row.citation}
                    onChange={(event) => onRowChange(row.id, { citation: event.currentTarget.value })}
                  />
                </label>
                <p className="toa-row__pages">Pages {formatPages(row.pageIndexes)}</p>
                {row.excluded ? <span className="toa-row__excluded-tag">Excluded</span> : null}
              </div>
              <div className="toa-row__actions">
                <label className="toa-field">
                  <span>Merge into</span>
                  <select
                    value={selectedMergeTarget}
                    onChange={(event) => onMergeTargetChange(row.id, event.currentTarget.value)}
                  >
                    <option value="">Choose authority</option>
                    {AUTHORITY_GROUPS.map((mergeGroup) => {
                      const groupOptions = mergeOptions.filter((candidate) => candidate.kind === mergeGroup.kind);
                      return groupOptions.length > 0 ? (
                        <optgroup key={mergeGroup.kind} label={mergeGroup.label}>
                          {groupOptions.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.citation}</option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                </label>
                <button
                  type="button"
                  className="toa-workspace__secondary toa-row__merge-button"
                  disabled={!selectedMergeTarget}
                  onClick={() => onMerge(row.id)}
                >
                  <ScaleIcon size={12} />
                  Merge
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function GarbledGate({
  garbledPages,
  onForceOcr,
}: {
  garbledPages: readonly { pageIndex: number }[];
  onForceOcr: () => void;
}) {
  return (
    <div className="toa-card toa-card--gate" role="alert">
      <div className="toa-gate__lede">
        <span className="toa-gate__lede-icon" aria-hidden="true">
          <OcrSearchIcon size={15} />
        </span>
        <div>
          <p className="toa-gate__eyebrow">Searchable text needs repair</p>
          <h3 className="toa-gate__heading">Hidden text looks garbled</h3>
        </div>
      </div>
      <p className="toa-gate__intro">
        RaioPDF needs clean page text before it can detect citations. Redo searchable text, then run Table of Authorities again.
      </p>
      <p className="toa-gate__pages">Affected pages: {formatPages(garbledPages.map((page) => page.pageIndex))}</p>
      <button type="button" className="toa-workspace__primary" onClick={onForceOcr}>
        Redo searchable text
      </button>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="toa-empty">
      <p>{title}</p>
      <span>{detail}</span>
    </div>
  );
}

function DetectingState() {
  return (
    <div className="toa-loading">
      <LoadingSun size={26} label="Scanning citations" />
      <p className="toa-loading__title">Scanning citations</p>
      <span className="toa-loading__detail">
        RaioPDF is reading the page text and grouping detected authorities.
      </span>
    </div>
  );
}

function rowFromDetectedAuthority(authority: DetectedAuthority): AuthorityReviewRow {
  return {
    id: authority.id,
    kind: authority.kind,
    citation: authority.canonical,
    pageIndexes: normalizePageIndexes(authority.hits.map((hit) => hit.pageIndex)),
    excluded: false,
    source: "detected",
  };
}

function parsePageList(value: string, pageCount: number): number[] {
  const indexes: number[] = [];

  for (const token of value.split(",")) {
    const part = token.trim();
    if (!part) {
      continue;
    }

    const hyphenIndex = part.indexOf("-");
    if (hyphenIndex >= 0) {
      const start = parseInteger(part.slice(0, hyphenIndex));
      const end = parseInteger(part.slice(hyphenIndex + 1));
      if (start === null || end === null) {
        continue;
      }

      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let page = low; page <= high; page += 1) {
        if (page > 0 && (pageCount <= 0 || page <= pageCount)) {
          indexes.push(page - 1);
        }
      }
      continue;
    }

    const page = parseInteger(part);
    if (page !== null && page > 0 && (pageCount <= 0 || page <= pageCount)) {
      indexes.push(page - 1);
    }
  }

  return normalizePageIndexes(indexes);
}

function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed = 0;
  for (const char of trimmed) {
    const digit = char.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) {
      return null;
    }
    parsed = (parsed * 10) + digit;
  }

  return parsed;
}

function normalizePageIndexes(pageIndexes: readonly number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];

  for (const pageIndex of pageIndexes) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || seen.has(pageIndex)) {
      continue;
    }

    seen.add(pageIndex);
    normalized.push(pageIndex);
  }

  return normalized.sort((left, right) => left - right);
}

function formatPages(pageIndexes: readonly number[]): string {
  const pages = normalizePageIndexes(pageIndexes).map((pageIndex) => pageIndex + 1);
  return pages.length > 0 ? pages.join(", ") : "none";
}

function summaryText(rows: readonly AuthorityReviewRow[], passimThreshold: number | null): string {
  const included = rows.filter((row) => !row.excluded).length;
  const threshold = passimThreshold === null ? "invalid" : String(passimThreshold);

  return `${included} included authority${included === 1 ? "" : "ies"} · passim over ${threshold} pages`;
}

function outputValidationMessage(passimThreshold: number | null): string {
  if (passimThreshold === null) {
    return "Passim threshold must be a whole number.";
  }

  return "Include at least one authority with citation text and page hits.";
}

function toaFileName(fileName: string | null): string {
  const base = fileName ? stripPdfExtension(fileName) : "Table of Authorities";
  return `${sanitizeFileNamePart(base).slice(0, 80)} Table of Authorities.pdf`;
}

function stripPdfExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".pdf") ? fileName.slice(0, fileName.length - 4) : fileName;
}

function sanitizeFileNamePart(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
    })
    .join("");
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
