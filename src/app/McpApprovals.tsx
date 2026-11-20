import { Fragment, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mcp, type McpApproval, type McpDeletion } from "../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useT, type T } from "../i18n";

/**
 * A request that takes the place of one just answered or refused appears under the pointer: a second click meant for the
 * first, as in a double-click, must not allow it.
 */
const ARM_MS = 1000;

function target(d: McpDeletion, t: T): { rows: [label: string, value: string][]; desc: string } {
  const titled = (label: string, title: string | null, url: string): [string, string][] =>
    title === null
      ? [[label, url]]
      : [
          [label, title],
          [t("mcpApproval.url"), url],
        ];
  switch (d.kind) {
    case "article":
      return { rows: titled(t("common.article"), d.title, d.url), desc: t("app.deleteDesc") };
    case "collection":
      return { rows: [[t("common.group"), d.name]], desc: t("mcpApproval.collectionDesc", { count: d.articles }) };
    case "feed":
      return { rows: titled(t("common.feed"), d.title, d.url), desc: t("feedsView.deleteDesc", { article_count: d.articles }) };
    case "folder":
      return { rows: [[t("common.folder"), d.name]], desc: t("mcpApproval.folderDesc", { count: d.feeds }) };
    case "genre":
      return {
        rows: [
          [t("common.genre"), d.from],
          [t("mcpApproval.into"), d.into],
        ],
        desc: t("mcpApproval.genreDesc", { count: d.articles }),
      };
  }
}

/** Puts each deletion an agent asks for over MCP to the user, oldest first. The server refuses one left unanswered. */
export function McpApprovals() {
  const t = useT();
  const [waiting, setWaiting] = useState<McpApproval[]>([]);
  const [now, setNow] = useState(() => Date.now());
  /** Reads can answer out of order. */
  const sent = useRef(0);
  const shown = useRef(0);
  /** Requests answered here: a read sent before the answer still lists them. */
  const answered = useRef(new Set<number>());

  useEffect(() => {
    const reload = () => {
      const n = ++sent.current;
      mcp
        .approvals()
        .then((list) => {
          if (n > shown.current) {
            shown.current = n;
            setWaiting(list.filter((a) => !answered.current.has(a.id)));
            setNow(Date.now());
          }
        })
        .catch(() => {});
    };
    reload();
    const sub = listen("mcp-approval", reload);
    return () => void sub.then((f) => f());
  }, []);

  const ask = waiting.at(0);
  const id = ask?.id;
  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [id]);

  if (!ask) {
    return null;
  }
  const answer = (allow: boolean) => {
    answered.current.add(ask.id);
    setWaiting((list) => list.filter((a) => a.id !== ask.id));
    mcp.answer(ask.id, allow).catch(() => {});
  };
  const left = Math.max(0, Math.ceil((ask.deadline_ms - now) / 1000));
  const { rows, desc } = target(ask.deletion, t);
  return (
    <ConfirmDialog
      key={ask.id}
      title={t("mcpApproval.title")}
      confirm={t("mcpApproval.allow")}
      cancel={t("mcpApproval.deny")}
      armMs={ARM_MS}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    >
      <p>{t("mcpApproval.who", { name: ask.registration })}</p>
      <dl className="mcp-target">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>
              {/* The names come from the library but may be an agent's own words, so each stays apart from the text around it. */}
              <bdi>{value}</bdi>
            </dd>
          </Fragment>
        ))}
      </dl>
      <p>{desc}</p>
      <p>
        {t("mcpApproval.left", { seconds: left })}
        {waiting.length > 1 && ` ${t("mcpApproval.more", { count: waiting.length - 1 })}`}
      </p>
    </ConfirmDialog>
  );
}
