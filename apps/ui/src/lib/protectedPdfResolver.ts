import { PdfEngineError } from "@raiopdf/engine-api";
import {
  detectSignatureFacts,
  hasEmbeddedSignatureMarkers,
  type SignatureDetectionFacts,
} from "@raiopdf/rules";

export type UnlockWarning =
  | "signature-invalidated"
  | "form-fields-flattened"
  | "output-unverified";

export type ProtectedPdfSource = "owner-restricted" | "user-password";

export type UnlockResult =
  | {
      status: "unlocked";
      bytes: Uint8Array;
      changed: boolean;
      warnings: readonly UnlockWarning[];
      provenance: {
        source: ProtectedPdfSource;
        signature: SignatureDetectionFacts;
      };
    }
  | { status: "password_required" }
  | { status: "unavailable"; error: PdfEngineError }
  | { status: "failed"; error: PdfEngineError };

export interface ResolveProtectedPdfBytesOptions {
  isUnavailableError?: ((error: unknown) => boolean) | undefined;
  password?: string | undefined;
  removeEncryption: (bytes: Uint8Array, password: string) => Promise<Uint8Array>;
}

const EMPTY_SIGNATURE_FACTS: SignatureDetectionFacts = {
  standardAcroFormSignatureCount: 0,
  hasByteRangeOrContentsMarkers: false,
  hasCertificationDictionary: false,
};

export async function resolveProtectedPdfBytes(
  bytes: Uint8Array,
  options: ResolveProtectedPdfBytesOptions,
): Promise<UnlockResult> {
  const password = options.password ?? "";

  try {
    const unlockedBytes = await options.removeEncryption(bytes, password);
    const warnings: UnlockWarning[] = [];
    let signature = EMPTY_SIGNATURE_FACTS;

    try {
      signature = await detectSignatureFacts(unlockedBytes);
      if (hasEmbeddedSignatureMarkers(signature)) {
        warnings.push("signature-invalidated");
      }
    } catch {
      warnings.push("output-unverified");
    }

    return {
      status: "unlocked",
      bytes: unlockedBytes,
      changed: !bytesEqual(bytes, unlockedBytes),
      warnings,
      provenance: {
        source: password ? "user-password" : "owner-restricted",
        signature,
      },
    };
  } catch (error) {
    if (isPasswordRequired(error, password)) {
      return { status: "password_required" };
    }

    const wrapped = toPdfEngineError(error);
    if (options.isUnavailableError?.(error)) {
      return {
        status: "unavailable",
        error: new PdfEngineError("UNSUPPORTED", wrapped.message, { cause: error }),
      };
    }

    if (wrapped.code === "UNSUPPORTED") {
      return { status: "unavailable", error: wrapped };
    }

    return { status: "failed", error: wrapped };
  }
}

export function unlockResultHasSignatureWarning(result: UnlockResult): boolean {
  return result.status === "unlocked" && hasEmbeddedSignatureMarkers(result.provenance.signature);
}

function isPasswordRequired(error: unknown, password: string): boolean {
  return error instanceof PdfEngineError &&
    (
      error.code === "PASSWORD_REQUIRED" ||
      (password.length === 0 && error.code === "ENCRYPTED_DOCUMENT")
    );
}

function toPdfEngineError(error: unknown): PdfEngineError {
  if (error instanceof PdfEngineError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Protected PDF unlock failed.";

  return new PdfEngineError("INVALID_DOCUMENT", message, { cause: error });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
