import { useEffect, useEffectEvent, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tabDrag, windows } from "../api";
import { allTabs, close, docOf, open, serialize, single, tabById, type Doc, type Id, type Layout, type Tab } from "../layout/layout";
import { HOST, IS_MAIN, STORAGE } from "./host";
import { CHAT, MAIN, nextDocLabel, openWindows, storageKeys, toMain, toWindow, windowKey } from "./windows";

/** This pop-out is done: its storage key goes first, so it is not restored at the next start. */
function closeWindow() {
  if (HOST.kind === "doc") void toMain({ kind: "openDocs", label: HOST.label, docs: [] });
  try {
    localStorage.removeItem(STORAGE);
  } catch {
    // Then it comes back at the next start, which is the lesser harm.
  }
  windows.close().catch(() => {});
}

/** The chat window's メインウィンドウに戻す: the pane docks back in main. */
export function dockChat() {
  void toMain({ kind: "chatDocked" });
  closeWindow();
}

/**
 * The windows (G52): tabs popped out to document windows or sent between them, the chat docked
 * in main or in its own window, and a pop-out closing. `layout` is this window's, `forgetPage`
 * lets a page tab leave with its webview.
 */
export function useWindows({ layout, setLayout, forgetPage, fail }: {
  layout: Layout;
  setLayout: (f: (l: Layout) => Layout) => void;
  forgetPage: (t: Tab) => void;
  fail: (e: unknown) => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  /** The chat is in its own window (main only; restored from storage at startup). */
  const [chatWindow, setChatWindow] = useState(() => IS_MAIN && openWindows(storageKeys()).includes(CHAT));

  /** A new document window's label, its layout showing `doc` stored for it to load; null if it could not be stored. */
  function storeDocWindow(doc: Doc): string | null {
    const label = nextDocLabel(openWindows(storageKeys()));
    try {
      localStorage.setItem(windowKey(label), serialize(open(single(), doc, "new")));
    } catch (e) {
      fail(e);
      return null;
    }
    return label;
  }

  /** A new document window showing `doc`. False if it could not be stored. */
  function popOutDoc(doc: Doc): boolean {
    const label = storeDocWindow(doc);
    if (label) windows.open(label).catch(fail);
    return label != null;
  }

  /** The tab moves to a new document window; `drag`: torn off a strip, so the drag creates and places the window (design-review §26). */
  function popOutTab(tab: Id, drag = false) {
    const hit = tabById(layout, tab);
    const label = hit && storeDocWindow(docOf(hit.tab));
    if (!hit || !label) return;
    (drag ? tabDrag.float(label) : windows.open(label)).catch(fail);
    forgetPage(hit.tab);
    setLayout((l) => close(l, tab));
  }

  /** The tab goes to window `label`: its focused pane, or the slot `at` it was dropped on. */
  function sendTab(tab: Id, label: string, at?: { pane: Id; index: number }) {
    const hit = tabById(layout, tab);
    if (!hit) return;
    forgetPage(hit.tab);
    setLayout((l) => close(l, tab));
    void toWindow(label, { kind: "open", docs: [docOf(hit.tab)], at });
  }

  /** Document window: the tab goes back to the main window's focused pane. */
  const returnTab = (tab: Id) => sendTab(tab, MAIN);

  /** × or Alt+F4 on a pop-out: a document window hands its tabs back; the chat window just closes. */
  function closeRequested() {
    if (HOST.kind === "doc") {
      const docs = allTabs(layout).map(docOf);
      if (docs.length) void toMain({ kind: "open", docs });
    } else if (HOST.kind === "chat") {
      void toMain({ kind: "chatClosed" });
    }
    closeWindow();
  }

  /** Main: the chat dock moves to its own window. */
  function popOutChat() {
    try {
      localStorage.setItem(windowKey(CHAT), "1");
    } catch (e) {
      return fail(e);
    }
    setChatOpen(false);
    setChatWindow(true);
    windows.open(CHAT).catch(fail);
  }

  const toggleChat = () => (chatWindow ? void windows.open(CHAT).catch(fail) : setChatOpen((o) => !o));

  const onCloseRequested = useEffectEvent(closeRequested);
  useEffect(() => {
    if (IS_MAIN) return;
    const sub = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      onCloseRequested();
    });
    return () => void sub.then((f) => f());
  }, []);

  // A document window with nothing left closes (its last tab was closed or sent back).
  const empty = HOST.kind === "doc" && allTabs(layout).length === 0;
  useEffect(() => {
    if (empty) closeWindow();
  }, [empty]);

  return { chatOpen, setChatOpen, chatWindow, setChatWindow, popOutDoc, popOutTab, sendTab, returnTab, closeRequested, popOutChat, toggleChat };
}
