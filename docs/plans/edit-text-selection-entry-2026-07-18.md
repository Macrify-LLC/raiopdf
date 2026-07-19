# Edit Text: right-click selection entry + rename — Plan (v5, LOCKED trimmed scope)

> Decision (maintainer, 2026-07-18): trimmed scope locked. The auto-continue-through-the-
> annotation-prompt machinery (document-bound pending request, commit-identity API
> extension, effect-owned continuation) is CUT — four Codex rounds held exclusively on
> that machinery; everything below was accepted.

## Scope

1. **"Replace text…" in the selection right-click menu** (after Copy; disabled when
   gated or when capture fails). Selecting it enters Edit Text mode with the selection
   pre-captured and the Replace-with field focused.
2. **Unsaved-annotations corner case = existing sidebar behavior.** The handler defers
   to the existing Save/Discard/Cancel prompt path (`requestTextEditMode` flow); no
   selection is carried across. After the prompt resolves into Edit Text mode, a status
   line says to reselect the text. Honest tradeoff: reselect once in that rare path.
3. **Rename "Find & Replace" → "Edit Text"** everywhere per the v4 inventory (registry,
   App label/eyebrows, review dialog, AppShell copy, ToolPanel tests, help article incl.
   frontmatter summary, getting-started, README, smoke + canary selectors,
   LegalModeBar.css comment; CHANGELOG and archived plans stay historical).

## Mechanics kept from the critique rounds (all accepted by Codex)

- **Hook-owned gate:** `selectedReplacementGate(pageIndex)` in `useTextEdit` — blocked
  when `gate.blocked` · unsafe page · `pendingOps.length > 0` · `selectionResolving` ·
  `phase === "staging" | "applying"`. App composes only `longProcessRunning` on top.
- **Resolution is an entry blocker:** prime during an in-flight resolution no-ops with a
  message; no runRef bump from priming.
- **Ref-backed dispatch:** EditLayer menu items carry data only (build-time
  `CapturedTextSelection`); `onSelect`/gate go through latest-value refs so a stale menu
  can never run stale logic; `primeSelectedReplacement` re-checks the gate as the last
  line of defense.
- **`primeSelectedReplacement(selection)`** = `captureSelectedText` minus the DOM capture
  (single write path; capture delegates to it); bumps monotonic `selectionPrimeCount`.
- **Focus:** EditTextModeBar focuses the Replace-with input in an effect keyed on
  `selectionPrimeCount` (repeat primes of identical text still focus).
- **Prop threading:** App → AppShell → CanvasWell → PageList → PageView → EditLayer
  (two props: `onReplaceTextInSelection`, `replaceTextInSelectionBlocked`); no memo
  claims, no memo added.
- **Scope honesty in help:** selected replacement is single-page, single-line/run; RTL
  unsupported (pre-existing); cross-page capture fails → item disabled.

## Tests

- Hook: prime sets text/message/bumps count; blocked prime no-ops (pendingOps /
  resolving / staging / unsafe page); queueSelectedReplacement works from a primed
  capture with the live selection collapsed.
- EditLayer: menu order Copy · Replace text… · Highlight · Underline · Strike through;
  disabled on gate / failed capture; click dispatches latest ref with build-time capture;
  stale-menu click no-ops.
- EditTextModeBar: focus on prime, and again on second identical prime.
- Smoke e2e: select → right-click → Replace text… → mode bar "Selection captured" +
  focused input → type → Replace selection → review shows the single selected op → Cancel.
- Real-engine canary: two identical occurrences; select the second on-page via the menu
  route; verify only that occurrence changes.
- Rename: all selector updates; full gates (typecheck/build/test/lint, smoke pre-push,
  `pnpm canary`).

## PR shape

Branch `feature/edit-text-selection-entry` stacked on `feature/sidebar-annotate-reorg`
(PR #278) — same ToolPanel/registry/test/help files; PR base = #278's branch, retarget
to `main` after #278 merges. Plan committed as `docs/plans/edit-text-selection-entry-2026-07-18.md`.
No Rust, no engine, no schema.
