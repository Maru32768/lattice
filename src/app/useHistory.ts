import { useEffect, useEffectEvent, useState } from "react";
import { NO_HISTORY, arrived, canGo, go, placeKey, visit, type Place } from "./history";

/**
 * In-app history (H4): every new `place` is a visit; back / forward hand a visited one to `restore`.
 * Off (`enabled` false) where there is nothing to go back to.
 */
export function useHistory(place: Place, restore: (p: Place) => void, enabled: boolean) {
  const [hist, setHist] = useState(NO_HISTORY);
  /** Set by a back / forward step: the place it lands on replaces that entry rather than cutting the ones ahead. */
  const [stepping, setStepping] = useState(false);
  const here = placeKey(place);
  const [seen, setSeen] = useState<string | null>(null);
  if (enabled && seen !== here) {
    setSeen(here);
    setHist((h) => (stepping ? arrived(h, place) : visit(h, place)));
    setStepping(false);
  }

  function step(d: 1 | -1) {
    const next = go(hist, d);
    if (!next) return;
    const p = next.stack[next.at];
    setHist(next);
    if (placeKey(p) === here) return;
    setStepping(true);
    restore(p);
  }

  // The mouse's side buttons (XButton1 / XButton2). Over a page they never reach here: the page's
  // webview takes them for its own history.
  const onSide = useEffectEvent(step);
  useEffect(() => {
    if (!enabled) return;
    const side = (e: MouseEvent) => e.button === 3 || e.button === 4;
    const down = (e: MouseEvent) => {
      if (side(e)) e.preventDefault();
    };
    const up = (e: MouseEvent) => {
      if (!side(e)) return;
      e.preventDefault();
      onSide(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
    };
  }, [enabled]);

  return { back: canGo(hist, -1), forward: canGo(hist, 1), step };
}
