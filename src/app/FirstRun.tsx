import { useRef } from "react";
import { Kbd } from "../ui/Icon";
import { useCover } from "../ui/Popover";
import { useT } from "../i18n";
import { useBindings } from "../lib/keys";
import { actionLabel, afterFirst, keyLabel } from "../lib/keymap";

/** States board #8: an empty library. */
export function FirstRun({
  onPaste,
  onFeeds,
  onImport,
  onMarkdown,
  onSettings,
}: {
  onPaste: () => void;
  onFeeds: () => void;
  onImport: () => void;
  onMarkdown: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  return (
    <section className="first-run" aria-label={t("app.firstRun")}>
      <h1>{t("app.firstRun")}</h1>
      <div className="first-cards">
        <button className="btn" onClick={onPaste}>
          <span className="h">{t("app.pasteUrl")}</span>
          <span className="muted">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
            {t("app.pasteHint")}
          </span>
        </button>
        <button className="btn" onClick={onFeeds}>
          <span className="h">{t("common.addFeed")}</span>
          <span className="muted">{t("app.feedHint")}</span>
        </button>
        <button className="btn" onClick={onImport}>
          <span className="h">{t("common.bulkImport")}</span>
          <span className="muted">{t("app.bulkHint")}</span>
        </button>
        <button className="btn" onClick={onMarkdown}>
          <span className="h">{t("common.importMarkdown")}</span>
          <span className="muted">{t("app.markdownHint")}</span>
        </button>
      </div>
      <p className="muted">{t("app.localFeatures")}</p>
      <p className="muted">
        {t.rich("app.needsProvider", {
          link: (
            <button className="linkish" onClick={onSettings}>
              {t("app.setUp")}
            </button>
          ),
        })}
      </p>
      <p className="muted">{t("app.aiPrivacy")}</p>
    </section>
  );
}

/** Shown after the first key of a two-key binding: what can follow it. */
export function PrefixHint({ first }: { first: string }) {
  const t = useT();
  const bindings = useBindings();
  const ref = useRef<HTMLDivElement>(null);
  useCover(ref, true);
  return (
    <div ref={ref} className="prefix-hint" role="status">
      <Kbd>{keyLabel(first)}</Kbd>
      {afterFirst(bindings, first).map(([id, seconds]) => (
        <span key={id}>
          {seconds.map((k) => (
            <Kbd key={k}>{keyLabel(k)}</Kbd>
          ))}{" "}
          {actionLabel(t, id)}
        </span>
      ))}
    </div>
  );
}
