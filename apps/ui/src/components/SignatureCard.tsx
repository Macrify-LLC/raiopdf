import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { EditingState } from "../hooks/useEditing";
import "./SignatureCard.css";

const DRAW_WIDTH = 360;
const DRAW_HEIGHT = 130;
const DRAW_STROKE_WIDTH = 2.5;
const EXPORT_PADDING_PX = 8;

type SignatureTab = "draw" | "upload";

export interface SignatureCardProps {
  editing: EditingState;
}

/**
 * The Sign tool's signature card: draw a signature on a canvas or pick an
 * image, keep reusable signatures in localStorage only, and control the
 * flatten-on-save behavior for signed documents.
 */
export function SignatureCard({ editing }: SignatureCardProps) {
  const [tab, setTab] = useState<SignatureTab>("draw");
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const getCanvasPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return null;
    }

    const bounds = canvas.getBoundingClientRect();

    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }, []);

  function handleDrawStart(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0) {
      return;
    }

    const point = getCanvasPoint(event);

    if (!point) {
      return;
    }

    drawingRef.current = true;
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDrawMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) {
      return;
    }

    const point = getCanvasPoint(event);
    const lastPoint = lastPointRef.current;
    const context = canvasRef.current?.getContext("2d");

    if (!point || !lastPoint || !context) {
      return;
    }

    context.strokeStyle = readInkColor();
    context.lineWidth = DRAW_STROKE_WIDTH;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPointRef.current = point;
    setHasInk(true);
  }

  function handleDrawEnd() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (canvas && context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    setHasInk(false);
  }

  function useDrawnSignature() {
    const canvas = canvasRef.current;

    if (!canvas || !hasInk) {
      return;
    }

    const dataUrl = cropCanvasToInk(canvas);

    if (!dataUrl) {
      return;
    }

    editing.saveSignature(dataUrl);
    void editing.armSignatureFromDataUrl(dataUrl);
  }

  function handleUploadFile(file: File | undefined) {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      void editing.armSignatureFromDataUrl(dataUrl).then((armed) => {
        if (armed) {
          editing.saveSignature(dataUrl);
        }
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="signature-card" role="dialog" aria-label="Signature card">
      <div className="signature-card__header">
        <p className="signature-card__title">Signature</p>
        <button
          type="button"
          className="signature-card__close"
          aria-label="Close signature card"
          onClick={() => editing.setSignatureCardOpen(false)}
        >
          ×
        </button>
      </div>

      <div className="signature-card__tabs" role="tablist" aria-label="Signature source">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "draw"}
          className="signature-card__tab"
          data-active={tab === "draw" ? "true" : undefined}
          onClick={() => setTab("draw")}
        >
          Draw
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "upload"}
          className="signature-card__tab"
          data-active={tab === "upload" ? "true" : undefined}
          onClick={() => setTab("upload")}
        >
          Image from file
        </button>
      </div>

      {tab === "draw" ? (
        <div className="signature-card__draw">
          <canvas
            ref={canvasRef}
            className="signature-card__canvas"
            width={DRAW_WIDTH}
            height={DRAW_HEIGHT}
            aria-label="Signature drawing area"
            onPointerDown={handleDrawStart}
            onPointerMove={handleDrawMove}
            onPointerUp={handleDrawEnd}
            onPointerCancel={handleDrawEnd}
          />
          <div className="signature-card__row">
            <button
              type="button"
              className="signature-card__secondary"
              disabled={!hasInk}
              onClick={clearCanvas}
            >
              Clear
            </button>
            <button
              type="button"
              className="signature-card__primary"
              disabled={!hasInk}
              onClick={useDrawnSignature}
            >
              Use Signature
            </button>
          </div>
        </div>
      ) : (
        <div className="signature-card__upload">
          <label className="signature-card__file-label">
            Choose a PNG or JPEG signature image
            <input
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Choose signature image file"
              onChange={(event) => {
                handleUploadFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      )}

      {editing.savedSignatures.length > 0 ? (
        <div className="signature-card__saved">
          <p className="signature-card__saved-label">Saved signatures</p>
          <div className="signature-card__saved-grid">
            {editing.savedSignatures.map((signature) => (
              <span key={signature.id} className="signature-card__saved-item">
                <button
                  type="button"
                  className="signature-card__saved-use"
                  aria-label="Use saved signature"
                  onClick={() => void editing.armSignatureFromDataUrl(signature.dataUrl)}
                >
                  <img src={signature.dataUrl} alt="Saved signature" draggable={false} />
                </button>
                <button
                  type="button"
                  className="signature-card__saved-delete"
                  aria-label="Delete saved signature"
                  onClick={() => editing.deleteSavedSignature(signature.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="signature-card__footer">
        <label className="signature-card__flatten">
          <input
            type="checkbox"
            checked={editing.flattenOnSave}
            onChange={(event) => editing.setFlattenOnSave(event.target.checked)}
          />
          Flatten on save
        </label>
        <p className="signature-card__note">Saved signatures stay on this computer.</p>
      </div>
    </div>
  );
}

function readInkColor(): string {
  const inkColor = window
    .getComputedStyle(window.document.documentElement)
    .getPropertyValue("--edit-ink")
    .trim();

  return inkColor || "CanvasText";
}

/** Crops the drawing canvas to its inked bounds (plus padding) as a PNG. */
function cropCanvasToInk(canvas: HTMLCanvasElement): string | null {
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = image.data[(y * canvas.width + x) * 4 + 3] ?? 0;

      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const left = Math.max(0, minX - EXPORT_PADDING_PX);
  const top = Math.max(0, minY - EXPORT_PADDING_PX);
  const width = Math.min(canvas.width, maxX + EXPORT_PADDING_PX) - left;
  const height = Math.min(canvas.height, maxY + EXPORT_PADDING_PX) - top;
  const output = window.document.createElement("canvas");
  output.width = Math.max(1, width);
  output.height = Math.max(1, height);
  const outputContext = output.getContext("2d");

  if (!outputContext) {
    return null;
  }

  outputContext.drawImage(canvas, left, top, width, height, 0, 0, width, height);

  return output.toDataURL("image/png");
}
