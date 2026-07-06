import type { EditToolId } from "./edits";

export type ToolGroupId = "edit" | "organize" | "comment-ocr" | "legal";

export interface ToolRegistryEntry {
  id: string;
  label: string;
  group: ToolGroupId;
  helpArticleId: string;
  tooltip?: string;
  description?: string;
}

export const LEGAL_TOOLS = [
  { id: "prepare-for-filing", label: "Prepare for Filing", group: "legal", helpArticleId: "prepare-for-filing", description: "Check filing limits, normalize pages, split if needed, and verify the output." },
  { id: "batch-cleanup", label: "Batch Cleanup", group: "legal", helpArticleId: "batch-cleanup", description: "Run OCR, cleanup, metadata removal, and filing splits across local PDFs." },
  { id: "production-set", label: "Production Set", group: "legal", helpArticleId: "production-set", description: "Build a Bates-numbered production package with index files and optional volumes." },
  { id: "combine-exhibits", label: "Combine with Exhibits", group: "legal", helpArticleId: "combine-exhibits", description: "Append exhibits, stamp exhibit labels, add bookmarks, and optionally add an index." },
  { id: "sanitize", label: "Sanitize...", group: "legal", helpArticleId: "sanitize", description: "Remove active content such as JavaScript, links, and embedded files." },
  { id: "redact", label: "Redact", group: "legal", helpArticleId: "redact", description: "Mark areas for permanent removal, then verify redacted content is gone." },
  { id: "bates-numbering", label: "Bates Numbering", group: "legal", helpArticleId: "bates-numbering", description: "Stamp page numbers into the PDF content with a prefix and fixed digit width." },
  { id: "scanner-2425", label: "2.425 Scanner", group: "legal", helpArticleId: "scanner-2425", description: "Look for common Florida Rule 2.425 sensitive-information patterns." },
  { id: "scrub-metadata", label: "Scrub Metadata", group: "legal", helpArticleId: "scrub-metadata", description: "Inspect and remove document metadata without changing page content." },
  { id: "passwords", label: "Passwords", group: "legal", helpArticleId: "passwords", description: "Review password controls; filing prep can remove encryption with the open password." },
] as const satisfies readonly ToolRegistryEntry[];

export const ORGANIZE_TOOLS = [
  { id: "pages", label: "Organize Pages", group: "organize", helpArticleId: "pages", description: "Select, reorder, rotate, delete, extract, or split pages." },
  { id: "compress", label: "Compress...", group: "organize", helpArticleId: "compress", description: "Reduce file size through the desktop engine while preserving a PDF output." },
  { id: "repair", label: "Repair...", group: "organize", helpArticleId: "repair", description: "Ask the desktop engine to rebuild a PDF that will not open cleanly." },
  { id: "merge", label: "Merge PDFs...", group: "organize", helpArticleId: "merge", description: "Append other PDFs after the current document." },
  { id: "insert", label: "Insert from File...", group: "organize", helpArticleId: "insert", description: "Insert pages from another PDF at the selected position." },
  { id: "insert-images", label: "Insert images as pages...", group: "organize", helpArticleId: "insert-images", description: "Convert image files into PDF pages and insert them." },
  { id: "crop", label: "Crop / Resize...", group: "organize", helpArticleId: "crop", description: "Crop margins or resize selected pages to a standard page size." },
  { id: "properties", label: "Document Properties", group: "organize", helpArticleId: "properties", description: "View document metadata, size, page count, and text-layer status." },
  { id: "rotate", label: "Rotate Pages", group: "organize", helpArticleId: "rotate", description: "Rotate the selected pages clockwise." },
] as const satisfies readonly ToolRegistryEntry[];

export const TOOL_PANEL_EDIT_TOOLS = [
  { id: "edit-text", label: "Find & Replace", group: "edit", helpArticleId: "edit-text", description: "Find and replace real PDF text with a staged review." },
  { id: "textBox", label: "Text Box", group: "edit", helpArticleId: "textBox", description: "Place editable text on the current page before saving." },
  { id: "callout", label: "Callout", group: "edit", helpArticleId: "callout", description: "Place a text box with a leader arrow pointing to a page spot." },
  { id: "image", label: "Image", group: "edit", helpArticleId: "image", description: "Place an image on the current page before saving." },
  { id: "highlight", label: "Highlight", group: "edit", helpArticleId: "highlight", description: "Drag over text to create a saved highlight mark." },
  { id: "underline", label: "Underline", group: "edit", helpArticleId: "underline", description: "Drag over text to create a saved underline mark." },
  { id: "strikethrough", label: "Strikethrough", group: "edit", helpArticleId: "strikethrough", description: "Drag over text to create a saved strikethrough mark." },
  { id: "draw", label: "Draw", group: "edit", helpArticleId: "draw", description: "Draw freehand ink that will be saved with the PDF." },
  { id: "shapeRect", label: "Rectangle", group: "edit", helpArticleId: "shapes", description: "Drag a rectangle that will be saved with the PDF." },
  { id: "shapeEllipse", label: "Ellipse", group: "edit", helpArticleId: "shapes", description: "Drag an ellipse that will be saved with the PDF." },
  { id: "shapeLine", label: "Line", group: "edit", helpArticleId: "shapes", description: "Drag a straight line that will be saved with the PDF." },
  { id: "shapeArrow", label: "Arrow", group: "edit", helpArticleId: "shapes", description: "Drag an arrow that will be saved with the PDF." },
  { id: "sign", label: "Sign", group: "edit", helpArticleId: "sign", description: "Place a signature image as a visible page edit." },
] as const satisfies readonly ToolRegistryEntry[];

export const EDIT_DIALOG_TOOLS = [
  { id: "page-numbers", label: "Page Numbers...", group: "edit", helpArticleId: "page-numbers", description: "Stamp generated page numbers into selected page positions." },
  { id: "watermark", label: "Watermark...", group: "edit", helpArticleId: "watermark", description: "Add repeated visible text across document pages." },
] as const satisfies readonly ToolRegistryEntry[];

export const COMMAND_BAR_EDIT_TOOLS = [
  { id: "select", label: "Select", group: "edit", helpArticleId: "getting-started", tooltip: "Select text or return to the normal pointer." },
  { id: "highlight", label: "Highlight", group: "edit", helpArticleId: "highlight", tooltip: "Drag over text to create a saved highlight mark." },
  { id: "underline", label: "Underline", group: "edit", helpArticleId: "underline", tooltip: "Drag over text to create a saved underline mark." },
  { id: "strikethrough", label: "Strikethrough", group: "edit", helpArticleId: "strikethrough", tooltip: "Drag over text to create a saved strikethrough mark." },
  { id: "textBox", label: "Text box", group: "edit", helpArticleId: "textBox", tooltip: "Place editable text on the current page before saving." },
  { id: "callout", label: "Callout", group: "edit", helpArticleId: "callout", tooltip: "Place a text box with a leader arrow pointing to a page spot." },
  { id: "image", label: "Image", group: "edit", helpArticleId: "image", tooltip: "Place an image on the current page before saving." },
  { id: "comment", label: "Comment", group: "comment-ocr", helpArticleId: "comment", tooltip: "Add a PDF note annotation on the current page." },
  { id: "draw", label: "Draw", group: "edit", helpArticleId: "draw", tooltip: "Draw freehand ink that will be saved with the PDF." },
  { id: "shapeRect", label: "Rectangle", group: "edit", helpArticleId: "shapes", tooltip: "Drag a saved rectangle on the current page." },
  { id: "shapeEllipse", label: "Ellipse", group: "edit", helpArticleId: "shapes", tooltip: "Drag a saved ellipse on the current page." },
  { id: "shapeLine", label: "Line", group: "edit", helpArticleId: "shapes", tooltip: "Drag a saved line on the current page." },
  { id: "shapeArrow", label: "Arrow", group: "edit", helpArticleId: "shapes", tooltip: "Drag a saved arrow on the current page." },
  { id: "sign", label: "Sign", group: "edit", helpArticleId: "sign", tooltip: "Place a signature image as a visible page edit." },
] as const satisfies readonly (ToolRegistryEntry & { id: EditToolId })[];

export const HELP_ONLY_TOOL_ENTRIES = [
  { id: "make-searchable", label: "Make Searchable (OCR)", group: "comment-ocr", helpArticleId: "make-searchable", description: "Run OCR through the desktop engine and verify the output has searchable text." },
] as const satisfies readonly ToolRegistryEntry[];

export const TOOL_REGISTRY = [
  ...LEGAL_TOOLS,
  ...ORGANIZE_TOOLS,
  ...TOOL_PANEL_EDIT_TOOLS,
  ...EDIT_DIALOG_TOOLS,
  ...COMMAND_BAR_EDIT_TOOLS,
  ...HELP_ONLY_TOOL_ENTRIES,
] as const satisfies readonly ToolRegistryEntry[];

export type LegalToolId = typeof LEGAL_TOOLS[number]["id"];
export type OrganizeToolId = typeof ORGANIZE_TOOLS[number]["id"];
export type EditDialogToolId = typeof EDIT_DIALOG_TOOLS[number]["id"];
