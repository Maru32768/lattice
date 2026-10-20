import { useEffect, useState } from "react";
import { api, type ArticleView, type Grade, type Quiz } from "./api";
import { QuizCard } from "./QuizCard";
import { knownCount } from "./quiz";
import { Icon } from "./Icon";
import "./quiz.css";
import { locale, useT } from "./i18n";

/** 理解度チェック beside the Reader: take the article's quiz, then optionally add it to review. */
export function QuizPanel({ view, onSource, onReviewChanged, onClose }: {
  view: ArticleView;
  /** Scrolls the Reader to a block the answer comes from. */
  onSource: (blockId: number) => void;
  /** Cards were added to or removed from review (the nav badge). */
  onReviewChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = view.article.id;
  const job = view.jobs.find((j) => j.type === "quiz");
  const running = job?.status === "running" || (job?.status === "pending" && !job.last_error);
  const failure = job?.last_error && !running && job.status !== "succeeded" ? job.last_error : null;
  const [quiz, setQuiz] = useState<Quiz | null | undefined>(undefined);
  /** The quiz shown when 作成 was pressed: generating until a newer one arrives or the job fails. */
  const [requested, setRequested] = useState<number | null | false>(false);
  const [at, setAt] = useState(0);
  const [grades, setGrades] = useState<Map<number, Grade>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = () => api.quiz(id).then(setQuiz, (e) => setError(String(e)));
  // The job's progress reaches the view by article-changed; reload the quiz when it moves.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- load reads only id
  useEffect(() => { void load(); }, [id, job?.status, job?.attempt_count]);
  useEffect(() => { setAt(0); setGrades(new Map()); }, [quiz?.id]);

  const generating = !failure && (running || (requested !== false && (quiz?.id ?? null) === requested));
  async function generate() {
    setError(null);
    setRequested(quiz?.id ?? null);
    try {
      await api.quizArticle(id);
      await load();
    } catch (e) {
      setRequested(false);
      setError(String(e));
    }
  }

  async function review(add: boolean) {
    if (!quiz) return;
    setError(null);
    try {
      const n = add ? await api.reviewAdd(quiz.id, [...grades].map(([question_id, grade]) => ({ question_id, grade }))) : 0;
      if (!add) await api.reviewRemoveArticle(id);
      setQuiz({ ...quiz, in_review: n });
      onReviewChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  const total = quiz?.questions.length ?? 0;
  const q = quiz?.questions[at];
  const reviewRow = quiz && (quiz.in_review > 0
    ? <><span className="qz-in">{t("quizPanel.inReview", { in_review: quiz.in_review })}</span><button className="tb" onClick={() => review(false)}>{t("quizPanel.removeFromReview")}</button></>
    : <button className="tb" onClick={() => review(true)} title={t("quizPanel.addHint")}>{t("quizPanel.addToReview")}</button>);

  return (
    <aside className="qz-panel" aria-label={t("quizPanel.title")}>
      <div className="qz-h">
        <Icon name="quiz" />
        <span className="qz-title">{t("quizPanel.title")}</span>
        {q && <span className="qz-n mono">{at + 1} / {total}</span>}
        <button className="ib push" onClick={onClose} aria-label={t("quizPanel.close")} title={t("common.close")}><Icon name="x" /></button>
      </div>
      <div className="qz-body">
        {quiz === null && (
          <div className="qz-empty">
            <p>{t("quizPanel.intro")}</p>
            {generating ? <p className="muted" role="status">{t("quizPanel.generating")}</p> : <button className="btn pri" onClick={generate}>{t("quizPanel.generate")}</button>}
          </div>
        )}
        {quiz && q && <QuizCard key={q.id} q={q} onSource={onSource} onGrade={(g) => { setGrades((m) => new Map(m).set(q.id, g)); setAt(at + 1); }} />}
        {quiz && !q && (
          <div className="qz-done" role="status">
            <p className="qz-score">{t.rich("quizPanel.score", { known: <b>{knownCount(grades.values())}</b>, total })}</p>
            {quiz.in_review === 0
              ? <>
                  <button className="btn pri" onClick={() => review(true)}>{t("quizPanel.addToReview")}</button>
                  <p className="muted">{t("quizPanel.addDesc")}</p>
                </>
              : <p className="muted">{t("quizPanel.reviewing", { in_review: quiz.in_review })}</p>}
            <button className="btn" onClick={() => { setAt(0); setGrades(new Map()); }}>{t("quizPanel.retry")}</button>
          </div>
        )}
        {failure && <p className="qz-note error-text" title={t.msg(failure)}>{t("quizPanel.failed", { failure: t.msg(failure) })}</p>}
        {error && <p className="qz-note error-text" role="alert">{t.msg(error)}</p>}
      </div>
      {quiz && (
        <div className="qz-foot">
          {quiz.stale && <p className="qz-note muted">{t("quizPanel.stale")}</p>}
          <div className="qz-meta">
            <span>{t("quizPanel.created", { date: new Date(quiz.created_at).toLocaleDateString(locale(t.lang), { month: "2-digit", day: "2-digit" }) })}</span>
            {generating ? <span>{t("quizPanel.regenerating")}</span> : <button className="tb" onClick={generate}>{t("quizPanel.regenerate")}</button>}
            <span className="push" />
            {/* At the end the summary offers 復習に追加 itself. */}
            {(q || quiz.in_review > 0) && reviewRow}
          </div>
        </div>
      )}
    </aside>
  );
}
