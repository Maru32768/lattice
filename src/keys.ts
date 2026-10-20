// Keyboard shortcuts: one registry of shell actions with their default keys. The user's
// changes (Settings › ショートカット) persist as overrides; the shell reads the merged bindings.
import { useSyncExternalStore } from "react";
import { keyOf } from "./keyname.ts";

export type ActionId =
  | "palette" | "search" | "next" | "prev" | "open" | "openPage" | "favorite" | "read" | "focus" | "view" | "less" | "more"
  | "escape" | "pane" | "newTab" | "closeTab" | "nextTab" | "prevTab" | "splitRight" | "splitDown";

export interface ActionDef {
  id: ActionId;
  label: string;
  keys: string[];
  /** Also runs while focus is in a text field. */
  inFields?: boolean;
}

export const ACTIONS: ActionDef[] = [
  { id: "palette", label: "コマンドパレット", keys: ["Ctrl+K"], inFields: true },
  { id: "search", label: "検索", keys: ["/"] },
  { id: "next", label: "次の項目へ", keys: ["J", "ArrowDown"] },
  { id: "prev", label: "前の項目へ", keys: ["K", "ArrowUp"] },
  { id: "open", label: "カーソルの記事を開く", keys: ["Enter"] },
  { id: "openPage", label: "カーソルの記事を Page で開く", keys: ["Shift+Enter"] },
  { id: "favorite", label: "お気に入り", keys: ["S"] },
  { id: "read", label: "既読 / 未読", keys: ["M"] },
  { id: "focus", label: "フォーカスモード", keys: ["F"] },
  { id: "view", label: "Reader / Page を切り替え", keys: ["V"] },
  { id: "less", label: "日本語の割合を下げる", keys: ["["] },
  { id: "more", label: "日本語の割合を上げる", keys: ["]"] },
  { id: "escape", label: "戻る・絞り込みを解除", keys: ["Escape"], inFields: true },
  { id: "pane", label: "ペイン移動のプレフィックス（続けて ← → ↑ ↓ / h j k l・o・z・\" %・x・c n p）", keys: ["Ctrl+B"], inFields: true },
  { id: "newTab", label: "新しいタブ", keys: ["Ctrl+T"], inFields: true },
  { id: "closeTab", label: "タブを閉じる", keys: ["Ctrl+W"], inFields: true },
  { id: "nextTab", label: "次のタブ", keys: ["Ctrl+Tab"], inFields: true },
  { id: "prevTab", label: "前のタブ", keys: ["Ctrl+Shift+Tab"], inFields: true },
  { id: "splitRight", label: "ペインを右に分割", keys: ["Ctrl+\\"], inFields: true },
  { id: "splitDown", label: "ペインを下に分割", keys: ["Ctrl+-"], inFields: true },
];

export type Bindings = Record<ActionId, string[]>;
export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.keys])) as Bindings;

const NAMES: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: "⌫" };

/** Display form: "Ctrl+K" → "Ctrl K", "J" → "j", "ArrowDown" → "↓". */
export function keyLabel(k: string): string {
  const mods: string[] = [];
  let rest = k;
  for (const m of ["Ctrl+", "Alt+", "Shift+"]) {
    if (rest.startsWith(m) && rest.length > m.length) {
      mods.push(m.slice(0, -1));
      rest = rest.slice(m.length);
    }
  }
  const name = NAMES[rest] ?? (rest.length === 1 && mods.length === 0 ? rest.toLowerCase() : rest);
  return [...mods, name].join(" ");
}

/** The action a key runs: the first in registry order that has it. */
export function actionFor(b: Bindings, key: string): ActionDef | undefined {
  return ACTIONS.find((a) => b[a.id].includes(key));
}

/** Keys bound to more than one action, with those actions in registry order. */
export function conflicts(b: Bindings): Map<string, ActionId[]> {
  const by = new Map<string, ActionId[]>();
  for (const a of ACTIONS) for (const k of b[a.id]) by.set(k, [...(by.get(k) ?? []), a.id]);
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** How long the pane prefix (Ctrl+B) waits for its follow-up key. */
export const PREFIX_MS = 1500;

/** The app shortcuts the page overlay forwards while the page has keyboard focus. */
export interface PageKeys {
  /** Ctrl / Alt keys of actions that also run in text fields: forwarded even from the page's own fields. */
  inFields: string[];
  /** Forwarded only outside the page's fields. */
  outside: string[];
  /** The pane prefix: the key after it is forwarded too, within prefixMs. */
  prefix: string[];
  prefixMs: number;
}

const MODIFIED = /^(Ctrl|Alt)\+/;

export function pageKeys(b: Bindings): PageKeys {
  const out: PageKeys = { inFields: [], outside: [], prefix: b.pane, prefixMs: PREFIX_MS };
  for (const a of ACTIONS) {
    for (const k of b[a.id]) {
      const mod = MODIFIED.test(k);
      // Enter, Escape, the arrows, Space stay the page's own: it navigates and scrolls with them.
      if (!mod && k.replace(/^Shift\+/, "").length > 1) continue;
      (mod && a.inFields ? out.inFields : out.outside).push(k);
    }
  }
  return out;
}

export const merge = (overrides: Partial<Bindings>): Bindings => ({ ...DEFAULT_BINDINGS, ...overrides });

// ---- persisted store ----------------------------------------------------------------------------
const STORAGE_KEY = "lattice.shortcuts";

function load(): Partial<Bindings> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Partial<Bindings> = {};
    for (const a of ACTIONS) {
      const v = raw[a.id];
      if (Array.isArray(v) && v.every((k) => typeof k === "string")) out[a.id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

let overrides = load();
let bindings = merge(overrides);
const listeners = new Set<() => void>();

function commit(next: Partial<Bindings>) {
  overrides = next;
  bindings = merge(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the change lasts for this session only.
  }
  listeners.forEach((f) => f());
}

export const getBindings = () => bindings;
export const isCustom = (id: ActionId) => id in overrides;

export function setKeys(id: ActionId, keys: string[]) {
  const same = keys.length === DEFAULT_BINDINGS[id].length && keys.every((k, i) => k === DEFAULT_BINDINGS[id][i]);
  const { [id]: _, ...rest } = overrides;
  commit(same ? rest : { ...rest, [id]: keys });
}

/** One action back to its default keys, or every action when `id` is omitted. */
export function resetKeys(id?: ActionId) {
  if (!id) return commit({});
  const { [id]: _, ...rest } = overrides;
  commit(rest);
}

export function useBindings(): Bindings {
  return useSyncExternalStore((f) => {
    listeners.add(f);
    return () => listeners.delete(f);
  }, getBindings);
}

/** Up / down inside a popover list: the arrows, plus next / prev keys that are not text input when `typing`. */
export function listStep(e: React.KeyboardEvent, typing: boolean): 1 | -1 | 0 {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  const k = keyOf(e.nativeEvent);
  if (!k || (typing && k.length === 1)) return 0;
  return bindings.next.includes(k) ? 1 : bindings.prev.includes(k) ? -1 : 0;
}
