import type { DragDropEvent } from "@tauri-apps/api/webview";
import type { Event, UnlistenFn } from "@tauri-apps/api/event";
import {
  isTauriRuntime,
  openedPdfFromTauri,
  type OpenedFileSource,
  type TauriOpenedPdf,
} from "./filePort";

type DropOpenHandler = (source: OpenedFileSource) => void;
type DropOpenErrorHandler = (error: unknown) => void;

export async function listenForDesktopPdfDrops(
  onOpen: DropOpenHandler,
  onError: DropOpenErrorHandler = () => {},
): Promise<UnlistenFn | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const [{ invoke }, { getCurrentWebview }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/webview"),
  ]);

  return getCurrentWebview().onDragDropEvent((event: Event<DragDropEvent>) => {
    if (event.payload.type !== "drop") {
      return;
    }

    const path = firstPdfPath(event.payload.paths);
    if (!path) {
      return;
    }

    void invoke<TauriOpenedPdf>("open_dropped_pdf", { path })
      .then(openedPdfFromTauri)
      .then(onOpen)
      .catch(onError);
  });
}

function firstPdfPath(paths: readonly string[]): string | null {
  return paths.find((path) => path.toLowerCase().endsWith(".pdf")) ?? null;
}
