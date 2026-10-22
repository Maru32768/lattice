import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mergeDocs, type OpenDoc } from "../chat/chat";
import { HOST, IS_MAIN } from "./host";
import { toMain } from "./windows";

type DocRef = { id: number; title: string } | null;

/** Runs `send` when `value` differs in content from what it last sent. */
function useSendOnChange<V>(value: V, send: (v: V) => void) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(value);
    if (key === sent.current) {
      return;
    }
    sent.current = key;
    send(value);
  });
}

/**
 * What the chat knows of the other windows. Main announces its open article (この記事) and the open
 * documents of every window (開いている記事: its own, and those each document window reports);
 * the chat window takes both from main. `own`: this window's open article and documents.
 */
export function useChatBridge(own: { article: DocRef; docs: OpenDoc[] }) {
  /** The chat window's この記事: the article open in the main window, as it announces it. */
  const [remoteArticle, setRemoteArticle] = useState<DocRef>(null);
  const [mainOpen, setMainOpen] = useState<OpenDoc[]>([]);
  const [docWindowsOpen, setDocWindowsOpen] = useState<Record<string, OpenDoc[]>>({});
  const [chatScope, setChatScope] = useState<{ key: string; seq: number } | null>(null);
  const askScope = (key: string) => setChatScope((c) => ({ key, seq: (c?.seq ?? 0) + 1 }));

  const article = HOST.kind === "chat" ? remoteArticle : own.article;
  const docs = HOST.kind === "chat" ? mainOpen : mergeDocs([own.docs, ...Object.values(docWindowsOpen)]);
  useSendOnChange(article, (a) => {
    if (IS_MAIN) {
      void emit("doc-current", a);
    }
  });
  useSendOnChange(own.docs, (d) => {
    if (HOST.kind === "doc") {
      void toMain({ kind: "openDocs", label: HOST.label, docs: d });
    }
  });
  useSendOnChange(docs, (d) => {
    if (IS_MAIN) {
      void emit("open-docs", d);
    }
  });

  // Broadcasts (`emit`) reach every window's `listen`; what is addressed to one window (`emitTo`) is
  // heard through that window's own listener, since a global `listen` matches any target.
  useEffect(() => {
    const subs = [
      listen<DocRef>("doc-current", (e) => setRemoteArticle(e.payload)),
      ...(HOST.kind === "chat"
        ? [
            getCurrentWindow().listen<{ key: string }>("chat-request", (e) => setChatScope((c) => ({ key: e.payload.key, seq: (c?.seq ?? 0) + 1 }))),
            listen<OpenDoc[]>("open-docs", (e) => setMainOpen(e.payload)),
          ]
        : []),
    ];
    if (HOST.kind === "chat") {
      void toMain({ kind: "chatReady" });
    }
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  /** The chat window asked for both (it just started). */
  const resend = () => {
    void emit("doc-current", article);
    void emit("open-docs", docs);
  };
  /** A document window reported its open documents. */
  const docWindowOpen = (label: string, d: OpenDoc[]) => setDocWindowsOpen((m) => ({ ...m, [label]: d }));

  return { article, docs, chatScope, askScope, resend, docWindowOpen };
}
