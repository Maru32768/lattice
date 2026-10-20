import { useState } from "react";
import type { Grade, QuizQuestion } from "./api";
import { GRADES, formatInterval, suggestedGrade } from "./quiz";
import "./quiz.css";

/**
 * One question: answer (pick an option, or reveal after recalling), then the answer, its
 * explanation and sources, and the grade. A multiple-choice answer preselects 正解 or もう一度;
 * any grade can override it. The grade row takes focus (Enter accepts, as Space does in Anki) and
 * keys 1–4 pick a grade. Remount (key) per question.
 * Question text is model output over an untrusted page: text nodes only.
 */
export function QuizCard({ q, previews, onGrade, onSource }: {
  q: QuizQuestion;
  /** Minutes until the next review after each grade (review only). */
  previews?: number[];
  onGrade: (g: Grade) => void;
  onSource: (blockId: number) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const shown = revealed || chosen != null;
  const hint = suggestedGrade(q, chosen);

  const keys = (e: React.KeyboardEvent) => {
    const i = "1234".indexOf(e.key);
    if (!shown || i < 0 || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    onGrade(GRADES[i].grade);
  };

  return (
    <div className="qz-card" onKeyDown={keys}>
      <p className="qz-q">{q.question}</p>
      {q.kind === "choice" ? (
        <div className="qz-opts" role="group" aria-label="選択肢">
          {q.options.map((o, i) => {
            const tone = shown && o === q.answer ? " right" : chosen === o ? " wrong" : "";
            return (
              <button key={i} className={`qz-opt${tone}`} disabled={shown} aria-pressed={chosen === o} onClick={() => setChosen(o)}>
                <span className="k" aria-hidden="true">{"ABCD"[i]}</span><span>{o}</span>
              </button>
            );
          })}
        </div>
      ) : !revealed && (
        <div className="qz-recall">
          <textarea className="qz-draft" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="自分の答え"
            placeholder="自分の答え（任意・保存されません）" />
          <button className="btn pri" onClick={() => setRevealed(true)}>答えを見る</button>
        </div>
      )}
      {shown && (
        <div className="qz-reveal">
          {q.kind === "choice"
            ? <p className={`qz-verdict ${chosen === q.answer ? "ok" : "ng"}`} role="status">{chosen === q.answer ? "正解" : `不正解 · 答えは「${q.answer}」`}</p>
            : <>
                {draft.trim() && <p className="qz-mine"><span className="cap">自分の答え</span>{draft}</p>}
                <p className="qz-answer" role="status"><span className="cap">答え</span>{q.answer}</p>
              </>}
          {q.explanation && <p className="qz-expl">{q.explanation}</p>}
          {q.block_ids.length > 0 && (
            <div className="qz-src">
              {q.block_ids.map((b, i) => (
                <button key={b} className="chip" onClick={() => onSource(b)} title="記事のこの箇所へ移動">出典{q.block_ids.length > 1 ? ` ${i + 1}` : ""}へ</button>
              ))}
            </div>
          )}
          <div className="qz-grades" role="group" aria-label={hint ? "評価（変更できます）" : "どのくらい答えられましたか"}>
            {GRADES.map(({ grade, label }, i) => (
              <button key={grade} className={`btn${hint === grade ? " pri" : ""}`} autoFocus={hint ? hint === grade : i === 2} onClick={() => onGrade(grade)}
                title={`${label} (${i + 1})`}>
                {label}{previews && <span className="ivl">{formatInterval(previews[i])}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
