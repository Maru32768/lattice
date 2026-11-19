import { useEffect, useRef, useState } from "react";
import type { GroupRow } from "../api";
import { Popover } from "../ui/Popover";
import { PickList } from "../ui/PickList";
import { filterSections, type PickOption, type PickSection } from "../ui/pickRows";
import { Icon, Kbd, type IconName } from "../ui/Icon";
import { useT } from "../i18n";

/** Multi-select of groups with find-or-create, styled like the facet popover. */
export function GroupPicker({
  groups,
  selected,
  onToggle,
  onCreate,
  anchor,
  onClose,
}: {
  groups: GroupRow[];
  selected: number[];
  onToggle: (id: number, on: boolean) => void;
  /** Creates the group and returns its id; the picker then selects it. */
  onCreate: (name: string) => Promise<number>;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Picker
      options={groups.map((g) => ({ id: g.id, name: g.name, count: g.count }))}
      selected={selected}
      onToggle={onToggle}
      onCreate={onCreate}
      anchor={anchor}
      onClose={onClose}
      icon="folder"
      text={{ label: t("groupPicker.label"), find: t("groupPicker.find"), create: (name) => t("groupPicker.create", { name }), none: t("groupPicker.none") }}
    />
  );
}

/** Multi-select of tags with find-or-add: a picked tag is on every article, and a new name is added as a tag. */
export function TagPicker({
  tags,
  selected,
  onToggle,
  anchor,
  onClose,
}: {
  tags: { name: string; count: number }[];
  selected: string[];
  onToggle: (name: string, on: boolean) => void;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Picker
      options={tags.map((g) => ({ id: g.name, name: g.name, count: g.count }))}
      selected={selected}
      onToggle={onToggle}
      onCreate={(name) => Promise.resolve(name)}
      anchor={anchor}
      onClose={onClose}
      icon="search"
      text={{ label: t("tagPicker.label"), find: t("tagPicker.find"), create: (name) => t("tagPicker.create", { name }), none: t("tagPicker.none") }}
    />
  );
}

/** A picker's row: an option it has, or the offer to make one named `name`. */
type PickerOption<K> = PickOption & ({ kind: "have"; id: K } | { kind: "add"; name: string });

function Picker<K extends number | string>({
  options,
  selected,
  onToggle,
  onCreate,
  anchor,
  onClose,
  icon,
  text,
}: {
  options: { id: K; name: string; count: number }[];
  selected: K[];
  onToggle: (id: K, on: boolean) => void;
  /** Makes the option and returns its id; the picker then selects it. */
  onCreate: (name: string) => Promise<K>;
  anchor: HTMLElement;
  onClose: () => void;
  icon: IconName;
  text: { label: string; find: string; create: (name: string) => string; none: string };
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  // First, where the cleared search shows it: and the caller may list it only after a refresh, later than the list
  // asks for its rows.
  const [made, setMade] = useState<{ id: K; name: string }[]>([]);
  const known = [...made, ...options.filter((o) => !made.some((m) => m.id === o.id))];

  async function create(name: string) {
    setError(null);
    try {
      const id = await onCreate(name);
      setMade((m) => [...m, { id, name }]);
      onToggle(id, true);
      setQ("");
    } catch (e) {
      setError(String(e));
    }
  }

  function arrange(query: string): PickSection<PickerOption<K>>[] {
    const name = query.trim();
    const have = known.map((o): PickerOption<K> => ({ kind: "have", key: String(o.id), label: o.name, id: o.id }));
    const hits = filterSections([{ label: "", options: have }], name)[0]?.options ?? [];
    const fresh = name !== "" && !known.some((o) => o.name.toLowerCase() === name.toLowerCase());
    return [{ label: "", options: fresh ? [...hits, { kind: "add", key: "", label: text.create(name), icon: "plus", name }] : hits }];
  }

  return (
    <Popover anchor={anchor} label={text.label} width={300} onClose={onClose}>
      <PickList
        label={text.label}
        search={text.find}
        icon={icon}
        query={q}
        onQuery={(v) => {
          setQ(v);
          setError(null);
        }}
        arrange={arrange}
        selected={selected.map(String)}
        counts={{ of: new Map(options.map((o) => [String(o.id), o.count])) }}
        onPick={(o) => (o.kind === "add" ? void create(o.name) : onToggle(o.id, !selected.includes(o.id)))}
        empty={text.none}
      >
        {error && (
          <div className="pv-empty error-text" role="alert">
            {t.msg(error)}
          </div>
        )}
        <div className="pv-foot hints">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("common.hintMove")}
          </span>
          <span>
            <Kbd>Enter</Kbd>
            {t("facetPopover.hintToggle")}
          </span>
          <span className="r">
            <Kbd>Esc</Kbd>
          </span>
        </div>
      </PickList>
    </Popover>
  );
}

/** An article's groups as removable chips, and a dashed chip that opens the picker (also when `request` grows: the palette). */
export function GroupChips({
  groups,
  ids,
  onToggle,
  onCreate,
  request,
}: {
  groups: GroupRow[];
  /** The groups the article is in. */
  ids: number[];
  onToggle: (id: number, on: boolean) => void;
  onCreate: (name: string) => Promise<number>;
  request: number;
}) {
  const t = useT();
  const add = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Only a request made while mounted: the Reader remounts per article, and other tabs see it drop to 0.
  const seen = useRef(request);
  useEffect(() => {
    if (request > seen.current) {
      setAnchor(add.current);
    }
    seen.current = request;
  }, [request]);
  return (
    <>
      {groups
        .filter((g) => ids.includes(g.id))
        .map((g) => (
          <span key={g.id} className="chip">
            <Icon name="folder" size="sm" />
            {g.name}
            <button className="x" onClick={() => onToggle(g.id, false)} aria-label={t("reader.removeFromGroup", { name: g.name })}>
              <Icon name="x" size="sm" />
            </button>
          </span>
        ))}
      <button
        ref={add}
        className="chip dashed"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
      >
        {t("reader.addToGroup")}
      </button>
      {anchor && <GroupPicker groups={groups} selected={ids} onToggle={onToggle} onCreate={onCreate} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}
