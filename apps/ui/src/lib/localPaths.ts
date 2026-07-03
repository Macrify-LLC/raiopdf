export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface ResolveDesktopFileGrantPathsOptions {
  invoke?: TauriInvoke | undefined;
  isTauriRuntime?: (() => boolean) | undefined;
}

export function looksLikeAbsolutePath(value: string | null): value is string {
  return Boolean(value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)));
}

export async function resolveDesktopFileGrantPaths(
  paths: readonly (string | null)[],
  options: ResolveDesktopFileGrantPathsOptions = {},
): Promise<(string | null)[]> {
  const isRuntime = options.isTauriRuntime ?? isTauriRuntime;
  if (!isRuntime()) {
    return [...paths];
  }

  const grantEntries = paths
    .map((filePath, index) => ({ filePath, index }))
    .filter((entry): entry is { filePath: string; index: number } => (
      entry.filePath !== null && !looksLikeAbsolutePath(entry.filePath)
    ));

  if (grantEntries.length === 0) {
    return [...paths];
  }

  const invoke = options.invoke ?? await loadTauriInvoke();
  const resolved = await invoke<string[]>("resolve_file_grants", {
    grants: grantEntries.map((entry) => entry.filePath),
  });

  if (resolved.length !== grantEntries.length) {
    throw new Error("Desktop file grant resolution returned an unexpected number of paths.");
  }

  const next = [...paths];
  for (let index = 0; index < grantEntries.length; index += 1) {
    const entry = grantEntries[index];
    const resolvedPath = resolved[index];
    if (!entry || !resolvedPath) {
      throw new Error("Desktop file grant resolution returned an empty path.");
    }
    next[entry.index] = resolvedPath;
  }

  return next;
}

async function loadTauriInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
