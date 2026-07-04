import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfEdit, PdfEditImageFormat, PdfFormFieldValue } from "@raiopdf/engine-api";
import {
  dataUrlToBytes,
  toPdfEdits,
  type EditToolId,
  type PendingEdit,
  type ShapeToolId,
  type TextMarkupToolId,
} from "../lib/edits";
import {
  DEFAULT_INK_STROKE_WIDTH_PT,
  DEFAULT_SHAPE_STROKE_WIDTH_PT,
  type HighlightEditStyle,
  type InkEditStyle,
  type ShapeEditStyle,
  type TextMarkupEditStyle,
  type TextBoxEditStyle,
} from "../lib/editStyles";
import type { PDFDocumentProxy } from "../lib/pdfjs";

/** An image (or signature image) picked and ready to place with a click. */
export interface ArmedStamp {
  bytes: Uint8Array;
  format: PdfEditImageFormat;
  dataUrl: string;
  /** Natural pixel width, used for the initial placement size and aspect lock. */
  width: number;
  height: number;
}

export interface SavedSignature {
  id: string;
  dataUrl: string;
  createdAt: number;
}

const SIGNATURES_STORAGE_KEY = "raiopdf.saved-signatures";
const MAX_SAVED_SIGNATURES = 12;
const MAX_SAVED_SIGNATURE_BYTES = 500 * 1024;
const MAX_SAVED_SIGNATURES_BYTES = 2 * 1024 * 1024;

export interface EditingState {
  tool: EditToolId;
  setTool: (tool: EditToolId) => void;
  pendingEdits: readonly PendingEdit[];
  addEdit: (edit: PendingEdit) => void;
  updateEdit: (id: string, update: (edit: PendingEdit) => PendingEdit) => void;
  removeEdit: (id: string) => void;
  clearPending: () => void;
  /** Pick-to-place state for the Image tool. */
  armedImage: ArmedStamp | null;
  handleImageFile: (file: File) => void;
  disarmImage: () => void;
  /** Pick-to-place state for the Sign tool. */
  armedSignature: ArmedStamp | null;
  signatureCardOpen: boolean;
  setSignatureCardOpen: (open: boolean) => void;
  savedSignatures: readonly SavedSignature[];
  saveSignature: (dataUrl: string) => boolean;
  deleteSavedSignature: (id: string) => void;
  armSignatureFromDataUrl: (dataUrl: string) => Promise<boolean>;
  disarmSignature: () => void;
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
  /** Clears all document-bound edit state (pending items + form values). */
  resetForDocument: () => void;
}

let editIdCounter = 0;

export function newEditId(): string {
  editIdCounter += 1;

  return `edit-${editIdCounter}`;
}

export function useEditing(pdfDocument: PDFDocumentProxy | null): EditingState {
  const [tool, setToolState] = useState<EditToolId>("select");
  const [pendingEdits, setPendingEdits] = useState<readonly PendingEdit[]>([]);
  const [armedImage, setArmedImage] = useState<ArmedStamp | null>(null);
  const [armedSignature, setArmedSignature] = useState<ArmedStamp | null>(null);
  const [signatureCardOpen, setSignatureCardOpen] = useState(false);
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
    setSignatureCardOpen(nextTool === "sign");
  }, []);

  const addEdit = useCallback((edit: PendingEdit) => {
    setPendingEdits((current) => [...current, edit]);
  }, []);

  const updateEdit = useCallback(
    (id: string, update: (edit: PendingEdit) => PendingEdit) => {
      setPendingEdits((current) =>
        current.map((edit) => (edit.id === id ? update(edit) : edit)),
      );
    },
    [],
  );

  const removeEdit = useCallback((id: string) => {
    setPendingEdits((current) => current.filter((edit) => edit.id !== id));
  }, []);

  const clearPending = useCallback(() => {
    setPendingEdits([]);
    setFormValues({});
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

    return {
      edits,
      flatten: flattenOnSave && (hasSignatureEdit || hasFormWrite),
    };
  }, [flattenOnSave, formValues, pendingEdits]);

  const resetForDocument = useCallback(() => {
    setPendingEdits([]);
    setFormValues({});
    setMessage(null);
  }, []);

  return useMemo(
    () => ({
      tool,
      setTool,
      pendingEdits,
      addEdit,
      updateEdit,
      removeEdit,
      clearPending,
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
      inkStyle,
      updateInkStyle,
      shapeStyles,
      updateShapeStyle,
      message,
      setMessage,
      collectEdits,
      resetForDocument,
    }),
    [
      tool,
      setTool,
      pendingEdits,
      addEdit,
      updateEdit,
      removeEdit,
      clearPending,
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
      inkStyle,
      updateInkStyle,
      shapeStyles,
      updateShapeStyle,
      message,
      collectEdits,
      resetForDocument,
    ],
  );
}

async function armStampFromFile(file: File): Promise<ArmedStamp> {
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

async function armStampFromDataUrl(dataUrl: string): Promise<ArmedStamp> {
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
