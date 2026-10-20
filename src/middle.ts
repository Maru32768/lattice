/**
 * Props that run `f` on a middle click (open in a new tab, close a tab). Chromium on Windows starts
 * autoscroll on a middle press over anything scrollable and then fires no mousedown, mouseup or
 * auxclick, so this listens to the pointer events and cancels the press, which also stops the autoscroll.
 */
export const onMiddle = (f: () => void) => ({
  onPointerDown: (e: React.PointerEvent) => { if (e.button === 1) e.preventDefault(); },
  onPointerUp: (e: React.PointerEvent) => { if (e.button === 1) f(); },
});
