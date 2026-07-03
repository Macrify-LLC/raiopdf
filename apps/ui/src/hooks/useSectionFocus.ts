import { useEffect, useRef, useState } from "react";

const DEFAULT_RING_MS = 1600;

/**
 * Shared behavior for a Preferences section that can be deep-linked to: when
 * `focused` flips true (a native-menu item or similar opened Preferences
 * pointed at this section specifically, as opposed to general Preferences),
 * scroll it into view and show a brief highlight ring, then call
 * `onFocusHandled` so the parent can drop the flag back to `null`/`false`.
 */
export function useSectionFocus(
  focused: boolean,
  onFocusHandled?: (() => void) | undefined,
  ringMs: number = DEFAULT_RING_MS,
) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [showFocusRing, setShowFocusRing] = useState(false);

  useEffect(() => {
    if (!focused) {
      return;
    }

    sectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setShowFocusRing(true);

    const timeoutId = window.setTimeout(() => {
      setShowFocusRing(false);
      onFocusHandled?.();
    }, ringMs);

    return () => window.clearTimeout(timeoutId);
  }, [focused, onFocusHandled, ringMs]);

  return { sectionRef, showFocusRing };
}
