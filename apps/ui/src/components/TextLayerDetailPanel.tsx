import type { GarbleReason, GarbledPageInfo } from "@raiopdf/rules";
import { OcrSearchIcon } from "../icons";
import { FloatingDialog } from "./FloatingDialog";
import "./TextLayerDetailPanel.css";

export interface TextLayerDetailPanelProps {
  garbledPages: readonly GarbledPageInfo[];
  onClose: () => void;
}

const REASON_COPY: Record<GarbleReason, string> = {
  low_alpha_entropy: "the hidden text is stored as unreadable character codes. The page looks perfect, but copy, paste, and screen readers get gibberish.",
  pua_glyphs: "the hidden text uses private font codes instead of normal characters. Searching and copying can return symbols or nonsense.",
  replacement_chars: "the hidden text contains replacement characters where readable text should be. Search, copy, paste, and screen readers cannot rely on it.",
  combined: "the hidden text trips multiple garbled-text checks. The visible page may look correct, but the searchable layer is not trustworthy.",
};

export function TextLayerDetailPanel({
  garbledPages,
  onClose,
}: TextLayerDetailPanelProps) {
  const reasonGroups = groupByReason(garbledPages);

  return (
    <FloatingDialog
      title="Why this text can't be trusted"
      eyebrow="Searchability"
      width="sm"
      onClose={onClose}
    >
      <div className="text-layer-detail">
        <div className="text-layer-detail__lede">
          <span className="text-layer-detail__lede-icon" aria-hidden="true">
            <OcrSearchIcon size={15} />
          </span>
          <p className="text-layer-detail__intro">
            RaioPDF found a hidden text layer, but parts of it look poisoned or garbled. The visible PDF pages are unchanged; the problem is the invisible text used for search, copy, paste, and screen readers.
          </p>
        </div>

        <section className="text-layer-detail__section" aria-label="Affected pages">
          <p className="text-layer-detail__label text-layer-detail__label--warn">Affected pages</p>
          <div className="text-layer-detail__reasons" role="list">
            {reasonGroups.map((group) => (
              <div key={group.reason} className="text-layer-detail__reason" role="listitem">
                <p className="text-layer-detail__reason-pages">Pages {formatPageList(group.pageIndexes)}</p>
                <p className="text-layer-detail__reason-copy">{REASON_COPY[group.reason]}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="text-layer-detail__fix">
          <p className="text-layer-detail__label">The fix</p>
          <p className="text-layer-detail__fix-copy">
            The fix is to rebuild the text layer with OCR. That can run offline on this device and should leave the visible page images unchanged.
          </p>
          <button type="button" className="text-layer-detail__disabled-action" disabled>
            <OcrSearchIcon size={13} />
            <span>Fix garbled text</span>
            <span className="text-layer-detail__disabled-note">(coming in a later update)</span>
          </button>
        </section>
      </div>
    </FloatingDialog>
  );
}

function groupByReason(garbledPages: readonly GarbledPageInfo[]): Array<{
  reason: GarbleReason;
  pageIndexes: number[];
}> {
  const groups = new Map<GarbleReason, number[]>();

  for (const page of garbledPages) {
    const pages = groups.get(page.reason) ?? [];
    pages.push(page.pageIndex);
    groups.set(page.reason, pages);
  }

  return Array.from(groups, ([reason, pageIndexes]) => ({
    reason,
    pageIndexes: [...pageIndexes].sort((a, b) => a - b),
  }));
}

function formatPageList(pageIndexes: readonly number[]): string {
  const pages = pageIndexes.map((pageIndex) => pageIndex + 1);

  if (pages.length <= 2) {
    return pages.join(" and ");
  }

  return `${pages.slice(0, -1).join(", ")}, and ${pages[pages.length - 1]}`;
}
