import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mcp, type McpEdit, type McpOutcome, type McpRegistration, type McpRole, type McpStatus, type McpTarget } from "../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SetRow, Switch } from "../ui/SetRow";
import { locale, parseCoded, useT, type Key, type Lang, type PlainKey } from "../i18n";

const ROLES = { read: "mcpSettings.roleRead", edit: "mcpSettings.roleEdit", delete: "mcpSettings.roleDelete" } as const satisfies Record<McpRole, PlainKey>;
const TARGETS = {
  claude_code: "mcpSettings.targetClaudeCode",
  claude_code_project: "mcpSettings.targetClaudeCodeProject",
  codex: "mcpSettings.targetCodex",
  other: "mcpSettings.targetOther",
} as const satisfies Record<McpTarget, PlainKey>;
/** The agent whose own settings the app writes: such a target takes one registration. */
const AGENTS: Record<McpTarget, string | null> = { claude_code: "Claude Code", claude_code_project: null, codex: "Codex", other: null };
const COPIES = {
  claude_code: "mcpSettings.copyCommand",
  claude_code_project: "mcpSettings.copyCommand",
  codex: "mcpSettings.copySettings",
  other: "mcpSettings.copySettings",
} as const satisfies Record<McpTarget, PlainKey>;
const CONFIRM_DESCS = {
  regenerate: {
    claude_code: "mcpSettings.regenerateDescAgent",
    claude_code_project: "mcpSettings.regenerateDescProject",
    codex: "mcpSettings.regenerateDescAgent",
    other: "mcpSettings.regenerateDescOther",
  },
  delete: {
    claude_code: "mcpSettings.deleteDescAgent",
    claude_code_project: "mcpSettings.deleteDescProject",
    codex: "mcpSettings.deleteDescAgent",
    other: "mcpSettings.deleteDescOther",
  },
} as const satisfies Record<"regenerate" | "delete", Record<McpTarget, Key>>;
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
  /** `help` is what to do by hand about an agent's own settings; the change to the registration itself stands. */
  const [error, setError] = useState<{ text: string; help?: { kind: "add" | "remove"; agent: string; remove: string | null } } | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<McpRole>("read");
  /** Until one is picked, the new registration is for the first agent that has none. */
  const [target, setTarget] = useState<McpTarget | null>(null);
  /** The agent whose settings an edit is changing, which takes a CLI and may take half a minute. */
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ kind: "added" | "removed"; agent: string } | null>(null);
  /** What was last copied: a regenerated token makes it another text, so the button offers to copy again. */
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "regenerate" | "delete"; reg: McpRegistration } | null>(null);
  /**
   * Reads can overlap each other and an edit, and one that answers late would put an older status back: after a new
   * token, its dead text to copy. A read shows only if sent after the one on screen, and an edit's answer outranks every
   * read still out.
   */
  const sent = useRef(0);
  const shown = useRef(0);

  useEffect(() => {
    let timer = 0;
    const reload = () => {
      const n = ++sent.current;
      return mcp
        .status()
        .then((s) => {
          if (n > shown.current) {
            shown.current = n;
            setStatus(s);
          }
        })
        .catch((e: unknown) => setError({ text: String(e) }));
    };
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

  /** `at` is the registration's target where the edit reaches into an agent's settings too. */
  async function edit(change: McpEdit, at?: McpTarget) {
    const agent = at ? AGENTS[at] : null;
    setError(null);
    setDone(null);
    // An edit that reaches into no agent may still be out while one that does begins, and must not say it is over.
    if (agent) {
      setBusy(agent);
    }
    const edited = await mcp.edit(change).catch((e: unknown) => {
      setError({ text: String(e) });
      return null;
    });
    if (agent) {
      setBusy(null);
    }
    if (!edited) {
      return false;
    }
    shown.current = ++sent.current;
    setStatus(edited.status);
    if (agent && edited.agent) {
      const removing = change.kind === "delete";
      if (edited.agent.kind === "written") {
        setDone({ kind: removing ? "removed" : "added", agent });
      } else if (parseCoded(edited.agent.error)?.code === "mcp.agentOther") {
        // No help: the command that removes would take out the user's own server, and the message says what to do.
        setError({ text: edited.agent.error });
      } else {
        // A deleted registration is gone from the new status, and one just made is not in the old.
        const reg = [...edited.status.registrations, ...(status?.registrations ?? [])].find((r) => r.target === at);
        setError({ text: edited.agent.error, help: { kind: removing ? "remove" : "add", agent, remove: reg?.remove ?? null } });
      }
    }
    return true;
  }

  async function create(target: McpTarget) {
    if (await edit({ kind: "create", name, role, target }, target)) {
      setName("");
      setTarget(null);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => setCopied(text),
      (e: unknown) => setError({ text: String(e) }),
    );
  }

  const failure = error && (
    <div role="alert">
      <p className="msg error-text">{t.msg(error.text)}</p>
      {error.help && (
        <p className="msg">
          {t.rich(error.help.kind === "add" ? "mcpSettings.addByHand" : "mcpSettings.removeByHand", {
            agent: error.help.agent,
            remove: <code>{error.help.remove}</code>,
          })}
        </p>
      )}
    </div>
  );
  if (!status) {
    return failure;
  }
  const off = status.fell_back || busy !== null;
  const taken = (at: McpTarget) => AGENTS[at] !== null && status.registrations.some((r) => r.target === at);
  const targets = Object.keys(TARGETS) as McpTarget[];
  const newTarget = target ?? targets.find((at) => AGENTS[at] !== null && !taken(at)) ?? "claude_code_project";
  const roleOptions = (Object.keys(ROLES) as McpRole[]).map((r) => (
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
        {status.fell_back && <p className="note warn">{t("be.mcp.fellBack")}</p>}
        {status.error && <p className="note err">{t.msg(status.error)}</p>}
      </section>
      <section aria-labelledby="mcp-registrations">
        <h2 id="mcp-registrations">{t("mcpSettings.registrations")}</h2>
        <p className="sec-d">{t("mcpSettings.registrationsDesc")}</p>
        <p className="sec-d">{t("mcpSettings.rolesDesc")}</p>
        <div className="grp mcp-regs">
          {status.registrations.map((reg) => (
            <SetRow key={reg.id} title={reg.name} desc={t(TARGETS[reg.target])}>
              <select
                className="input sm fit"
                aria-label={t("mcpSettings.roleOf", { name: reg.name })}
                value={reg.role}
                disabled={off}
                onChange={(e) => void edit({ kind: "set_role", id: reg.id, role: e.target.value as McpRole })}
              >
                {roleOptions}
              </select>
              {AGENTS[reg.target] && (
                <button className="btn sm" onClick={() => void edit({ kind: "connect", id: reg.id }, reg.target)} disabled={off}>
                  {t("mcpSettings.connect", { agent: AGENTS[reg.target] ?? "" })}
                </button>
              )}
              <button className="btn sm" onClick={() => copy(reg.copy)} disabled={off}>
                {t(copied === reg.copy ? "mcpSettings.copied" : COPIES[reg.target])}
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
            <input
              id="mcp-new-name"
              className="input sm fit"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={AGENTS[newTarget] ?? undefined}
              disabled={off}
            />
            <select
              className="input sm fit"
              aria-label={t("mcpSettings.role")}
              value={role}
              onChange={(e) => setRole(e.target.value as McpRole)}
              disabled={off}
            >
              {roleOptions}
            </select>
            <select
              className="input sm fit"
              aria-label={t("mcpSettings.target")}
              value={newTarget}
              onChange={(e) => setTarget(e.target.value as McpTarget)}
              disabled={off}
            >
              {targets.map((at) => (
                <option key={at} value={at} disabled={taken(at)}>
                  {t(TARGETS[at])}
                </option>
              ))}
            </select>
            <button className="btn sm pri" onClick={() => void create(newTarget)} disabled={off || (!name.trim() && AGENTS[newTarget] === null)}>
              {t("mcpSettings.create")}
            </button>
          </SetRow>
        </div>
        <div role="status">
          {busy && <p className="msg">{t("mcpSettings.writing", { agent: busy })}</p>}
          {done && <p className="msg">{t(done.kind === "added" ? "mcpSettings.added" : "mcpSettings.removed", { agent: done.agent })}</p>}
        </div>
        {failure}
      </section>
      {status.enabled && !status.fell_back && !status.error && status.registrations.length > 0 && (
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
                      <bdi>{s.client ?? t("mcpSettings.unknownClient")}</bdi>{" "}
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
                      <span className="muted">{when(c.at_ms, t.lang)}</span>{" "}
                      <code>
                        <bdi>{c.tool}</bdi>
                      </code>{" "}
                      <span className={c.outcome}>{t(OUTCOMES[c.outcome])}</span>
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
      {confirming && (
        <ConfirmDialog
          title={t(confirming.kind === "delete" ? "mcpSettings.confirmDelete" : "mcpSettings.confirmRegenerate", { name: confirming.reg.name })}
          confirm={t(confirming.kind === "delete" ? "common.delete" : "mcpSettings.regenerateConfirm")}
          onConfirm={() => {
            setConfirming(null);
            void edit({ kind: confirming.kind, id: confirming.reg.id }, confirming.reg.target);
          }}
          onCancel={() => setConfirming(null)}
        >
          <p>
            {t.rich(CONFIRM_DESCS[confirming.kind][confirming.reg.target], {
              agent: AGENTS[confirming.reg.target],
              remove: <code>{confirming.reg.remove}</code>,
            })}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
