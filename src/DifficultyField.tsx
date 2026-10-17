import type { ArticleRow } from "./api";

/** Mirrors classify.rs DIFFICULTIES (1-5), judged for a working software engineer. */
export const DIFFICULTY_LABELS = ["入門", "初級", "中級", "上級", "専門"];

export const difficultyLabel = (d: number | null) => (d == null ? null : DIFFICULTY_LABELS[d - 1] ?? null);

/** Small badge for list items; nothing until the article is rated. */
export function DifficultyBadge({ article }: { article: ArticleRow }) {
  const label = difficultyLabel(article.difficulty);
  return label && <span className={`difficulty d${article.difficulty}`} title={`難易度 ${article.difficulty}/5`}>{label}</span>;
}

/** Reader meta row: shows the estimate and lets the user pin their own (cleared = re-estimated by 自動分類). */
export function DifficultyField({ article, onDifficulty }: { article: ArticleRow; onDifficulty: (level: number | null) => void }) {
  return (
    <label className="difficulty-field">
      難易度
      <select value={article.difficulty ?? ""} onChange={(e) => onDifficulty(e.target.value ? Number(e.target.value) : null)}>
        <option value="">未判定</option>
        {DIFFICULTY_LABELS.map((l, i) => <option key={l} value={i + 1}>{i + 1} {l}</option>)}
      </select>
      {article.difficulty_manual && <span className="status">手動</span>}
    </label>
  );
}
