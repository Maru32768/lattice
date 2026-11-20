import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mcp, type McpApproval, type McpDeletion } from "../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useT } from "../i18n";

/**
 * A request that takes the place of one just answered or refused appears under the pointer: a second click meant for the
 * first, as in a double-click, must not allow it.
 */
const ARM_MS = 1000;

/** The names come from the library but may be an agent's own words, so each stays apart from the text around it. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <bdi>{value}</bdi>
      </dd>
    </>
  );
}

function Target({ deletion: d }: { deletion: McpDeletion }) {
  const t = useT();
  switch (d.kind) {
    case "article":
      return (
        <>
          <dl className="mcp-target">
            <Row label={t("mcpApproval.article")} value={d.title ?? d.url} />
            {d.title !== null && <Row label={t("mcpApproval.url")} value={d.url} />}
          </dl>
          <p>{t("app.deleteDesc")}</p>
        </>
      );
    case "collection":
      return (
        <>
          <dl className="mcp-target">
            <Row label={t("mcpApproval.collection")} value={d.name} />
          </dl>
          <p>{t("mcpApproval.collectionDesc", { count: d.articles })}</p>
        </>
      );
    case "feed":
      return (
        <>
          <dl className="mcp-target">
            <Row label={t("mcpApproval.feed")} value={d.title ?? d.url} />
            {d.title !== null && <Row label={t("mcpApproval.url")} value={d.url} />}
          </dl>
          <p>{t("feedsView.deleteDesc", { article_count: d.articles })}</p>
        </>
      );
    case "folder":
      return (
        <>
          <dl className="mcp-target">
            <Row label={t("mcpApproval.folder")} value={d.name} />
          </dl>
          <p>{t("mcpApproval.folderDesc", { count: d.feeds })}</p>
        </>
      );
    case "genre":
      return (
        <>
          <dl className="mcp-target">
            <Row label={t("mcpApproval.genre")} value={d.from} />
            <Row label={t("mcpApproval.into")} value={d.into} />
          </dl>
          <p>{t("mcpApproval.genreDesc", { count: d.articles })}</p>
        </>
      );
  }
}

/** Puts each deletion an agent asks for over MCP to the user, oldest first. The server refuses one left unanswered. */
export function McpApprovals() {
  const t = useT();
  const [waiting, setWaiting] = useState<McpApproval[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [armed, setArmed] = useState<number | null>(null);
  /** Reads can answer out of order, and one sent before an answer would put the answered request back. */
  const sent = useRef(0);
  const shown = useRef(0);

  useEffect(() => {
    const reload = () => {
      const n = ++sent.current;
      mcp
        .approvals()
        .then((list) => {
          if (n > shown.current) {
            shown.current = n;
            setWaiting(list);
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
    const arm = setTimeout(() => setArmed(id), ARM_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(arm);
      clearInterval(tick);
    };
  }, [id]);

  if (!ask) {
    return null;
  }
  const answer = (allow: boolean) => {
    shown.current = ++sent.current;
    setWaiting((list) => list.filter((a) => a.id !== ask.id));
    mcp.answer(ask.id, allow).catch(() => {});
  };
  const left = Math.max(0, Math.ceil((ask.deadline_ms - now) / 1000));
  return (
    <ConfirmDialog
      key={ask.id}
      title={t("mcpApproval.title")}
      confirm={t("mcpApproval.allow")}
      cancel={t("mcpApproval.deny")}
      confirmDisabled={armed !== ask.id}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    >
      <p>{t("mcpApproval.who", { name: ask.registration })}</p>
      <Target deletion={ask.deletion} />
      <p>
        {t("mcpApproval.left", { seconds: left })}
        {waiting.length > 1 && ` ${t("mcpApproval.more", { count: waiting.length - 1 })}`}
      </p>
    </ConfirmDialog>
  );
}
