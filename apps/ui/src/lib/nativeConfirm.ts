/**
 * In a plain browser `window.confirm` blocks and returns a boolean, but inside
 * the Tauri shell the dialog plugin replaces it with an async function that
 * returns a Promise<boolean>. A sync call site there would treat the pending
 * Promise as truthy — every "are you sure?" guard silently confirms. All
 * confirm prompts must go through this helper so both runtimes resolve to a
 * real answer.
 */
export async function confirmWithUser(message: string): Promise<boolean> {
  try {
    return (await Promise.resolve(window.confirm(message))) === true;
  } catch (error) {
    // A denied or unavailable native dialog must read as "No" — the guarded
    // branch is always the destructive one.
    console.error("Confirm dialog failed; treating as cancelled.", error);
    return false;
  }
}
