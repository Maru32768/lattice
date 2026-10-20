import { useState } from "react";
import { ACTIONS, actionLabel, conflicts, isCustom, keyLabel, resetKeys, setKeys, useBindings, type ActionId } from "./keys";
import { keyOf } from "./keyname";
import { useT } from "./i18n";

/** Settings › ショートカット: every shell action with its keys; add (record), remove, reset. */
export function ShortcutSettings() {
  const t = useT();
  const bindings = useBindings();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const clash = conflicts(bindings);
  
  function record(id: ActionId, e: React.KeyboardEvent) {
    if (e.key === "Tab") return; // leaves the button, which cancels
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(null);
    const k = keyOf(e.nativeEvent);
    if (!k) return; // a modifier alone: wait for the key it modifies
    if (!bindings[id].includes(k)) setKeys(id, [...bindings[id], k]);
    setRecording(null);
  }

  return (
    <>
      <div className="btn-row">
        <button className="btn" onClick={() => resetKeys()} disabled={!ACTIONS.some((a) => isCustom(a.id))}>{t("shortcutSettings.resetAll")}</button>
        <span className="muted">{t("shortcutSettings.hint")}</span>
      </div>
      <div className="grp">
        {ACTIONS.map((a) => {
          const keys = bindings[a.id];
          const shared = keys.flatMap((k) => (clash.get(k) ?? []).filter((id) => id !== a.id).map((id) => t("shortcutSettings.clash", { keyLabel: keyLabel(k), labelOf: actionLabel(t, id) })));
          return (
            <div className="set" key={a.id}>
              <span className="h">{actionLabel(t, a.id)}</span>
              {shared.length > 0 && <span className="d warn-text" role="note">{shared.join(t("shortcutSettings.clashSeparator"))}</span>}
              <span className="ctl keys-ctl">
                {keys.length === 0 && <span className="muted">{t("common.none")}</span>}
                {keys.map((k) => (
                  <span key={k} className={`kbd key${clash.has(k) ? " clash" : ""}`}>
                    {keyLabel(k)}
                    <button className="x" onClick={() => setKeys(a.id, keys.filter((x) => x !== k))} aria-label={t("shortcutSettings.removeKey", { label: actionLabel(t, a.id), keyLabel: keyLabel(k) })}>×</button>
                  </span>
                ))}
                <button className={`btn sm ghost${recording === a.id ? " rec" : ""}`} aria-pressed={recording === a.id}
                  onClick={() => setRecording((r) => (r === a.id ? null : a.id))} onKeyDown={recording === a.id ? (e) => record(a.id, e) : undefined}
                  onBlur={() => setRecording((r) => (r === a.id ? null : r))}>
                  {recording === a.id ? t("shortcutSettings.pressKey") : t("shortcutSettings.addKey")}
                </button>
                <button className="btn sm ghost" onClick={() => resetKeys(a.id)} disabled={!isCustom(a.id)}>{t("shortcutSettings.reset")}</button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
