import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { PdfBinderOptions } from "@raiopdf/engine-api";
import { PDFDocument } from "pdf-lib";
import type { DocumentState } from "../hooks/useDocument";
import { readBrowserFile } from "../lib/filePort";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CombineExhibitsIcon,
  DeleteIcon,
  DragHandleIcon,
  OpenIcon,
  PlusIcon,
  SlipSheetIcon,
} from "../icons";
import { PdfMiniThumb } from "./PdfMiniThumb";
import "./BinderWorkspace.css";

type IdentifierStyle = "letters" | "numbers";
type PlacementEdge = "header" | "footer";
type PlacementAlign = "left" | "center" | "right";
type StampPages = "first" | "all";

export interface ExhibitFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

export interface BinderWorkspaceProps {
  document: DocumentState;
  onBuildBinder: (
    exhibits: readonly { bytes: Uint8Array; label: string }[],
    options: PdfBinderOptions,
    fileName: string,
  ) => Promise<boolean>;
  onOpenRequested: () => void;
  onCancel: () => void;
}

export function BinderWorkspace({
  document,
  onBuildBinder,
  onOpenRequested,
  onCancel,
}: BinderWorkspaceProps) {
  const addInputRef = useRef<HTMLInputElement>(null);
  const [exhibits, setExhibits] = useState<ExhibitFile[]>([]);
  const [identifierStyle, setIdentifierStyle] = useState<IdentifierStyle>("letters");
  const [prefix, setPrefix] = useState("Exhibit");
  const [placementEdge, setPlacementEdge] = useState<PlacementEdge>("footer");
  const [placementAlign, setPlacementAlign] = useState<PlacementAlign>("center");
  const [stampPages, setStampPages] = useState<StampPages>("first");
  const [slipSheets, setSlipSheets] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const mainName = document.fileName ?? "Untitled.pdf";
  const mainPages = document.pageCount;
  const labels = useMemo(
    () => exhibits.map((_, index) => formatExhibitLabel(prefix, identifierStyle, index)),
    [exhibits, identifierStyle, prefix],
  );
  const totalPages = mainPages + exhibits.reduce(
    (total, exhibit) => total + exhibit.pageCount + (slipSheets ? 1 : 0),
    0,
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  async function handleAddFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (files.length === 0 || building) {
      return;
    }

    setStatus("Reading exhibit files...");

    try {
      const nextExhibits = await Promise.all(files.map(readExhibitFile));
      setExhibits((current) => [...current, ...nextExhibits]);
      setStatus(null);
    } catch {
      setStatus("One of the exhibit PDFs could not be opened. Check the file and try again.");
    }
  }

  function moveExhibit(index: number, direction: -1 | 1) {
    setExhibits((current) => {
      const targetIndex = index + direction;

      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(index, 1);

      if (!moved) {
        return current;
      }

      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function removeExhibit(id: string) {
    setExhibits((current) => current.filter((exhibit) => exhibit.id !== id));
  }

  async function buildBinder() {
    if (!document.bytes || exhibits.length === 0 || building) {
      return;
    }

    setBuilding(true);
    setStatus("Building binder...");

    try {
      const built = await onBuildBinder(
        exhibits.map((exhibit, index) => ({
          bytes: exhibit.bytes,
          label: labels[index]!,
        })),
        {
          slipSheets,
          placement: {
            edge: placementEdge,
            align: placementAlign,
          },
          stampPages: stampPages === "first" ? "first" : "all",
          fontSizePt: 11,
          marginIn: 0.5,
        },
        `${stripPdfExtension(mainName)} Binder.pdf`,
      );

      if (built) {
        setStatus("Binder built. The bookmarks panel will show each exhibit.");
        onCancel();
      } else {
        setStatus("The binder could not be built. Check the exhibit files and try again.");
      }
    } catch {
      setStatus("The binder could not be built. Check the exhibit files and try again.");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <section className="binder-workspace" aria-label="Combine with Exhibits workspace">
      <header className="binder-workspace__header">
        <div>
          <p className="binder-workspace__eyebrow">Legal</p>
          <h2>Combine with Exhibits</h2>
        </div>
        <button type="button" className="binder-workspace__ghost" onClick={onCancel}>
          Cancel
        </button>
      </header>

      <div className="binder-workspace__grid">
        <section className="binder-card" aria-label="Main document">
          <p className="binder-card__label">Main document</p>
          <div className="binder-main">
            <PdfMiniThumb bytes={document.bytes} label={`${mainName} thumbnail`} />
            <div>
              <p className="binder-main__name">{mainName}</p>
              <p className="binder-main__meta">{mainPages} {mainPages === 1 ? "page" : "pages"}</p>
            </div>
          </div>
          <button
            type="button"
            className="binder-workspace__secondary"
            onClick={onOpenRequested}
            disabled={building}
          >
            <OpenIcon size={15} />
            Replace via Open
          </button>
        </section>

        <section className="binder-card binder-card--list" aria-label="Exhibits list">
          <div className="binder-card__title-row">
            <p className="binder-card__label">Exhibits</p>
            <span>{exhibits.length}</span>
          </div>

          <div className="binder-exhibits" role="list">
            {exhibits.length === 0 ? (
              <p className="binder-exhibits__empty">Add exhibit PDFs to build the ordered binder.</p>
            ) : null}

            {exhibits.map((exhibit, index) => (
              <article className="binder-exhibit" key={exhibit.id} role="listitem">
                <span className="binder-exhibit__handle" aria-hidden="true">
                  <DragHandleIcon size={16} />
                </span>
                <PdfMiniThumb bytes={exhibit.bytes} label={`${exhibit.name} thumbnail`} />
                <div className="binder-exhibit__body">
                  <p className="binder-exhibit__name">{exhibit.name}</p>
                  <p className="binder-exhibit__meta">{exhibit.pageCount} {exhibit.pageCount === 1 ? "page" : "pages"}</p>
                  <span className="binder-exhibit__chip">{labels[index]}</span>
                </div>
                <div className="binder-exhibit__actions">
                  <button
                    type="button"
                    aria-label={`Move ${exhibit.name} up`}
                    onClick={() => moveExhibit(index, -1)}
                    disabled={building || index === 0}
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${exhibit.name} down`}
                    onClick={() => moveExhibit(index, 1)}
                    disabled={building || index === exhibits.length - 1}
                  >
                    <ArrowDownIcon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${exhibit.name}`}
                    onClick={() => removeExhibit(exhibit.id)}
                    disabled={building}
                  >
                    <DeleteIcon size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <input
            ref={addInputRef}
            className="binder-workspace__file-input"
            type="file"
            accept="application/pdf"
            multiple
            aria-label="Add exhibits"
            onChange={handleAddFiles}
            disabled={building}
          />
          <button
            type="button"
            className="binder-workspace__secondary binder-workspace__add"
            onClick={() => addInputRef.current?.click()}
            disabled={building}
          >
            <PlusIcon size={15} />
            Add exhibits...
          </button>
        </section>

        <section className="binder-card binder-card--settings" aria-label="Binder settings">
          <p className="binder-card__label">Settings</p>
          <fieldset className="binder-fieldset">
            <legend>Identifier style</legend>
            <label><input type="radio" name="identifier" checked={identifierStyle === "letters"} onChange={() => setIdentifierStyle("letters")} disabled={building} /> Letters</label>
            <label><input type="radio" name="identifier" checked={identifierStyle === "numbers"} onChange={() => setIdentifierStyle("numbers")} disabled={building} /> Numbers</label>
          </fieldset>

          <label className="binder-field">
            <span>Prefix</span>
            <input value={prefix} placeholder="Plaintiff's Exhibit" onChange={(event) => setPrefix(event.currentTarget.value)} disabled={building} />
          </label>

          <fieldset className="binder-fieldset">
            <legend>Placement</legend>
            <label><input type="radio" name="placement-edge" checked={placementEdge === "header"} onChange={() => setPlacementEdge("header")} disabled={building} /> Header</label>
            <label><input type="radio" name="placement-edge" checked={placementEdge === "footer"} onChange={() => setPlacementEdge("footer")} disabled={building} /> Footer</label>
          </fieldset>

          <fieldset className="binder-fieldset">
            <legend>Position</legend>
            <label><input type="radio" name="placement-align" checked={placementAlign === "left"} onChange={() => setPlacementAlign("left")} disabled={building} /> Left</label>
            <label><input type="radio" name="placement-align" checked={placementAlign === "center"} onChange={() => setPlacementAlign("center")} disabled={building} /> Center</label>
            <label><input type="radio" name="placement-align" checked={placementAlign === "right"} onChange={() => setPlacementAlign("right")} disabled={building} /> Right</label>
          </fieldset>

          <fieldset className="binder-fieldset">
            <legend>Stamp pages</legend>
            <label><input type="radio" name="stamp-pages" checked={stampPages === "first"} onChange={() => setStampPages("first")} disabled={building} /> First page only</label>
            <label><input type="radio" name="stamp-pages" checked={stampPages === "all"} onChange={() => setStampPages("all")} disabled={building} /> Every page</label>
          </fieldset>

          <label className="binder-toggle">
            <input type="checkbox" checked={slipSheets} onChange={(event) => setSlipSheets(event.currentTarget.checked)} disabled={building} />
            <span><SlipSheetIcon size={15} /> Slip sheets</span>
          </label>
          <p className="binder-card__hint">Insert a separator page before each exhibit</p>
          <p className="binder-card__hint">Each exhibit is bookmarked automatically.</p>
        </section>
      </div>

      <footer className="binder-workspace__footer">
        <div className="binder-workspace__footer-summary">
          <p>
            {stripPdfExtension(mainName)} + {exhibits.length} {exhibits.length === 1 ? "exhibit" : "exhibits"} · {totalPages} {totalPages === 1 ? "page" : "pages"}
          </p>
          {status ? <p className="binder-workspace__status" role="status">{status}</p> : null}
        </div>
        <button
          type="button"
          className="binder-workspace__primary"
          onClick={buildBinder}
          disabled={!document.bytes || exhibits.length === 0 || building}
        >
          <CombineExhibitsIcon size={16} />
          {building ? "Building Binder" : "Build Binder"}
        </button>
      </footer>
    </section>
  );
}

async function readExhibitFile(file: File): Promise<ExhibitFile> {
  const opened = await readBrowserFile(file);
  const pdf = await PDFDocument.load(opened.bytes);

  return {
    id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
    name: opened.name,
    bytes: opened.bytes,
    pageCount: pdf.getPageCount(),
  };
}

function formatExhibitLabel(
  prefix: string,
  identifierStyle: IdentifierStyle,
  index: number,
): string {
  const cleanPrefix = prefix.trim() || "Exhibit";
  const identifier = identifierStyle === "letters"
    ? toLetters(index)
    : String(index + 1);

  return `${cleanPrefix} ${identifier}`;
}

function toLetters(index: number): string {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
}

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}
