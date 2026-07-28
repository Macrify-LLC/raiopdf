import { describeErrorChain, recordDiagnosticEvent } from "./diagnostics";

/**
 * Per-document, per-kind guard for page render/load failures.
 *
 * Pages mount and unmount as the user scrolls, and re-render on every zoom step,
 * so a document whose pages all fail would otherwise record one diagnostic per
 * page per pass. That is actively harmful, not merely wasteful: each recording is
 * a synchronous shell-side log write, a 1,000-page pass can push a whole
 * rotation's worth of bytes through `app.log` and age out the root-cause line,
 * and each push evicts an entry from the bounded ring -- including the failure
 * the user is currently reading.
 *
 * Keyed weakly on the document, so the guard is collected with it and a newly
 * opened document starts fresh.
 */
const reportedPageFailureIds = new WeakMap<object, Map<string, string>>();

/**
 * Record the first page failure of each kind for a document, and return that same
 * id for every later one.
 *
 * Returning the retained id rather than null matters: the id is forwarded into the
 * document's failure state, so returning null on a suppressed call would *clear*
 * the id already on screen and make the report action vanish while the message
 * stayed. Reusing the first id is also the honest answer -- a second broken page
 * is the same fact as the first, which is why only one diagnostic is written.
 */
export function recordFirstPageFailure(
  documentKey: object,
  kind: string,
  error: unknown,
  details: readonly string[] = [],
): string {
  let idsByKind = reportedPageFailureIds.get(documentKey);
  if (!idsByKind) {
    idsByKind = new Map();
    reportedPageFailureIds.set(documentKey, idsByKind);
  }

  const existing = idsByKind.get(kind);
  if (existing !== undefined) {
    return existing;
  }

  // Deliberately no stack: a pdf.js render stack is noise, and this is the
  // largest payload on the highest-frequency recording site in the app.
  const id = recordDiagnosticEvent(kind, describeErrorChain(error), details);
  idsByKind.set(kind, id);
  return id;
}
