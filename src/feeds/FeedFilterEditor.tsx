import { useEffect, useState } from "react";
import { api, type FeedFilter, type FeedRow, type FilterRule, type RejectedEntry } from "../api";
import { EMPTY_FILTER, FIELDS, newRule, reasonText, reevaluatedText, withoutRule } from "./feedFilter";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";

const THRESHOLDS = [2, 3, 4, 5];

/** The rules, length and LLM settings of one import filter: a feed's own (`feedId`) or the global defaults (null). */
export function FilterEditor({ feedId, onSaved }: { feedId: number | null; onSaved: () => void }) {
  const t = useT();
  const [f, setF] = useState<FeedFilter>(EMPTY_FILTER);
  const [saved, setSaved] = useState<FeedFilter>(EMPTY_FILTER);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offerReevaluate, setOfferReevaluate] = useState(false);
  const id = feedId ?? "global";

  useEffect(() => {
    api
      .feedFilter(feedId)
      .then((v) => {
        setF(v);
        setSaved(v);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [feedId]);

  const setRule = (i: number, r: Partial<FilterRule>) => setF((x) => ({ ...x, rules: x.rules.map((old, j) => (j === i ? { ...old, ...r } : old)) }));
  const changed = JSON.stringify(f) !== JSON.stringify(saved);

  async function run(task: () => Promise<string | null>) {
    setError(null);
    setStatus(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    }
  }
  const save = () =>
    run(async () => {
      await api.setFeedFilter(feedId, f);
      const v = await api.feedFilter(feedId);
      setF(v);
      setSaved(v);
      setOfferReevaluate(true);
      onSaved();
      return t("common.saved");
    });
  const reevaluate = () =>
    run(async () => {
      const r = await api.reevaluateRejected(feedId);
      setOfferReevaluate(false);
      onSaved();
      return reevaluatedText(r, t);
    });

  return (
    <section className="ff" aria-label={feedId == null ? t("feedFilter.globalTitle") : t("feedFilter.title")}>
      <div className="ff-h">
        {t("feedFilter.rules")}
        <span className="muted">{t("feedFilter.rulesHint")}</span>
      </div>
      {f.rules.map((r, i) => (
        <div className="ff-rule" key={i} role="group" aria-label={t("feedFilter.ruleN", { n: i + 1 })}>
          <select
            className="select"
            aria-label={t("feedFilter.field")}
            value={r.field}
            onChange={(e) => setRule(i, { field: e.target.value as FilterRule["field"] })}
          >
            {FIELDS.map(([v, l]) => (
              <option key={v} value={v}>
                {t(l)}
              </option>
            ))}
          </select>
          <input
            className="input sm mono"
            aria-label={t("feedFilter.pattern")}
            value={r.pattern}
            maxLength={200}
            spellCheck={false}
            placeholder={r.regex ? t("feedFilter.regexPlaceholder") : t("feedFilter.patternPlaceholder")}
            onChange={(e) => setRule(i, { pattern: e.target.value })}
          />
          <select
            className="select"
            aria-label={t("feedFilter.action")}
            value={r.action}
            onChange={(e) => setRule(i, { action: e.target.value as FilterRule["action"] })}
          >
            <option value="exclude">{t("feedFilter.exclude")}</option>
            <option value="include">{t("feedFilter.include")}</option>
          </select>
          <label className="ff-check">
            <input type="checkbox" checked={r.regex} onChange={(e) => setRule(i, { regex: e.target.checked })} />
            {t("feedFilter.regex")}
          </label>
          <button
            type="button"
            className="ib"
            aria-label={t("feedFilter.removeRule", { n: i + 1 })}
            onClick={() => setF((x) => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm" onClick={() => setF((x) => ({ ...x, rules: [...x.rules, newRule()] }))}>
          {t("feedFilter.addRule")}
        </button>
      </div>
      <label className="ff-line" htmlFor={`ff-min-${id}`}>
        {t("feedFilter.minChars")}
        <input
          id={`ff-min-${id}`}
          className="input sm num"
          type="number"
          min={0}
          max={100000}
          value={f.min_chars ?? ""}
          onChange={(e) => setF((x) => ({ ...x, min_chars: e.target.value ? Number(e.target.value) : null }))}
        />
        <span className="muted">{t("feedFilter.minCharsHint")}</span>
      </label>
      <label className="ff-line">
        <input type="checkbox" role="switch" className="tg" checked={f.llm} onChange={(e) => setF((x) => ({ ...x, llm: e.target.checked }))} />
        {t("feedFilter.llm")}
      </label>
      <div className="muted">{t("feedFilter.llmHint")}</div>
      {f.llm && (
        <>
          <label className="ff-sub" htmlFor={`ff-ins-${id}`}>
            {t("feedFilter.instruction")}
          </label>
          <textarea
            id={`ff-ins-${id}`}
            rows={2}
            maxLength={1000}
            value={f.instruction}
            placeholder={t("feedFilter.instructionPlaceholder")}
            onChange={(e) => setF((x) => ({ ...x, instruction: e.target.value }))}
          />
          <label className="ff-line" htmlFor={`ff-rel-${id}`}>
            {t("feedFilter.minRelevance")}
            <select
              id={`ff-rel-${id}`}
              className="select"
              value={f.min_relevance ?? ""}
              onChange={(e) => setF((x) => ({ ...x, min_relevance: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">{t("feedFilter.minRelevanceOff")}</option>
              {THRESHOLDS.map((n) => (
                <option key={n} value={n}>
                  {t("relevanceSettings.atLeast", { n })}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="ff-acts">
        <button type="button" className="btn sm pri" onClick={save} disabled={!changed}>
          {t("common.save")}
        </button>
        {offerReevaluate && (
          <button type="button" className="btn sm" onClick={reevaluate}>
            {t("feedFilter.reevaluate")}
          </button>
        )}
        {status && (
          <span className="muted" role="status">
            {status}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="error-text">
          {t.msg(error)}
        </p>
      )}
    </section>
  );
}

/** 「除外された記事」: what a feed's filters kept out, with 取り込む and, for a rule, このルールを外す. */
export function RejectedList({ feed, onChanged }: { feed: FeedRow; onChanged: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<RejectedEntry[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .feedRejected(feed.id)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    api
      .feedRejected(feed.id)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new count (a poll, a re-evaluation) means a new list
  }, [feed.id, feed.rejected]);

  async function run(task: () => Promise<string | null>) {
    setError(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    }
    void load();
    onChanged();
  }
  const importOne = (r: RejectedEntry) =>
    run(async () => {
      await api.importRejected(feed.id, r.url);
      return t("feedFilter.imported", { title: r.title ?? r.url });
    });
  const dropRule = (r: RejectedEntry) =>
    run(async () => {
      if (r.reason?.kind !== "excluded") {
        return null;
      }
      const scope = r.reason.scope === "global" ? null : feed.id;
      await api.setFeedFilter(scope, withoutRule(await api.feedFilter(scope), r.reason.rule));
      return reevaluatedText(await api.reevaluateRejected(feed.id), t);
    });

  if (!rows) {
    return error ? (
      <p role="alert" className="error-text">
        {t.msg(error)}
      </p>
    ) : null;
  }
  return (
    <section className="ff" aria-label={t("feedFilter.rejected")}>
      <div className="ff-h">{t("feedFilter.rejectedN", { n: rows.length })}</div>
      {rows.length === 0 && <div className="muted">{t("feedFilter.noneRejected")}</div>}
      <ul className="ff-rejected">
        {rows.map((r) => (
          <li key={r.url}>
            <div className="ff-title">{r.title ?? r.url}</div>
            <div className="fs">
              {r.url}
              {r.published_at && ` · ${r.published_at.slice(0, 10)}`}
            </div>
            <div className="ff-reason">{reasonText(r.reason, t)}</div>
            <div className="ff-acts">
              <button type="button" className="btn sm" onClick={() => importOne(r)} aria-label={t("feedFilter.importOf", { title: r.title ?? r.url })}>
                {t("feedFilter.import")}
              </button>
              {r.reason?.kind === "excluded" && (
                <button type="button" className="btn sm ghost" onClick={() => dropRule(r)}>
                  {t("feedFilter.dropRule")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {status && (
        <p role="status" className="muted">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {t.msg(error)}
        </p>
      )}
    </section>
  );
}
