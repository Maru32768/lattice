// Canonical key names, shared by the app and the page overlay (which cannot load keys.ts: that
// module imports React and reads the app's storage at load).

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Unidentified", "Process"]);

/** Canonical key ("Ctrl+K", "Shift+Enter", "J", "/", "ArrowDown"); null for a lone modifier. */
export function keyOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const k = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  // A printed symbol already carries Shift ("?" is Shift+/); letters and named keys keep it.
  const shift = e.shiftKey && (e.key.length > 1 || e.key === " " || /^[a-z]$/i.test(e.key));
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${shift ? "Shift+" : ""}${k}`;
}
