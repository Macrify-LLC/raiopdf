import type { EditToolId } from "./edits";

export type ToolGroupId = "edit" | "organize" | "comment-ocr" | "legal";

export interface ToolRegistryEntry {
  id: string;
  label: string;
  group: ToolGroupId;
  helpArticleId: string;
}

export const LEGAL_TOOLS = [
  { id: "prepare-for-filing", label: "Prepare for Filing", group: "legal", helpArticleId: "prepare-for-filing" },
  { id: "batch-cleanup", label: "Batch Cleanup", group: "legal", helpArticleId: "batch-cleanup" },
  { id: "production-set", label: "Production Set", group: "legal", helpArticleId: "production-set" },
  { id: "combine-exhibits", label: "Combine with Exhibits", group: "legal", helpArticleId: "combine-exhibits" },
  { id: "sanitize", label: "Sanitize...", group: "legal", helpArticleId: "sanitize" },
  { id: "redact", label: "Redact", group: "legal", helpArticleId: "redact" },
  { id: "bates-numbering", label: "Bates Numbering", group: "legal", helpArticleId: "bates-numbering" },
  { id: "scanner-2425", label: "2.425 Scanner", group: "legal", helpArticleId: "scanner-2425" },
  { id: "scrub-metadata", label: "Scrub Metadata", group: "legal", helpArticleId: "scrub-metadata" },
  { id: "passwords", label: "Passwords", group: "legal", helpArticleId: "passwords" },
] as const satisfies readonly ToolRegistryEntry[];

export const ORGANIZE_TOOLS = [
  { id: "pages", label: "Organize Pages", group: "organize", helpArticleId: "pages" },
  { id: "compress", label: "Compress...", group: "organize", helpArticleId: "compress" },
  { id: "repair", label: "Repair...", group: "organize", helpArticleId: "repair" },
  { id: "merge", label: "Merge PDFs...", group: "organize", helpArticleId: "merge" },
  { id: "insert", label: "Insert from File...", group: "organize", helpArticleId: "insert" },
  { id: "insert-images", label: "Insert images as pages...", group: "organize", helpArticleId: "insert-images" },
  { id: "crop", label: "Crop / Resize...", group: "organize", helpArticleId: "crop" },
  { id: "properties", label: "Document Properties", group: "organize", helpArticleId: "properties" },
  { id: "rotate", label: "Rotate Pages", group: "organize", helpArticleId: "rotate" },
] as const satisfies readonly ToolRegistryEntry[];

export const TOOL_PANEL_EDIT_TOOLS = [
  { id: "textBox", label: "Text Box", group: "edit", helpArticleId: "textBox" },
  { id: "image", label: "Image", group: "edit", helpArticleId: "image" },
  { id: "highlight", label: "Highlight", group: "edit", helpArticleId: "highlight" },
  { id: "draw", label: "Draw", group: "edit", helpArticleId: "draw" },
  { id: "sign", label: "Sign", group: "edit", helpArticleId: "sign" },
] as const satisfies readonly (ToolRegistryEntry & {
  id: Exclude<EditToolId, "select" | "comment">;
})[];

export const EDIT_DIALOG_TOOLS = [
  { id: "page-numbers", label: "Page Numbers...", group: "edit", helpArticleId: "page-numbers" },
  { id: "watermark", label: "Watermark...", group: "edit", helpArticleId: "watermark" },
] as const satisfies readonly ToolRegistryEntry[];

export const COMMAND_BAR_EDIT_TOOLS = [
  { id: "select", label: "Select", group: "edit", helpArticleId: "getting-started" },
  { id: "highlight", label: "Highlight", group: "edit", helpArticleId: "highlight" },
  { id: "textBox", label: "Text box", group: "edit", helpArticleId: "textBox" },
  { id: "image", label: "Image", group: "edit", helpArticleId: "image" },
  { id: "comment", label: "Comment", group: "comment-ocr", helpArticleId: "comment" },
  { id: "draw", label: "Draw", group: "edit", helpArticleId: "draw" },
  { id: "sign", label: "Sign", group: "edit", helpArticleId: "sign" },
] as const satisfies readonly (ToolRegistryEntry & { id: EditToolId })[];

export const HELP_ONLY_TOOL_ENTRIES = [
  { id: "make-searchable", label: "Make Searchable (OCR)", group: "comment-ocr", helpArticleId: "make-searchable" },
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
