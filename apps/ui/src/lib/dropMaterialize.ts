import {
  isTauriRuntime,
  openedPdfFromTauri,
  type OpenedFileSource,
  type TauriOpenedPdf,
} from "./filePort";
import { STREAMED_RANGE_CHUNK_SIZE } from "./streamedChunks";

const HEADER_FILE_NAME = "x-raio-file-name";
const HEADER_DROPPED_PDF_SIZE = "x-raio-dropped-pdf-size";
const HEADER_DROPPED_PDF_TOKEN = "x-raio-dropped-pdf-token";

type Invoke = typeof import("@tauri-apps/api/core").invoke;

export async function materializeDroppedFileGrant(
  file: File,
  signal?: AbortSignal,
): Promise<OpenedFileSource | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  let token: string | null = null;

  try {
    throwIfAborted(signal);
    token = await invoke<string>("dropped_pdf_begin", {}, {
      headers: {
        [HEADER_DROPPED_PDF_SIZE]: encodeURIComponent(String(file.size)),
        [HEADER_FILE_NAME]: encodeURIComponent(file.name),
      },
    });

    for (let offset = 0; offset < file.size; offset += STREAMED_RANGE_CHUNK_SIZE) {
      throwIfAborted(signal);
      const end = Math.min(offset + STREAMED_RANGE_CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      throwIfAborted(signal);
      await appendDroppedPdfChunk(invoke, token, chunk);
    }

    throwIfAborted(signal);
    const opened = await invoke<TauriOpenedPdf>("dropped_pdf_finish", {}, {
      headers: {
        [HEADER_DROPPED_PDF_TOKEN]: encodeURIComponent(token),
      },
    });

    return openedPdfFromTauri(opened);
  } catch (error) {
    if (token) {
      await abortDroppedPdfUpload(invoke, token);
    }
    throw error;
  }
}

function appendDroppedPdfChunk(
  invoke: Invoke,
  token: string,
  chunk: Uint8Array,
): Promise<void> {
  return invoke("dropped_pdf_append", chunk, {
    headers: {
      [HEADER_DROPPED_PDF_TOKEN]: encodeURIComponent(token),
    },
  });
}

async function abortDroppedPdfUpload(invoke: Invoke, token: string): Promise<void> {
  await invoke("dropped_pdf_abort", {}, {
    headers: {
      [HEADER_DROPPED_PDF_TOKEN]: encodeURIComponent(token),
    },
  }).catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Dropped PDF materialization was cancelled.", "AbortError");
  }
}
