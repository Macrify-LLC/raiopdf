import { useState } from "react";
import type { OcrUiState } from "../App";
import {
  BatesIcon,
  BoltIcon,
  CombineExhibitsIcon,
  CommentIcon,
  CropIcon,
  EditIcon,
  ExtractIcon,
  InsertIcon,
  OcrSearchIcon,
  OrganizeIcon,
  RedactIcon,
  ScaleIcon,
  ScrubMetadataIcon,
  ShieldCheckIcon,
  SplitIcon,
} from "../icons";
import { AccordionGroup } from "./AccordionGroup";
import { ToolRow } from "./ToolRow";
import "./ToolPanel.css";

type GroupId = "edit" | "organize" | "comment" | "legal";
export type LegalToolId = typeof LEGAL_TOOLS[number]["id"];
export type OrganizeToolId = typeof ORGANIZE_TOOLS[number]["id"];

const LEGAL_TOOLS = [
  { id: "prepare-for-filing", label: "Prepare for Filing", icon: <BoltIcon variant="outline" size={16} /> },
  { id: "combine-exhibits", label: "Combine with Exhibits", icon: <CombineExhibitsIcon size={16} /> },
  { id: "make-searchable", label: "Make Searchable (OCR)", icon: <OcrSearchIcon size={16} /> },
  { id: "redact", label: "Redact", icon: <RedactIcon size={16} /> },
  { id: "bates-numbering", label: "Bates Numbering", icon: <BatesIcon size={16} /> },
  { id: "scanner-2425", label: "2.425 Scanner", icon: <ShieldCheckIcon size={16} /> },
  { id: "scrub-metadata", label: "Scrub Metadata", icon: <ScrubMetadataIcon size={16} /> },
] as const;

const ORGANIZE_TOOLS = [
  { id: "merge", label: "Merge PDFs...", icon: <CombineExhibitsIcon size={16} /> },
  { id: "split", label: "Split by Pages...", icon: <SplitIcon size={16} /> },
  { id: "extract", label: "Extract Pages...", icon: <ExtractIcon size={16} /> },
  { id: "insert", label: "Insert from File...", icon: <InsertIcon size={16} /> },
  { id: "crop", label: "Crop / Resize...", icon: <CropIcon size={16} /> },
] as const;

export interface ToolPanelProps {
  hasDocument: boolean;
  ocrState: OcrUiState;
  ocrAvailable: boolean;
  ocrStarting: boolean;
  activeLegalTool: string | null;
  activeOrganizeTool: string | null;
  onLegalToolSelected: (toolId: LegalToolId) => void;
  onOrganizeToolSelected: (toolId: OrganizeToolId) => void;
  onMakeSearchable: () => void;
}

export function ToolPanel({
  hasDocument,
  ocrState,
  ocrAvailable,
  ocrStarting,
  activeLegalTool,
  activeOrganizeTool,
  onLegalToolSelected,
  onOrganizeToolSelected,
  onMakeSearchable,
}: ToolPanelProps) {
  const [openGroup, setOpenGroup] = useState<GroupId | null>("legal");

  function toggleGroup(group: GroupId) {
    setOpenGroup((current) => (current === group ? null : group));
  }

  function selectLegalTool(toolId: string) {
    onLegalToolSelected(toolId as LegalToolId);

    if (toolId === "make-searchable") {
      if (isOcrActive(ocrState.phase, ocrStarting)) {
        return;
      }

      onMakeSearchable();
    }
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
        {ORGANIZE_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={tool.icon}
            label={tool.label}
            selected={activeOrganizeTool === tool.id}
            onSelect={() => onOrganizeToolSelected(tool.id)}
          />
        ))}
      </AccordionGroup>

      <AccordionGroup
        id="organize"
        icon={<OrganizeIcon size={16} />}
        label="Organize"
        isOpen={openGroup === "organize"}
        onToggle={() => toggleGroup("organize")}
      >
        <p className="accordion-group__empty">More tools coming soon.</p>
      </AccordionGroup>

      <AccordionGroup
        id="comment"
        icon={<CommentIcon size={16} />}
        label="Comment"
        isOpen={openGroup === "comment"}
        onToggle={() => toggleGroup("comment")}
      >
        <p className="accordion-group__empty">More tools coming soon.</p>
      </AccordionGroup>

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
          const disabled = tool.id === "make-searchable" && isOcrActive(ocrState.phase, ocrStarting);

          return (
            <div key={tool.id}>
              <ToolRow
                icon={tool.icon}
                label={tool.label}
                selected={selected}
                disabled={disabled}
                onSelect={() => selectLegalTool(tool.id)}
              />
              {tool.id === "make-searchable" && selected ? (
                <OcrStatusPanel
                  hasDocument={hasDocument}
                  ocrState={ocrState}
                  ocrAvailable={ocrAvailable}
                  ocrStarting={ocrStarting}
                />
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

  return (
    <div
      className="tool-panel__ocr-status"
      data-phase={phase}
      role="status"
      aria-live="polite"
    >
      <p className="tool-panel__ocr-status-label">{getOcrStatusLabel(phase)}</p>
      <p className="tool-panel__ocr-status-message">{message}</p>
    </div>
  );
}

function getDefaultOcrMessage(hasDocument: boolean, ocrAvailable: boolean): string {
  if (!hasDocument) {
    return "Open a PDF before running OCR.";
  }

  if (!ocrAvailable) {
    return "OCR runs in the desktop app.";
  }

  return "Ready to make this PDF searchable.";
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
