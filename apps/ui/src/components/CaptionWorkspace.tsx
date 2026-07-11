import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PdfEngineError, type PdfCaptionData, type PdfCaptionParty, type PdfCoverPageOptions } from "@raiopdf/engine-api";
import { CAPTION_STYLES } from "@raiopdf/engine-local";
import type { DocumentFileInput, DocumentState } from "../hooks/useDocument";
import {
  deleteCaseProfile,
  readCaseProfiles,
  readLastUsedCaseProfile,
  selectLastUsedCaseProfile,
  upsertCaseProfile,
  type CaseProfile,
} from "../lib/caseProfiles";
import { saveCaptionPdf } from "../lib/captionActions";
import { generateCaptionPdf } from "../lib/captionPreview";
import {
  DeleteIcon,
  HelpIcon,
  InsertIcon,
  PlusIcon,
  SaveIcon,
  SlipSheetIcon,
} from "../icons";
import { IconButton } from "./IconButton";
import { PdfMiniThumb } from "./PdfMiniThumb";
import "./CaptionWorkspace.css";

interface CaptionPartyDraft {
  id: string;
  role: string;
  names: string[];
  etAl: boolean;
}

interface CaptionDraft {
  courtName: string;
  county: string;
  parties: CaptionPartyDraft[];
  caseNumber: string;
  division: string;
  judge: string;
  documentTitle: string;
  signatureBlockLines: string;
}

export interface CaptionWorkspaceProps {
  document: DocumentState;
  onPrependCaption: (file: DocumentFileInput, insertAtPageIndex: number) => Promise<boolean>;
  onCancel: () => void;
  onHelpRequested?: (() => void) | undefined;
}

const DEFAULT_CAPTION: CaptionDraft = {
  courtName: "",
  county: "",
  parties: [
    { id: "party-plaintiff", role: "Plaintiff", names: [""], etAl: false },
    { id: "party-defendant", role: "Defendant", names: [""], etAl: false },
  ],
  caseNumber: "",
  division: "",
  judge: "",
  documentTitle: "",
  signatureBlockLines: "",
};

export function CaptionWorkspace({
  document,
  onPrependCaption,
  onCancel,
  onHelpRequested,
}: CaptionWorkspaceProps) {
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const initialProfile = useMemo(() => readLastUsedCaseProfile(), []);
  const [profiles, setProfiles] = useState<readonly CaseProfile[]>(() => readCaseProfiles());
  const [selectedProfileId, setSelectedProfileId] = useState(initialProfile?.id ?? "");
  const [profileName, setProfileName] = useState(initialProfile?.name ?? "");
  const [draft, setDraft] = useState<CaptionDraft>(() =>
    initialProfile ? draftFromCaption(initialProfile.caption) : DEFAULT_CAPTION);
  const [styleId, setStyleId] = useState(
    initialProfile?.preferredStyleId ?? CAPTION_STYLES[0]?.id ?? "classic-boxed",
  );
  const [stylePreviews, setStylePreviews] = useState<Record<string, Uint8Array | null>>({});
  const [mainPreview, setMainPreview] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const caption = useMemo(() => captionFromDraft(draft), [draft]);
  const options = useMemo<PdfCoverPageOptions>(() => ({ caption, styleId }), [caption, styleId]);
  const validationMessage = validateCaption(caption);
  const canOutput = !validationMessage && !working;
  const canPrepend = canOutput && document.source?.kind === "memory" && Boolean(document.bytes);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  useEffect(() => {
    let disposed = false;
    const timeout = window.setTimeout(() => {
      setMainPreview(null);
      void generateCaptionPdf(options)
        .then((bytes) => {
          if (!disposed) {
            setMainPreview(bytes);
          }
        })
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }

          setMainPreview(null);
          // Surface the one-page overflow immediately so the user learns the
          // caption doesn't fit while editing, not at save time.
          const overflow = captionOverflowMessage(error);
          if (overflow) {
            setStatus(overflow);
          }
        });
    }, 160);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [options]);

  useEffect(() => {
    let disposed = false;
    const timeout = window.setTimeout(() => {
      setStylePreviews({});
      void Promise.all(
        CAPTION_STYLES.map(async (style) => [
          style.id,
          // Style margins differ, so overflow is per style; a style whose
          // page can't fit the content shows an empty tile instead of
          // rejecting the whole batch.
          await generateCaptionPdf({ caption, styleId: style.id }).catch(() => null),
        ] as const),
      ).then((entries) => {
        if (!disposed) {
          setStylePreviews(Object.fromEntries(entries));
        }
      });
    }, 220);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
    };
  }, [caption]);

  function updateField(field: keyof Omit<CaptionDraft, "parties">, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateParty(id: string, patch: Partial<Omit<CaptionPartyDraft, "id">>) {
    setDraft((current) => ({
      ...current,
      parties: current.parties.map((party) => party.id === id ? { ...party, ...patch } : party),
    }));
  }

  function updatePartyName(partyId: string, nameIndex: number, value: string) {
    setDraft((current) => ({
      ...current,
      parties: current.parties.map((party) => {
        if (party.id !== partyId) {
          return party;
        }

        return {
          ...party,
          names: party.names.map((name, index) => index === nameIndex ? value : name),
        };
      }),
    }));
  }

  function addParty() {
    setDraft((current) => ({
      ...current,
      parties: [
        ...current.parties,
        { id: makeId("party"), role: "Party", names: [""], etAl: false },
      ],
    }));
  }

  function removeParty(id: string) {
    setDraft((current) => ({
      ...current,
      parties: current.parties.filter((party) => party.id !== id),
    }));
  }

  function addPartyName(id: string) {
    setDraft((current) => ({
      ...current,
      parties: current.parties.map((party) =>
        party.id === id ? { ...party, names: [...party.names, ""] } : party
      ),
    }));
  }

  function removePartyName(partyId: string, nameIndex: number) {
    setDraft((current) => ({
      ...current,
      parties: current.parties.map((party) => {
        if (party.id !== partyId) {
          return party;
        }

        const names = party.names.filter((_, index) => index !== nameIndex);
        return { ...party, names: names.length > 0 ? names : [""] };
      }),
    }));
  }

  function loadProfile(profileId: string) {
    const profile = profiles.find((candidate) => candidate.id === profileId);

    setSelectedProfileId(profileId);

    if (!profile) {
      return;
    }

    setDraft(draftFromCaption(profile.caption));
    setProfileName(profile.name);
    setStyleId(profile.preferredStyleId ?? CAPTION_STYLES[0]?.id ?? "classic-boxed");
    selectLastUsedCaseProfile(profile.id);
    setStatus(`Loaded ${profile.name}.`);
  }

  function saveProfile() {
    const name = profileName.trim() || caption.caseNumber || caption.documentTitle || "Case caption";

    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }

    const saved = upsertCaseProfile({
      id: selectedProfileId || undefined,
      name,
      caption,
      preferredStyleId: styleId,
    });
    setProfiles(readCaseProfiles());
    setSelectedProfileId(saved.id);
    setProfileName(saved.name);
    setStatus("Case profile saved.");
  }

  function deleteProfile() {
    if (!selectedProfileId) {
      return;
    }

    deleteCaseProfile(selectedProfileId);
    setProfiles(readCaseProfiles());
    setSelectedProfileId("");
    setProfileName("");
    setStatus("Case profile deleted.");
  }

  async function savePdf() {
    if (validationMessage || working) {
      setStatus(validationMessage);
      return;
    }

    setWorking(true);
    setStatus("Rendering caption...");

    try {
      const saved = await saveCaptionPdf(options, captionFileName(caption));
      setStatus(saved ? `Saved ${saved.name}.` : "Save cancelled.");
    } catch (error) {
      setStatus(captionOverflowMessage(error) ?? "The caption PDF could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function prependCaption() {
    if (validationMessage || working) {
      setStatus(validationMessage);
      return;
    }

    if (!canPrepend) {
      setStatus(document.source ? "Prepend is available for standard in-memory documents." : "Open a PDF before prepending a caption.");
      return;
    }

    setWorking(true);
    setStatus("Rendering caption...");

    try {
      const bytes = await generateCaptionPdf(options);
      const inserted = await onPrependCaption(
        { bytes, name: captionFileName(caption), path: null },
        0,
      );
      setStatus(inserted ? "Caption prepended to the open PDF." : "The caption could not be prepended.");
      if (inserted) {
        onCancel();
      }
    } catch (error) {
      setStatus(captionOverflowMessage(error) ?? "The caption could not be prepended.");
    } finally {
      setWorking(false);
    }
  }

  function notePacketHandoff() {
    setStatus("Packet handoff is the next wire-up. Save or prepend this caption here, then add the resulting PDF to the binder or filing packet.");
  }

  return (
    <section className="caption-workspace" aria-label="Case Caption workspace">
      <header className="caption-workspace__header">
        <div>
          <p className="caption-workspace__eyebrow">Legal</p>
          <h2>Case Caption</h2>
        </div>
        <div className="caption-workspace__header-actions">
          {onHelpRequested ? (
            <IconButton
              icon={<HelpIcon size={14} />}
              label="Help: Case Caption"
              onClick={onHelpRequested}
            />
          ) : null}
          <button type="button" className="caption-workspace__ghost" onClick={onCancel}>
            Back to document
          </button>
        </div>
      </header>

      <div className="caption-workspace__grid">
        <section className="caption-card caption-card--form" aria-label="Caption fields">
          <div className="caption-card__title-row">
            <p className="caption-card__label">Caption form</p>
            <span>{caption.parties.length} parties</span>
          </div>

          <div className="caption-form-grid">
            <label className="caption-field">
              <span>Court name</span>
              <input value={draft.courtName} onChange={(event) => updateField("courtName", event.currentTarget.value)} />
            </label>
            <label className="caption-field">
              <span>County</span>
              <input value={draft.county} onChange={(event) => updateField("county", event.currentTarget.value)} />
            </label>
            <label className="caption-field">
              <span>Case number</span>
              <input value={draft.caseNumber} onChange={(event) => updateField("caseNumber", event.currentTarget.value)} />
            </label>
            <label className="caption-field">
              <span>Division</span>
              <input value={draft.division} onChange={(event) => updateField("division", event.currentTarget.value)} />
            </label>
            <label className="caption-field">
              <span>Judge</span>
              <input value={draft.judge} onChange={(event) => updateField("judge", event.currentTarget.value)} />
            </label>
            <label className="caption-field">
              <span>Document title</span>
              <input value={draft.documentTitle} onChange={(event) => updateField("documentTitle", event.currentTarget.value)} />
            </label>
          </div>

          <div className="caption-parties" role="list" aria-label="Party blocks">
            {draft.parties.map((party, partyIndex) => (
              <article className="caption-party" role="listitem" key={party.id}>
                <div className="caption-party__header">
                  <p>Party {partyIndex + 1}</p>
                  <button
                    type="button"
                    aria-label={`Remove party ${partyIndex + 1}`}
                    onClick={() => removeParty(party.id)}
                    disabled={draft.parties.length === 1}
                  >
                    <DeleteIcon size={14} />
                  </button>
                </div>
                <label className="caption-field">
                  <span>Role label</span>
                  <input value={party.role} onChange={(event) => updateParty(party.id, { role: event.currentTarget.value })} />
                </label>
                <div className="caption-party__names">
                  {party.names.map((name, nameIndex) => (
                    <label className="caption-field" key={`${party.id}-${nameIndex}`}>
                      <span>Name {nameIndex + 1}</span>
                      <span className="caption-party__name-row">
                        <input value={name} onChange={(event) => updatePartyName(party.id, nameIndex, event.currentTarget.value)} />
                        <button
                          type="button"
                          aria-label={`Remove name ${nameIndex + 1}`}
                          onClick={() => removePartyName(party.id, nameIndex)}
                          disabled={party.names.length === 1}
                        >
                          <DeleteIcon size={14} />
                        </button>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="caption-party__actions">
                  <button type="button" className="caption-workspace__secondary" onClick={() => addPartyName(party.id)}>
                    <PlusIcon size={14} />
                    Add name
                  </button>
                  <label className="caption-toggle">
                    <input
                      type="checkbox"
                      checked={party.etAl}
                      onChange={(event) => updateParty(party.id, { etAl: event.currentTarget.checked })}
                    />
                    <span>et al.</span>
                  </label>
                </div>
              </article>
            ))}
          </div>

          <button type="button" className="caption-workspace__secondary" onClick={addParty}>
            <PlusIcon size={15} />
            Add party block
          </button>

          <label className="caption-field">
            <span>Signature block lines</span>
            <textarea
              rows={4}
              value={draft.signatureBlockLines}
              onChange={(event) => updateField("signatureBlockLines", event.currentTarget.value)}
            />
          </label>
        </section>

        <section className="caption-card caption-card--profiles" aria-label="Case profiles and style">
          <p className="caption-card__label">Case profile</p>
          <label className="caption-field">
            <span>Saved profile</span>
            <select value={selectedProfileId} onChange={(event) => loadProfile(event.currentTarget.value)}>
              <option value="">No saved profile</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </label>
          <label className="caption-field">
            <span>Profile name</span>
            <input value={profileName} onChange={(event) => setProfileName(event.currentTarget.value)} placeholder="Smith v. Jones" />
          </label>
          <div className="caption-profile-actions">
            <button type="button" className="caption-workspace__secondary" onClick={saveProfile} disabled={Boolean(validationMessage)}>
              <SaveIcon size={15} />
              Save profile
            </button>
            <button type="button" className="caption-workspace__secondary" onClick={deleteProfile} disabled={!selectedProfileId}>
              <DeleteIcon size={15} />
              Delete
            </button>
          </div>

          <div className="caption-style">
            <p className="caption-card__label">Style</p>
            <div className="caption-style__grid" role="radiogroup" aria-label="Caption style">
              {CAPTION_STYLES.map((style, index) => {
                const selected = styleId === style.id;

                return (
                  <button
                    key={style.id}
                    ref={(node) => {
                      tileRefs.current[style.id] = node;
                    }}
                    type="button"
                    className="caption-style__tile"
                    role="radio"
                    aria-checked={selected}
                    data-selected={selected ? "true" : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setStyleId(style.id)}
                    onKeyDown={(event) => handleStyleKey(event, index, setStyleId, tileRefs.current)}
                  >
                    <PdfMiniThumb
                      bytes={stylePreviews[style.id] ?? null}
                      label={`${style.label} caption preview`}
                      targetWidth={70}
                      targetHeight={90}
                    />
                    <span className="caption-style__meta">
                      <span className="caption-style__radio" aria-hidden="true" />
                      <span>{style.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="caption-card caption-card--preview" aria-label="Caption preview">
          <div className="caption-card__title-row">
            <p className="caption-card__label">Preview</p>
            <span>{CAPTION_STYLES.find((style) => style.id === styleId)?.label ?? "Caption"}</span>
          </div>
          <div className="caption-preview">
            <PdfMiniThumb
              bytes={mainPreview}
              label="Selected caption preview"
              targetWidth={260}
              targetHeight={336}
            />
          </div>
          {validationMessage ? (
            <p className="caption-card__hint" role="status">{validationMessage}</p>
          ) : (
            <p className="caption-card__hint">The preview and saved page are rendered by the same local caption engine.</p>
          )}
        </section>
      </div>

      <footer className="caption-workspace__footer">
        <div className="caption-workspace__footer-summary">
          <p>{caption.documentTitle || "Untitled caption"} · {caption.parties.length} party block{caption.parties.length === 1 ? "" : "s"}</p>
          {status ? (
            <p className="caption-workspace__status" role="status">{status}</p>
          ) : null}
        </div>
        <div className="caption-workspace__footer-actions">
          <button type="button" className="caption-workspace__secondary" onClick={notePacketHandoff}>
            <SlipSheetIcon size={15} />
            Add to binder / packet
          </button>
          <button type="button" className="caption-workspace__secondary" onClick={prependCaption} disabled={!canPrepend}>
            <InsertIcon size={15} />
            Prepend to current PDF
          </button>
          <button type="button" className="caption-workspace__primary" onClick={savePdf} disabled={!canOutput}>
            <SaveIcon size={16} />
            {working ? "Rendering..." : "Save as PDF"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function handleStyleKey(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  index: number,
  onChange: (styleId: string) => void,
  refs: Record<string, HTMLButtonElement | null>,
) {
  let nextIndex: number | null = null;

  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % CAPTION_STYLES.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + CAPTION_STYLES.length) % CAPTION_STYLES.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = CAPTION_STYLES.length - 1;
  }

  if (nextIndex === null) {
    return;
  }

  event.preventDefault();
  const nextStyle = CAPTION_STYLES[nextIndex];

  if (nextStyle) {
    onChange(nextStyle.id);
    refs[nextStyle.id]?.focus();
  }
}

function captionFromDraft(draft: CaptionDraft): PdfCaptionData {
  const parties = draft.parties
    .map((party): PdfCaptionParty => ({
      role: party.role.trim(),
      names: compactStrings(party.names),
      ...(party.etAl ? { etAl: true } : {}),
    }))
    .filter((party) => party.role && party.names.length > 0);
  const signatureBlockLines = compactStrings(draft.signatureBlockLines.split(/\r?\n/u));

  return {
    courtName: draft.courtName.trim(),
    ...(draft.county.trim() ? { county: draft.county.trim() } : {}),
    parties,
    ...(draft.caseNumber.trim() ? { caseNumber: draft.caseNumber.trim() } : {}),
    ...(draft.division.trim() ? { division: draft.division.trim() } : {}),
    ...(draft.judge.trim() ? { judge: draft.judge.trim() } : {}),
    documentTitle: draft.documentTitle.trim(),
    ...(signatureBlockLines.length > 0 ? { signatureBlockLines } : {}),
  };
}

function draftFromCaption(caption: PdfCaptionData): CaptionDraft {
  return {
    courtName: caption.courtName,
    county: caption.county ?? "",
    parties: caption.parties.length > 0
      ? caption.parties.map((party) => ({
        id: makeId("party"),
        role: party.role,
        names: party.names.length > 0 ? [...party.names] : [""],
        etAl: Boolean(party.etAl),
      }))
      : DEFAULT_CAPTION.parties,
    caseNumber: caption.caseNumber ?? "",
    division: caption.division ?? "",
    judge: caption.judge ?? "",
    documentTitle: caption.documentTitle,
    signatureBlockLines: caption.signatureBlockLines?.join("\n") ?? "",
  };
}

function validateCaption(caption: PdfCaptionData): string | null {
  if (!caption.courtName) {
    return "Court name is required.";
  }

  if (!caption.documentTitle) {
    return "Document title is required.";
  }

  if (caption.parties.length === 0) {
    return "Add at least one party block with a name.";
  }

  return null;
}

// The shared caption renderer refuses to silently truncate a caption that
// cannot fit its one page; surface that message verbatim so the user knows
// what to shorten instead of getting a generic failure.
function captionOverflowMessage(error: unknown): string | null {
  return error instanceof PdfEngineError && error.code === "CONTENT_OVERFLOW"
    ? error.message
    : null;
}

function captionFileName(caption: PdfCaptionData): string {
  const base = caption.caseNumber || caption.documentTitle || "Case Caption";
  return `${sanitizeFileNamePart(base).slice(0, 80)} Caption.pdf`;
}

function compactStrings(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function sanitizeFileNamePart(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || '<>:"/\\|?*'.includes(character) ? "-" : character;
    })
    .join("");
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
