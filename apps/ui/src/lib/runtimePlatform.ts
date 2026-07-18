export type RuntimePlatform = "web" | "macos" | "windows";

export function detectRuntimePlatform(input: {
  tauri: boolean;
  userAgent: string;
}): RuntimePlatform {
  if (!input.tauri) {
    return "web";
  }

  return /Macintosh|Mac OS X/i.test(input.userAgent) ? "macos" : "windows";
}

export function runtimePlatform(): RuntimePlatform {
  return detectRuntimePlatform({
    tauri: typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  });
}
