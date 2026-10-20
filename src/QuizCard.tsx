import { useState } from "react";
import type { Grade, QuizQuestion } from "./api";
import { GRADES, formatInterval, suggestedGrade } from "./quiz";
import "./quiz.css";
import { useT } from "./i18n";

/** Keys 1–4 grade a revealed card (outside text fields). */
export function gradeKey(e: React.KeyboardEvent, shown: boolean, onGrade: (g: Grade) => void) {
  const i = "1234".indexOf(e.key);
  if (!shown || i < 0 || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopPropagation();
  onGrade(GRADES[i].grade);
}

/** もう一度 / 難しい / 正解 / 簡単, with the next intervals in review; `hint` is preselected and focused (else 正解). */
export function GradeRow({ hint, previews, onGrade }: { hint: Grade | null; previews?: number[]; onGrade: (g: Grade) => void }) {
  const t = useT();
  return (
    <div className="qz-grades" role="group" aria-label={hint ? t("quizCard.gradeChange") : t("quizCard.gradeAsk")}>
      {GRADES.map(({ grade, label }, i) => (
        <button key={grade} className={`btn${hint === grade ? " pri" : ""}`} autoFocus={hint ? hint === grade : i === 2} onClick={() => onGrade(grade)}
          title={`${label} (${i + 1})`}>
          {t(label)}{previews && <span className="ivl">{formatInterval(previews[i], t)}</span>}
        </button>
      ))}
    </div>
  );
}

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
  const t = useT();
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const shown = revealed || chosen != null;
  const hint = suggestedGrade(q, chosen);

  return (
    <div className="qz-card" onKeyDown={(e) => gradeKey(e, shown, onGrade)}>
      <p className="qz-q">{q.question}</p>
      {q.kind === "choice" ? (
        <div className="qz-opts" role="group" aria-label={t("quizCard.options")}>
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
          <textarea className="qz-draft" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t("quizCard.yourAnswer")}
            placeholder={t("quizCard.yourAnswerPlaceholder")} />
          <button className="btn pri" onClick={() => setRevealed(true)}>{t("quizCard.reveal")}</button>
        </div>
      )}
      {shown && (
        <div className="qz-reveal">
          {q.kind === "choice"
            ? <p className={`qz-verdict ${chosen === q.answer ? "ok" : "ng"}`} role="status">{chosen === q.answer ? t("quizCard.correct") : t("quizCard.wrong", { answer: q.answer })}</p>
            : <>
                {draft.trim() && <p className="qz-mine"><span className="cap">{t("quizCard.yourAnswer")}</span>{draft}</p>}
                <p className="qz-answer" role="status"><span className="cap">{t("quizCard.answer")}</span>{q.answer}</p>
              </>}
          {q.explanation && <p className="qz-expl">{q.explanation}</p>}
          {q.block_ids.length > 0 && (
            <div className="qz-src">
              {q.block_ids.map((b, i) => (
                <button key={b} className="chip" onClick={() => onSource(b)} title={t("quizCard.sourceHint")}>{t.rich("quizCard.source", { x: q.block_ids.length > 1 ? ` ${i + 1}` : "" })}</button>
              ))}
            </div>
          )}
          <GradeRow hint={hint} previews={previews} onGrade={onGrade} />
        </div>
      )}
    </div>
  );
}
