import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { PdfBatesStampOptions, PdfStampPlacement } from "@raiopdf/engine-api";
import type { OcrUiState } from "../App";
import { describePendingEdit, excerpt, type PendingEdit } from "../lib/edits";
import type { PdfMetadataSummary, SensitiveHit } from "../lib/legalTools";
import {
  EDIT_DIALOG_TOOLS,
  HELP_ONLY_TOOL_ENTRIES,
  LEGAL_TOOLS,
  ORGANIZE_TOOLS,
  TOOL_PANEL_EDIT_TOOLS,
  type EditDialogToolId,
  type LegalToolId,
  type OrganizeToolId,
} from "../lib/toolRegistry";
import {
  BatesIcon,
  BoltIcon,
  CombineExhibitsIcon,
  CommentIcon,
  CropIcon,
  DrawIcon,
  EditIcon,
  HighlightIcon,
  ImageIcon,
  InsertIcon,
  OcrSearchIcon,
  OrganizeIcon,
  RedactIcon,
  RotateIcon,
  ScaleIcon,
  ScrubMetadataIcon,
  ShieldCheckIcon,
  SignIcon,
  TextBoxIcon,
} from "../icons";
import type { EditToolId } from "../lib/edits";
import { AccordionGroup } from "./AccordionGroup";
import { LoadingSun } from "./LoadingSun";
import { ToolRow } from "./ToolRow";
import "./ToolPanel.css";

type GroupId = "edit" | "organize" | "comment" | "legal";
export type { EditDialogToolId, LegalToolId, OrganizeToolId };

const TOOL_PANEL_ICONS: Record<string, ReactNode> = {
  "prepare-for-filing": <BoltIcon variant="outline" size={16} />,
  "batch-cleanup": <OcrSearchIcon size={16} />,
  "production-set": <BatesIcon size={16} />,
  "combine-exhibits": <CombineExhibitsIcon size={16} />,
  sanitize: <ShieldCheckIcon size={16} />,
  redact: <RedactIcon size={16} />,
  "bates-numbering": <BatesIcon size={16} />,
  "scanner-2425": <ShieldCheckIcon size={16} />,
  "scrub-metadata": <ScrubMetadataIcon size={16} />,
  passwords: <ShieldCheckIcon size={16} />,
  pages: <OrganizeIcon size={16} />,
  compress: <CropIcon size={16} />,
  repair: <ShieldCheckIcon size={16} />,
  merge: <CombineExhibitsIcon size={16} />,
  insert: <InsertIcon size={16} />,
  "insert-images": <ImageIcon size={16} />,
  crop: <CropIcon size={16} />,
  properties: <ScrubMetadataIcon size={16} />,
  rotate: <RotateIcon size={16} />,
  textBox: <TextBoxIcon size={16} />,
  image: <ImageIcon size={16} />,
  highlight: <HighlightIcon size={16} />,
  draw: <DrawIcon size={16} />,
  sign: <SignIcon size={16} />,
  "page-numbers": <BatesIcon size={16} />,
  watermark: <ScrubMetadataIcon size={16} />,
};

const MAKE_SEARCHABLE_TOOL = HELP_ONLY_TOOL_ENTRIES[0];

export type RedactionPhase = "idle" | "confirming" | "applying" | "verified" | "error";

export interface RedactionPanelState {
  phase: RedactionPhase;
  message: string | null;
  pendingCount: number;
  available: boolean;
}

export interface BatesPanelState {
  applying: boolean;
  message: string | null;
}

export interface ScannerPanelState {
  scanning: boolean;
  message: string | null;
  hits: readonly SensitiveHit[];
}

export interface ScrubMetadataPanelState {
  metadata: PdfMetadataSummary | null;
  scrubbing: boolean;
  message: string | null;
  removedFields: readonly string[];
}

export interface ToolPanelProps {
  hasDocument: boolean;
  ocrState: OcrUiState;
  ocrAvailable: boolean;
  ocrStarting: boolean;
  activeEditTool: EditToolId;
  activeEditDialogTool: EditDialogToolId | null;
  activeLegalTool: string | null;
  activeOrganizeTool: string | null;
  onEditToolSelected: (toolId: EditToolId) => void;
  onEditDialogToolSelected: (toolId: EditDialogToolId) => void;
  onLegalToolSelected: (toolId: LegalToolId) => void;
  onOrganizeToolSelected: (toolId: OrganizeToolId) => void;
  onMakeSearchable: () => void;
  redaction: RedactionPanelState;
  scanner: ScannerPanelState;
  pendingEdits: readonly PendingEdit[];
  onRemovePendingEdit: (id: string) => void;
  onConfirmRedactions: () => void;
  onCancelRedactions: () => void;
  onRunScanner: () => void;
  onMarkScannerHit: (hit: SensitiveHit) => void;
}

export function ToolPanel({
  hasDocument,
  ocrState,
  ocrAvailable,
  ocrStarting,
  activeEditTool,
  activeEditDialogTool,
  activeLegalTool,
  activeOrganizeTool,
  onEditToolSelected,
  onEditDialogToolSelected,
  onLegalToolSelected,
  onOrganizeToolSelected,
  onMakeSearchable,
  redaction,
  scanner,
  pendingEdits,
  onRemovePendingEdit,
  onConfirmRedactions,
  onCancelRedactions,
  onRunScanner,
  onMarkScannerHit,
}: ToolPanelProps) {
  const [openGroup, setOpenGroup] = useState<GroupId | null>("legal");
  const pendingComments = pendingEdits.filter(
    (edit): edit is Extract<PendingEdit, { kind: "comment" }> => edit.kind === "comment",
  );
  const pendingContentEdits = pendingEdits.filter((edit) => edit.kind !== "comment");

  function toggleGroup(group: GroupId) {
    setOpenGroup((current) => (current === group ? null : group));
  }

  return (
    <aside className="tool-panel" aria-label="Tools">
      <p className="tool-panel__heading">Tools</p>

      <AccordionGroup
        id="edit"
        icon={<EditIcon size={16} />}
        label="Edit"
        isOpen={openGroup === "edit"}
        onToggle={() => toggleGroup("edit")}
      >
        {TOOL_PANEL_EDIT_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={TOOL_PANEL_ICONS[tool.id]}
            label={tool.label}
            description={tool.description}
            selected={activeEditTool === tool.id}
            onSelect={() => onEditToolSelected(tool.id)}
          />
        ))}
        {EDIT_DIALOG_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={TOOL_PANEL_ICONS[tool.id]}
            label={tool.label}
            description={tool.description}
            selected={activeEditDialogTool === tool.id}
            onSelect={() => onEditDialogToolSelected(tool.id)}
          />
        ))}
        {pendingContentEdits.length > 0 ? (
          <PendingEditsCard edits={pendingContentEdits} onRemove={onRemovePendingEdit} />
        ) : null}
      </AccordionGroup>

      <AccordionGroup
        id="organize"
        icon={<OrganizeIcon size={16} />}
        label="Organize"
        isOpen={openGroup === "organize"}
        onToggle={() => toggleGroup("organize")}
      >
        {ORGANIZE_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={TOOL_PANEL_ICONS[tool.id]}
            label={tool.label}
            description={tool.description}
            selected={activeOrganizeTool === tool.id}
            onSelect={() => onOrganizeToolSelected(tool.id)}
          />
        ))}
      </AccordionGroup>

      <AccordionGroup
        id="comment"
        icon={<CommentIcon size={16} />}
        label="Comment"
        isOpen={openGroup === "comment"}
        onToggle={() => toggleGroup("comment")}
      >
        {pendingComments.length > 0 ? (
          <CommentsCard comments={pendingComments} onRemove={onRemovePendingEdit} />
        ) : (
          <p className="accordion-group__empty">
            No comments.
          </p>
        )}
      </AccordionGroup>

      <div className="tool-panel__top-row">
        <ToolRow
          icon={<OcrSearchIcon size={16} />}
          label={MAKE_SEARCHABLE_TOOL.label}
          description={MAKE_SEARCHABLE_TOOL.description}
          disabled={isOcrActive(ocrState.phase, ocrStarting)}
          onSelect={onMakeSearchable}
        />
        {ocrState.phase !== "idle" || ocrStarting ? (
          <OcrStatusPanel
            hasDocument={hasDocument}
            ocrState={ocrState}
            ocrAvailable={ocrAvailable}
            ocrStarting={ocrStarting}
          />
        ) : null}
      </div>

      <AccordionGroup
        id="legal"
        icon={<ScaleIcon size={16} />}
        label="Legal"
        variant="legal"
        isOpen={openGroup === "legal"}
        onToggle={() => toggleGroup("legal")}
      >
        {LEGAL_TOOLS.map((tool) => {
          const selected = activeLegalTool === tool.id;

          return (
            <div key={tool.id}>
              <ToolRow
                icon={TOOL_PANEL_ICONS[tool.id]}
                label={tool.label}
                description={tool.description}
                selected={selected}
                onSelect={() => onLegalToolSelected(tool.id)}
              />
              {tool.id === "redact" && selected ? (
                <RedactionStatusPanel
                  state={redaction}
                  hasDocument={hasDocument}
                  onConfirm={onConfirmRedactions}
                  onCancel={onCancelRedactions}
                />
              ) : null}
              {tool.id === "bates-numbering" && selected ? (
                <InlineMessage tone="neutral" message="Configure Bates numbering in the document dialog." />
              ) : null}
              {tool.id === "scanner-2425" && selected ? (
                <ScannerPanel
                  state={scanner}
                  hasDocument={hasDocument}
                  onRunScanner={onRunScanner}
                  onMarkHit={onMarkScannerHit}
                />
              ) : null}
              {tool.id === "scrub-metadata" && selected ? (
                <InlineMessage tone="neutral" message="Inspect and scrub metadata in the document dialog." />
              ) : null}
              {tool.id === "passwords" && selected ? (
                <InlineMessage tone="neutral" message="Password controls open over the document." />
              ) : null}
            </div>
          );
        })}
      </AccordionGroup>
    </aside>
  );
}

interface OcrStatusPanelProps {
  hasDocument: boolean;
  ocrState: OcrUiState;
  ocrAvailable: boolean;
  ocrStarting: boolean;
}

function OcrStatusPanel({
  hasDocument,
  ocrState,
  ocrAvailable,
  ocrStarting,
}: OcrStatusPanelProps) {
  const message = ocrState.message ?? getDefaultOcrMessage(hasDocument, ocrAvailable);
  const phase = ocrStarting && ocrState.phase === "starting-engine"
    ? "starting-engine"
    : ocrState.phase;
  const active = isOcrActive(phase, ocrStarting);

  // A missing capability (no desktop engine) is not a processing failure --
  // OCR never ran. Every other tool in this panel (Redact, Sanitize, Repair,
  // Compress, Scrub Metadata, Passwords) renders that same "not available
  // here" fact as a calm, neutral note, never as an attention-grabbing error.
  // OCR should read the same way instead of the only tool that flashes amber
  // for a browser/desktop capability gap.
  if (phase === "error" && !ocrAvailable) {
    return <InlineMessage tone="neutral" message={message} />;
  }

  return (
    <div
      className="tool-panel__ocr-status"
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <p className="tool-panel__ocr-status-label">
        {active ? <LoadingSun size={13} label="OCR processing" /> : null}
        {getOcrStatusLabel(phase)}
      </p>
      <p className="tool-panel__ocr-status-message">{message}</p>
    </div>
  );
}

function RedactionStatusPanel({
  state,
  hasDocument,
  onConfirm,
  onCancel,
}: {
  state: RedactionPanelState;
  hasDocument: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!hasDocument) {
    return <InlineMessage tone="neutral" message="Open a PDF before marking redactions." />;
  }

  if (!state.available) {
    return <InlineMessage tone="neutral" message="This action is available in the desktop app." />;
  }

  if (state.phase === "confirming") {
    return (
      <div className="tool-panel__inline-card">
        <p className="tool-panel__card-title">
          {state.pendingCount} {state.pendingCount === 1 ? "area" : "areas"} will be permanently removed
        </p>
        <p className="tool-panel__card-copy">
          RaioPDF checks extractable source text when available, redacted page images, annotations, and metadata.
        </p>
        <div className="tool-panel__button-row">
          <button type="button" className="tool-panel__danger-button" onClick={onConfirm}>
            Apply Redactions
          </button>
          <button type="button" className="tool-panel__secondary-button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.message) {
    return (
      <InlineMessage
        tone={state.phase === "error" ? "danger" : state.phase === "verified" ? "ok" : "neutral"}
        message={state.message}
      />
    );
  }

  return (
    <InlineMessage
      tone="neutral"
      message="Drag boxes on the page, or use Search text in the canvas mode bar."
    />
  );
}

export function BatesPanel({
  state,
  hasDocument,
  pageCount,
  onApply,
}: {
  state: BatesPanelState;
  hasDocument: boolean;
  pageCount: number;
  onApply: (options: PdfBatesStampOptions) => Promise<boolean>;
}) {
  const [prefix, setPrefix] = useState("SMITH");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [placement, setPlacement] = useState<PdfStampPlacement>({
    edge: "footer",
    align: "right",
  });
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const preview = useMemo(
    () => `${prefix}${String(Math.max(0, start)).padStart(Math.max(1, digits), "0")}`,
    [digits, prefix, start],
  );
  const lastNumber = start + Math.max(0, pageCount - 1);
  const overflows = Number.isFinite(lastNumber) && lastNumber >= 10 ** digits;
  const message = localMessage ?? state.message;

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalMessage(null);

    if (!hasDocument) {
      setLocalMessage("Open a PDF before applying Bates numbers.");
      return;
    }

    if (overflows) {
      setLocalMessage("Increase digits or lower the start number so every page fits.");
      return;
    }

    const applied = await onApply({
      prefix,
      start,
      digits,
      placement,
      fontSizePt: 10,
    });

    if (!applied) {
      setLocalMessage("Bates numbers could not be applied. Check the format and try again.");
    }
  }

  return (
    <form className="tool-panel__inline-card" onSubmit={apply}>
      <div className="tool-panel__field">
        <label htmlFor="bates-prefix">Prefix</label>
        <input id="bates-prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} />
      </div>
      <div className="tool-panel__field-grid">
        <div className="tool-panel__field">
          <label htmlFor="bates-start">Start</label>
          <input
            id="bates-start"
            type="number"
            min="0"
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </div>
        <div className="tool-panel__field">
          <label htmlFor="bates-digits">Digits</label>
          <input
            id="bates-digits"
            type="number"
            min="1"
            max="12"
            value={digits}
            onChange={(event) => setDigits(Number(event.target.value))}
          />
        </div>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="bates-position">Position</label>
        <select
          id="bates-position"
          value={`${placement.edge}-${placement.align}`}
          onChange={(event) => setPlacement(parsePlacement(event.target.value))}
        >
          <option value="footer-left">Footer left</option>
          <option value="footer-center">Footer center</option>
          <option value="footer-right">Footer right</option>
          <option value="header-left">Header left</option>
          <option value="header-center">Header center</option>
          <option value="header-right">Header right</option>
        </select>
      </div>
      <span className="tool-panel__preview-chip" aria-label="Bates preview">{preview}</span>
      {overflows ? (
        <p className="tool-panel__field-error">
          The last page would exceed the configured digit width.
        </p>
      ) : null}
      {message ? <p className="tool-panel__status-line">{message}</p> : null}
      <p className="tool-panel__note">Numbers are stamped into page content, not annotations.</p>
      <button
        type="submit"
        className="tool-panel__primary-button"
        disabled={!hasDocument || state.applying || overflows}
      >
        Apply Bates Numbers
      </button>
    </form>
  );
}

function ScannerPanel({
  state,
  hasDocument,
  onRunScanner,
  onMarkHit,
}: {
  state: ScannerPanelState;
  hasDocument: boolean;
  onRunScanner: () => void;
  onMarkHit: (hit: SensitiveHit) => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <p className="tool-panel__note">
        Assistive scan — not a substitute for review. Fla. R. Jud. Admin. 2.425 governs.
      </p>
      <button
        type="button"
        className="tool-panel__primary-button"
        disabled={!hasDocument || state.scanning}
        onClick={onRunScanner}
      >
        Scan Document
      </button>
      {/* `state.message` already carries the right copy for every outcome --
          "No obvious sensitive patterns found...", "N possible items found.",
          or a genuine failure like "The scanner could not read text from
          this PDF." A second hardcoded "no patterns found" line here used to
          render underneath *any* message once scanning finished, including
          a real failure -- telling the reader the scan came back clean right
          after saying it didn't run. Don't duplicate/contradict it. */}
      {state.message ? <p className="tool-panel__status-line">{state.message}</p> : null}
      {state.hits.length ? (
        <div className="tool-panel__hit-list" role="list">
          {state.hits.map((hit) => (
            <div key={hit.id} className="tool-panel__hit" role="listitem">
              <div className="tool-panel__hit-head">
                <span className="tool-panel__category-chip">{hit.category}</span>
                {hit.confidence === "lower" ? (
                  <span className="tool-panel__confidence-chip">Lower confidence</span>
                ) : null}
                <span>Page {hit.pageIndex + 1}</span>
              </div>
              <p>{hit.excerpt}</p>
              <button
                type="button"
                className="tool-panel__secondary-button"
                onClick={() => onMarkHit(hit)}
              >
                Mark for redaction
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ScrubMetadataPanel({
  state,
  hasDocument,
  onScrub,
}: {
  state: ScrubMetadataPanelState;
  hasDocument: boolean;
  onScrub: () => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      {state.metadata ? (
        <table className="tool-panel__metadata-table">
          <tbody>
            {state.metadata.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="tool-panel__status-line">Open a PDF to inspect metadata.</p>
      )}
      {state.removedFields.length ? (
        <p className="tool-panel__status-line" data-tone="ok">
          Removed {state.removedFields.join(", ")}.
        </p>
      ) : null}
      {state.message ? <p className="tool-panel__status-line">{state.message}</p> : null}
      <p className="tool-panel__note">Does not affect page content or annotations.</p>
      <button
        type="button"
        className="tool-panel__primary-button"
        disabled={!hasDocument || state.scrubbing}
        onClick={onScrub}
      >
        Scrub Metadata
      </button>
    </div>
  );
}

function PendingEditsCard({
  edits,
  onRemove,
}: {
  edits: readonly PendingEdit[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <p className="tool-panel__card-title">
        {edits.length} pending {edits.length === 1 ? "edit" : "edits"}
      </p>
      <p className="tool-panel__note">Applied to the document when you save.</p>
      <div className="tool-panel__pending-list" role="list">
        {edits.map((edit) => {
          const { label, detail } = describePendingEdit(edit);

          return (
            <div key={edit.id} className="tool-panel__pending-row" role="listitem">
              <span className="tool-panel__pending-text">
                <span className="tool-panel__pending-label">
                  {label} · Page {edit.pageIndex + 1}
                </span>
                {detail ? (
                  <span className="tool-panel__pending-detail">{detail}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="tool-panel__pending-remove"
                aria-label={`Remove pending ${label.toLowerCase()} on page ${edit.pageIndex + 1}`}
                onClick={() => onRemove(edit.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommentsCard({
  comments,
  onRemove,
}: {
  comments: ReadonlyArray<Extract<PendingEdit, { kind: "comment" }>>;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <p className="tool-panel__card-title">
        {comments.length} {comments.length === 1 ? "comment" : "comments"}
      </p>
      <p className="tool-panel__note">Saved as real PDF annotations, not baked content.</p>
      <div className="tool-panel__pending-list" role="list">
        {comments.map((comment) => (
          <div key={comment.id} className="tool-panel__pending-row" role="listitem">
            <span className="tool-panel__pending-text">
              <span className="tool-panel__pending-label">Page {comment.pageIndex + 1}</span>
              <span className="tool-panel__pending-detail">{excerpt(comment.text)}</span>
            </span>
            <button
              type="button"
              className="tool-panel__pending-remove"
              aria-label={`Delete comment on page ${comment.pageIndex + 1}`}
              onClick={() => onRemove(comment.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PasswordsPanel() {
  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__field">
        <label htmlFor="open-password">Open password</label>
        <input id="open-password" type="password" disabled />
      </div>
      <label className="tool-panel__check-row">
        <input type="checkbox" disabled />
        Allow printing
      </label>
      <label className="tool-panel__check-row">
        <input type="checkbox" disabled />
        Allow copying
      </label>
      <p className="tool-panel__note">
        Never stored. Password changes are unavailable in this build: pdf-lib does not encrypt PDFs, and the verified sidecar notes list no password endpoints.
      </p>
      <div className="tool-panel__button-row">
        <button type="button" className="tool-panel__primary-button" disabled>
          Set Password
        </button>
        <button type="button" className="tool-panel__secondary-button" disabled>
          Remove Password
        </button>
      </div>
    </div>
  );
}

function InlineMessage({
  tone,
  message,
}: {
  tone: "neutral" | "ok" | "danger";
  message: string;
}) {
  return (
    <div className="tool-panel__inline-card" data-tone={tone} role="status">
      <p className="tool-panel__card-copy">{message}</p>
    </div>
  );
}

function getDefaultOcrMessage(hasDocument: boolean, ocrAvailable: boolean): string {
  if (!hasDocument) {
    return "Open a PDF before running OCR.";
  }

  if (!ocrAvailable) {
    return "This action is available in the desktop app.";
  }

  return "Ready to make this PDF searchable.";
}

function parsePlacement(value: string): PdfStampPlacement {
  const [edge, align] = value.split("-");

  return {
    edge: edge === "header" ? "header" : "footer",
    align: align === "left" || align === "center" ? align : "right",
  };
}

function isOcrActive(phase: OcrUiState["phase"], ocrStarting: boolean): boolean {
  return (
    ocrStarting ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying"
  );
}

function getOcrStatusLabel(phase: OcrUiState["phase"]): string {
  if (phase === "done") {
    return "Verified";
  }

  if (phase === "error") {
    return "Needs attention";
  }

  if (phase === "starting-engine") {
    return "Starting";
  }

  if (phase === "processing") {
    return "Processing";
  }

  if (phase === "verifying") {
    return "Verifying";
  }

  return "OCR";
}
