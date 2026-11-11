import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type VocabEntry } from "../api";
import { wordMarks } from "../vocab/vocab";
import { savePref, useSynced } from "../lib/prefs";

const MARKS_KEY = "lattice.vocabMarks";
/** Whether saved words are underlined in the Reader (default on). */
function loadMarks(): boolean {
  try {
    return localStorage.getItem(MARKS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Vocabulary (G56): the book, its marks in the Reader, and the 単語を登録 shortcut. `onChanged`: the book changed, so may the due reviews. */
export function useVocab(onChanged: () => void) {
  const [vocab, setVocab] = useState<VocabEntry[]>([]);
  const [marksOn, setMarksOn] = useSynced(MARKS_KEY, loadMarks);
  const [saveWordSeq, setSaveWordSeq] = useState(0);
  const marks = useMemo(() => (marksOn ? wordMarks(vocab) : null), [vocab, marksOn]);
  const loadVocab = () => {
    void api
      .vocabList()
      .then(setVocab)
      .catch(() => {});
    onChanged();
  };
  const setMarks = (on: boolean) => {
    setMarksOn(on);
    savePref(MARKS_KEY, on ? "on" : "off");
  };
  const onVocabChanged = useEffectEvent(loadVocab);
  useEffect(() => {
    onVocabChanged();
    // The job filled in meanings, or a page's overlay saved a word.
    const sub = listen("vocab-changed", () => onVocabChanged());
    return () => void sub.then((f) => f());
  }, []);
  return { vocab, marksOn, setMarks, marks, loadVocab, saveWordSeq, saveWord: () => setSaveWordSeq((n) => n + 1) };
}
