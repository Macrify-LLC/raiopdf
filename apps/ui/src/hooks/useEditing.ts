import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfEdit, PdfEditImageFormat, PdfFormFieldValue } from "@raiopdf/engine-api";
import {
  dataUrlToBytes,
  toPdfEdits,
  type EditToolId,
  type PendingEdit,
} from "../lib/edits";
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
  saveSignature: (dataUrl: string) => void;
  deleteSavedSignature: (id: string) => void;
  armSignatureFromDataUrl: (dataUrl: string) => Promise<boolean>;
  disarmSignature: () => void;
  flattenOnSave: boolean;
  setFlattenOnSave: (flatten: boolean) => void;
  /** AcroForm fill state — document-scoped changed values only. */
  hasFormFields: boolean;
  formValues: Readonly<Record<string, PdfFormFieldValue>>;
  setFormValue: (fieldName: string, value: PdfFormFieldValue) => void;
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
    signatureIdRef.current += 1;
    const signature: SavedSignature = {
      id: `signature-${Date.now()}-${signatureIdRef.current}`,
      dataUrl,
      createdAt: Date.now(),
    };

    setSavedSignatures((current) => {
      const next = [signature, ...current].slice(0, MAX_SAVED_SIGNATURES);
      persistSavedSignatures(next);
      return next;
    });
  }, []);

  const deleteSavedSignature = useCallback((id: string) => {
    setSavedSignatures((current) => {
      const next = current.filter((signature) => signature.id !== id);
      persistSavedSignatures(next);
      return next;
    });
  }, []);

  const armSignatureFromDataUrl = useCallback(async (dataUrl: string) => {
    try {
      const stamp = await armStampFromDataUrl(dataUrl);
      setArmedSignature(stamp);
      setSignatureCardOpen(false);
      setMessage(null);
      return true;
    } catch {
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
  const format: PdfEditImageFormat = dataUrl.startsWith("data:image/jpeg")
    ? "jpeg"
    : "png";
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

function persistSavedSignatures(signatures: readonly SavedSignature[]): void {
  try {
    window.localStorage.setItem(SIGNATURES_STORAGE_KEY, JSON.stringify(signatures));
  } catch {
    // Saved signatures are a convenience; storage failures must not break editing.
  }
}
