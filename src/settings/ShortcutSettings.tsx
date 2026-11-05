import { useState } from "react";
import { ACTIONS, actionLabel, chordFrom, conflicts, isCustom, keyLabel, resetKeys, setKeys, useBindings, type ActionId } from "../lib/keys";
import { keyOf } from "../lib/keyname";
import { useT } from "../i18n";

/** Settings › ショートカット: every shell action with its keys; add (record), remove, reset. */
export function ShortcutSettings() {
  const t = useT();
  const bindings = useBindings();
  /** `first`: the key pressed so far. The next key makes it a two-key binding; Enter keeps it alone. */
  const [recording, setRecording] = useState<{ id: ActionId; first?: string } | null>(null);
  const clash = conflicts(bindings);

  function record({ id, first }: { id: ActionId; first?: string }, e: React.KeyboardEvent) {
    if (e.key === "Tab") {
      return;
    } // leaves the button, which cancels
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      return setRecording(null);
    }
    const k = keyOf(e.nativeEvent);
    if (!k) {
      return;
    } // a modifier alone: wait for the key it modifies
    if (!first) {
      return setRecording({ id, first: k });
    }
    const key = k === "Enter" ? first : `${first} ${k}`;
    if (!bindings[id].includes(key)) {
      setKeys(id, [...bindings[id], key]);
    }
    setRecording(null);
  }

  return (
    <>
      <div className="btn-row">
        <button className="btn" onClick={() => resetKeys()} disabled={!ACTIONS.some((a) => isCustom(a.id, bindings))}>
          {t("shortcutSettings.resetAll")}
        </button>
        <span className="muted">{t("shortcutSettings.hint")}</span>
      </div>
      <div className="grp">
        {ACTIONS.map((a) => {
          const keys = bindings[a.id];
          const mine = recording?.id === a.id ? recording : null;
          const shared = keys.flatMap((k) =>
            (clash.get(k) ?? []).filter((id) => id !== a.id).map((id) => t("shortcutSettings.clash", { keyLabel: keyLabel(k), labelOf: actionLabel(t, id) })),
          );
          const shadowed = keys.flatMap((k) => {
            const by = chordFrom(bindings, k);
            return by ? [t("shortcutSettings.shadowed", { keyLabel: keyLabel(k), labelOf: actionLabel(t, by.id) })] : [];
          });
          return (
            <div className="set" key={a.id}>
              <span className="h">{actionLabel(t, a.id)}</span>
              {shared.length + shadowed.length > 0 && (
                <span className="d warn-text" role="note">
                  {[...shared, ...shadowed].join(t("shortcutSettings.clashSeparator"))}
                </span>
              )}
              <span className="ctl keys-ctl">
                {keys.length === 0 && <span className="muted">{t("common.none")}</span>}
                {keys.map((k) => (
                  <span key={k} className={`kbd key${clash.has(k) || chordFrom(bindings, k) ? " clash" : ""}`}>
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
                <button className="btn sm ghost" onClick={() => resetKeys(a.id)} disabled={!isCustom(a.id, bindings)}>
                  {t("shortcutSettings.reset")}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
