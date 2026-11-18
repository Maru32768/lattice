import { useState } from "react";
import { Popover } from "../ui/Popover";
import { PickList } from "../ui/PickList";
import { filterSections, labelOf, type PickSection } from "../ui/pickRows";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";

/** The chat's 範囲 chip: it shows the scope and opens a search over every scope. */
export function ScopePicker({ value, sections, onChange }: { value: string; sections: PickSection[]; onChange: (key: string) => void }) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const shown = labelOf(sections, value);
  // A scope no option offers any more (the list has left the scope it names) still asks over it: keep its name.
  const [kept, setKept] = useState(shown);
  if (shown !== undefined && shown !== kept) {
    setKept(shown);
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
        <span className="opt-l">{shown ?? kept}</span>
        <Icon name="down" size="sm" />
      </button>
      {anchor && (
        <ScopeList
          anchor={anchor}
          sections={sections}
          value={value}
          onClose={() => setAnchor(null)}
          onPick={(key) => {
            setAnchor(null);
            onChange(key);
          }}
        />
      )}
    </>
  );
}

/** Mounted only while open, so each opening starts with an empty search. */
function ScopeList({
  anchor,
  sections,
  value,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  sections: PickSection[];
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  return (
    <Popover anchor={anchor} label={t("chatPane.scopeLabel")} width={340} onClose={onClose}>
      <PickList
        label={t("chatPane.scopeLabel")}
        search={t("chatPane.findScope")}
        query={q}
        onQuery={setQ}
        sections={filterSections(sections, q)}
        selected={value}
        onPick={(o) => onPick(o.key)}
      />
    </Popover>
  );
}
