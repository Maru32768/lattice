import { useEffect, useEffectEvent, useState } from "react";
import { useT } from "../i18n";
import { SetRow, Switch } from "../ui/SetRow";
import { readUtf8 } from "../lib/files";
import { setVimEnabled, setVimrc, useVimEnabled, useVimrc } from "../vim/vim";
import { KNOWN, parseVimrc } from "../vim/vimrc";

const VIMRC_MAX_MB = 1;

/** Settings › Vim: Vim in the text fields, on or off, and the vimrc with what it could not use. */
export function VimSettings() {
  const t = useT();
  const on = useVimEnabled();
  const vimrc = useVimrc();
  // Half-typed lines stay here while it is typed in: `unmap <leader>x` passes through `unmap <`, and what an editor gives up stays gone until the app restarts.
  // Leaving the field applies it, also by leaving the window: losing the text would be worse than a key gone until a restart.
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
    <div className="grp">
      <SetRow title={t("shortcutSettings.vim")} htmlFor="vim-on" desc={t("shortcutSettings.vimDesc")}>
        <Switch id="vim-on" checked={on} onChange={setVimEnabled} />
      </SetRow>
      <div className="set wide">
        <label className="h" htmlFor="vim-rc">
          {t("shortcutSettings.vimrc")}
        </label>
        <div className="d">{t("shortcutSettings.vimrcDesc")}</div>
        <textarea id="vim-rc" className="mono" value={draft} rows={8} spellCheck={false} wrap="off" onChange={(e) => setDraft(e.target.value)} onBlur={apply} />
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
  );
}
