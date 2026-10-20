import { useState } from "react";
import type { Grade, VocabContext, VocabReviewItem } from "./api";
import { GradeRow, gradeKey } from "./QuizCard";
import { cloze, findWord } from "./vocab";
import "./quiz.css";
import "./vocab.css";
import { useT } from "./i18n";

/** The sentence with the captured form emphasized. */
function Sentence({ c }: { c: VocabContext }) {
  const spans = findWord(c.sentence, c.surface);
  if (spans.length === 0) return <>{c.sentence}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(([s, e], i) => {
    out.push(c.sentence.slice(at, s), <b key={i}>{c.sentence.slice(s, e)}</b>);
    at = e;
  });
  out.push(c.sentence.slice(at));
  return <>{out}</>;
}

/**
 * One vocabulary card. Cloze: the context sentence with the word blanked and its meaning as the
 * hint; recall the English. Meaning: the word; recall what it means, with the sentence after
 * reveal. Then the grade, as for a quiz question. Remount (key) per card.
 * Words, meanings and sentences come from pages and the LLM: text nodes only.
 */
export function VocabCard({ item, onGrade, onSource }: {
  item: VocabReviewItem;
  onGrade: (g: Grade) => void;
  /** Opens where the word was captured. */
  onSource: () => void;
}) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const c = item.context;
  const parts = cloze(c.sentence, c.surface);
  const head = (
    <p className="vc-word">
      <span lang="en">{item.headword}</span>
      {item.ipa && <span className="vc-ipa">/{item.ipa}/</span>}
      {item.pos && <span className="vc-pos">{item.pos}</span>}
    </p>
  );

  return (
    <div className="qz-card" onKeyDown={(e) => gradeKey(e, shown, onGrade)}>
      {item.kind === "cloze" ? (
        <>
          <p className="qz-q vc-cloze" lang="en">
            {parts.map((p, i) => !p.blank ? p.v
              : shown ? <b key={i} className="vc-fill">{p.v}</b>
              : <span key={i} className="vc-blank" role="img" aria-label={t("vocabCard.blank")} />)}
          </p>
          <p className="vc-hint"><span className="cap">{t("vocabCard.hint")}</span>{item.meaning}</p>
        </>
      ) : head}
      {!shown && <button className="btn pri vc-show" autoFocus onClick={() => setShown(true)}>{t("quizCard.reveal")}</button>}
      {shown && (
        <div className="qz-reveal">
          {item.kind === "cloze" ? head : <p className="qz-answer" role="status">{item.meaning}</p>}
          {item.definition && <p className="qz-expl" lang="en">{item.definition}</p>}
          {item.example && <p className="vc-example" lang="en">{item.example}</p>}
          {item.kind === "meaning" && <p className="vc-context" lang="en"><span className="cap">{t("vocabCard.context")}</span><Sentence c={c} /></p>}
          {(c.article_id != null || c.url) && (
            <div className="qz-src">
              <button className="chip" onClick={onSource} title={c.title ?? c.url ?? undefined}>{t("vocabCard.source")}</button>
            </div>
          )}
          <GradeRow hint={null} previews={item.previews} onGrade={onGrade} />
        </div>
      )}
    </div>
  );
}
