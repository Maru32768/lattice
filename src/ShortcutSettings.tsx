import { useState } from "react";
import { ACTIONS, conflicts, isCustom, keyLabel, keyOf, resetKeys, setKeys, useBindings, type ActionId } from "./keys";

/** Settings › ショートカット: every shell action with its keys; add (record), remove, reset. */
export function ShortcutSettings() {
  const bindings = useBindings();
  const [recording, setRecording] = useState<ActionId | null>(null);
  const clash = conflicts(bindings);
  const labelOf = (id: ActionId) => ACTIONS.find((a) => a.id === id)!.label;

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
        <button className="btn" onClick={() => resetKeys()} disabled={!ACTIONS.some((a) => isCustom(a.id))}>すべて既定に戻す</button>
        <span className="muted">1 つの操作に複数のキーを割り当てられます。同じキーが複数の操作にあるときは上の操作が優先されます。</span>
      </div>
      <div className="grp">
        {ACTIONS.map((a) => {
          const keys = bindings[a.id];
          const shared = keys.flatMap((k) => (clash.get(k) ?? []).filter((id) => id !== a.id).map((id) => `${keyLabel(k)} は「${labelOf(id)}」にも割り当てられています`));
          return (
            <div className="set" key={a.id}>
              <span className="h">{a.label}</span>
              {shared.length > 0 && <span className="d warn-text" role="note">{shared.join("。")}</span>}
              <span className="ctl keys-ctl">
                {keys.length === 0 && <span className="muted">なし</span>}
                {keys.map((k) => (
                  <span key={k} className={`kbd key${clash.has(k) ? " clash" : ""}`}>
                    {keyLabel(k)}
                    <button className="x" onClick={() => setKeys(a.id, keys.filter((x) => x !== k))} aria-label={`${a.label}から ${keyLabel(k)} を外す`}>×</button>
                  </span>
                ))}
                <button className={`btn sm ghost${recording === a.id ? " rec" : ""}`} aria-pressed={recording === a.id}
                  onClick={() => setRecording((r) => (r === a.id ? null : a.id))} onKeyDown={recording === a.id ? (e) => record(a.id, e) : undefined}
                  onBlur={() => setRecording((r) => (r === a.id ? null : r))}>
                  {recording === a.id ? "キーを押してください（Esc で取消）" : "+ キーを追加"}
                </button>
                <button className="btn sm ghost" onClick={() => resetKeys(a.id)} disabled={!isCustom(a.id)}>既定に戻す</button>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
