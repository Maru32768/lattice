import { useEffect, useState } from "react";
import { api, type ArticleView, type Grade, type Quiz } from "./api";
import { QuizCard } from "./QuizCard";
import { knownCount } from "./quiz";
import { Icon } from "./Icon";
import "./quiz.css";

/** 理解度チェック beside the Reader: take the article's quiz, then optionally add it to review. */
export function QuizPanel({ view, onSource, onReviewChanged, onClose }: {
  view: ArticleView;
  /** Scrolls the Reader to a block the answer comes from. */
  onSource: (blockId: number) => void;
  /** Cards were added to or removed from review (the nav badge). */
  onReviewChanged: () => void;
  onClose: () => void;
}) {
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
    ? <><span className="qz-in">復習中 · {quiz.in_review} 枚</span><button className="tb" onClick={() => review(false)}>復習から外す</button></>
    : <button className="tb" onClick={() => review(true)} title="答えた問題はその結果を最初の復習として記録します">復習に追加</button>);

  return (
    <aside className="qz-panel" aria-label="理解度チェック">
      <div className="qz-h">
        <Icon name="quiz" />
        <span className="qz-title">理解度チェック</span>
        {q && <span className="qz-n mono">{at + 1} / {total}</span>}
        <button className="ib push" onClick={onClose} aria-label="理解度チェックを閉じる" title="閉じる"><Icon name="x" /></button>
      </div>
      <div className="qz-body">
        {quiz === null && (
          <div className="qz-empty">
            <p>この記事の要点を確かめる問題を 3〜8 問作ります（記述と 4 択）。答えたあと「復習に追加」すると、間隔を空けて「今日の復習」で出題します。</p>
            {generating ? <p className="muted" role="status">作成中…</p> : <button className="btn pri" onClick={generate}>クイズを作成</button>}
          </div>
        )}
        {quiz && q && <QuizCard key={q.id} q={q} onSource={onSource} onGrade={(g) => { setGrades((m) => new Map(m).set(q.id, g)); setAt(at + 1); }} />}
        {quiz && !q && (
          <div className="qz-done" role="status">
            <p className="qz-score"><b>{knownCount(grades.values())}</b> / {total} 問 答えられました</p>
            {quiz.in_review === 0
              ? <>
                  <button className="btn pri" onClick={() => review(true)}>復習に追加</button>
                  <p className="muted">今日の結果を最初の復習として、Anki と同じように間隔を空けて出題します（間隔は 設定 › 復習）。</p>
                </>
              : <p className="muted">復習中です（{quiz.in_review} 枚）。「今日の復習」で出題します。</p>}
            <button className="btn" onClick={() => { setAt(0); setGrades(new Map()); }}>もう一度解く</button>
          </div>
        )}
        {failure && <p className="qz-note error-text" title={failure}>クイズの作成に失敗: {failure}</p>}
        {error && <p className="qz-note error-text" role="alert">{error}</p>}
      </div>
      {quiz && (
        <div className="qz-foot">
          {quiz.stale && <p className="qz-note muted">本文か「自分について」が変わっています。作り直すと反映されます</p>}
          <div className="qz-meta">
            <span>{new Date(quiz.created_at).toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit" })} 作成</span>
            {generating ? <span>作り直し中…</span> : <button className="tb" onClick={generate}>作り直す</button>}
            <span className="push" />
            {/* At the end the summary offers 復習に追加 itself. */}
            {(q || quiz.in_review > 0) && reviewRow}
          </div>
        </div>
      )}
    </aside>
  );
}
