import { useEffect, useEffectEvent, useId, useState, type DragEvent } from "react";
import { acceptsFile, isEditable } from "../lib/files";

const ZONE = "data-file-drop";

const zoneOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest(`[${ZONE}]`)?.getAttribute(ZONE) ?? null) : null);

/**
 * A second way to give a file picker its file: dropped on the element given `zone`, or pasted. Only
 * the innermost zone under the pointer takes a drop, so one zone can sit inside another. A paste goes
 * to the zone holding the focus; with the focus in no zone or field, to whichever accepts the file.
 * One file at a time, like the pickers.
 */
export function useFileDrop({
  accept,
  onFile,
  onReject,
  disabled,
}: {
  accept: string;
  onFile: (file: File) => void;
  /** A file came to this zone that `accept` does not cover. */
  onReject: () => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const matching = (files: FileList) => Array.from(files).find((f) => acceptsFile(f, accept));

  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    const data = e.clipboardData;
    // A copy from Word or Excel holds its text and a picture of it: that is a paste of the text.
    if (disabled || !data?.files.length || data.types.includes("text/plain")) {
      return;
    }
    const zone = zoneOf(e.target);
    if (zone ? zone !== id : isEditable(e.target)) {
      return;
    }
    const file = matching(data.files);
    if (file) {
      e.preventDefault();
      onFile(file);
    } else if (zone) {
      onReject();
    }
  });
  useEffect(() => {
    const paste = (e: ClipboardEvent) => onPaste(e);
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);

  const mine = (e: DragEvent) => !disabled && zoneOf(e.target) === id && e.dataTransfer.types.includes("Files");
  const zone = {
    [ZONE]: id,
    onDragOver: (e: DragEvent) => {
      const over = mine(e);
      setDragging(over);
      if (over) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDragging(false);
      }
    },
    onDrop: (e: DragEvent) => {
      setDragging(false);
      if (mine(e)) {
        e.preventDefault();
        const file = matching(e.dataTransfer.files);
        if (file) {
          onFile(file);
        } else {
          onReject();
        }
      }
    },
  };
  return { dragging, zone };
}
