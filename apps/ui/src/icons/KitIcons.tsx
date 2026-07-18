import { createKitIcon, RpIcon, type RpIconProps } from "./RpIcon";
export { TextBoxIcon } from "./TextBoxIcon";
import type { IconProps } from "./types";

export interface BoltIconProps extends IconProps {
  variant?: "filled" | "outline";
}

export function BoltIcon({
  variant = "filled",
  size = 20,
  ...props
}: BoltIconProps) {
  return (
    <RpIcon
      {...props}
      name={variant === "outline" ? "bolt-outline" : "bolt-filled"}
      size={size}
    />
  );
}

export interface ShieldCheckIconProps extends IconProps {
  checked?: boolean;
}

export function ShieldCheckIcon({
  checked = true,
  size = 20,
  ...props
}: ShieldCheckIconProps) {
  return (
    <RpIcon
      {...props}
      name={checked ? "shield-check" : "shield-check-bare"}
      size={size}
    />
  );
}

export const OpenIcon = createKitIcon("open");
export const SaveIcon = createKitIcon("save");
export const PrintIcon = createKitIcon("print");
export const UndoIcon = createKitIcon("undo");
export const SelectTextIcon = createKitIcon("select-text");
export const HighlightIcon = createKitIcon("highlight");
export const UnderlineIcon = createKitIcon("underline");
export const StrikethroughIcon = createKitIcon("strikethrough");
export const EditIcon = createKitIcon("edit");
export const OrganizeIcon = createKitIcon("organize");
export const CommentIcon = createKitIcon("comment");
export const CommentMarkerIcon = createKitIcon("comment-marker");
export const ScaleIcon = createKitIcon("scale");
export const CombineExhibitsIcon = createKitIcon("combine-exhibits");
export const OcrSearchIcon = createKitIcon("ocr-search");
export const RedactIcon = createKitIcon("redact");
export const BatesIcon = createKitIcon("bates");
export const ScrubMetadataIcon = createKitIcon("scrub-metadata");
export const ChevronLeftIcon = createKitIcon("chevron-left");
export const ChevronRightIcon = createKitIcon("chevron-right");
export const ChevronDownIcon = createKitIcon("chevron-down");
export const SearchIcon = createKitIcon("search");
export const HelpIcon = createKitIcon("help");
export const MinusIcon = createKitIcon("minus");
export const PlusIcon = createKitIcon("plus");
export const CheckIcon = createKitIcon("check");
export const RotateIcon = createKitIcon("rotate");
export const DeleteIcon = createKitIcon("delete");
export const ArrowUpIcon = createKitIcon("arrow-up");
export const ArrowDownIcon = createKitIcon("arrow-down");
export const DragHandleIcon = createKitIcon("drag-handle");
export const SlipSheetIcon = createKitIcon("slip-sheet");
export const SplitIcon = createKitIcon("split");
export const ExtractIcon = createKitIcon("extract");
export const InsertIcon = createKitIcon("insert");
export const CropIcon = createKitIcon("crop");
export const SensitiveScanIcon = createKitIcon("sensitive-scan");
export const LockIcon = createKitIcon("lock");
export const WrenchIcon = createKitIcon("wrench");
export const ProductionSetIcon = createKitIcon("production-set");
export const PageNumbersIcon = createKitIcon("page-numbers");
export const TableOfAuthoritiesIcon = createKitIcon("table-of-authorities");
export const DocPropertiesIcon = createKitIcon("doc-properties");
export const WatermarkIcon = createKitIcon("watermark");
export const MergeIcon = createKitIcon("merge");
export const CompressIcon = createKitIcon("compress");
export const PdfToWordIcon = createKitIcon("pdf-to-word");
export const InsertImageIcon = createKitIcon("insert-image");
export const BatchCleanupIcon = createKitIcon("batch-cleanup");
export const PagesIcon = createKitIcon("pages");

export type { RpIconProps };
