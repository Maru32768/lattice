import { useEffect, useState } from "react";
import { api, type ArticleView } from "./api";

/** Genre of the article in the Reader: pick or type one (pinned against auto runs), or let the LLM choose. */
export function GenreField({ view, onGenre, onClassify }: {
  view: ArticleView;
  onGenre: (name: string) => void;
  onClassify: () => void;
}) {
  const a = view.article;
  const [value, setValue] = useState(a.genre ?? "");
  const [genres, setGenres] = useState<string[]>([]);
  useEffect(() => { setValue(a.genre ?? ""); }, [a.genre]);
  useEffect(() => { api.listGenres().then((g) => setGenres(g.map((x) => x.name))).catch(() => {}); }, []);

  const job = view.jobs.find((j) => j.type === "classify");
  const busy = job?.status === "running" || (job?.status === "pending" && !job.last_error);
  const commit = () => { if (value.trim() !== (a.genre ?? "")) onGenre(value.trim()); };

  return (
    <form className="genre" onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <label>
        ジャンル
        <input list="genre-options" value={value} onChange={(e) => setValue(e.target.value)} onBlur={commit} placeholder="未分類" />
      </label>
      <datalist id="genre-options">{genres.map((g) => <option key={g} value={g} />)}</datalist>
      {a.genre_manual && <span className="status">手動</span>}
      {busy ? <span className="status">分類中…</span> : <button type="button" onClick={onClassify}>自動分類</button>}
      {job?.last_error && !busy && job.status !== "succeeded" && <span className="status error-text" title={job.last_error}>失敗: {job.last_error}</span>}
    </form>
  );
}
