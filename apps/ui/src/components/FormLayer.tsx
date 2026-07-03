import { useEffect, useState } from "react";
import type { PdfFormFieldValue } from "@raiopdf/engine-api";
import type { PDFPageProxy } from "../lib/pdfjs";
import {
  clamp,
  pdfRectToViewportRect,
  type PageViewport,
  type ViewportRect,
} from "../lib/viewportGeometry";
import "./FormLayer.css";

const ANNOTATION_FLAG_HIDDEN = 2;
const ANNOTATION_FLAG_NO_VIEW = 32;

/** Structural view of the pdf.js Widget annotation data we consume. */
interface WidgetAnnotationLike {
  id?: string;
  subtype?: string;
  fieldType?: string;
  fieldName?: string;
  rect?: unknown;
  fieldValue?: unknown;
  readOnly?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: ReadonlyArray<{ exportValue?: string; displayValue?: string }>;
  combo?: boolean;
  multiSelect?: boolean;
  multiLine?: boolean;
  annotationFlags?: number;
}

interface FormWidget {
  key: string;
  fieldName: string;
  kind: "text" | "checkbox" | "radio" | "choice";
  rect: ViewportRect;
  initialValue: unknown;
  readOnly: boolean;
  multiLine: boolean;
  exportValue: string | null;
  buttonValue: string | null;
  options: ReadonlyArray<{ exportValue: string; displayValue: string }>;
  multiSelect: boolean;
}

export interface FormLayerProps {
  page: PDFPageProxy;
  viewport: PageViewport;
  values: Readonly<Record<string, PdfFormFieldValue>>;
  onValueChange: (fieldName: string, value: PdfFormFieldValue) => void;
}

/**
 * Renders the document's AcroForm fields as fillable inputs positioned over
 * the page. Values are UI state until Save, when they leave as one
 * document-scoped `formValues` edit.
 */
export function FormLayer({ page, viewport, values, onValueChange }: FormLayerProps) {
  const [widgets, setWidgets] = useState<readonly FormWidget[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    setLoadError(null);
    void page
      .getAnnotations()
      .then((annotations) => {
        if (!disposed) {
          setWidgets(toFormWidgets(annotations, viewport));
        }
      })
      .catch(() => {
        if (!disposed) {
          setWidgets([]);
          setLoadError("Fillable fields could not be shown on this page.");
        }
      });

    return () => {
      disposed = true;
    };
  }, [page, viewport]);

  if (widgets.length === 0 && !loadError) {
    return null;
  }

  return (
    <div className="form-layer">
      {loadError ? (
        <p className="form-layer__message" role="status">
          {loadError}
        </p>
      ) : null}
      {widgets.map((widget) => (
        <FormWidgetInput
          key={widget.key}
          widget={widget}
          value={values[widget.fieldName]}
          onChange={(value) => onValueChange(widget.fieldName, value)}
        />
      ))}
    </div>
  );
}

function FormWidgetInput({
  widget,
  value,
  onChange,
}: {
  widget: FormWidget;
  value: PdfFormFieldValue | undefined;
  onChange: (value: PdfFormFieldValue) => void;
}) {
  const style = {
    left: `${widget.rect.left}px`,
    top: `${widget.rect.top}px`,
    width: `${widget.rect.width}px`,
    height: `${widget.rect.height}px`,
    fontSize: `${clamp(widget.rect.height * 0.55, 9, 16)}px`,
  };

  if (widget.kind === "checkbox") {
    const checked =
      typeof value === "boolean"
        ? value
        : widget.initialValue !== undefined &&
          widget.initialValue !== null &&
          widget.initialValue !== "Off";

    return (
      <input
        type="checkbox"
        className="form-layer__checkbox"
        style={style}
        aria-label={widget.fieldName}
        checked={checked}
        disabled={widget.readOnly}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }

  if (widget.kind === "radio") {
    const groupValue = typeof value === "string" ? value : widget.initialValue;
    const checked = widget.buttonValue !== null && groupValue === widget.buttonValue;

    return (
      <input
        type="radio"
        className="form-layer__checkbox"
        style={style}
        aria-label={`${widget.fieldName}: ${widget.buttonValue ?? ""}`}
        name={`form-layer-${widget.fieldName}`}
        checked={checked}
        disabled={widget.readOnly || widget.buttonValue === null}
        onChange={() => {
          if (widget.buttonValue !== null) {
            onChange(widget.buttonValue);
          }
        }}
      />
    );
  }

  if (widget.kind === "choice") {
    if (widget.multiSelect) {
      const selected = Array.isArray(value)
        ? value
        : Array.isArray(widget.initialValue)
          ? (widget.initialValue as string[])
          : typeof widget.initialValue === "string"
            ? [widget.initialValue]
            : [];

      return (
        <select
          multiple
          className="form-layer__select"
          style={style}
          aria-label={widget.fieldName}
          value={[...selected]}
          disabled={widget.readOnly}
          onChange={(event) =>
            onChange(
              Array.from(event.target.selectedOptions).map((option) => option.value),
            )
          }
        >
          {widget.options.map((option) => (
            <option key={option.exportValue} value={option.exportValue}>
              {option.displayValue}
            </option>
          ))}
        </select>
      );
    }

    const selectedValue =
      typeof value === "string"
        ? value
        : Array.isArray(widget.initialValue)
          ? String(widget.initialValue[0] ?? "")
          : typeof widget.initialValue === "string"
            ? widget.initialValue
            : "";

    return (
      <select
        className="form-layer__select"
        style={style}
        aria-label={widget.fieldName}
        value={selectedValue}
        disabled={widget.readOnly}
        onChange={(event) => onChange(event.target.value)}
      >
        {widget.options.map((option) => (
          <option key={option.exportValue} value={option.exportValue}>
            {option.displayValue}
          </option>
        ))}
      </select>
    );
  }

  const textValue =
    typeof value === "string"
      ? value
      : typeof widget.initialValue === "string"
        ? widget.initialValue
        : "";

  if (widget.multiLine) {
    return (
      <textarea
        className="form-layer__text form-layer__textarea"
        style={style}
        aria-label={widget.fieldName}
        value={textValue}
        disabled={widget.readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      type="text"
      className="form-layer__text"
      style={style}
      aria-label={widget.fieldName}
      value={textValue}
      disabled={widget.readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function toFormWidgets(
  annotations: readonly unknown[],
  viewport: PageViewport,
): FormWidget[] {
  const widgets: FormWidget[] = [];

  annotations.forEach((rawAnnotation, index) => {
    const annotation = rawAnnotation as WidgetAnnotationLike;

    if (
      annotation.subtype !== "Widget" ||
      typeof annotation.fieldName !== "string" ||
      !annotation.fieldName ||
      annotation.pushButton ||
      annotation.fieldType === "Sig"
    ) {
      return;
    }

    const flags = annotation.annotationFlags ?? 0;

    if ((flags & ANNOTATION_FLAG_HIDDEN) !== 0 || (flags & ANNOTATION_FLAG_NO_VIEW) !== 0) {
      return;
    }

    if (!Array.isArray(annotation.rect) || annotation.rect.length < 4) {
      return;
    }

    const [x1, y1, x2, y2] = (annotation.rect as unknown[]).map(Number);

    if ([x1, y1, x2, y2].some((value) => !Number.isFinite(value))) {
      return;
    }

    const rect = pdfRectToViewportRect(
      {
        x: Math.min(x1!, x2!),
        y: Math.min(y1!, y2!),
        w: Math.abs(x2! - x1!),
        h: Math.abs(y2! - y1!),
      },
      viewport,
    );

    if (rect.width < 2 || rect.height < 2) {
      return;
    }

    const kind: FormWidget["kind"] =
      annotation.fieldType === "Ch"
        ? "choice"
        : annotation.checkBox
          ? "checkbox"
          : annotation.radioButton
            ? "radio"
            : "text";

    if (annotation.fieldType === "Btn" && !annotation.checkBox && !annotation.radioButton) {
      return;
    }

    widgets.push({
      key: annotation.id ?? `${annotation.fieldName}-${index}`,
      fieldName: annotation.fieldName,
      kind,
      rect,
      initialValue: annotation.fieldValue,
      readOnly: Boolean(annotation.readOnly),
      multiLine: Boolean(annotation.multiLine),
      exportValue: annotation.exportValue ?? null,
      buttonValue: annotation.buttonValue ?? null,
      options: (annotation.options ?? []).map((option) => ({
        exportValue: option.exportValue ?? option.displayValue ?? "",
        displayValue: option.displayValue ?? option.exportValue ?? "",
      })),
      multiSelect: Boolean(annotation.multiSelect),
    });
  });

  return widgets;
}
