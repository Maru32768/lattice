import { useEffect, useState } from "react";
import { api, type Grade, type ReviewItem, type ReviewOverview, type VocabContext } from "../api";
import { QuizCard } from "./QuizCard";
import { VocabCard } from "../vocab/VocabCard";
import { hostOf } from "../ui/Favicon";
import { GRADES } from "./quiz";
import { relTime } from "../lib/time";
import { Menu } from "../ui/Popover";
import { Icon } from "../ui/Icon";
import "../ui/manage.css";
import "./quiz.css";
import { useT, type T } from "../i18n";

const when = (unix: number | null, t: T) => (unix == null ? "—" : unix * 1000 <= Date.now() ? t("quizReview.dueNow") : relTime(new Date(unix * 1000).toISOString(), t));

const same = (a: ReviewItem, b: ReviewItem) => a.type === b.type && a.id === b.id;

/** 今日の復習: today's due cards (quiz questions and words) one by one, then a summary; and the articles in review. */
export function QuizReview({ onOpen, onOpenPage, onChanged }: {
  /** Opens the article in the Reader, at `block` when given, marked with `label`. */
  onOpen: (articleId: number, block?: number, label?: string) => void;
  /** Opens a page a word was captured from, scrolled to `text`. */
  onOpenPage: (url: string, text: string) => void;
  /** Cards were answered or removed (the nav badge). */
  onChanged: () => void;
}) {
  const t = useT();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState<Grade[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Cards start on a press, not on opening the screen: a word card speaks as it appears.
  const [started, setStarted] = useState(false);

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
  useEffect(() => {
    Promise.all([api.reviewQueue(), api.reviewOverview()]).then(([q, o]) => { setItems(q); setOverview(o); }).catch((e) => setError(String(e)));
  }, []);

  const item = items?.[at];
  const finished = items != null && !item;

  const grade = (g: Grade) => item && run(async () => {
    await (item.type === "quiz" ? api.reviewGrade(item.id, g) : api.vocabGrade(item.id, g));
    setAnswered((a) => [...a, g]);
    setAt((n) => n + 1);
    onChanged();
    // The summary shows when the next cards come due, so the last card re-reads the overview.
    if (at + 1 === items?.length) setOverview(await api.reviewOverview());
  });
  const dropCard = () => item && run(async () => {
    // A word's cards are suspended together (単語帳 resumes them).
    await (item.type === "quiz" ? api.reviewRemoveCard(item.id) : api.vocabSuspend(item.entry_id, true));
    setItems((xs) => xs && xs.filter((x, i) => i < at || !(same(x, item) || (item.type === "vocab" && x.type === "vocab" && x.entry_id === item.entry_id))));
    onChanged();
    await refreshOverview();
  });
  const dropArticle = (articleId: number) => run(async () => {
    await api.reviewRemoveArticle(articleId);
    // Cards already answered stay counted; the rest of that article's cards leave the session.
    setItems((xs) => xs && xs.filter((x, i) => i < at || x.type !== "quiz" || x.article_id !== articleId));
    onChanged();
    await refreshOverview();
  });

  const left = items ? items.length - at : 0;
  const fresh = items ? items.slice(at).filter((x) => x.new).length : 0;
  const articles = overview?.articles ?? [];
  const openContext = (c: VocabContext) =>
    c.article_id != null ? onOpen(c.article_id, c.block_id ?? undefined, t("vocabCard.sourceLabel")) : c.url && onOpenPage(c.url, c.sentence);

  return (
    <main className="manage">
      <div className="wrap qz-review">
        <header className="head base">
          <h1>{t("common.todaysReview")}</h1>
          {items && left > 0 && <span className="sub">{t("quizReview.left", { left })}{fresh > 0 && t("quizReview.fresh", { fresh })}</span>}
          <span className="aside">{t("quizReview.settingsHint")}</span>
        </header>
        {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}

        {item && !started && (
          <section className="card qz-session qz-start" aria-label={t("quizReview.start")}>
            <p className="qz-score">{t.rich("quizReview.ready", { n: <b>{left}</b> })}{fresh > 0 && t("quizReview.fresh", { fresh })}</p>
            <p className="qz-tally">{t("quizReview.kinds", { quiz: items.slice(at).filter((x) => x.type === "quiz").length, words: items.slice(at).filter((x) => x.type === "vocab").length })}</p>
            <button className="btn pri" autoFocus onClick={() => setStarted(true)}>{t("quizReview.start")}</button>
            {items.some((x) => x.type === "vocab") && <p className="muted">{t("quizReview.startHint")}</p>}
          </section>
        )}

        {item && started && (
          <section className="card qz-session" aria-label={t("quizReview.card")}>
            <div className="qz-session-h">
              <span className="mono muted">{at + 1} / {items.length}</span>
              {item.new && <span className="bd run">{t("quizReview.new")}</span>}
              {item.type === "quiz"
                ? <button className="linkish qz-art" onClick={() => onOpen(item.article_id)} title={t("quizReview.openArticle")}>{item.article_title}</button>
                : <button className="linkish qz-art" onClick={() => openContext(item.context)} title={t("vocabCard.source")}
                    disabled={item.context.article_id == null && !item.context.url}>
                    {item.context.title ?? (item.context.url ? hostOf(item.context.url) : t("vocabCard.word"))}
                  </button>}
              <Menu className="ib" label={t("quizReview.cardActions")} align="right" trigger={<Icon name="more" />} items={item.type === "quiz" ? [
                { label: t("quizReview.removeCard"), onSelect: () => void dropCard() },
                { label: t("quizReview.removeArticle"), onSelect: () => void dropArticle(item.article_id) },
              ] : [
                { label: t("vocabCard.suspend"), onSelect: () => void dropCard() },
              ]} />
            </div>
            {item.type === "quiz"
              ? <QuizCard key={`q${item.id}`} q={item} previews={item.previews} onGrade={(g) => void grade(g)} onSource={(b) => onOpen(item.article_id, b)} />
              : <VocabCard key={`v${item.id}`} item={item} onGrade={(g) => void grade(g)} onSource={() => openContext(item.context)} />}
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
                ? <p className="muted">{t("quizReview.done")}{overview?.next_due_at != null && t("quizReview.next", { when: when(overview.next_due_at, t) })}</p>
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
                      <td className="m">{when(a.next_due_at, t)}</td>
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
