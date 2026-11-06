import { Fragment, useEffect, useEffectEvent, useState } from "react";
import { isCustom, resetKeys, setKeys, useBindings } from "../lib/keys";
import { ACTIONS, ACTION_GROUPS, actionLabel, chordFrom, conflicts, keyLabel, keyOf, scopesOverlap, type ActionId } from "../lib/keymap";
import { useT } from "../i18n";
import { SetRow, Switch } from "../ui/SetRow";
import { readUtf8 } from "../lib/files";
import { setVimEnabled, setVimrc, useVimEnabled, useVimrc } from "../vim/vim";
import { KNOWN, parseVimrc } from "../vim/vimrc";

const VIMRC_MAX_MB = 1;

/** Vim in the text fields: on or off, and the vimrc with what it could not use. */
function VimSettings() {
  const t = useT();
  const on = useVimEnabled();
  const vimrc = useVimrc();
  // Half-typed lines stay here: `unmap <leader>x` passes through `unmap <`, and what an editor gives up stays gone until the app restarts.
  // shortcut: a window closed by a key while this field has the keyboard loses what it holds, upgrade if vimrcs get edited here at length.
  const [draft, setDraft] = useState(vimrc);
  const [stored, setStored] = useState(vimrc);
  if (stored !== vimrc) {
    setStored(vimrc);
    setDraft(vimrc);
  }
  const apply = () => {
    if (draft !== vimrc) {
      setVimrc(draft);
    }
  };
  const applyOnLeave = useEffectEvent(apply);
  useEffect(() => () => applyOnLeave(), []);
  const [error, setError] = useState<string | null>(null);
  const entries = parseVimrc(draft, KNOWN);
  const skipped = entries.flatMap((e) => (e.kind === "skip" ? [e] : []));

  async function load(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > VIMRC_MAX_MB * 1024 * 1024) {
      return setError(t("be.file.tooLarge", { max: VIMRC_MAX_MB }));
    }
    const text = await readUtf8(file);
    setError(text === null ? t("be.file.notUtf8") : null);
    if (text !== null) {
      setVimrc(text);
    }
  }

  return (
    <>
      <h2>{t("shortcutSettings.vimGroup")}</h2>
      <div className="grp">
        <SetRow title={t("shortcutSettings.vim")} htmlFor="vim-on" desc={t("shortcutSettings.vimDesc")}>
          <Switch id="vim-on" checked={on} onChange={setVimEnabled} />
        </SetRow>
        <div className="set wide">
          <label className="h" htmlFor="vim-rc">
            {t("shortcutSettings.vimrc")}
          </label>
          <div className="d">{t("shortcutSettings.vimrcDesc")}</div>
          <textarea
            id="vim-rc"
            className="mono"
            value={draft}
            rows={8}
            spellCheck={false}
            wrap="off"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
          />
          <div className="acts">
            <label className="btn sm">
              {t("shortcutSettings.vimrcLoad")}
              <input
                type="file"
                className="vh"
                onChange={(e) => {
                  load(e.target.files?.[0]).catch((err: unknown) => setError(String(err)));
                  e.target.value = "";
                }}
              />
            </label>
            {draft.trim() && <span className="muted">{t("shortcutSettings.vimrcApplied", { n: entries.length - skipped.length })}</span>}
            {error && (
              <span className="error-text" role="alert">
                {error}
              </span>
            )}
          </div>
          {skipped.length > 0 && (
            <details open>
              <summary>{t("shortcutSettings.vimrcSkipped", { n: skipped.length })}</summary>
              <ul className="vimrc-skips">
                {skipped.map((e, i) => (
                  <li key={i}>
                    <span className="muted">{t("shortcutSettings.vimrcLine", { line: e.line })}</span> <code>{e.text}</code>{" "}
                    <span className="muted">{t(`shortcutSettings.vimrcReason.${e.reason}`)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </>
  );
}

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
      <VimSettings />
      <div className="btn-row">
        <button className="btn" onClick={() => resetKeys()} disabled={!ACTIONS.some((a) => isCustom(a.id, bindings))}>
          {t("shortcutSettings.resetAll")}
        </button>
        <span className="muted">{t("shortcutSettings.hint")}</span>
      </div>
      {ACTION_GROUPS.map((g) => (
        <Fragment key={g.title}>
          <h2>{t(g.title)}</h2>
          <div className="grp">
            {g.actions.map((a) => {
              const keys = bindings[a.id];
              const mine = recording?.id === a.id ? recording : null;
              const shared = keys.flatMap((k) =>
                (clash.get(k) ?? [])
                  .filter((o) => o !== a && scopesOverlap(o, a))
                  .map((o) => t("shortcutSettings.clash", { keyLabel: keyLabel(k), labelOf: actionLabel(t, o.id) })),
              );
              const shadowed = keys.flatMap((k) => {
                const by = chordFrom(bindings, k, a.scope);
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
                      <span key={k} className={`kbd key${clash.has(k) || chordFrom(bindings, k, a.scope) ? " clash" : ""}`}>
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
        </Fragment>
      ))}
    </>
  );
}
