import { getCurrentWindow } from "@tauri-apps/api/window";
import { LAYOUT_KEY } from "../layout/layout";
import { CHAT, hostOf, windowKey } from "./windows";

/** Which window this frontend runs in (design-review §26): the main shell, a document pop-out (one pane tree) or the chat window. */
export const HOST = hostOf(getCurrentWindow().label);
export const IS_MAIN = HOST.kind === "main";
/** Where this window's layout lives; a pop-out's key also marks it as open. */
export const STORAGE = HOST.kind === "main" ? LAYOUT_KEY : windowKey(HOST.kind === "doc" ? HOST.label : CHAT);

/** Where a document opens: the focused pane's active tab, or a new tab (Ctrl / middle click, Ctrl+T). */
export type Where = "active" | "new";
