import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mcp, type McpEdit, type McpOutcome, type McpRegistration, type McpRole, type McpScope, type McpStatus } from "../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SetRow, Switch } from "../ui/SetRow";
import { locale, useT, type Key, type Lang, type PlainKey } from "../i18n";

// shortcut: no delete role here until the app can ask the user before each deletion an agent makes.
const ROLES = { read: "mcpSettings.roleRead", edit: "mcpSettings.roleEdit" } as const satisfies Partial<Record<McpRole, PlainKey>>;
type Offered = keyof typeof ROLES;
const SCOPES = { user: "mcpSettings.scopeUser", local: "mcpSettings.scopeLocal" } as const satisfies Record<McpScope, PlainKey>;
const CONFIRM_DESCS = {
  regenerate: { user: "mcpSettings.regenerateDescUser", local: "mcpSettings.regenerateDescLocal" },
  delete: { user: "mcpSettings.deleteDescUser", local: "mcpSettings.deleteDescLocal" },
} as const satisfies Record<"regenerate" | "delete", Record<McpScope, Key>>;
const OUTCOMES = {
  succeeded: "mcpSettings.succeeded",
  failed: "mcpSettings.failed",
  refused: "mcpSettings.refused",
} as const satisfies Record<McpOutcome, PlainKey>;
/** The server tells of every request: reading again at most this often keeps up with a busy agent without a read per request. */
const RELOAD_MS = 300;

/** A time today needs no date. */
function when(ms: number, lang: Lang) {
  const at = new Date(ms);
  return at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString(locale(lang)) : at.toLocaleString(locale(lang));
}

/** Settings section for AI agents reaching the library over MCP (design-review §23). */
export function McpSettings() {
  const t = useT();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Offered>("read");
  /** Until one is picked, the new registration is for all of Claude Code unless another one already is. */
  const [scope, setScope] = useState<McpScope | null>(null);
  /** The command last copied: a regenerated token makes a new one, so the button offers to copy again. */
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "regenerate" | "delete"; reg: McpRegistration } | null>(null);

  useEffect(() => {
    let timer = 0;
    const reload = () =>
      mcp
        .status()
        .then(setStatus)
        .catch((e: unknown) => setError(String(e)));
    void reload();
    const sub = listen("mcp-activity", () => {
      if (!timer) {
        timer = window.setTimeout(() => {
          timer = 0;
          void reload();
        }, RELOAD_MS);
      }
    });
    return () => {
      clearTimeout(timer);
      void sub.then((f) => f());
    };
  }, []);

  async function edit(change: McpEdit) {
    setError(null);
    const s = await mcp.edit(change).catch((e: unknown) => {
      setError(String(e));
      return null;
    });
    if (s) {
      setStatus(s);
    }
    return s !== null;
  }

  async function create(scope: McpScope) {
    if (await edit({ kind: "create", name, role, scope })) {
      setName("");
      setScope(null);
    }
  }

  function copy(command: string) {
    navigator.clipboard.writeText(command).then(
      () => setCopied(command),
      (e: unknown) => setError(String(e)),
    );
  }

  const failure = error && (
    <p role="alert" className="msg error-text">
      {t.msg(error)}
    </p>
  );
  if (!status) {
    return failure;
  }
  const off = status.fell_back;
  const userTaken = status.registrations.some((r) => r.scope === "user");
  const newScope = scope ?? (userTaken ? "local" : "user");
  const roleOptions = (Object.keys(ROLES) as Offered[]).map((r) => (
    <option key={r} value={r}>
      {t(ROLES[r])}
    </option>
  ));
  const used = status.registrations.filter((r) => r.sessions.length > 0 || r.calls.length > 0);
  return (
    <>
      <section aria-labelledby="mcp-server">
        <h2 id="mcp-server">{t("mcpSettings.server")}</h2>
        <div className="grp">
          <SetRow title={t("mcpSettings.enabled")} desc={t("mcpSettings.enabledDesc")} htmlFor="mcp-enabled">
            <Switch id="mcp-enabled" checked={status.enabled} disabled={off} onChange={(on) => void edit({ kind: "enable", on })} />
          </SetRow>
        </div>
        {off && <p className="note warn">{t("be.mcp.fellBack")}</p>}
        {status.error && <p className="note err">{t.msg(status.error)}</p>}
      </section>
      <section aria-labelledby="mcp-registrations">
        <h2 id="mcp-registrations">{t("mcpSettings.registrations")}</h2>
        <p className="sec-d">{t("mcpSettings.registrationsDesc")}</p>
        <p className="sec-d">{t("mcpSettings.rolesDesc")}</p>
        <div className="grp mcp-regs">
          {status.registrations.map((reg) => (
            <SetRow key={reg.id} title={reg.name} desc={t(SCOPES[reg.scope])}>
              <select
                className="input sm fit"
                aria-label={t("mcpSettings.roleOf", { name: reg.name })}
                value={reg.role}
                disabled={off}
                onChange={(e) => void edit({ kind: "set_role", id: reg.id, role: e.target.value as Offered })}
              >
                {roleOptions}
              </select>
              <button className="btn sm" onClick={() => copy(reg.command)} disabled={off}>
                {t(copied === reg.command ? "mcpSettings.copied" : "mcpSettings.copy")}
              </button>
              <button className="btn sm" onClick={() => setConfirming({ kind: "regenerate", reg })} disabled={off}>
                {t("mcpSettings.regenerate")}
              </button>
              <button className="btn sm danger" onClick={() => setConfirming({ kind: "delete", reg })} disabled={off}>
                {t("common.delete")}
              </button>
            </SetRow>
          ))}
          {status.registrations.length === 0 && <SetRow title={t("mcpSettings.none")} />}
          <SetRow title={t("mcpSettings.new")} htmlFor="mcp-new-name">
            <input id="mcp-new-name" className="input sm fit" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code" disabled={off} />
            <select
              className="input sm fit"
              aria-label={t("mcpSettings.role")}
              value={role}
              onChange={(e) => setRole(e.target.value as Offered)}
              disabled={off}
            >
              {roleOptions}
            </select>
            <select
              className="input sm fit"
              aria-label={t("mcpSettings.scope")}
              value={newScope}
              onChange={(e) => setScope(e.target.value as McpScope)}
              disabled={off}
            >
              {(Object.keys(SCOPES) as McpScope[]).map((s) => (
                <option key={s} value={s} disabled={s === "user" && userTaken}>
                  {t(SCOPES[s])}
                </option>
              ))}
            </select>
            <button className="btn sm pri" onClick={() => void create(newScope)} disabled={off || !name.trim()}>
              {t("mcpSettings.create")}
            </button>
          </SetRow>
        </div>
      </section>
      {status.enabled && status.registrations.length > 0 && (
        <section aria-labelledby="mcp-activity">
          <h2 id="mcp-activity">{t("mcpSettings.activity")}</h2>
          <p className="sec-d">{t("mcpSettings.activityDesc")}</p>
          <div className="grp">
            {used.map((reg) => (
              <div key={reg.id} className="set wide" role="group" aria-label={reg.name}>
                <div className="h">{reg.name}</div>
                <div className="mcp-log-h" id={`mcp-sessions-${reg.id}`}>
                  {t("mcpSettings.sessions")}
                </div>
                <ul className="mcp-log" aria-labelledby={`mcp-sessions-${reg.id}`}>
                  {reg.sessions.map((s, i) => (
                    <li key={i}>
                      <span>{s.client ?? t("mcpSettings.unknownClient")}</span>{" "}
                      <span className="muted">{t("mcpSettings.sessionTimes", { started: when(s.started_ms, t.lang), last: when(s.last_ms, t.lang) })}</span>
                    </li>
                  ))}
                  {reg.sessions.length === 0 && <li className="muted">{t("mcpSettings.noSessions")}</li>}
                </ul>
                <div className="mcp-log-h" id={`mcp-calls-${reg.id}`}>
                  {t("mcpSettings.calls")}
                </div>
                <ul className="mcp-log" aria-labelledby={`mcp-calls-${reg.id}`}>
                  {reg.calls.map((c, i) => (
                    <li key={i}>
                      <span className="muted">{when(c.at_ms, t.lang)}</span> <code>{c.tool}</code> <span className={c.outcome}>{t(OUTCOMES[c.outcome])}</span>
                    </li>
                  ))}
                  {reg.calls.length === 0 && <li className="muted">{t("mcpSettings.noCalls")}</li>}
                </ul>
              </div>
            ))}
            {used.length === 0 && <SetRow title={t("mcpSettings.noActivity")} />}
          </div>
        </section>
      )}
      {failure}
      {confirming && (
        <ConfirmDialog
          title={t(confirming.kind === "delete" ? "mcpSettings.confirmDelete" : "mcpSettings.confirmRegenerate", { name: confirming.reg.name })}
          confirm={t(confirming.kind === "delete" ? "common.delete" : "mcpSettings.regenerateConfirm")}
          onConfirm={() => {
            setConfirming(null);
            void edit({ kind: confirming.kind, id: confirming.reg.id });
          }}
          onCancel={() => setConfirming(null)}
        >
          <p>{t.rich(CONFIRM_DESCS[confirming.kind][confirming.reg.scope], { remove: <code>{confirming.reg.remove}</code> })}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
