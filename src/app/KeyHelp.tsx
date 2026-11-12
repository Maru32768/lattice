import { useEffect, useRef } from "react";
import { Kbd } from "../ui/Icon";
import { coverStyle, useCover } from "../ui/Popover";
import { useT } from "../i18n";
import { useBindings } from "../lib/keys";
import { ACTION_GROUPS, actionLabel, keyLabel, keyOf } from "../lib/keymap";
import { scrollDoc, type DocScroll } from "../docnav/scroll";

const SCROLLS: DocScroll[] = ["scrollDown", "scrollUp", "halfDown", "halfUp", "pageDown", "pageUp", "docTop", "docBottom"];

/** Every binding, by what it is for, as Settings › Shortcuts has them. */
export function KeyHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  const bindings = useBindings();
  const scrim = useRef<HTMLDivElement>(null);
  const clear = useCover(scrim, true);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    body.current?.focus();
    return () => prev?.focus?.();
  }, []);

  function keys(e: React.KeyboardEvent) {
    const k = keyOf(e.nativeEvent);
    if (k === "Escape" || (k && bindings.keyHelp.includes(k))) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // The document's scroll keys, one key each: a chord such as gg would need the key machine for one dialog.
    const move = k ? SCROLLS.find((id) => bindings[id].includes(k)) : undefined;
    if (move && body.current) {
      e.preventDefault();
      e.stopPropagation();
      scrollDoc(body.current, move, 1);
    }
  }

  return (
    <div
      ref={scrim}
      className="pal-scrim"
      style={coverStyle(clear)}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="pal key-help" role="dialog" aria-modal="true" aria-label={t("keys.keyHelp")} tabIndex={-1} onKeyDown={keys}>
        <h2>{t("keys.keyHelp")}</h2>
        <div className="pal-list" ref={body} tabIndex={-1}>
          {ACTION_GROUPS.map((g) => ({ ...g, actions: g.actions.filter((a) => bindings[a.id].length > 0) }))
            .filter((g) => g.actions.length > 0)
            .map((g) => (
              <section key={g.id}>
                <h3 className="gh">{t(g.title)}</h3>
                {g.actions.map((a) => (
                  <div className="it" key={a.id}>
                    <span className="it-l">{actionLabel(t, a.id)}</span>
                    {a.scope && <span className="s">{t(`keys.scope.${a.scope}`)}</span>}
                    <span className="r">
                      {bindings[a.id].map((k) => (
                        <Kbd key={k}>{keyLabel(k)}</Kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
