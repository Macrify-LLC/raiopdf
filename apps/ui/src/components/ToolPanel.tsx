import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  PdfBatesStampOptions,
  PdfCompressOptions,
  PdfPageNumbersOptions,
  PdfSanitizeRemovedItem,
  PdfStampPlacement,
  PdfWatermarkOptions,
} from "@raiopdf/engine-api";
import type { OcrUiState } from "../App";
import { describePendingEdit, excerpt, type PendingEdit } from "../lib/edits";
import type { PdfMetadataSummary, SensitiveHit } from "../lib/legalTools";
import { formatDefaultRange, parsePageRanges } from "../lib/pageRanges";
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
  HelpIcon,
  HighlightIcon,
  ImageIcon,
  InsertIcon,
  OcrSearchIcon,
  OrganizeIcon,
  PlugIcon,
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
import { IconButton } from "./IconButton";
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

// Shared status shape for every sidecar-engine action (Sanitize, Repair,
// Insert Images, Page Numbers, Watermark, Compress) -- one running/message
// pair since only one of these can ever be the visible expansion at a time.
export type SidecarStatus = {
  running: boolean;
  message: string | null;
  removed: readonly PdfSanitizeRemovedItem[];
  beforeBytes: number | null;
  afterBytes: number | null;
};

export interface ToolPanelProps {
  hasDocument: boolean;
  pageCount: number;
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
  onForceOcr: () => void;
  redaction: RedactionPanelState;
  scanner: ScannerPanelState;
  pendingEdits: readonly PendingEdit[];
  onRemovePendingEdit: (id: string) => void;
  onConfirmRedactions: () => void;
  onCancelRedactions: () => void;
  onRunScanner: () => void;
  onMarkScannerHit: (hit: SensitiveHit) => void;
  onHelpRequested: (articleId: string) => void;
  /**
   * Top-level entry point for "Connect to AI Agent" -- opens the same
   * settings surface as the File menu's "Open Raio to AI..." item. Not
   * routed through the ToolRow help-icon plumbing: this is a doorway to a
   * whole settings section, not a tool with its own help article.
   */
  onConnectToAi: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  sidecarStatus: SidecarStatus;
  onApplyPageNumbers: (options: PdfPageNumbersOptions) => Promise<boolean>;
  onApplyWatermark: (options: PdfWatermarkOptions) => Promise<boolean>;
  compressAvailable: boolean;
  onCompress: (options: PdfCompressOptions) => Promise<boolean>;
}

export function ToolPanel({
  hasDocument,
  pageCount,
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
  onForceOcr,
  redaction,
  scanner,
  pendingEdits,
  onRemovePendingEdit,
  onConfirmRedactions,
  onCancelRedactions,
  onRunScanner,
  onMarkScannerHit,
  onHelpRequested,
  onConnectToAi,
  onRotateLeft,
  onRotateRight,
  sidecarStatus,
  onApplyPageNumbers,
  onApplyWatermark,
  compressAvailable,
  onCompress,
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
        {EDIT_DIALOG_TOOLS.map((tool) => {
          const selected = activeEditDialogTool === tool.id;

          return (
            <div key={tool.id}>
              <ToolRow
                icon={TOOL_PANEL_ICONS[tool.id]}
                label={tool.label}
                description={tool.description}
                selected={selected}
                onSelect={() => onEditDialogToolSelected(tool.id)}
              />
              {tool.id === "page-numbers" && selected ? (
                <ToolExpansion onEscape={() => onEditDialogToolSelected("page-numbers")}>
                  <PageNumbersPanel
                    hasDocument={hasDocument}
                    pageCount={pageCount}
                    status={sidecarStatus}
                    onApply={onApplyPageNumbers}
                    onHelp={() => onHelpRequested(tool.helpArticleId)}
                  />
                </ToolExpansion>
              ) : null}
              {tool.id === "watermark" && selected ? (
                <ToolExpansion onEscape={() => onEditDialogToolSelected("watermark")}>
                  <WatermarkPanel
                    hasDocument={hasDocument}
                    pageCount={pageCount}
                    status={sidecarStatus}
                    onApply={onApplyWatermark}
                    onHelp={() => onHelpRequested(tool.helpArticleId)}
                  />
                </ToolExpansion>
              ) : null}
            </div>
          );
        })}
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
        {ORGANIZE_TOOLS.map((tool) => {
          const selected = activeOrganizeTool === tool.id;

          return (
            <div key={tool.id}>
              <ToolRow
                icon={TOOL_PANEL_ICONS[tool.id]}
                label={tool.label}
                description={tool.description}
                selected={selected}
                onSelect={() => onOrganizeToolSelected(tool.id)}
              />
              {tool.id === "rotate" && selected ? (
                <ToolExpansion onEscape={() => onOrganizeToolSelected("rotate")}>
                  <RotatePanel
                    hasDocument={hasDocument}
                    onRotateLeft={onRotateLeft}
                    onRotateRight={onRotateRight}
                    onHelp={() => onHelpRequested(tool.helpArticleId)}
                  />
                </ToolExpansion>
              ) : null}
              {tool.id === "compress" && selected ? (
                <ToolExpansion onEscape={() => onOrganizeToolSelected("compress")}>
                  <CompressPanel
                    hasDocument={hasDocument}
                    available={compressAvailable}
                    status={sidecarStatus}
                    onCompress={onCompress}
                    onHelp={() => onHelpRequested(tool.helpArticleId)}
                  />
                </ToolExpansion>
              ) : null}
            </div>
          );
        })}
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
        <ToolRow
          icon={<OcrSearchIcon size={16} />}
          label="Force re-OCR text layer"
          description="Rebuild the invisible searchable text by re-rendering the whole file."
          disabled={!hasDocument || isOcrActive(ocrState.phase, ocrStarting)}
          onSelect={onForceOcr}
        />
        {ocrState.phase === "done" || ocrState.phase === "error" ? (
          <OcrResultNotice ocrState={ocrState} ocrAvailable={ocrAvailable} />
        ) : null}
      </div>

      <ConnectToAiRow onSelect={onConnectToAi} />

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
                  onHelp={() => onHelpRequested(tool.helpArticleId)}
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
                  onHelp={() => onHelpRequested(tool.helpArticleId)}
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

// Top-level entry point (item 11) -- previously the only way to reach this
// surface was the Built-by-Macrify byline or the invisible native File menu.
// Copy follows the two-halves framing: no AI runs inside RaioPDF; this wires
// Raio up to the user's OWN AI tools. Deliberately calm, not a promo card --
// no badge, no accent wash, just a labeled row like everything else here.
function ConnectToAiRow({ onSelect }: { onSelect: () => void }) {
  return (
    <div className="tool-panel__ai-connect">
      <button type="button" className="tool-panel__ai-connect-button" onClick={onSelect}>
        <span className="tool-panel__ai-connect-icon">
          <PlugIcon size={16} />
        </span>
        <span className="tool-panel__ai-connect-copy">
          <span className="tool-panel__ai-connect-label">Connect to AI Agent</span>
          <span className="tool-panel__ai-connect-description">
            Let your own AI assistant drive Raio — nothing runs in the app itself.
          </span>
        </span>
      </button>
    </div>
  );
}

interface OcrResultNoticeProps {
  ocrState: OcrUiState;
  ocrAvailable: boolean;
}

// The active phases (confirm/starting-engine/processing/verifying) live in
// the OcrDialog now -- this only ever renders for the terminal done/error
// phases, as a brief result line under the Make Searchable/Force re-OCR
// buttons, reusing the same InlineMessage pattern every other tool in this
// panel (Redact, Sanitize, Repair, Compress, Scrub Metadata, Passwords)
// already uses for its own result/availability messaging.
function OcrResultNotice({ ocrState, ocrAvailable }: OcrResultNoticeProps) {
  const message = ocrState.message ?? "OCR finished.";

  // A missing capability (no desktop engine, no OCR toolchain) is not a
  // processing failure -- OCR never ran. Every other tool in this panel
  // renders that same "not available here" fact as a calm, neutral note,
  // never as an attention-grabbing error. OCR reads the same way.
  if (ocrState.phase === "error" && !ocrAvailable) {
    return <InlineMessage tone="neutral" message={message} />;
  }

  return (
    <InlineMessage tone={ocrState.phase === "done" ? "ok" : "danger"} message={message} />
  );
}

function RedactionStatusPanel({
  state,
  hasDocument,
  onConfirm,
  onCancel,
  onHelp,
}: {
  state: RedactionPanelState;
  hasDocument: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onHelp: () => void;
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
        <div className="tool-panel__card-header">
          <p className="tool-panel__card-title">
            {state.pendingCount} {state.pendingCount === 1 ? "area" : "areas"} will be permanently removed
          </p>
          <IconButton icon={<HelpIcon size={14} />} label="Help: Redact" onClick={onHelp} />
        </div>
        <p className="tool-panel__card-copy">
          RaioPDF checks extractable source text when available, redacted page images, annotations, and metadata.
          Your open file on disk is left untouched — Save will prompt you for a new file name.
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
  onHelp,
}: {
  state: ScannerPanelState;
  hasDocument: boolean;
  onRunScanner: () => void;
  onMarkHit: (hit: SensitiveHit) => void;
  onHelp: () => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__card-header">
        <p className="tool-panel__note">
          Assistive scan — not a substitute for review. Fla. R. Jud. Admin. 2.425 governs.
        </p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: 2.425 Scanner" onClick={onHelp} />
      </div>
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
        Never stored. Prepare for Filing can remove encryption with the open password. Setting or changing PDF passwords remains unavailable in this build.
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

function parsePlacement(value: string): PdfStampPlacement {
  const [edge, align] = value.split("-");

  return {
    edge: edge === "header" ? "header" : "footer",
    align: align === "left" || align === "center" ? align : "right",
  };
}

function parsePlacementValue(value: string): PdfPageNumbersOptions["placement"] {
  const [edge, align] = value.split("-");

  return {
    edge: edge === "header" ? "header" : "footer",
    align: align === "left" || align === "right" ? align : "center",
  };
}

// Wraps an inline tool's expanded form. Mounted only while its ToolRow is
// selected, so entry gets the CSS keyframe below; there's no exit animation,
// matching every other appear-on-demand card in this panel (Redact confirm,
// Scanner results, etc.) -- collapse is an unmount, not a reverse transition.
// Escape while focus is anywhere inside re-fires the same select handler
// that opened the tool, which item 18's toggle-off-on-reselect logic in
// App.tsx turns into a close.
function ToolExpansion({
  onEscape,
  children,
}: {
  onEscape: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="tool-row__expansion"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onEscape();
        }
      }}
    >
      {children}
    </div>
  );
}

function RotatePanel({
  hasDocument,
  onRotateLeft,
  onRotateRight,
  onHelp,
}: {
  hasDocument: boolean;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onHelp: () => void;
}) {
  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__card-header">
        <p className="tool-panel__card-title">Rotate Pages</p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: Rotate Pages" onClick={onHelp} />
      </div>
      <div className="tool-panel__button-row">
        <button
          type="button"
          className="tool-panel__secondary-button"
          disabled={!hasDocument}
          onClick={onRotateLeft}
        >
          <RotateIcon size={15} className="tool-panel__icon-mirror" />
          Rotate Left
        </button>
        <button
          type="button"
          className="tool-panel__secondary-button"
          disabled={!hasDocument}
          onClick={onRotateRight}
        >
          <RotateIcon size={15} />
          Rotate Right
        </button>
      </div>
      <p className="tool-panel__note">Rotates the selected pages.</p>
    </div>
  );
}

function PageNumbersPanel({
  hasDocument,
  pageCount,
  status,
  onApply,
  onHelp,
}: {
  hasDocument: boolean;
  pageCount: number;
  status: SidecarStatus;
  onApply: (options: PdfPageNumbersOptions) => Promise<boolean>;
  onHelp: () => void;
}) {
  const [range, setRange] = useState(formatDefaultRange(pageCount));
  const [format, setFormat] = useState<PdfPageNumbersOptions["format"]>("number");
  const [startAt, setStartAt] = useState(1);
  const [fontSizePt, setFontSizePt] = useState(11);
  const [placement, setPlacement] = useState<PdfPageNumbersOptions["placement"]>({
    edge: "footer",
    align: "center",
  });
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parsePageRanges(range, pageCount), [pageCount, range]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);

    if (parsed.error) {
      return;
    }

    await onApply({
      startAt,
      pageIndexes: parsed.pageIndexes,
      format,
      placement,
      fontSizePt,
    });
  }

  return (
    <form className="tool-panel__inline-card" onSubmit={submit}>
      <div className="tool-panel__card-header">
        <p className="tool-panel__card-title">Page Numbers</p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: Page Numbers" onClick={onHelp} />
      </div>
      <div className="tool-panel__field">
        <label htmlFor="page-number-range">Pages</label>
        <input id="page-number-range" value={range} onBlur={() => setTouched(true)} onChange={(event) => setRange(event.target.value)} />
        {touched && parsed.error ? <span className="tool-panel__field-error">{parsed.error}</span> : null}
      </div>
      <div className="tool-panel__field-grid">
        <div className="tool-panel__field">
          <label htmlFor="page-number-start">Start at</label>
          <input id="page-number-start" type="number" min="0" value={startAt} onChange={(event) => setStartAt(Number(event.target.value))} />
        </div>
        <div className="tool-panel__field">
          <label htmlFor="page-number-size">Font size</label>
          <input id="page-number-size" type="number" min="1" value={fontSizePt} onChange={(event) => setFontSizePt(Number(event.target.value))} />
        </div>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="page-number-format">Format</label>
        <select id="page-number-format" value={format} onChange={(event) => setFormat(event.target.value as PdfPageNumbersOptions["format"])}>
          <option value="number">1, 2, 3</option>
          <option value="page-of-total">Page N of M</option>
        </select>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="page-number-position">Position</label>
        <select id="page-number-position" value={`${placement.edge}-${placement.align}`} onChange={(event) => setPlacement(parsePlacementValue(event.target.value))}>
          <option value="footer-left">Footer left</option>
          <option value="footer-center">Footer center</option>
          <option value="footer-right">Footer right</option>
          <option value="header-left">Header left</option>
          <option value="header-center">Header center</option>
          <option value="header-right">Header right</option>
        </select>
      </div>
      <SidecarStatusLine status={status} label="Applying page numbers" />
      <button type="submit" className="tool-panel__primary-button" disabled={!hasDocument || status.running}>
        Apply Page Numbers
      </button>
    </form>
  );
}

function WatermarkPanel({
  hasDocument,
  pageCount,
  status,
  onApply,
  onHelp,
}: {
  hasDocument: boolean;
  pageCount: number;
  status: SidecarStatus;
  onApply: (options: PdfWatermarkOptions) => Promise<boolean>;
  onHelp: () => void;
}) {
  const [text, setText] = useState("DRAFT");
  const [range, setRange] = useState(formatDefaultRange(pageCount));
  const [orientation, setOrientation] = useState<PdfWatermarkOptions["orientation"]>("diagonal");
  const [opacity, setOpacity] = useState(0.18);
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parsePageRanges(range, pageCount), [pageCount, range]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);

    if (parsed.error || !text.trim()) {
      return;
    }

    await onApply({
      text: text.trim(),
      pageIndexes: parsed.pageIndexes,
      orientation,
      opacity,
    });
  }

  return (
    <form className="tool-panel__inline-card" onSubmit={submit}>
      <div className="tool-panel__card-header">
        <p className="tool-panel__card-title">Watermark</p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: Watermark" onClick={onHelp} />
      </div>
      <div className="tool-panel__button-row">
        <button type="button" className="tool-panel__secondary-button" onClick={() => setText("DRAFT")}>DRAFT</button>
        <button type="button" className="tool-panel__secondary-button" onClick={() => setText("CONFIDENTIAL")}>CONFIDENTIAL</button>
      </div>
      <div className="tool-panel__field">
        <label htmlFor="watermark-text">Text</label>
        <input id="watermark-text" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="tool-panel__field">
        <label htmlFor="watermark-range">Pages</label>
        <input id="watermark-range" value={range} onBlur={() => setTouched(true)} onChange={(event) => setRange(event.target.value)} />
        {touched && parsed.error ? <span className="tool-panel__field-error">{parsed.error}</span> : null}
      </div>
      <div className="tool-panel__field-grid">
        <div className="tool-panel__field">
          <label htmlFor="watermark-orientation">Direction</label>
          <select id="watermark-orientation" value={orientation} onChange={(event) => setOrientation(event.target.value as PdfWatermarkOptions["orientation"])}>
            <option value="diagonal">Diagonal</option>
            <option value="horizontal">Horizontal</option>
          </select>
        </div>
        <div className="tool-panel__field">
          <label htmlFor="watermark-opacity">Opacity</label>
          <input id="watermark-opacity" type="number" min="0.05" max="1" step="0.05" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
        </div>
      </div>
      <SidecarStatusLine status={status} label="Applying watermark" />
      <button type="submit" className="tool-panel__primary-button" disabled={!hasDocument || status.running}>
        Apply Watermark
      </button>
    </form>
  );
}

function CompressPanel({
  hasDocument,
  available,
  status,
  onCompress,
  onHelp,
}: {
  hasDocument: boolean;
  available: boolean;
  status: SidecarStatus;
  onCompress: (options: PdfCompressOptions) => Promise<boolean>;
  onHelp: () => void;
}) {
  const [quality, setQuality] = useState(5);
  const [grayscale, setGrayscale] = useState(false);

  return (
    <div className="tool-panel__inline-card">
      <div className="tool-panel__card-header">
        <p className="tool-panel__card-title">Compress</p>
        <IconButton icon={<HelpIcon size={14} />} label="Help: Compress" onClick={onHelp} />
      </div>
      {!available ? <DesktopCapabilityMessage /> : null}
      <div className="tool-panel__field">
        <label htmlFor="compress-quality">Quality</label>
        <input id="compress-quality" type="number" min="1" max="9" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
      </div>
      <label className="tool-panel__check-row">
        <input type="checkbox" checked={grayscale} onChange={(event) => setGrayscale(event.target.checked)} />
        Grayscale
      </label>
      {status.beforeBytes !== null && status.afterBytes !== null ? (
        <p className="tool-panel__status-line">
          {formatBytes(status.beforeBytes)} to {formatBytes(status.afterBytes)}
        </p>
      ) : null}
      <SidecarStatusLine status={status} label="Compressing PDF" />
      <button type="button" className="tool-panel__primary-button" disabled={!hasDocument || !available || status.running} onClick={() => void onCompress({ quality, grayscale })}>
        Compress PDF
      </button>
    </div>
  );
}

export function DesktopCapabilityMessage() {
  return (
    <p className="tool-panel__status-line">
      This action is available in the desktop app.
    </p>
  );
}

export function SidecarStatusLine({
  status,
  label,
}: {
  status: SidecarStatus;
  label: string;
}) {
  if (!status.message) {
    return null;
  }

  return (
    <p className="tool-panel__status-line tool-panel__status-line--inline">
      {status.running ? <LoadingSun size={13} label={label} /> : null}
      {status.message}
    </p>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Covers the confirm dialog too -- once "Make Searchable" is clicked, the
// buttons stay disabled through the confirm step and the whole run, not
// just while bytes are actually moving.
function isOcrActive(phase: OcrUiState["phase"], ocrStarting: boolean): boolean {
  return (
    ocrStarting ||
    phase === "confirm" ||
    phase === "starting-engine" ||
    phase === "processing" ||
    phase === "verifying"
  );
}
