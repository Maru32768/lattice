/** Whether a file matches an `<input accept>` list: `.ext` by its name, `type/sub` by its type. Windows gives many files no type, so names decide those. */
export function acceptsFile(file: { name: string; type: string }, accept: string): boolean {
  const name = file.name.toLowerCase();
  return accept.split(",").some((a) => (a.startsWith(".") ? name.endsWith(a) : a === file.type));
}

export const fileStem = (name: string) => name.replace(/\.[^.]+$/u, "");

/** The file's text, or null when it is not UTF-8: refused like in the backend's file import, not decoded into garbage. */
export async function readUtf8(file: File): Promise<string | null> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));

/**
 * With Tauri's drop handler off, a file or link dropped outside a drop zone would navigate the app's
 * webview to it. Only text dragged into a field keeps the browser's behavior.
 */
export function guardDrops() {
  const guard = (e: DragEvent) => {
    if (e.defaultPrevented || (isEditable(e.target) && !e.dataTransfer?.types.includes("Files"))) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "none";
    }
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
}
