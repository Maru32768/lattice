import { useRef, useState } from "react";
import { isCustom, resetKeys, setKeys, useBindings } from "../lib/keys";
import {
  ACTIONS,
  ACTION_GROUPS,
  KEY_GROUPS,
  actionLabel,
  chordFrom,
  conflicts,
  keyLabel,
  keyOf,
  scopesOverlap,
  type ActionDef,
  type ActionId,
  type KeyGroup,
} from "../lib/keymap";
import { useT } from "../i18n";

/**
 * A key pressed in for a binding, `first` being the key pressed so far: the binding's first key, the whole of it (the next key,
 * or Enter to keep `first` alone), or Esc. Null: none of these, and Tab or Shift+Tab moves the focus on; Ctrl+Tab is a key like any other.
 */
function pressed(first: string | undefined, e: React.KeyboardEvent): { first: string } | { key: string } | "cancel" | null {
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return null;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    return "cancel";
  }
  const k = keyOf(e.nativeEvent);
  if (!k) {
    // A modifier alone: wait for the key it modifies.
    return null;
  }
  return first ? { key: k === "Enter" ? first : `${first} ${k}` } : { first: k };
}

/** Settings › ショートカット: the actions by what they are for, a tab each, with their keys (add by recording, remove, reset), and a search across the tabs by name or by the key itself. */
export function ShortcutSettings() {
  const t = useT();
  const bindings = useBindings();
  /** `first`: the key pressed so far. The next key makes it a two-key binding; Enter keeps it alone. */
  const [recording, setRecording] = useState<{ id: ActionId; first?: string } | null>(null);
  const [tab, setTab] = useState<KeyGroup>("app");
  const [text, setText] = useState("");
  /** Finding by the key pressed: null while finding by text. `first` may still get a second key; `key` is whole. */
  const [byKey, setByKey] = useState<{ first?: string; key?: string } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const clash = conflicts(bindings);

  /** What the row says of its key `k`: another action that runs at the same place has it too, or it starts a two-key binding and so does nothing alone. */
  function notesOf(a: ActionDef, k: string) {
    const shared = (clash.get(k) ?? [])
      .filter((o) => o !== a && scopesOverlap(o, a))
      .map((o) => t("shortcutSettings.clash", { keyLabel: keyLabel(k), labelOf: actionLabel(t, o.id) }));
    const by = chordFrom(bindings, k, a.scope);
    return by ? [...shared, t("shortcutSettings.shadowed", { keyLabel: keyLabel(k), labelOf: actionLabel(t, by.id) })] : shared;
  }

  function record({ id, first }: { id: ActionId; first?: string }, e: React.KeyboardEvent) {
    const p = pressed(first, e);
    if (p === "cancel") {
      setRecording(null);
    } else if (p && "first" in p) {
      setRecording({ id, first: p.first });
    } else if (p) {
      if (!bindings[id].includes(p.key)) {
        setKeys(id, [...bindings[id], p.key]);
      }
      setRecording(null);
    }
  }

  /** Esc clears the key found, and with none it goes back to finding by text. */
  function findKey(e: React.KeyboardEvent) {
    const p = pressed(byKey?.first, e);
    if (p === "cancel") {
      setByKey(byKey?.first || byKey?.key ? {} : null);
    } else if (p) {
      setByKey(p);
    }
  }

  function onTabKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = KEY_GROUPS.indexOf(tab);
    const to = ({ ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: KEY_GROUPS.length - 1 } as Partial<Record<string, number>>)[keyOf(e.nativeEvent) ?? ""];
    if (to === undefined) {
      return;
    }
    e.preventDefault();
    const n = (to + KEY_GROUPS.length) % KEY_GROUPS.length;
    setTab(KEY_GROUPS[n]!);
    (e.currentTarget.children[n] as HTMLElement).focus();
  }

  const query = text.trim().toLowerCase();
  const [keyFirst, keyWhole] = [byKey?.first, byKey?.key];
  const matches = (a: ActionDef) => {
    const keys = bindings[a.id];
    if (keyWhole) {
      return keys.includes(keyWhole);
    }
    if (keyFirst) {
      return keys.some((k) => k === keyFirst || k.startsWith(`${keyFirst} `));
    }
    return [actionLabel(t, a.id), ...keys, ...keys.map(keyLabel)].some((s) => s.toLowerCase().includes(query));
  };
  const found = (byKey ? keyFirst || keyWhole : query)
    ? ACTION_GROUPS.map((g) => ({ ...g, actions: g.actions.filter(matches) })).filter((g) => g.actions.length)
    : null;

  const row = (a: ActionDef) => {
    const keys = bindings[a.id];
    const mine = recording?.id === a.id ? recording : null;
    const notes = keys.flatMap((k) => notesOf(a, k));
    return (
      <div className="set" key={a.id}>
        <span className="h">
          <span>{actionLabel(t, a.id)}</span>
          {a.scope && <span className="scope">{t(`keys.scope.${a.scope}`)}</span>}
        </span>
        {notes.length > 0 && (
          <span className="d warn-text" role="note">
            {notes.join(t("shortcutSettings.clashSeparator"))}
          </span>
        )}
        <span className="ctl keys-ctl">
          {keys.length === 0 && <span className="muted">{t("common.none")}</span>}
          {keys.map((k) => (
            <span key={k} className={`kbd key${notesOf(a, k).length ? " clash" : ""}`}>
              {keyLabel(k)}
              <button
                className="x"
                onClick={() =>
                  setKeys(
                    a.id,
                    keys.filter((x) => x !== k),
                  )
                }
                aria-label={t("shortcutSettings.removeKey", { label: actionLabel(t, a.id), keyLabel: keyLabel(k) })}
              >
                ×
              </button>
            </span>
          ))}
          <button
            className={`btn sm ghost${mine ? " rec" : ""}`}
            aria-pressed={!!mine}
            onClick={() => setRecording(mine ? null : { id: a.id })}
            onKeyDown={mine ? (e) => record(mine, e) : undefined}
            onBlur={() => setRecording((r) => (r?.id === a.id ? null : r))}
          >
            {mine?.first
              ? t("shortcutSettings.pressNextKey", { first: keyLabel(mine.first) })
              : mine
                ? t("shortcutSettings.pressKey")
                : t("shortcutSettings.addKey")}
          </button>
          <button className="btn sm ghost reset" onClick={() => resetKeys(a.id)} disabled={!isCustom(a.id, bindings)}>
            {t("shortcutSettings.reset")}
          </button>
        </span>
      </div>
    );
  };

  return (
    <>
      <div className="btn-row">
        <button className="btn" onClick={() => resetKeys()} disabled={!ACTIONS.some((a) => isCustom(a.id, bindings))}>
          {t("shortcutSettings.resetAll")}
        </button>
        <span className="muted">{t("shortcutSettings.hint")}</span>
      </div>
      <div className="keys">
        <div className="keys-find">
          <input
            ref={field}
            className="input"
            value={byKey ? (keyFirst ? t("shortcutSettings.pressNextKey", { first: keyLabel(keyFirst) }) : keyWhole ? keyLabel(keyWhole) : "") : text}
            readOnly={!!byKey}
            placeholder={t(byKey ? "shortcutSettings.byKeyPrompt" : "shortcutSettings.find")}
            aria-label={t(byKey ? "shortcutSettings.byKey" : "shortcutSettings.find")}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={
              byKey
                ? findKey
                : (e) => {
                    // The first Esc empties the field, the next leaves it.
                    if (e.key === "Escape" && text) {
                      e.preventDefault();
                      setText("");
                    }
                  }
            }
          />
          <button
            className={`btn sm${byKey ? " rec" : ""}`}
            aria-pressed={!!byKey}
            onClick={() => {
              setByKey(byKey ? null : {});
              field.current?.focus();
            }}
          >
            {t("shortcutSettings.byKey")}
          </button>
        </div>
        {found ? (
          found.length ? (
            found.map((g) => (
              <section key={g.id} aria-labelledby={`keys-found-${g.id}`}>
                <h2 id={`keys-found-${g.id}`}>{t(g.title)}</h2>
                <div className="grp">{g.actions.map(row)}</div>
              </section>
            ))
          ) : (
            <p className="muted" role="status">
              {byKey ? t("shortcutSettings.noKeyMatch", { keyLabel: keyLabel(keyWhole ?? keyFirst ?? "") }) : t("shortcutSettings.noMatch")}
            </p>
          )
        ) : (
          <>
            <div className="seg keys-tabs" role="tablist" aria-label={t("shortcutSettings.groups")} onKeyDown={onTabKey}>
              {ACTION_GROUPS.map((g) => (
                <button
                  key={g.id}
                  id={`keys-tab-${g.id}`}
                  role="tab"
                  className={g.id === tab ? "on" : ""}
                  aria-selected={g.id === tab}
                  aria-controls={g.id === tab ? "keys-panel" : undefined}
                  tabIndex={g.id === tab ? 0 : -1}
                  onClick={() => setTab(g.id)}
                >
                  {t(g.title)} <span className="n">{g.actions.length}</span>
                  {g.actions.some((a) => isCustom(a.id, bindings)) && (
                    <span className="mark" title={t("shortcutSettings.tabChanged")}>
                      <span className="vh"> {t("shortcutSettings.tabChanged")}</span>
                    </span>
                  )}
                  {g.actions.some((a) => bindings[a.id].some((k) => notesOf(a, k).length > 0)) && (
                    <span className="mark warn" title={t("shortcutSettings.tabClash")}>
                      <span aria-hidden="true">!</span>
                      <span className="vh"> {t("shortcutSettings.tabClash")}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="grp" role="tabpanel" id="keys-panel" aria-labelledby={`keys-tab-${tab}`}>
              {ACTION_GROUPS.find((g) => g.id === tab)?.actions.map(row)}
            </div>
          </>
        )}
      </div>
    </>
  );
}
