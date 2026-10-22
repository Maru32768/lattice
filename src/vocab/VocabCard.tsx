import { useEffect, useRef, useState } from "react";
import type { Grade, VocabContext, VocabReviewItem } from "../api";
import { GradeRow, gradeKey } from "../quiz/QuizCard";
import { findWord } from "./vocab";
import { autoplay, onReplay, speak, useEnglishVoice } from "./speech";
import { Icon } from "../ui/Icon";
import "../quiz/quiz.css";
import "./vocab.css";
import { useT } from "../i18n";

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
 * One vocabulary card, Anki's basic word → meaning. Front: the word, its IPA and part of speech,
 * said aloud. Back: the English definition and an example, then smaller the Japanese gloss and
 * the sentence it was captured in. Then the grade, as for a quiz question. Remount (key) per card.
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
  const voice = useEnglishVoice();
  const said = useRef(false);
  const c = item.context;
  // A meaning typed by hand has no definition: it is the answer itself.
  const answer = item.definition || item.meaning;

  useEffect(() => {
    if (!voice) return;
    if (!said.current && autoplay()) speak(item.headword, voice);
    said.current = true;
    return onReplay(() => speak(item.headword, voice));
  }, [voice, item.headword]);

  const say = (text: string, label: string) => voice && (
    <button className="ib vc-say" onClick={() => speak(text, voice)} aria-label={label} title={label}><Icon name="speaker" /></button>
  );

  return (
    <div className="qz-card" onKeyDown={(e) => gradeKey(e, shown, onGrade)}>
      <div className="vc-front">
        <p className="vc-word"><span lang="en">{item.headword}</span>{say(item.headword, t("vocabCard.sayWord"))}</p>
        {(item.ipa || item.pos) && (
          <p className="vc-sub">
            {item.ipa && <span className="vc-ipa">/{item.ipa}/</span>}
            {item.pos && <span className="vc-pos">{item.pos}</span>}
          </p>
        )}
      </div>
      {!shown && <button className="btn pri vc-show" autoFocus onClick={() => setShown(true)}>{t("quizCard.reveal")}</button>}
      {shown && (
        <div className="qz-reveal vc-back">
          <section className="vc-field" aria-label={t("vocabCard.meaning")}>
            <span className="cap">{t("vocabCard.meaning")}</span>
            <p className="vc-def" role="status" lang={item.definition ? "en" : undefined}>{answer}</p>
          </section>
          {item.example && (
            <section className="vc-field" aria-label={t("vocabCard.example")}>
              <span className="cap">{t("vocabCard.example")}</span>
              <p className="vc-example"><span lang="en">{item.example}</span>{say(item.example, t("vocabCard.sayExample"))}</p>
            </section>
          )}
          <div className="vc-more">
            {item.definition && item.meaning && <p className="vc-gloss"><span className="cap">{t("vocabCard.gloss")}</span>{item.meaning}</p>}
            <p className="vc-context" lang="en"><span className="cap">{t("vocabCard.context")}</span><Sentence c={c} /></p>
            {(c.article_id != null || c.url) && (
              <div className="qz-src">
                <button className="chip" onClick={onSource} title={c.title ?? c.url ?? undefined}>{t("vocabCard.source")}</button>
              </div>
            )}
          </div>
          <GradeRow hint={null} previews={item.previews} onGrade={onGrade} />
        </div>
      )}
    </div>
  );
}
