import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PdfEdit,
  PdfEditImageFormat,
  PdfFormFieldValue,
  PdfRaioAnnotationImport,
  PdfStampSequence,
} from "@raiopdf/engine-api";
import {
  annotationSavePlanHasChanges,
  buildAnnotationSavePlan,
  dataUrlToBytes,
  pendingEditsFromRaioAnnotations,
  isTextMarkupTool,
  MARKUP_FROM_SELECTION_EVENT,
  toPdfEdits,
  type AnnotationSavePlan,
  type EditToolId,
  type PendingEdit,
  type PendingEditStatus,
  type ShapeToolId,
  type TextMarkupToolId,
} from "../lib/edits";
import { exhibitLabelLines, formatExhibitLabel } from "../lib/exhibitLabels";
import {
  allocateIdentifier,
  findExhibitStampTemplate,
  rollbackIdentifier,
  type ExhibitStampAllocation,
  type ExhibitStampTemplateV1,
} from "../lib/exhibitStamps";
import { closestTextLayer } from "../lib/selectedTextEdit";
import {
  DEFAULT_INK_STROKE_WIDTH_PT,
  DEFAULT_CALLOUT_STROKE_WIDTH_PT,
  DEFAULT_SHAPE_STROKE_WIDTH_PT,
  type CalloutEditStyle,
  type HighlightEditStyle,
  type InkEditStyle,
  type ShapeEditStyle,
  type TextMarkupEditStyle,
  type TextBoxEditStyle,
} from "../lib/editStyles";
import type { PDFDocumentProxy } from "../lib/pdfjs";

/** An image (or signature image) picked and ready to place with a click. */
export interface ArmedImageStamp {
  bytes: Uint8Array;
  format: PdfEditImageFormat;
  dataUrl: string;
  /** Natural pixel width, used for the initial placement size and aspect lock. */
  width: number;
  height: number;
}

/**
 * An exhibit stamp template picked and ready to place, previewing the number
 * the NEXT click will use.
 *
 * Arming reserves nothing: the counter only advances when a stamp actually
 * lands on a page (`allocateExhibitStampIdentifier`), so arming the tool and
 * then changing your mind never burns an exhibit number. `label`/`lines` are
 * therefore a preview recomputed from the store after every placement.
 */
export interface ArmedExhibitStamp {
  templateId: string;
  label: string;
  lines: readonly string[];
  sequence: PdfStampSequence;
  template: ExhibitStampTemplateV1;
}

export interface SavedSignature {
  id: string;
  dataUrl: string;
  createdAt: number;
}

/**
 * Document-bound editing state that survives a tab switch: pending edits
 * (including imported annotations and their ids) plus changed form values.
 * Captured on switch-away and restored on switch-back so pending work is
 * never silently destroyed by viewing another tab.
 */
export interface EditingDocumentSnapshot {
  pendingEdits: readonly PendingEdit[];
  importedAnnotIds: ReadonlySet<string>;
  formValues: Readonly<Record<string, PdfFormFieldValue>>;
}

const SIGNATURES_STORAGE_KEY = "raiopdf.saved-signatures";
const MAX_SAVED_SIGNATURES = 12;
const MAX_SAVED_SIGNATURE_BYTES = 500 * 1024;
const MAX_SAVED_SIGNATURES_BYTES = 2 * 1024 * 1024;

function resetFormAuthoringTool(tool: EditToolId): EditToolId {
  return tool === "formText" || tool === "formCheckbox" ? "select" : tool;
}

export interface EditingState {
  tool: EditToolId;
  setTool: (tool: EditToolId) => void;
  pendingEdits: readonly PendingEdit[];
  addEdit: (edit: PendingEdit) => void;
  updateEdit: (id: string, update: (edit: PendingEdit) => PendingEdit) => void;
  removeEdit: (id: string) => void;
  clearPending: () => void;
  clearPendingEdits: () => void;
  draftEditCount: number;
  appliedEditCount: number;
  applyPending: () => void;
  unapplyPending: () => void;
  setEditStatus: (id: string, status: PendingEditStatus) => void;
  loadImportedAnnotations: (annotations: readonly PdfRaioAnnotationImport[]) => void;
  /**
   * The one selected placed item (stamp/image/text box) across ALL pages.
   * Shared here rather than per-EditLayer because the continuous-scroll
   * viewer mounts one EditLayer per visible page — a per-layer selection
   * would let Delete remove an item on every mounted page at once.
   */
  selectedEditId: string | null;
  setSelectedEditId: (id: string | null) => void;
  /** Pick-to-place state for the Image tool. */
  armedImage: ArmedImageStamp | null;
  handleImageFile: (file: File) => void;
  disarmImage: () => void;
  /** Pick-to-place state for the Sign tool. */
  armedSignature: ArmedImageStamp | null;
  signatureCardOpen: boolean;
  setSignatureCardOpen: (open: boolean) => void;
  savedSignatures: readonly SavedSignature[];
  saveSignature: (dataUrl: string) => boolean;
  deleteSavedSignature: (id: string) => void;
  armSignatureFromDataUrl: (dataUrl: string) => Promise<boolean>;
  disarmSignature: () => void;
  /** Pick-to-place state for the Exhibit Stamp tool. */
  armedExhibitStamp: ArmedExhibitStamp | null;
  stampCardOpen: boolean;
  setStampCardOpen: (open: boolean) => void;
  /** Arms a template and previews the number its next placement will use. */
  armExhibitStamp: (templateId: string) => boolean;
  /** Re-reads the armed template so an edited counter shows up immediately. */
  refreshArmedExhibitStamp: () => void;
  disarmExhibitStamp: () => void;
  /**
   * Reserves the next exhibit number for the armed template and advances the
   * counter on disk. Returns null — with the reason in `message` — when the
   * counter could not be committed, in which case nothing may be placed.
   */
  allocateExhibitStampIdentifier: () => Promise<ExhibitStampAllocation | null>;
  flattenOnSave: boolean;
  setFlattenOnSave: (flatten: boolean) => void;
  /** AcroForm fill state — document-scoped changed values only. */
  hasFormFields: boolean;
  formValues: Readonly<Record<string, PdfFormFieldValue>>;
  setFormValue: (fieldName: string, value: PdfFormFieldValue) => void;
  highlightStyle: HighlightEditStyle;
  updateHighlightStyle: (style: Partial<HighlightEditStyle>) => void;
  textMarkupStyles: Readonly<Record<Exclude<TextMarkupToolId, "highlight">, TextMarkupEditStyle>>;
  updateTextMarkupStyle: (
    tool: Exclude<TextMarkupToolId, "highlight">,
    style: Partial<TextMarkupEditStyle>,
  ) => void;
  textBoxStyle: TextBoxEditStyle;
  updateTextBoxStyle: (style: Partial<TextBoxEditStyle>) => void;
  calloutStyle: CalloutEditStyle;
  updateCalloutStyle: (style: Partial<CalloutEditStyle>) => void;
  inkStyle: InkEditStyle;
  updateInkStyle: (style: Partial<InkEditStyle>) => void;
  shapeStyles: Readonly<Record<ShapeToolId, ShapeEditStyle>>;
  updateShapeStyle: (tool: ShapeToolId, style: Partial<ShapeEditStyle>) => void;
  /** Transient status line for the edit mode bar. */
  message: string | null;
  setMessage: (message: string | null) => void;
  /**
   * Builds the single applyEdits payload for Save. Returns null when there is
   * nothing to apply.
   */
  collectEdits: () => { edits: PdfEdit[]; flatten: boolean } | null;
  collectAnnotationSavePlan: () => {
    plan: AnnotationSavePlan;
    flatten: boolean;
  } | null;
  collectMarkupAnnotationSavePlan: () => AnnotationSavePlan;
  hasUnsavedEdits: boolean;
  /**
   * The id of the newest pending edit that undo may remove, or null. Imported
   * annotations (opened with the document) are never undo targets — undoing
   * "your last edit" must not delete pre-existing document content. Every
   * undo door (menu, Ctrl+Z, toolbar) derives from this one value.
   */
  lastUndoableEditId: string | null;
  /** Clears all document-bound edit state (pending items + form values). */
  resetForDocument: () => void;
  /** Captures the document-bound edit state for a tab switch-away. */
  captureDocumentState: () => EditingDocumentSnapshot;
  /** Restores a previously captured snapshot on tab switch-back. */
  restoreDocumentState: (snapshot: EditingDocumentSnapshot) => void;
}

let editIdCounter = 0;

export function newEditId(): string {
  editIdCounter += 1;

  return `edit-${editIdCounter}`;
}

export function useEditing(pdfDocument: PDFDocumentProxy | null): EditingState {
  const [tool, setToolState] = useState<EditToolId>("select");
  const [pendingEdits, setPendingEdits] = useState<readonly PendingEdit[]>([]);
  const [importedAnnotIds, setImportedAnnotIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);
  const [armedImage, setArmedImage] = useState<ArmedImageStamp | null>(null);
  const [armedSignature, setArmedSignature] = useState<ArmedImageStamp | null>(null);
  const [signatureCardOpen, setSignatureCardOpen] = useState(false);
  const [armedExhibitStamp, setArmedExhibitStamp] = useState<ArmedExhibitStamp | null>(null);
  const [stampCardOpen, setStampCardOpen] = useState(false);
  const [savedSignatures, setSavedSignatures] = useState<readonly SavedSignature[]>(
    loadSavedSignatures,
  );
  const [flattenOnSave, setFlattenOnSave] = useState(true);
  const [hasFormFields, setHasFormFields] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, PdfFormFieldValue>>({});
  const [highlightStyle, setHighlightStyle] = useState<HighlightEditStyle>({});
  const [textMarkupStyles, setTextMarkupStyles] = useState<
    Record<Exclude<TextMarkupToolId, "highlight">, TextMarkupEditStyle>
  >({
    underline: {},
    strikethrough: {},
  });
  const [textBoxStyle, setTextBoxStyle] = useState<TextBoxEditStyle>({});
  const [calloutStyle, setCalloutStyle] = useState<CalloutEditStyle>({
    strokeWidthPt: DEFAULT_CALLOUT_STROKE_WIDTH_PT,
  });
  const [inkStyle, setInkStyle] = useState<InkEditStyle>({
    strokeWidthPt: DEFAULT_INK_STROKE_WIDTH_PT,
  });
  const [shapeStyles, setShapeStyles] = useState<Record<ShapeToolId, ShapeEditStyle>>({
    shapeRect: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
    shapeEllipse: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT, fillColor: null },
    shapeLine: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
    shapeArrow: { strokeWidthPt: DEFAULT_SHAPE_STROKE_WIDTH_PT },
  });
  const [message, setMessage] = useState<string | null>(null);
  const signatureIdRef = useRef(0);
  // Latest-value refs so the stable callbacks below can read current state
  // without taking it as a dependency (which would re-create every callback on
  // each keystroke and, for removeEdit, force the whole editing object to
  // change identity on every edit).
  const pendingEditsRef = useRef(pendingEdits);
  pendingEditsRef.current = pendingEdits;
  const armedExhibitStampRef = useRef(armedExhibitStamp);
  armedExhibitStampRef.current = armedExhibitStamp;

  useEffect(() => {
    let disposed = false;

    if (!pdfDocument) {
      setHasFormFields(false);
      return;
    }

    void pdfDocument
      .getFieldObjects()
      .then((fields) => {
        if (!disposed) {
          setHasFormFields(Boolean(fields && Object.keys(fields).length > 0));
        }
      })
      .catch(() => {
        if (!disposed) {
          setHasFormFields(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [pdfDocument]);

  const setTool = useCallback((nextTool: EditToolId) => {
    setToolState(nextTool);
    setMessage(null);
    setSelectedEditId(null);
    setSignatureCardOpen(nextTool === "sign");
    // Choosing the stamp tool with nothing armed opens the gallery, because
    // there is nothing to place until a template is picked. Leaving the tool
    // disarms, so a stray click under another tool can never stamp.
    setStampCardOpen(nextTool === "stamp" && !armedExhibitStampRef.current);

    if (nextTool !== "stamp") {
      setArmedExhibitStamp(null);
    }

    // A live page-text selection must not linger inert across a tool switch.
    // Switching to a text-markup tool converts it into that markup (the
    // mounted EditLayers handle the event synchronously, each for its own
    // page); switching to anything else just drops it. Selections outside
    // the page text layers (search box, form fields) are left alone.
    if (nextTool === "select") {
      return;
    }
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !closestTextLayer(selection.anchorNode)
    ) {
      return;
    }
    if (isTextMarkupTool(nextTool)) {
      window.dispatchEvent(
        new CustomEvent(MARKUP_FROM_SELECTION_EVENT, { detail: { kind: nextTool } }),
      );
    }
    selection.removeAllRanges();
  }, []);

  const addEdit = useCallback((edit: PendingEdit) => {
    setPendingEdits((current) => [...current, { ...edit, status: edit.status ?? "draft" }]);
  }, []);

  const updateEdit = useCallback(
    (id: string, update: (edit: PendingEdit) => PendingEdit) => {
      setPendingEdits((current) =>
        current.map((edit) => (edit.id === id ? update(edit) : edit)),
      );
    },
    [],
  );

  const refreshArmedExhibitStamp = useCallback(() => {
    const armed = armedExhibitStampRef.current;

    if (armed) {
      setArmedExhibitStamp(nextArmedExhibitStamp(armed.templateId));
    }
  }, []);

  /**
   * The single removal door — every delete path (the X badge, the right-click
   * menu, the Delete/Backspace key, and Undo) goes through here, so giving an
   * exhibit number back can never depend on which one the user used.
   */
  const removeEdit = useCallback(
    (id: string) => {
      const removed = pendingEditsRef.current.find((edit) => edit.id === id);

      if (removed) {
        void returnExhibitNumber(removed).then((returned) => {
          if (returned) {
            refreshArmedExhibitStamp();
          }
        });
      }

      setPendingEdits((current) => current.filter((edit) => edit.id !== id));
      setSelectedEditId((current) => (current === id ? null : current));
    },
    [refreshArmedExhibitStamp],
  );

  const clearPending = useCallback(() => {
    setPendingEdits([]);
    setImportedAnnotIds(new Set());
    setFormValues({});
    setSelectedEditId(null);
  }, []);

  const clearPendingEdits = useCallback(() => {
    setPendingEdits([]);
    setImportedAnnotIds(new Set());
    setSelectedEditId(null);
  }, []);

  const draftEditCount = useMemo(
    () => pendingEdits.filter((edit) => edit.status !== "applied").length,
    [pendingEdits],
  );
  const appliedEditCount = useMemo(
    () => pendingEdits.filter((edit) => edit.status === "applied").length,
    [pendingEdits],
  );

  const applyPending = useCallback(() => {
    setPendingEdits((current) =>
      current.map((edit) => (edit.status === "applied" ? edit : { ...edit, status: "applied" })),
    );
    setSelectedEditId(null);
    setMessage("Applied edits are cemented for this session. Save writes them to the PDF.");
  }, []);

  const unapplyPending = useCallback(() => {
    setPendingEdits((current) =>
      current.map((edit) => (edit.status === "applied" ? { ...edit, status: "draft" } : edit)),
    );
    setMessage("Pinned edits are editable again until you save.");
  }, []);

  const setEditStatus = useCallback((id: string, status: PendingEditStatus) => {
    setPendingEdits((current) =>
      current.map((edit) => (edit.id === id ? { ...edit, status } : edit)),
    );
    setMessage(
      status === "applied"
        ? "Pinned this edit for this session. Save writes it to the PDF."
        : "Unpinned this edit so it can be adjusted before saving.",
    );
  }, []);

  const loadImportedAnnotations = useCallback((annotations: readonly PdfRaioAnnotationImport[]) => {
    const imported = pendingEditsFromRaioAnnotations(annotations);

    setPendingEdits(imported);
    // Ids come from the edits the overlay actually took on, not the raw
    // annotation list: an annotation kind the overlay can't represent must not
    // look deleted to the save plan.
    setImportedAnnotIds(
      new Set(imported.flatMap((edit) => (edit.annotId ? [edit.annotId] : []))),
    );
    setSelectedEditId(null);
  }, []);

  const handleImageFile = useCallback((file: File) => {
    void armStampFromFile(file)
      .then((stamp) => {
        setArmedImage(stamp);
        setMessage(null);
      })
      .catch(() => {
        setArmedImage(null);
        setMessage("That file could not be read as a PNG or JPEG image.");
      });
  }, []);

  const disarmImage = useCallback(() => {
    setArmedImage(null);
  }, []);

  const saveSignature = useCallback((dataUrl: string) => {
    const nextSignatureId = signatureIdRef.current + 1;
    const createdAt = Date.now();
    const signature: SavedSignature = {
      id: `signature-${createdAt}-${nextSignatureId}`,
      dataUrl,
      createdAt,
    };

    if (storageBytes(JSON.stringify(signature)) > MAX_SAVED_SIGNATURE_BYTES) {
      setMessage("That signature is too large to save.");
      return false;
    }

    const next = [signature, ...savedSignatures].slice(0, MAX_SAVED_SIGNATURES);
    const serialized = JSON.stringify(next);

    if (storageBytes(serialized) > MAX_SAVED_SIGNATURES_BYTES) {
      setMessage("Saved signatures are full. Delete one before saving another.");
      return false;
    }

    if (!persistSavedSignatures(serialized)) {
      setMessage("That signature could not be saved on this computer.");
      return false;
    }

    signatureIdRef.current = nextSignatureId;
    setSavedSignatures(next);
    setMessage(null);
    return true;
  }, [savedSignatures]);

  const deleteSavedSignature = useCallback((id: string) => {
    const next = savedSignatures.filter((signature) => signature.id !== id);

    if (!persistSavedSignatures(JSON.stringify(next))) {
      setMessage("Saved signatures could not be updated on this computer.");
      return;
    }

    setSavedSignatures(next);
    setMessage(null);
  }, [savedSignatures]);

  const armSignatureFromDataUrl = useCallback(async (dataUrl: string) => {
    try {
      const stamp = await armStampFromDataUrl(dataUrl);
      setArmedSignature(stamp);
      setSignatureCardOpen(false);
      setMessage(null);
      return true;
    } catch {
      setArmedSignature(null);
      setMessage("That signature image could not be read.");
      return false;
    }
  }, []);

  const disarmSignature = useCallback(() => {
    setArmedSignature(null);
  }, []);

  const armExhibitStamp = useCallback((templateId: string) => {
    const armed = nextArmedExhibitStamp(templateId);

    if (!armed) {
      setMessage("That exhibit stamp is no longer available.");
      return false;
    }

    setArmedExhibitStamp(armed);
    setStampCardOpen(false);
    setMessage(null);
    return true;
  }, []);

  const disarmExhibitStamp = useCallback(() => {
    setArmedExhibitStamp(null);
  }, []);

  /**
   * Drops the armed stamp when the document under the tool changes (a new
   * file, or a tab switch restoring another document's edits). The armed
   * preview shows a number read at arm time; carrying it across documents
   * would show a stale one, and the counter is shared across tabs.
   */
  const disarmForNewDocument = useCallback(() => {
    setArmedExhibitStamp(null);
    setStampCardOpen(false);
  }, []);

  const allocateExhibitStampIdentifier = useCallback(async () => {
    const armed = armedExhibitStampRef.current;

    if (!armed) {
      return null;
    }

    const result = await allocateIdentifier(armed.templateId);

    if (!result.ok) {
      // The counter did not move, so nothing may be placed — the caller reads
      // this null as "abandon the placement" and the number stays unused.
      setMessage(result.error);
      return null;
    }

    // The ghost now previews the NEXT number, so repeat stamping reads right
    // before the user clicks again.
    setArmedExhibitStamp(nextArmedExhibitStamp(armed.templateId) ?? armed);
    setMessage(null);
    return result.value;
  }, []);

  const setFormValue = useCallback((fieldName: string, value: PdfFormFieldValue) => {
    setFormValues((current) => ({ ...current, [fieldName]: value }));
  }, []);

  const updateHighlightStyle = useCallback((style: Partial<HighlightEditStyle>) => {
    setHighlightStyle((current) => ({ ...current, ...style }));
  }, []);

  const updateTextMarkupStyle = useCallback(
    (
      tool: Exclude<TextMarkupToolId, "highlight">,
      style: Partial<TextMarkupEditStyle>,
    ) => {
      setTextMarkupStyles((current) => ({
        ...current,
        [tool]: { ...current[tool], ...style },
      }));
    },
    [],
  );

  const updateTextBoxStyle = useCallback((style: Partial<TextBoxEditStyle>) => {
    setTextBoxStyle((current) => ({ ...current, ...style }));
  }, []);

  const updateCalloutStyle = useCallback((style: Partial<CalloutEditStyle>) => {
    setCalloutStyle((current) => ({ ...current, ...style }));
  }, []);

  const updateInkStyle = useCallback((style: Partial<InkEditStyle>) => {
    setInkStyle((current) => ({ ...current, ...style }));
  }, []);

  const updateShapeStyle = useCallback(
    (shapeTool: ShapeToolId, style: Partial<ShapeEditStyle>) => {
      setShapeStyles((current) => ({
        ...current,
        [shapeTool]: { ...current[shapeTool], ...style },
      }));
    },
    [],
  );

  const collectEdits = useCallback(() => {
    const edits = toPdfEdits(pendingEdits, formValues);

    if (edits.length === 0) {
      return null;
    }

    const hasSignatureEdit = pendingEdits.some((edit) => edit.kind === "signature");
    const hasFormWrite = Object.keys(formValues).length > 0;
    const hasFormFieldEdit = edits.some((edit) => edit.type === "formField");

    return {
      edits,
      flatten: flattenOnSave && !hasFormFieldEdit && (hasSignatureEdit || hasFormWrite),
    };
  }, [flattenOnSave, formValues, pendingEdits]);

  const annotationSavePlan = useMemo(
    () => buildAnnotationSavePlan(pendingEdits, importedAnnotIds),
    [importedAnnotIds, pendingEdits],
  );

  const hasUnsavedEdits = useMemo(() => {
    return annotationSavePlanHasChanges(annotationSavePlan) || Object.keys(formValues).length > 0;
  }, [annotationSavePlan, formValues]);

  const lastUndoableEditId = useMemo(() => {
    const last = pendingEdits[pendingEdits.length - 1];
    if (!last) {
      return null;
    }
    // Same imported-annotation test the save plan uses: an edit carrying an
    // annotId that was loaded with the document is existing content.
    const imported = Boolean(last.annotId) && importedAnnotIds.has(last.annotId!);
    return imported ? null : last.id;
  }, [importedAnnotIds, pendingEdits]);

  const collectAnnotationSavePlan = useCallback(() => {
    const hasFormWrite = Object.keys(formValues).length > 0;

    if (!annotationSavePlanHasChanges(annotationSavePlan) && !hasFormWrite) {
      return null;
    }

    const plan = hasFormWrite
      ? {
          ...annotationSavePlan,
          appendEdits: [
            ...annotationSavePlan.appendEdits,
            { type: "formValues" as const, values: formValues },
          ],
        }
      : annotationSavePlan;
    const hasFormFieldEdit = plan.appendEdits.some((edit) => edit.type === "formField");

    return {
      plan,
      flatten:
        flattenOnSave &&
        !hasFormFieldEdit &&
        (annotationSavePlan.hasSignatureEdit || hasFormWrite),
    };
  }, [annotationSavePlan, flattenOnSave, formValues]);

  const collectMarkupAnnotationSavePlan = useCallback(() => annotationSavePlan, [annotationSavePlan]);

  const resetForDocument = useCallback(() => {
    setToolState(resetFormAuthoringTool);
    setPendingEdits([]);
    setImportedAnnotIds(new Set());
    setFormValues({});
    setMessage(null);
    setSelectedEditId(null);
    disarmForNewDocument();
  }, [disarmForNewDocument]);

  const captureDocumentState = useCallback((): EditingDocumentSnapshot => ({
    pendingEdits,
    importedAnnotIds,
    formValues,
  }), [formValues, importedAnnotIds, pendingEdits]);

  const restoreDocumentState = useCallback(
    (snapshot: EditingDocumentSnapshot) => {
      setToolState(resetFormAuthoringTool);
      setPendingEdits(snapshot.pendingEdits);
      setImportedAnnotIds(snapshot.importedAnnotIds);
      setFormValues({ ...snapshot.formValues });
      setMessage(null);
      setSelectedEditId(null);
      disarmForNewDocument();
    },
    [disarmForNewDocument],
  );

  return useMemo(
    () => ({
      tool,
      setTool,
      pendingEdits,
      addEdit,
      updateEdit,
      removeEdit,
      clearPending,
      clearPendingEdits,
      draftEditCount,
      appliedEditCount,
      applyPending,
      unapplyPending,
      setEditStatus,
      loadImportedAnnotations,
      selectedEditId,
      setSelectedEditId,
      armedImage,
      handleImageFile,
      disarmImage,
      armedSignature,
      signatureCardOpen,
      setSignatureCardOpen,
      savedSignatures,
      saveSignature,
      deleteSavedSignature,
      armSignatureFromDataUrl,
      disarmSignature,
      armedExhibitStamp,
      stampCardOpen,
      setStampCardOpen,
      armExhibitStamp,
      refreshArmedExhibitStamp,
      disarmExhibitStamp,
      allocateExhibitStampIdentifier,
      flattenOnSave,
      setFlattenOnSave,
      hasFormFields,
      formValues,
      setFormValue,
      highlightStyle,
      updateHighlightStyle,
      textMarkupStyles,
      updateTextMarkupStyle,
      textBoxStyle,
      updateTextBoxStyle,
      calloutStyle,
      updateCalloutStyle,
      inkStyle,
      updateInkStyle,
      shapeStyles,
      updateShapeStyle,
      message,
      setMessage,
      collectEdits,
      collectAnnotationSavePlan,
      collectMarkupAnnotationSavePlan,
      hasUnsavedEdits,
      lastUndoableEditId,
      resetForDocument,
      captureDocumentState,
      restoreDocumentState,
    }),
    [
      tool,
      setTool,
      pendingEdits,
      addEdit,
      updateEdit,
      removeEdit,
      clearPending,
      clearPendingEdits,
      draftEditCount,
      appliedEditCount,
      applyPending,
      unapplyPending,
      setEditStatus,
      loadImportedAnnotations,
      selectedEditId,
      armedImage,
      handleImageFile,
      disarmImage,
      armedSignature,
      signatureCardOpen,
      savedSignatures,
      saveSignature,
      deleteSavedSignature,
      armSignatureFromDataUrl,
      disarmSignature,
      armedExhibitStamp,
      stampCardOpen,
      setStampCardOpen,
      armExhibitStamp,
      refreshArmedExhibitStamp,
      disarmExhibitStamp,
      allocateExhibitStampIdentifier,
      flattenOnSave,
      hasFormFields,
      formValues,
      setFormValue,
      highlightStyle,
      updateHighlightStyle,
      textMarkupStyles,
      updateTextMarkupStyle,
      textBoxStyle,
      updateTextBoxStyle,
      calloutStyle,
      updateCalloutStyle,
      inkStyle,
      updateInkStyle,
      shapeStyles,
      updateShapeStyle,
      message,
      collectEdits,
      collectAnnotationSavePlan,
      collectMarkupAnnotationSavePlan,
      hasUnsavedEdits,
      lastUndoableEditId,
      resetForDocument,
      captureDocumentState,
      restoreDocumentState,
    ],
  );
}

/**
 * The armed preview for a template as the store has it right now: the label
 * its next placement would use. Returns null when the template is gone (it can
 * be deleted from the gallery, or by another window).
 */
function nextArmedExhibitStamp(templateId: string): ArmedExhibitStamp | null {
  const template = findExhibitStampTemplate(templateId);

  if (!template) {
    return null;
  }

  const index = template.nextIndex;

  return {
    templateId,
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
    sequence: {
      schemaVersion: 1,
      identifierStyle: template.identifierStyle,
      prefix: template.prefix,
      ...(template.suffix ? { suffix: template.suffix } : {}),
      layout: template.layout,
      index,
    },
    template,
  };
}

/**
 * Hands an exhibit number back after a stamp placed in this session is
 * removed, and reports whether the counter actually moved.
 *
 * Only the newest number can be returned — the store refuses anything else, so
 * deleting the third of five stamps leaves the counter alone rather than
 * reissuing a number that is already on a page. A refusal is ordinary, not an
 * error, so nothing is surfaced. Imported stamps are skipped outright: their
 * number belongs to the saved file, not to this session's counter.
 */
async function returnExhibitNumber(edit: PendingEdit): Promise<boolean> {
  if (edit.kind !== "stamp" || edit.annotId || !edit.templateId || !edit.sequence) {
    return false;
  }

  const result = await rollbackIdentifier(edit.templateId, edit.sequence.index);

  return result.ok;
}

async function armStampFromFile(file: File): Promise<ArmedImageStamp> {
  const format = imageFormatFromFile(file);

  if (!format) {
    throw new Error("Unsupported image type.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const { width, height } = await measureImage(dataUrl);

  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    format,
    dataUrl,
    width,
    height,
  };
}

async function armStampFromDataUrl(dataUrl: string): Promise<ArmedImageStamp> {
  const format = imageFormatFromDataUrl(dataUrl);

  if (!format) {
    throw new Error("Unsupported signature image type.");
  }

  const { width, height } = await measureImage(dataUrl);

  return {
    bytes: dataUrlToBytes(dataUrl),
    format,
    dataUrl,
    width,
    height,
  };
}

function imageFormatFromFile(file: File): PdfEditImageFormat | null {
  if (file.type === "image/png" || /\.png$/i.test(file.name)) {
    return "png";
  }

  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) {
    return "jpeg";
  }

  return null;
}

function imageFormatFromDataUrl(dataUrl: string): PdfEditImageFormat | null {
  const commaIndex = dataUrl.indexOf(",");

  if (commaIndex < 0) {
    return null;
  }

  const mediaType = dataUrl.slice(0, commaIndex).toLowerCase();

  if (mediaType === "data:image/png" || mediaType.startsWith("data:image/png;")) {
    return "png";
  }

  if (
    mediaType === "data:image/jpeg" ||
    mediaType.startsWith("data:image/jpeg;")
  ) {
    return "jpeg";
  }

  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error("Image has no dimensions."));
        return;
      }

      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error("Image failed to decode."));
    image.src = dataUrl;
  });
}

function loadSavedSignatures(): SavedSignature[] {
  try {
    const raw = window.localStorage.getItem(SIGNATURES_STORAGE_KEY);

    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is SavedSignature =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SavedSignature).id === "string" &&
        typeof (entry as SavedSignature).dataUrl === "string" &&
        typeof (entry as SavedSignature).createdAt === "number",
    );
  } catch {
    return [];
  }
}

function storageBytes(value: string): number {
  return value.length;
}

function persistSavedSignatures(serializedSignatures: string): boolean {
  try {
    window.localStorage.setItem(SIGNATURES_STORAGE_KEY, serializedSignatures);
    return true;
  } catch {
    // Saved signatures are a convenience; storage failures must not break editing.
    return false;
  }
}
