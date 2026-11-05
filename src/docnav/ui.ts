// What the document keys draw over a document: labels, a box round the match, the find bar, the mode's
// name. Over a remote page, so: a closed shadow root keeps the page out, styles go through CSSOM because
// the page's CSP can block a style element, and all text goes in as text.

export interface View {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

type Css = Record<string, string>;

const FONT = 'system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif';
const PAPER = { color: "#45474C", background: "#fff", border: "1px solid #D2CFC6" };
const NIGHT = { color: "#C3C1BB", background: "#26272A", border: "1px solid #3B3C40" };

function make<K extends keyof HTMLElementTagNameMap>(tag: K, css: Css): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(css)) {
    el.style.setProperty(k, v);
  }
  return el;
}

const px = (n: number) => `${Math.round(n)}px`;

/** A strip along the bottom of `view`, with its theme. */
function strip(view: View, css: Css) {
  const theme = matchMedia("(prefers-color-scheme: dark)").matches ? NIGHT : PAPER;
  return make("div", {
    position: "fixed",
    left: px(view.left + 8),
    bottom: px(innerHeight - view.bottom + 8),
    padding: "3px 8px",
    "border-radius": "6px",
    "box-shadow": "0 8px 24px rgba(30,28,24,.18)",
    font: `12.5px/1.5 ${FONT}`,
    ...theme,
    ...css,
  });
}

export function createUi() {
  const host = document.createElement("div");
  host.dataset.latticeUi = "1";
  // Its keys are typed text: `inField` cannot see through a closed shadow root.
  host.dataset.latticeField = "1";
  for (const [k, v] of Object.entries({ all: "initial", display: "block", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none" })) {
    host.style.setProperty(k, v, "important");
  }
  const root = host.attachShadow({ mode: "closed" });
  const marks = make("div", {});
  let badge: HTMLElement | null = null;
  root.append(marks);
  document.documentElement.append(host);

  return {
    host,
    /** Labels at their targets' places. */
    labels(items: { label: string; rect: DOMRect }[]) {
      marks.replaceChildren(
        ...items.map(({ label, rect }) => {
          const el = make("div", {
            position: "fixed",
            left: px(Math.max(0, Math.min(rect.left, innerWidth - 24))),
            top: px(Math.max(0, rect.top)),
            padding: "0 3px",
            "border-radius": "3px",
            border: "1px solid #8A6D00",
            font: "700 11px/1.3 ui-monospace, Consolas, monospace",
            color: "#1C1C1E",
            background: "#FFE27A",
          });
          el.textContent = label;
          return el;
        }),
      );
    },
    /** A box over each of `rects`. */
    boxes(rects: DOMRect[]) {
      marks.replaceChildren(
        ...rects.map((r) =>
          make("div", {
            position: "fixed",
            left: px(r.left - 1),
            top: px(r.top - 1),
            width: px(r.width + 2),
            height: px(r.height + 2),
            background: "rgba(255, 186, 0, .45)",
            outline: "1px solid #B98500",
          }),
        ),
      );
    },
    /** The mode's name in the corner of `view`. */
    badge(text: string, view: View) {
      badge?.remove();
      badge = strip(view, { font: "700 11px/1.5 ui-monospace, Consolas, monospace" });
      badge.textContent = text;
      root.append(badge);
    },
    /** The find bar, with its input and its count for the caller to use. */
    bar(label: string, view: View) {
      const bar = strip(view, { display: "flex", gap: "6px", "align-items": "center", "pointer-events": "auto" });
      const slash = make("span", {});
      slash.textContent = "/";
      const input = make("input", {
        width: "220px",
        padding: "0",
        border: "0",
        outline: "none",
        font: "inherit",
        color: "inherit",
        background: "transparent",
      });
      input.ariaLabel = label;
      const count = make("span", { "font-variant-numeric": "tabular-nums", opacity: ".75" });
      bar.append(slash, input, count);
      root.append(bar);
      return { input, count };
    },
    remove: () => host.remove(),
  };
}

export type DocUi = ReturnType<typeof createUi>;
