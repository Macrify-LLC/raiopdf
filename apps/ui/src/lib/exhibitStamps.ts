import type { PdfEditColor, PdfStampSequence, PdfTextBoxFontFamily } from "@raiopdf/engine-api";
import { DEFAULT_STAMP_BORDER_WIDTH_PT } from "./edits";
import { DEFAULT_TEXT_COLOR } from "./editStyles";
import {
  exhibitLabelLines,
  formatExhibitLabel,
  parseIdentifier,
  type ExhibitIdentifierStyle,
  type ExhibitLabelLayout,
} from "./exhibitLabels";

/**
 * Stored exhibit-stamp templates and their counters.
 *
 * A template is the reusable sticker ("Plaintiff's Exhibit", letters, navy
 * border); `nextIndex` is the running counter that makes the next placement
 * land on the next exhibit without the user typing a number. Because the
 * counter is the one piece of state a user notices being wrong, every mutation
 * here is transactional: re-read, mutate, write, then re-read to confirm the
 * write actually persisted before the caller is told it may place a stamp.
 * localStorage can silently reject a write (quota, private-mode, another
 * window), and a counter that advanced only in memory produces duplicate
 * exhibit numbers on the next reload.
 *
 * Phase-2 plumbing: nothing user-facing calls this yet. The stamp tool, its
 * template editor, and the overlay arrive with the tool PR.
 */

const STORAGE_KEY = "raiopdf.exhibit-stamps.v1";

/** 1.6in × 1in at 72dpi — the printed exhibit-sticker size. */
export const DEFAULT_STAMP_WIDTH_PT = 115.2;
export const DEFAULT_STAMP_HEIGHT_PT = 72;
export const DEFAULT_STAMP_FONT_SIZE_PT = 14;
export const DEFAULT_STAMP_CORNER_RADIUS_PT = 4;
export { DEFAULT_STAMP_BORDER_WIDTH_PT };
const DEFAULT_STAMP_FILL_COLOR: PdfEditColor = { r: 1, g: 1, b: 1 };

export interface ExhibitStampTemplateV1 {
  version: 1;
  id: string;
  name: string;
  prefix: string;
  suffix?: string;
  identifierStyle: ExhibitIdentifierStyle;
  /** Zero-based index the next allocation will use. */
  nextIndex: number;
  layout: ExhibitLabelLayout;
  widthPt: number;
  heightPt: number;
  fontFamily: PdfTextBoxFontFamily;
  bold: boolean;
  italic: boolean;
  fontSizePt: number;
  textColor: PdfEditColor;
  fillColor: PdfEditColor | null;
  borderColor: PdfEditColor | null;
  borderWidthPt: number;
  cornerRadiusPt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExhibitStampStoreV1 {
  version: 1;
  /**
   * Bumped on every committed mutation. Two windows editing the same templates
   * detect each other by this number rather than by diffing template contents.
   */
  revision: number;
  templates: ExhibitStampTemplateV1[];
}

/** A reserved exhibit identifier, ready to be placed as a `PendingExhibitStamp`. */
export interface ExhibitStampAllocation {
  label: string;
  lines: readonly string[];
  sequence: PdfStampSequence;
  templateId: string;
  /** Store revision this allocation was committed at (the stamp's provenance). */
  templateRevision: number;
}

export type ExhibitStampResult<T> = { ok: true; value: T } | { ok: false; error: string };

const WRITE_FAILED_MESSAGE =
  "The exhibit number could not be saved on this computer, so nothing was stamped.";
const CONFLICT_MESSAGE =
  "Exhibit stamps changed in another window. Try again.";
const MISSING_TEMPLATE_MESSAGE = "That exhibit stamp template no longer exists.";

/**
 * Reads the store for display. Cached, because listing templates happens on
 * every render of the stamp tool; the cache is dropped whenever another window
 * writes the key (`storage` event) or this module commits a mutation. Every
 * mutation path re-reads from localStorage directly and never trusts this.
 */
export function readExhibitStampStore(): ExhibitStampStoreV1 {
  if (cachedStore) {
    return cachedStore;
  }

  subscribeToCrossWindowWrites();

  const store = readStoreUncached() ?? seedStore();

  cachedStore = store;

  return store;
}

export function listExhibitStampTemplates(): readonly ExhibitStampTemplateV1[] {
  return readExhibitStampStore().templates;
}

export function findExhibitStampTemplate(templateId: string): ExhibitStampTemplateV1 | null {
  return readExhibitStampStore().templates.find((template) => template.id === templateId) ?? null;
}

/**
 * Creates or replaces a template, keyed by id.
 *
 * The live counter is authoritative in the store, never in the caller's
 * snapshot: an editor that held a template while an allocation advanced the
 * counter must not roll `nextIndex` back on save. Counter changes go through
 * `allocateIdentifier` / `rollbackIdentifier` / `setNextIdentifier` /
 * `resetCounter` only.
 */
export function saveExhibitStampTemplate(
  template: ExhibitStampTemplateV1,
): Promise<ExhibitStampResult<ExhibitStampTemplateV1>> {
  return commitMutation((store) => {
    const now = Date.now();
    const existing = store.templates.find((candidate) => candidate.id === template.id);
    const next: ExhibitStampTemplateV1 = {
      ...template,
      nextIndex: existing?.nextIndex ?? template.nextIndex,
      createdAt: existing?.createdAt ?? template.createdAt,
      updatedAt: now,
    };

    return {
      templates: existing
        ? store.templates.map((candidate) => candidate.id === next.id ? next : candidate)
        : [...store.templates, next],
      value: next,
    };
  });
}

export function deleteExhibitStampTemplate(templateId: string): Promise<ExhibitStampResult<void>> {
  return commitMutation((store) => {
    if (!store.templates.some((template) => template.id === templateId)) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    return {
      templates: store.templates.filter((template) => template.id !== templateId),
      value: undefined,
    };
  });
}

/**
 * Reserves the next exhibit identifier for a template and advances its counter.
 *
 * The counter is advanced and confirmed on disk *before* the caller gets a
 * label, so a placement can never consume a number that a reload would hand out
 * again. A failed write is a hard stop — the caller must not place the stamp.
 * If another window moved the counter between our read and our write, this
 * re-reads and retries once (picking up that window's number), then gives up
 * rather than looping.
 *
 * If the placement is then abandoned, `rollbackIdentifier` gives the number back.
 */
export function allocateIdentifier(
  templateId: string,
): Promise<ExhibitStampResult<ExhibitStampAllocation>> {
  return commitMutation((store) => {
    const template = store.templates.find((candidate) => candidate.id === templateId);

    if (!template) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    const index = template.nextIndex;
    const sequence: PdfStampSequence = {
      schemaVersion: 1,
      identifierStyle: template.identifierStyle,
      prefix: template.prefix,
      ...(template.suffix ? { suffix: template.suffix } : {}),
      layout: template.layout,
      index,
    };

    return {
      templates: replaceTemplate(store, templateId, { nextIndex: index + 1 }),
      value: {
        label: formatExhibitLabel(
          template.prefix,
          template.identifierStyle,
          index,
          template.suffix,
        ),
        lines: exhibitLabelLines(
          template.prefix,
          template.identifierStyle,
          index,
          template.layout,
          template.suffix,
        ),
        sequence,
        templateId,
        templateRevision: store.revision + 1,
      },
    };
  });
}

/**
 * Gives back an identifier whose placement never happened (the user cancelled,
 * or the save failed). Only the most recent allocation can be returned — if
 * anything has been stamped since, the counter stays where it is rather than
 * reissuing a number that is already on a page.
 */
export function rollbackIdentifier(
  templateId: string,
  index: number,
): Promise<ExhibitStampResult<void>> {
  return commitMutation((store) => {
    const template = store.templates.find((candidate) => candidate.id === templateId);

    if (!template) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    if (template.nextIndex !== index + 1) {
      return { error: "That exhibit number is no longer the most recent one." };
    }

    return {
      templates: replaceTemplate(store, templateId, { nextIndex: index }),
      value: undefined,
    };
  });
}

/** Points the counter at what the user typed ("12", "AB"). */
export function setNextIdentifier(
  templateId: string,
  rawText: string,
): Promise<ExhibitStampResult<number>> {
  const index = parseIdentifier(rawText);

  if (index === null) {
    return Promise.resolve({
      ok: false,
      error: "Enter a number (12) or a letter (AB) for the next exhibit.",
    });
  }

  return commitMutation((store) => {
    if (!store.templates.some((template) => template.id === templateId)) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    return {
      templates: replaceTemplate(store, templateId, { nextIndex: index }),
      value: index,
    };
  });
}

export function resetCounter(templateId: string): Promise<ExhibitStampResult<void>> {
  return commitMutation((store) => {
    if (!store.templates.some((template) => template.id === templateId)) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    return { templates: replaceTemplate(store, templateId, { nextIndex: 0 }), value: undefined };
  });
}

/**
 * Moves a template one slot toward the front or back of the gallery. The
 * gallery's display order IS the stored template array order, so reordering
 * is just an array splice under the same commit cycle every other mutation
 * uses. A no-op at either edge (already first going up, already last going
 * down) rather than an error -- the caller only shows the button when it
 * would move something, but a stale render racing a delete shouldn't surface
 * a scary message for what is, from the user's seat, nothing happening.
 */
export function moveExhibitStampTemplate(
  templateId: string,
  direction: "up" | "down",
): Promise<ExhibitStampResult<void>> {
  return commitMutation((store) => {
    const index = store.templates.findIndex((template) => template.id === templateId);

    if (index === -1) {
      return { error: MISSING_TEMPLATE_MESSAGE };
    }

    const targetIndex = direction === "up" ? index - 1 : index + 1;

    if (targetIndex < 0 || targetIndex >= store.templates.length) {
      return { templates: store.templates, value: undefined };
    }

    const templates = [...store.templates];
    const [moved] = templates.splice(index, 1);
    templates.splice(targetIndex, 0, moved!);

    return { templates, value: undefined };
  });
}

/** Test seam: drops the read cache and the in-flight mutation queue. */
export function resetExhibitStampCacheForTests(): void {
  cachedStore = null;
  queue = Promise.resolve();
}

export function defaultExhibitStampTemplates(): ExhibitStampTemplateV1[] {
  const createdAt = Date.now();

  return [
    starterTemplate("plaintiffs-exhibit", "Plaintiff's Exhibit", "numbers", createdAt),
    starterTemplate("defendants-exhibit", "Defendant's Exhibit", "letters", createdAt),
    starterTemplate("exhibit", "Exhibit", "letters", createdAt),
  ];
}

type MutationOutcome<T> =
  | { templates: ExhibitStampTemplateV1[]; value: T }
  | { error: string };

let cachedStore: ExhibitStampStoreV1 | null = null;
let queue: Promise<void> = Promise.resolve();
let subscribed = false;

/**
 * Serializes mutations in this window (a module-level promise chain, so two
 * rapid allocations can't read the same counter) and commits each one with a
 * read-modify-write-verify cycle, retrying once on a cross-window conflict.
 */
const STORE_LOCK_NAME = "raiopdf.exhibit-stamps.v1";

/**
 * Cross-window exclusion for the read-modify-write-verify cycle. localStorage
 * has no compare-and-swap, so revision verification alone can miss two windows
 * interleaving cleanly around each other's verify reads — the Web Lock makes
 * the whole cycle atomic across windows. Where Web Locks are unavailable the
 * revision check remains as the best-effort fallback guard.
 */
function withStoreLock<T>(run: () => T): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;

  if (!locks?.request) {
    return Promise.resolve(run());
  }

  return locks.request(STORE_LOCK_NAME, async () => run());
}

function commitMutation<T>(mutate: (store: ExhibitStampStoreV1) => MutationOutcome<T>) {
  const run = queue.then(() =>
    withStoreLock((): ExhibitStampResult<T> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = attemptMutation(mutate);

        if (outcome.status === "ok") {
          return { ok: true, value: outcome.value };
        }

        if (outcome.status === "failed") {
          return { ok: false, error: outcome.error };
        }
      }

      return { ok: false, error: CONFLICT_MESSAGE };
    }),
  );

  // The queue must never reject or every later mutation inherits the failure.
  queue = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

type AttemptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "failed"; error: string }
  | { status: "conflict" };

function attemptMutation<T>(
  mutate: (store: ExhibitStampStoreV1) => MutationOutcome<T>,
): AttemptOutcome<T> {
  const store = readStoreUncached() ?? seedStore();
  const outcome = mutate(store);

  if ("error" in outcome) {
    return { status: "failed", error: outcome.error };
  }

  const nextStore: ExhibitStampStoreV1 = {
    version: 1,
    revision: store.revision + 1,
    templates: outcome.templates,
  };
  const serialized = JSON.stringify(nextStore);

  if (!writeStore(serialized)) {
    // Nothing was persisted — the caller must act as if the mutation never
    // happened rather than trust an in-memory counter.
    return { status: "failed", error: WRITE_FAILED_MESSAGE };
  }

  const persistedRaw = readRaw();
  const persisted = persistedRaw === serialized ? parseStore(persistedRaw) : null;

  if (!persisted || persisted.revision !== nextStore.revision) {
    // Either the write silently didn't stick or another window landed a write
    // on top of it. Both are recoverable by re-reading; neither is safe to
    // report as a committed mutation.
    cachedStore = null;
    return { status: "conflict" };
  }

  cachedStore = persisted;

  return { status: "ok", value: outcome.value };
}

function replaceTemplate(
  store: ExhibitStampStoreV1,
  templateId: string,
  patch: Partial<ExhibitStampTemplateV1>,
): ExhibitStampTemplateV1[] {
  const updatedAt = Date.now();

  return store.templates.map((template) =>
    template.id === templateId ? { ...template, ...patch, updatedAt } : template,
  );
}

function readRaw(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoreUncached(): ExhibitStampStoreV1 | null {
  return parseStore(readRaw());
}

function parseStore(raw: string | null): ExhibitStampStoreV1 | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return isExhibitStampStore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStore(serialized: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * A missing or unreadable store falls back to the starter templates rather than
 * an empty list — the tool is unusable without at least one template, and a
 * corrupt key should not brick it. The seed is written back best-effort; if the
 * write fails the same seed is produced next time.
 */
function seedStore(): ExhibitStampStoreV1 {
  const store: ExhibitStampStoreV1 = {
    version: 1,
    revision: 0,
    templates: defaultExhibitStampTemplates(),
  };

  writeStore(JSON.stringify(store));

  return store;
}

function starterTemplate(
  id: string,
  name: string,
  identifierStyle: ExhibitIdentifierStyle,
  createdAt: number,
): ExhibitStampTemplateV1 {
  return {
    version: 1,
    id,
    name,
    prefix: name,
    identifierStyle,
    nextIndex: 0,
    layout: "stacked",
    widthPt: DEFAULT_STAMP_WIDTH_PT,
    heightPt: DEFAULT_STAMP_HEIGHT_PT,
    fontFamily: "helvetica",
    bold: true,
    italic: false,
    fontSizePt: DEFAULT_STAMP_FONT_SIZE_PT,
    textColor: DEFAULT_TEXT_COLOR,
    fillColor: DEFAULT_STAMP_FILL_COLOR,
    borderColor: DEFAULT_TEXT_COLOR,
    borderWidthPt: DEFAULT_STAMP_BORDER_WIDTH_PT,
    cornerRadiusPt: DEFAULT_STAMP_CORNER_RADIUS_PT,
    createdAt,
    updatedAt: createdAt,
  };
}

function subscribeToCrossWindowWrites(): void {
  if (subscribed || typeof window === "undefined" || !window.addEventListener) {
    return;
  }

  subscribed = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    // key === null is a whole-storage clear.
    if (event.key === null || event.key === STORAGE_KEY) {
      cachedStore = null;
    }
  });
}

function isExhibitStampStore(value: unknown): value is ExhibitStampStoreV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const store = value as ExhibitStampStoreV1;

  return store.version === 1 &&
    isCount(store.revision) &&
    Array.isArray(store.templates) &&
    store.templates.every(isExhibitStampTemplate);
}

function isExhibitStampTemplate(value: unknown): value is ExhibitStampTemplateV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const template = value as ExhibitStampTemplateV1;

  return template.version === 1 &&
    typeof template.id === "string" &&
    template.id.length > 0 &&
    typeof template.name === "string" &&
    typeof template.prefix === "string" &&
    (template.suffix === undefined || typeof template.suffix === "string") &&
    (
      template.identifierStyle === "letters" ||
      template.identifierStyle === "numbers" ||
      template.identifierStyle === "none"
    ) &&
    isCount(template.nextIndex) &&
    (template.layout === "stacked" || template.layout === "inline") &&
    isPositive(template.widthPt) &&
    isPositive(template.heightPt) &&
    (
      template.fontFamily === "helvetica" ||
      template.fontFamily === "times" ||
      template.fontFamily === "courier"
    ) &&
    typeof template.bold === "boolean" &&
    typeof template.italic === "boolean" &&
    isPositive(template.fontSizePt) &&
    isColor(template.textColor) &&
    isOptionalColor(template.fillColor) &&
    isOptionalColor(template.borderColor) &&
    isNonNegative(template.borderWidthPt) &&
    isNonNegative(template.cornerRadiusPt) &&
    typeof template.createdAt === "number" &&
    typeof template.updatedAt === "number";
}

function isColor(value: unknown): value is PdfEditColor {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const color = value as PdfEditColor;

  return isChannel(color.r) && isChannel(color.g) && isChannel(color.b);
}

function isOptionalColor(value: unknown): value is PdfEditColor | null {
  return value === null || isColor(value);
}

function isChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
