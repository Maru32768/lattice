import { useEffect, useState } from "react";
import { api, type TagCount } from "./api";

/** Genres with counts: rename, merge (rename onto an existing genre), delete unused ones. */
export function GenreSettings({ onChanged }: { onChanged: () => void }) {
  const [genres, setGenres] = useState<TagCount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listGenres().then(setGenres).catch((e) => setError(String(e)));
  useEffect(() => { load(); }, []);

  async function act(task: Promise<void>, done: string) {
    setError(null);
    setStatus(null);
    try {
      await task;
      setStatus(done);
      setDrafts({});
    } catch (e) {
      setError(String(e));
    }
    load();
    onChanged();
  }

  function row(g: TagCount) {
    const to = (drafts[g.name] ?? g.name).trim();
    const into = genres.find((x) => x.name !== g.name && x.name.toLowerCase() === to.toLowerCase());
    const changed = to !== "" && to !== g.name;
    const submit = () => changed && act(api.renameGenre(g.name, to),
      into ? `「${g.name}」を「${into.name}」に統合しました` : `「${g.name}」を「${to}」に変更しました`);
    return (
      <form key={g.name} className="set" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="h">
          <input className="input sm" list="genre-manage-options" value={drafts[g.name] ?? g.name} aria-label={`${g.name} の新しい名前`}
            onChange={(e) => setDrafts((d) => ({ ...d, [g.name]: e.target.value }))} />
        </div>
        <div className="d">{g.count} 件{into && ` · 「${into.name}」に統合します（記事 ${g.count} 件を移動）`}</div>
        <div className="ctl">
          <button type="submit" className="btn" disabled={!changed}>{into ? "統合" : "名前を変更"}</button>
          {g.count === 0 && <button type="button" className="btn ghost" onClick={() => act(api.deleteGenre(g.name), `「${g.name}」を削除しました`)} aria-label={`${g.name} を削除`}>削除</button>}
        </div>
      </form>
    );
  }

  return (
    <>
      <datalist id="genre-manage-options">{genres.map((g) => <option key={g.name} value={g.name} />)}</datalist>
      {genres.length === 0 && <p className="muted">ジャンルはまだありません。</p>}
      <div className="grp">{genres.map(row)}</div>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </>
  );
}
