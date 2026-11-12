import { useEffect, useEffectEvent, useId, useState, type DragEvent } from "react";
import { acceptsFile, isEditable } from "../lib/files";

const ZONE = "data-file-drop";

const zoneOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest(`[${ZONE}]`)?.getAttribute(ZONE) ?? null) : null);

/** `onFile` takes the first file that fits, like a picker of one; `onFiles` every file that fits, like a picker of several. */
type Take = { onFile: (file: File) => void } | { onFiles: (files: File[]) => void };

/**
 * A second way to give a file picker its files: dropped on the element given `zone`, or pasted. Only
 * the innermost zone under the pointer takes a drop, so one zone can sit inside another. A paste goes
 * to the zone holding the focus; with the focus in no zone or field, to whichever accepts the file.
 * Files of other kinds that come with fitting ones are left out; when none fits, `onReject`.
 */
export function useFileDrop(
  options: {
    accept: string;
    /** A file came to this zone that `accept` does not cover. */
    onReject: () => void;
    disabled?: boolean;
  } & Take,
) {
  const { accept, onReject, disabled } = options;
  const id = useId();
  const [dragging, setDragging] = useState(false);
  /** Hands over the files that fit; false when none does. */
  const take = (list: FileList) => {
    const files = Array.from(list).filter((f) => acceptsFile(f, accept));
    const [first] = files;
    if (!first) {
      return false;
    }
    if ("onFiles" in options) {
      options.onFiles(files);
    } else {
      options.onFile(first);
    }
    return true;
  };

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
    if (take(data.files)) {
      e.preventDefault();
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
        if (!take(e.dataTransfer.files)) {
          onReject();
        }
      }
    },
  };
  return { dragging, zone };
}
