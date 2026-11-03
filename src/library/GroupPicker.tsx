import { useEffect, useRef, useState } from "react";
import type { GroupRow } from "../api";
import { Popover } from "../ui/Popover";
import { Icon, Kbd, type IconName } from "../ui/Icon";
import { listStep } from "../lib/keys";
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

function Picker<K extends number | string>({
  options: groups,
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
  const [act, setAct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const name = q.trim();
  const shown = groups.filter((g) => g.name.toLowerCase().includes(name.toLowerCase()));
  const canCreate = name !== "" && !groups.some((g) => g.name.toLowerCase() === name.toLowerCase());
  const count = shown.length + (canCreate ? 1 : 0);
  const at = Math.min(act, count - 1);

  async function create() {
    setError(null);
    try {
      onToggle(await onCreate(name), true);
      setQ("");
      setAct(0);
    } catch (e) {
      setError(String(e));
    }
  }

  const pick = (i: number) => {
    const g = shown[i];
    if (g) {
      onToggle(g.id, !selected.includes(g.id));
    } else if (canCreate) {
      void create();
    }
  };

  function keys(e: React.KeyboardEvent) {
    const d = listStep(e, true);
    if (d) {
      e.preventDefault();
      setAct(Math.max(0, Math.min(count - 1, at + d)));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (at >= 0) {
        pick(at);
      }
    }
  }

  return (
    <Popover anchor={anchor} label={text.label} width={300} onClose={onClose}>
      <div className="facet-pv" onKeyDown={keys}>
        <div className="pv-head">
          <label className="pv-search">
            <Icon name={icon} />
            <span className="vh">{text.find}</span>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setAct(0);
                setError(null);
              }}
              placeholder={text.find}
            />
          </label>
        </div>
        <div className="pv-list" role="group" aria-label={text.label}>
          {shown.map((g, i) => {
            const on = selected.includes(g.id);
            return (
              <button key={g.id} className={`opt${i === at ? " act" : ""}`} aria-pressed={on} onClick={() => pick(i)} onMouseMove={() => setAct(i)}>
                <span className={`cb${on ? " on" : ""}`} aria-hidden="true">
                  {on && "✓"}
                </span>
                <span className="opt-l">{g.name}</span>
                <span className="c">{g.count}</span>
              </button>
            );
          })}
          {canCreate && (
            <button className={`opt${at === shown.length ? " act" : ""}`} onClick={() => pick(shown.length)} onMouseMove={() => setAct(shown.length)}>
              <Icon name="plus" size="sm" />
              <span className="opt-l">{text.create(name)}</span>
            </button>
          )}
          {count === 0 && <div className="pv-empty">{text.none}</div>}
          {error && (
            <div className="pv-empty error-text" role="alert">
              {t.msg(error)}
            </div>
          )}
        </div>
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
      </div>
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
