export interface OcrProgressEvent {
  jobToken: string;
  phase: string;
  description: string | null;
  completed: number;
  total: number | null;
  unit: string;
}

export const OCR_PROGRESS_EVENT = "raiopdf-ocr-progress";

export function newOcrJobToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function listenOcrProgress(
  jobToken: string,
  onProgress: (event: OcrProgressEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<OcrProgressEvent>(OCR_PROGRESS_EVENT, (event) => {
    if (event.payload.jobToken === jobToken) {
      onProgress(event.payload);
    }
  });
}

export function describeOcrProgress(event: OcrProgressEvent): string {
  const label = event.phase === "postprocess" ? "Finishing searchable copy" : "Making searchable";
  if (typeof event.total === "number" && event.total > 0) {
    const completed = Math.min(Math.floor(event.completed), Math.ceil(event.total));
    const total = Math.ceil(event.total);
    if (event.unit === "%") {
      return `${label}: ${completed}%`;
    }
    return `${label}: ${completed} of ${total} ${formatProgressUnit(event.unit, total)}`;
  }
  return event.description ? `${label}: ${event.description}` : `${label}...`;
}

function formatProgressUnit(unit: string, total: number): string {
  const normalized = unit.trim().toLowerCase();
  if (!normalized || normalized === "unit" || normalized === "step" || normalized === "steps") {
    return total === 1 ? "step" : "steps";
  }
  if (normalized === "page" || normalized === "pages") {
    return total === 1 ? "page" : "pages";
  }
  if (normalized === "image" || normalized === "images") {
    return total === 1 ? "image" : "images";
  }
  return normalized;
}
