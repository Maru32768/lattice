import { useEffect, useState } from "react";
import { api, type ArticleView, type Grade, type Quiz } from "../api";
import { QuizCard } from "./QuizCard";
import { knownCount } from "./quiz";
import { Icon } from "../ui/Icon";
import "./quiz.css";
import { locale, useT } from "../i18n";

/** Where a quiz was left: the question shown and the grades so far. */
interface Progress { quizId: number; at: number; grades: Map<number, Grade> }

// The Reader unmounts when another screen (処理状況, 設定, …) or tab is shown; the open panels and
// their progress outlive it here, by article id, until the app restarts.
const openPanels = new Set<number>();
const progress = new Map<number, Progress>();

/** Whether the article's 理解度チェック is open, remembered across Reader remounts. */
export function useQuizOpen(id: number) {
  const [open, setOpen] = useState(() => openPanels.has(id));
  useEffect(() => { if (open) openPanels.add(id); else openPanels.delete(id); }, [id, open]);
  return [open, setOpen] as const;
}

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
  const [kept, setKept] = useState(() => progress.get(id) ?? null);
  // Progress belongs to one quiz: a regenerated quiz starts from its first question.
  const { at, grades } = quiz && kept?.quizId === quiz.id ? kept : { at: 0, grades: new Map<number, Grade>() };
  const keep = (p: Progress) => {
    progress.set(id, p);
    setKept(p);
  };
  const restart = () => quiz && keep({ quizId: quiz.id, at: 0, grades: new Map() });
  const [error, setError] = useState<string | null>(null);

  const load = () => api.quiz(id).then(setQuiz, (e: unknown) => setError(String(e)));
  // The job's progress reaches the view by article-changed; reload the quiz when it moves.
  useEffect(() => {
    api.quiz(id).then(setQuiz, (e: unknown) => setError(String(e)));
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the job's state is the trigger, not an input
  }, [id, job?.status, job?.attempt_count]);

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
      let n = 0;
      if (add) n = await api.reviewAdd(quiz.id, [...grades].map(([question_id, grade]) => ({ question_id, grade })));
      else await api.reviewRemoveArticle(id);
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
        {quiz && q && <QuizCard key={q.id} q={q} onSource={onSource} onGrade={(g) => keep({ quizId: quiz.id, at: at + 1, grades: new Map(grades).set(q.id, g) })} />}
        {quiz && !q && (
          <div className="qz-done" role="status">
            <p className="qz-score">{t.rich("quizPanel.score", { known: <b>{knownCount(grades.values())}</b>, total })}</p>
            {quiz.in_review === 0
              ? <>
                  <button className="btn pri" onClick={() => review(true)}>{t("quizPanel.addToReview")}</button>
                  <p className="muted">{t("quizPanel.addDesc")}</p>
                </>
              : <p className="muted">{t("quizPanel.reviewing", { in_review: quiz.in_review })}</p>}
            <button className="btn" onClick={restart}>{t("quizPanel.retry")}</button>
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
