import { useRef } from "react";
import { Kbd } from "../ui/Icon";
import { useCover } from "../ui/Popover";
import { useT } from "../i18n";

/** States board #8: an empty library. */
export function FirstRun({ onPaste, onFeeds, onImport, onMarkdown, onSettings }: {
  onPaste: () => void; onFeeds: () => void; onImport: () => void; onMarkdown: () => void; onSettings: () => void;
}) {
  const t = useT();
  return (
    <section className="first-run" aria-label={t("app.firstRun")}>
      <h1>{t("app.firstRun")}</h1>
      <div className="first-cards">
        <button className="btn" onClick={onPaste}><span className="h">{t("app.pasteUrl")}</span><span className="muted"><Kbd>Ctrl</Kbd><Kbd>K</Kbd>{t("app.pasteHint")}</span></button>
        <button className="btn" onClick={onFeeds}><span className="h">{t("common.addFeed")}</span><span className="muted">{t("app.feedHint")}</span></button>
        <button className="btn" onClick={onImport}><span className="h">{t("common.bulkImport")}</span><span className="muted">{t("app.bulkHint")}</span></button>
        <button className="btn" onClick={onMarkdown}><span className="h">{t("common.importMarkdown")}</span><span className="muted">{t("app.markdownHint")}</span></button>
      </div>
      <p className="muted">{t.rich("app.needsProvider", { link: <button className="linkish" onClick={onSettings}>{t("app.setUp")}</button> })}</p>
    </section>
  );
}

/** Shown while the pane prefix is armed. */
export function PrefixHint({ prefix }: { prefix: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useCover(ref, true);
  return (
    <div ref={ref} className="prefix-hint" role="status">
      <Kbd>{prefix}</Kbd>
      <span><Kbd>←</Kbd><Kbd>→</Kbd><Kbd>↑</Kbd><Kbd>↓</Kbd> <Kbd>h</Kbd><Kbd>j</Kbd><Kbd>k</Kbd><Kbd>l</Kbd>{t("app.prefixMove")}</span>
      <span><Kbd>o</Kbd>{t("app.prefixNext")}</span>
      <span><Kbd>%</Kbd>{t("app.prefixSplitRight")}</span>
      <span><Kbd>"</Kbd>{t("app.prefixSplitDown")}</span>
      <span><Kbd>x</Kbd>{t("app.prefixClose")}</span>
      <span><Kbd>c</Kbd><Kbd>n</Kbd><Kbd>p</Kbd>{t("app.prefixTabs")}</span>
      <span><Kbd>z</Kbd>{t("app.prefixFocus")}</span>
    </div>
  );
}
