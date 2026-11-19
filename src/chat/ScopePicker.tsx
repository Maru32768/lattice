import { useState } from "react";
import { Popover } from "../ui/Popover";
import { PickList } from "../ui/PickList";
import { filterSections, labelOf, type PickOption, type PickSection } from "../ui/pickRows";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";

/** The chat's 範囲 chip: it shows the scope and opens a search over every scope. */
export function ScopePicker({
  value,
  sections,
  loading,
  onChange,
}: {
  value: string;
  sections: PickSection[];
  /** The library has not loaded: `sections` lacks its scopes. */
  loading: boolean;
  onChange: (key: string) => void;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const shown = labelOf(sections, value);
  // A scope no option offers any more (the list has left the scope it names) still asks over it: keep its name. A
  // scope the options do not have yet (set from outside while the library loads) has none to keep.
  const [kept, setKept] = useState({ key: value, label: shown });
  if (shown !== undefined && (shown !== kept.label || value !== kept.key)) {
    setKept({ key: value, label: shown });
  }
  return (
    <>
      <button
        className="chip scope-btn"
        role="combobox"
        aria-label={t("chatPane.scopeLabel")}
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !anchor) {
            e.preventDefault();
            setAnchor(e.currentTarget);
          }
        }}
      >
        <span className="opt-l">{shown ?? (kept.key === value ? kept.label : undefined)}</span>
        <Icon name="down" size="sm" />
      </button>
      {anchor && (
        <ScopeList
          anchor={anchor}
          sections={loading ? null : sections}
          value={value}
          onClose={() => setAnchor(null)}
          onPick={(o) => {
            setAnchor(null);
            // Picked from the held options: it may have left the live ones, which then cannot name it.
            setKept({ key: o.key, label: o.label });
            onChange(o.key);
          }}
        />
      )}
    </>
  );
}

/** Mounted only while open, so each opening starts with an empty search and the latest scopes. */
function ScopeList({
  anchor,
  sections,
  value,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  /** Null while they load. */
  sections: PickSection[] | null;
  value: string;
  onPick: (o: PickOption) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  // Held while open: a refresh (a tag added, a tab opened) would move the options under the pointer and the keys.
  const [held, setHeld] = useState(sections);
  if (!held && sections) {
    setHeld(sections);
  }
  return (
    <Popover anchor={anchor} label={t("chatPane.scopeLabel")} width={340} onClose={onClose}>
      <PickList
        label={t("chatPane.scopeLabel")}
        search={t("chatPane.findScope")}
        query={q}
        onQuery={setQ}
        sections={held && filterSections(held, q)}
        selected={value}
        onPick={onPick}
      />
    </Popover>
  );
}
