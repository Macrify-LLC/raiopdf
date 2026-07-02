import { useState } from "react";
import {
  BatesIcon,
  BoltIcon,
  CombineExhibitsIcon,
  CommentIcon,
  EditIcon,
  OcrSearchIcon,
  OrganizeIcon,
  RedactIcon,
  ScaleIcon,
  ScrubMetadataIcon,
  ShieldCheckIcon,
} from "../icons";
import { AccordionGroup } from "./AccordionGroup";
import { ToolRow } from "./ToolRow";
import "./ToolPanel.css";

type GroupId = "edit" | "organize" | "comment" | "legal";

const LEGAL_TOOLS = [
  { id: "prepare-for-filing", label: "Prepare for Filing", icon: <BoltIcon variant="outline" size={16} /> },
  { id: "combine-exhibits", label: "Combine with Exhibits", icon: <CombineExhibitsIcon size={16} /> },
  { id: "make-searchable", label: "Make Searchable (OCR)", icon: <OcrSearchIcon size={16} /> },
  { id: "redact", label: "Redact", icon: <RedactIcon size={16} /> },
  { id: "bates-numbering", label: "Bates Numbering", icon: <BatesIcon size={16} /> },
  { id: "scanner-2425", label: "2.425 Scanner", icon: <ShieldCheckIcon size={16} /> },
  { id: "scrub-metadata", label: "Scrub Metadata", icon: <ScrubMetadataIcon size={16} /> },
] as const;

export function ToolPanel() {
  const [openGroup, setOpenGroup] = useState<GroupId | null>("legal");
  const [selectedLegalTool, setSelectedLegalTool] = useState<string>(
    "prepare-for-filing",
  );

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
        <p className="accordion-group__empty">More tools coming soon.</p>
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
        {LEGAL_TOOLS.map((tool) => (
          <ToolRow
            key={tool.id}
            icon={tool.icon}
            label={tool.label}
            selected={selectedLegalTool === tool.id}
            onSelect={() => setSelectedLegalTool(tool.id)}
          />
        ))}
      </AccordionGroup>
    </aside>
  );
}
