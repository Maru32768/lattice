import { useEffect, useState } from "react";
import { api, type Grade, type ReviewItem, type ReviewOverview } from "./api";
import { QuizCard } from "./QuizCard";
import { GRADES } from "./quiz";
import { relTime } from "./time";
import { Menu } from "./Popover";
import { Icon } from "./Icon";
import "./manage.css";
import "./quiz.css";
import { t, useT } from "./i18n";

const when = (unix: number | null) => (unix == null ? "—" : unix * 1000 <= Date.now() ? t("quizReview.dueNow") : relTime(new Date(unix * 1000).toISOString(), t));

/** 今日の復習: today's due cards one by one, then a summary; and the articles in review. */
export function QuizReview({ onOpen, onChanged }: {
  /** Opens the article in the Reader, at `block` when given. */
  onOpen: (articleId: number, block?: number) => void;
  /** Cards were answered or removed (the nav badge). */
  onChanged: () => void;
}) {
  const t = useT();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState<Grade[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<void>) {
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(String(e));
    }
  }
  const refreshOverview = () => run(async () => setOverview(await api.reviewOverview()));
  const start = () => run(async () => {
    const [q, o] = await Promise.all([api.reviewQueue(), api.reviewOverview()]);
    setItems(q);
    setOverview(o);
    setAt(0);
    setAnswered([]);
  });
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once on open
  useEffect(() => { void start(); }, []);

  const item = items?.[at];
  const finished = items != null && !item;
  // The summary shows when the next cards come due, so it re-reads the overview at the end.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per session end
  useEffect(() => { if (finished && answered.length > 0) void refreshOverview(); }, [finished]);

  const grade = (g: Grade) => item && run(async () => {
    await api.reviewGrade(item.id, g);
    setAnswered((a) => [...a, g]);
    setAt((n) => n + 1);
    onChanged();
  });
  const dropCard = () => item && run(async () => {
    await api.reviewRemoveCard(item.id);
    setItems((xs) => xs && xs.filter((x) => x.id !== item.id));
    onChanged();
    await refreshOverview();
  });
  const dropArticle = (articleId: number) => run(async () => {
    await api.reviewRemoveArticle(articleId);
    // Cards already answered stay counted; the rest of that article's cards leave the session.
    setItems((xs) => xs && xs.filter((x, i) => i < at || x.article_id !== articleId));
    onChanged();
    await refreshOverview();
  });

  const left = items ? items.length - at : 0;
  const fresh = items ? items.slice(at).filter((x) => x.new).length : 0;
  const articles = overview?.articles ?? [];

  return (
    <main className="manage">
      <div className="wrap qz-review">
        <header className="head base">
          <h1>{t("common.todaysReview")}</h1>
          {items && left > 0 && <span className="sub">{t("quizReview.left", { left })}{fresh > 0 && t("quizReview.fresh", { fresh })}</span>}
          <span className="aside">{t("quizReview.settingsHint")}</span>
        </header>
        {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}

        {item && (
          <section className="card qz-session" aria-label={t("quizReview.card")}>
            <div className="qz-session-h">
              <span className="mono muted">{at + 1} / {items.length}</span>
              {item.new && <span className="bd run">{t("quizReview.new")}</span>}
              <button className="linkish qz-art" onClick={() => onOpen(item.article_id)} title={t("quizReview.openArticle")}>{item.article_title}</button>
              <Menu className="ib" label={t("quizReview.cardActions")} align="right" trigger={<Icon name="more" />} items={[
                { label: t("quizReview.removeCard"), onSelect: () => void dropCard() },
                { label: t("quizReview.removeArticle"), onSelect: () => void dropArticle(item.article_id) },
              ]} />
            </div>
            <QuizCard key={item.id} q={item} previews={item.previews} onGrade={(g) => void grade(g)} onSource={(b) => onOpen(item.article_id, b)} />
          </section>
        )}

        {finished && (
          <section className="card qz-session qz-summary" role="status">
            {answered.length > 0 && <>
              <p className="qz-score">{t.rich("quizReview.reviewed", { n: <b>{answered.length}</b> })}</p>
              <p className="qz-tally">{GRADES.map(({ grade, label }) => <span key={grade}>{t(label)} {answered.filter((g) => g === grade).length}</span>)}</p>
            </>}
            {overview && overview.due > 0
              ? <button className="btn pri" onClick={() => void start()}>{t("quizReview.continue", { due: overview.due })}</button>
              : articles.length > 0
                ? <p className="muted">{t("quizReview.done")}{overview?.next_due_at != null && t("quizReview.next", { when: when(overview.next_due_at) })}</p>
                : <p className="muted">{t("quizReview.empty")}</p>}
          </section>
        )}

        {articles.length > 0 && (
          <>
            <h2>{t("quizReview.articles")}</h2>
            <div className="card scroll">
              <table className="tbl dense">
                <thead><tr><th>{t("common.article")}</th><th className="r">{t("quizReview.cards")}</th><th>{t("quizReview.nextDue")}</th><th><span className="vh">{t("common.actions")}</span></th></tr></thead>
                <tbody>
                  {articles.map((a) => (
                    <tr key={a.article_id}>
                      <td className="art"><button className="linkish" onClick={() => onOpen(a.article_id)}>{a.title}</button></td>
                      <td className="r m">{a.cards}</td>
                      <td className="m">{when(a.next_due_at)}</td>
                      <td className="r"><button className="btn sm ghost" onClick={() => void dropArticle(a.article_id)} aria-label={t("quizReview.removeTitle", { title: a.title })}>{t("quizReview.remove")}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
