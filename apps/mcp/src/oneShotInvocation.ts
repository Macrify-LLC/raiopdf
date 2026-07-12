export interface OneShotInvocation {
  oneShot: boolean;
  toolName: string | undefined;
}

// The shell invokes the packaged launcher as `raiopdf-mcp [flags...] --one-shot <tool>`
// and the launcher forwards ALL of its arguments after the Node entrypoint, so anything
// the shell prepends lands in process.argv BEFORE `--one-shot`. Scan for the marker
// instead of assuming a fixed position — a fixed `argv[2] === "--one-shot"` check
// silently booted the stdio server instead of the one-shot handler whenever a flag
// preceded the marker (shipped broken in v0.1.0–v0.1.2).
export function parseOneShotInvocation(argv: readonly string[]): OneShotInvocation {
  const markerIndex = argv.indexOf("--one-shot", 2);
  if (markerIndex === -1) {
    return { oneShot: false, toolName: undefined };
  }
  return { oneShot: true, toolName: argv[markerIndex + 1] };
}
