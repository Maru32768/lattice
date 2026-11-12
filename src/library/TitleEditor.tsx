import { useState } from "react";
import type { ArticleRow } from "../api";
import { Popover } from "../ui/Popover";
import { useT } from "../i18n";

/** The user's name for an article, from its menu. A blank name, or 元に戻す, goes back to the title the app found. */
export function TitleEditor({
  article,
  anchor,
  onSave,
  onClose,
}: {
  article: ArticleRow;
  anchor: HTMLElement;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(article.title ?? "");
  const save = (to: string) => {
    if (to.trim() !== (article.title ?? "")) {
      onSave(to);
    }
    onClose();
  };
  return (
    <Popover anchor={anchor} label={t("titleEditor.label")} width={440} onClose={onClose}>
      <div className="facet-pv">
        <div className="pv-head">
          <label className="pv-search">
            <span className="vh">{t("titleEditor.label")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={article.auto_title ?? article.original_url}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  save(title);
                }
              }}
            />
          </label>
          {article.auto_title != null && <p className="title-found">{t("titleEditor.found", { title: article.auto_title })}</p>}
        </div>
        <div className="pv-foot title-acts">
          {article.auto_title != null && (
            <button className="btn sm" onClick={() => save("")}>
              {t("titleEditor.reset")}
            </button>
          )}
          <button className="btn sm r" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn sm pri" onClick={() => save(title)}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </Popover>
  );
}
