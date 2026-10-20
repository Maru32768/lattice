import { useState } from "react";
import { api, type VocabContext, type VocabEntry } from "./api";
import { shownEntries, findWord, type VocabSort } from "./vocab";
import { relTime } from "./time";
import { Menu } from "./Popover";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./SetRow";
import "./manage.css";
import "./vocab.css";
import { useT, type PlainKey, type T } from "./i18n";

const SORTS: { sort: VocabSort; label: PlainKey }[] = [
  { sort: "added", label: "vocabView.sortAdded" },
  { sort: "due", label: "vocabView.sortDue" },
];

const dueLabel = (unix: number, t: T) => (unix * 1000 <= Date.now() ? t("quizReview.dueNow") : relTime(new Date(unix * 1000).toISOString(), t));

/** The captured sentence, the form in bold. Page text: text nodes only. */
function Context({ c }: { c: VocabContext }) {
  const [s, e] = findWord(c.sentence, c.surface)[0] ?? [0, 0];
  return <>{c.sentence.slice(0, s)}<b>{c.sentence.slice(s, e)}</b>{c.sentence.slice(e)}</>;
}

/** One meaning being edited. */
function MeaningEdit({ entry, onSave, onCancel }: { entry: VocabEntry; onSave: (meaning: string) => void; onCancel: () => void }) {
  const t = useT();
  const [v, setV] = useState(entry.meaning);
  return (
    <form className="meaning-edit" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <input className="input sm" value={v} autoFocus maxLength={300} aria-label={t("vocabView.meaningOf", { word: entry.headword })} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }} />
      <button type="submit" className="btn sm pri" disabled={!v.trim()}>{t("common.save")}</button>
      <button type="button" className="btn sm" onClick={onCancel}>{t("common.cancel")}</button>
    </form>
  );
}

/** 単語帳: the words captured in the Reader and pages, with search, sort, editing and the CSV export. */
export function VocabView({ entries, marks, onMarks, onChanged, onSource }: {
  entries: VocabEntry[];
  /** Saved words are underlined in the Reader. */
  marks: boolean;
  onMarks: (on: boolean) => void;
  /** The book changed: reload it. */
  onChanged: () => void;
  /** Opens where a word was captured. */
  onSource: (c: VocabContext) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<VocabSort>("added");
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<VocabEntry | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = shownEntries(entries, query, sort);

  async function act(task: () => Promise<unknown>) {
    setError(null);
    try {
      await task();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  }
  const exportCsv = () => act(async () => setStatus(t("vocabView.exported", { path: await api.exportVocabCsv() })));
  const state = (e: VocabEntry) =>
    e.suspended ? <span className="bd">{t("vocabView.suspended")}</span>
    : e.state === "pending" ? <span className="bd run">{t("vocabView.pending")}</span>
    : e.state === "failed" ? <span className="bd err">{t("vocabView.failed")}</span>
    : e.due_at != null && <span className="muted">{dueLabel(e.due_at, t)}</span>;

  return (
    <main className="manage">
      <div className="wrap vocab">
        <header className="head base">
          <h1>{t("vocabView.title")}</h1>
          <span className="sub">{t("vocabView.count", { n: entries.length })}</span>
          <span className="aside">{t("vocabView.hint")}</span>
        </header>
        <div className="filter">
          <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("vocabView.search")} aria-label={t("vocabView.search")} />
          <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as VocabSort)} aria-label={t("vocabView.sort")}>
            {SORTS.map((s) => <option key={s.sort} value={s.sort}>{t(s.label)}</option>)}
          </select>
          <span className="marks"><Switch id="vocab-marks" checked={marks} onChange={onMarks} /><label htmlFor="vocab-marks">{t("vocabView.marks")}</label></span>
          <div className="acts">
            <button className="btn" onClick={() => void exportCsv()} disabled={entries.length === 0} title={t("vocabView.exportHint")}>{t("vocabView.export")}</button>
          </div>
        </div>
        {status && <p role="status" className="msg">{status}</p>}
        {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}

        {entries.length === 0 ? <p className="muted">{t("vocabView.empty")}</p> : (
          <div className="card scroll">
            <table className="tbl dense">
              <thead><tr>
                <th>{t("vocabView.word")}</th><th>{t("vocabView.meaning")}</th><th>{t("vocabCard.context")}</th><th>{t("quizReview.nextDue")}</th>
                <th><span className="vh">{t("common.actions")}</span></th>
              </tr></thead>
              <tbody>
                {shown.map((e) => {
                  const c = e.contexts[e.contexts.length - 1];
                  return (
                    <tr key={e.id} className={e.suspended ? "off" : undefined}>
                      <td>
                        <span className="hw" lang="en">{e.headword}</span>
                        {(e.ipa || e.pos) && <span className="hw-sub">{[e.ipa && `/${e.ipa}/`, e.pos].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td>
                        {editing === e.id
                          ? <MeaningEdit entry={e} onCancel={() => setEditing(null)} onSave={(m) => void act(async () => { await api.vocabSetMeaning(e.id, m); setEditing(null); })} />
                          : <>{e.meaning || <span className="muted">—</span>}{e.definition && <span className="def" lang="en">{e.definition}</span>}</>}
                      </td>
                      <td className="ctx" lang="en">
                        {c && <Context c={c} />}
                        {e.contexts.length > 1 && <span className="more">{t("vocabView.moreContexts", { n: e.contexts.length - 1 })}</span>}
                      </td>
                      <td className="m">{state(e)}</td>
                      <td className="r">
                        <Menu className="ib" label={t("vocabView.actions", { word: e.headword })} align="right" trigger={<Icon name="more" />} items={[
                          { label: t("vocabView.editMeaning"), onSelect: () => setEditing(e.id) },
                          { label: t("vocabCard.source"), onSelect: () => c && onSource(c), disabled: !c || (c.article_id == null && !c.url) },
                          ...(e.state === "failed" ? [{ label: t("vocabView.retry"), onSelect: () => void act(() => api.vocabRetry(e.id)) }] : []),
                          { label: e.suspended ? t("vocabView.resume") : t("vocabView.suspend"), onSelect: () => void act(() => api.vocabSuspend(e.id, !e.suspended)) },
                          "-",
                          { label: <span className="error-text">{t("common.delete")}</span>, onSelect: () => setDeleting(e) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown.length === 0 && entries.length > 0 && <p className="muted">{t("vocabView.noMatch")}</p>}
      </div>
      {deleting && (
        <ConfirmDialog title={t("vocabView.confirmDelete", { word: deleting.headword })} confirm={t("common.delete")}
          onConfirm={() => { const id = deleting.id; setDeleting(null); void act(() => api.vocabDelete(id)); }} onCancel={() => setDeleting(null)}>
          <p>{t("vocabView.deleteDesc")}</p>
        </ConfirmDialog>
      )}
    </main>
  );
}
