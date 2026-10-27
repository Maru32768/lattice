import type { ReactNode } from "react";
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { T } from "../i18n";

/** Pointer and keyboard (Space, ↑ ↓, Space) dragging, as the AI provider chain has. */
export const useRowSensors = () => useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

/**
 * The handle describes how to drag it; the moved row shows where it went. As in the sidebar, the
 * live region goes to a node outside the page, so a list adds no empty `status` to its screen.
 */
export const rowDndText = (t: T) => ({
  screenReaderInstructions: { draggable: t("modelSettings.dndHelp") },
  announcements: { onDragStart: () => "", onDragOver: () => "", onDragEnd: () => "", onDragCancel: () => "" },
  container: offPage,
});
const offPage = document.createElement("div");

/** A table row or list item of a `SortableContext`; `children` places the ⋮⋮ handle that drags it. */
export function SortableRow({
  id,
  as: Tag,
  label,
  className,
  children,
}: {
  id: number;
  as: "tr" | "li";
  /** The handle's name: what is dragged. */
  label: string;
  className?: string;
  children: (grip: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const grip = (
    <button ref={setActivatorNodeRef} type="button" className="grip" aria-label={label} title={label} {...attributes} {...listeners}>
      ⋮⋮
    </button>
  );
  const cls = [className, isDragging ? "dragging" : ""].filter(Boolean).join(" ");
  return (
    <Tag ref={setNodeRef} className={cls || undefined} style={{ transform: CSS.Translate.toString(transform), transition }}>
      {children(grip)}
    </Tag>
  );
}
