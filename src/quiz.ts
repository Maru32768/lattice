import type { Grade, QuizQuestion } from "./api";
import type { PlainKey, T } from "./i18n/index.ts";

/** In the order of `ReviewItem.previews`; Anki's labels. */
export const GRADES: { grade: Grade; label: PlainKey }[] = [
  { grade: "again", label: "quiz.again" },
  { grade: "hard", label: "quiz.hard" },
  { grade: "good", label: "quiz.good" },
  { grade: "easy", label: "quiz.easy" },
];

const tenths = (n: number) => String(Math.round(n * 10) / 10);

/** A review interval: "10分", "4時間", "6日", "1.5か月", "2年" (ja). */
export function formatInterval(minutes: number, t: T): string {
  if (minutes < 60) return t("quiz.minutes", { n: minutes });
  if (minutes < 24 * 60) return t("quiz.hours", { n: Math.round(minutes / 60) });
  const days = Math.round(minutes / (24 * 60));
  if (days < 31) return t("quiz.days", { n: days });
  if (days < 365) return t("quiz.months", { n: tenths(days / 30) });
  return t("quiz.years", { n: tenths(days / 365) });
}

/** The grade a multiple-choice answer suggests (right: 正解, wrong: もう一度); recall is self-graded. */
export const suggestedGrade = (q: QuizQuestion, chosen: string | null): Grade | null =>
  q.kind === "choice" && chosen != null ? (chosen === q.answer ? "good" : "again") : null;

/** Answers counted as known: anything but もう一度. */
export const knownCount = (grades: Iterable<Grade>) => [...grades].filter((g) => g !== "again").length;
