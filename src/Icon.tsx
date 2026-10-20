import { keyLabel, useBindings, type ActionId } from "./keys";

// Stroke icons copied from the design boards (24×24 viewBox, styled by .ico).
const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  vsplit: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
  hsplit: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  recent: <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>,
  unread: <circle cx="12" cy="12" r="4" />,
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  all: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  right: <path d="M9 6l6 6-6 6" />,
  left: <path d="M15 6l-6 6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  manual: <path d="M7 3h10v18l-5-4-5 4z" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  jobs: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  import: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  sort: <path d="M7 4v16M3 16l4 4 4-4M14 6h7M14 11h5M14 16h3" />,
  reader: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7" /></>,
  page: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" /></>,
  check: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  focus: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  reload: <><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4v4h-4" /></>,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></>,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
  rss: <><path d="M5 5a14 14 0 0 1 14 14" /><path d="M5 11a8 8 0 0 1 8 8" /><circle cx="6" cy="18" r="1" /></>,
  translate: <><path d="M4 5h9M8.5 3v2M6 5c0 4 3 7 6 8M11 5c-1 4-4 7-7 8" /><path d="M13 20l4-9 4 9M14.5 17h5" /></>,
  alert: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5M12 16h.01" /></>,
  offline: <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3A10 10 0 0 1 19 13M12 20h.01" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: "sm" | "md" }) {
  return <svg className={`ico${size ? ` ${size}` : ""}`} viewBox="0 0 24 24" aria-hidden="true">{PATHS[name]}</svg>;
}

/** Five difficulty dots (filled up to `d`). */
export function Dif({ d }: { d: number | null }) {
  return (
    <span className="dif" aria-label={d == null ? "難易度 未判定" : `難易度 ${d}/5`} role="img">
      {[1, 2, 3, 4, 5].map((i) => <i key={i} className={d != null && i <= d ? "f" : ""} />)}
    </span>
  );
}

export const Kbd = ({ children }: { children: string }) => <span className="kbd">{children}</span>;

/** The first key bound to a shell action (Settings › ショートカット), as a key chip. */
export function ActionKey({ id }: { id: ActionId }) {
  const k = useBindings()[id][0];
  return k ? <Kbd>{keyLabel(k)}</Kbd> : null;
}
