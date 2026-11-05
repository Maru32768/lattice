// What the document keys draw over a document: labels, a box round the match, the find bar, the mode's
// name. Over a remote page, so: a closed shadow root keeps the page out, styles go through CSSOM because
// the page's CSP can block a style element, and all text goes in as text.

type Css = Record<string, string>;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, css: Css): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(css)) {
    el.style.setProperty(k, v);
  }
  return el;
}

const px = (n: number) => `${Math.round(n)}px`;

export function createUi() {
  const host = document.createElement("div");
  host.dataset.latticeUi = "1";
  for (const [k, v] of Object.entries({ all: "initial", display: "block", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none" })) {
    host.style.setProperty(k, v, "important");
  }
  const root = host.attachShadow({ mode: "closed" });
  const marks = make("div", {});
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
    remove: () => host.remove(),
  };
}

export type DocUi = ReturnType<typeof createUi>;
