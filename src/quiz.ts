import type { Grade, QuizQuestion } from "./api";

/** In the order of `ReviewItem.previews`; Anki's Japanese labels. */
export const GRADES: { grade: Grade; label: string }[] = [
  { grade: "again", label: "もう一度" },
  { grade: "hard", label: "難しい" },
  { grade: "good", label: "正解" },
  { grade: "easy", label: "簡単" },
];

const tenths = (n: number) => String(Math.round(n * 10) / 10);

/** A review interval: "10分", "4時間", "6日", "1.5か月", "2年". */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}時間`;
  const days = Math.round(minutes / (24 * 60));
  if (days < 31) return `${days}日`;
  if (days < 365) return `${tenths(days / 30)}か月`;
  return `${tenths(days / 365)}年`;
}

/** The grade a multiple-choice answer suggests (right: 正解, wrong: もう一度); recall is self-graded. */
export const suggestedGrade = (q: QuizQuestion, chosen: string | null): Grade | null =>
  q.kind === "choice" && chosen != null ? (chosen === q.answer ? "good" : "again") : null;

/** Answers counted as known: anything but もう一度. */
export const knownCount = (grades: Iterable<Grade>) => [...grades].filter((g) => g !== "again").length;
