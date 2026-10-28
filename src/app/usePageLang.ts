import { useEffect, useEffectEvent, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { browser } from "../api";
import { overlayLabels, overlayOf, type PageLang } from "../browser/BrowserView";
import type { T } from "../i18n";
import { HOST } from "./host";
import { pageLangOnStart, toMain } from "./windows";

/**
 * The Page language: one choice for every window's pages (the overlay config is shared). A change
 * is announced to the others, and main sends it on to every page's overlay, its tooltips in the display language.
 */
export function usePageLang(t: T, fail: (e: unknown) => void): [PageLang, (l: PageLang) => void] {
  const [pageLang, setPageLangState] = useState<PageLang>({ mode: "original", percent: 70 });
  const setPageLang = (l: PageLang) => {
    setPageLangState(l);
    void emit("page-lang", l);
  };
  const onError = useEffectEvent(fail);
  // Keyed on the overlay's values, not the object: this window hears its own "page-lang" broadcast back as a new, equal object.
  const { enabled, percent } = overlayOf(pageLang);
  useEffect(() => {
    if (pageLangOnStart(HOST) !== "send") {
      return;
    }
    browser.setTranslation(enabled, percent, overlayLabels(t)).catch(onError);
  }, [enabled, percent, t]);
  useEffect(() => {
    const sub = listen<PageLang>("page-lang", (e) => setPageLangState(e.payload));
    if (pageLangOnStart(HOST) === "ask") {
      void toMain({ kind: "pageLang" });
    }
    return () => void sub.then((f) => f());
  }, []);
  return [pageLang, setPageLang];
}
