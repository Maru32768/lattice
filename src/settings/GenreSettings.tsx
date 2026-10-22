import { useEffect, useState } from "react";
import { api, type TagCount } from "../api";
import { useT } from "../i18n";

/** Genres with counts: rename, merge (rename onto an existing genre), delete unused ones. */
export function GenreSettings({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [genres, setGenres] = useState<TagCount[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .listGenres()
      .then(setGenres)
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    api
      .listGenres()
      .then(setGenres)
      .catch((e: unknown) => setError(String(e)));
  }, []);

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
    void load();
    onChanged();
  }

  function row(g: TagCount) {
    const to = (drafts[g.name] ?? g.name).trim();
    const into = genres.find((x) => x.name !== g.name && x.name.toLowerCase() === to.toLowerCase());
    const changed = to !== "" && to !== g.name;
    const submit = () =>
      changed &&
      act(api.renameGenre(g.name, to), into ? t("genreSettings.merged", { name: g.name, name2: into.name }) : t("genreSettings.renamed", { name: g.name, to }));
    return (
      <form
        key={g.name}
        className="set"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="h">
          <input
            className="input sm"
            list="genre-manage-options"
            value={drafts[g.name] ?? g.name}
            aria-label={t("genreSettings.newName", { name: g.name })}
            onChange={(e) => setDrafts((d) => ({ ...d, [g.name]: e.target.value }))}
          />
        </div>
        <div className="d">
          {t("genreSettings.count", { count: g.count })}
          {into && t("genreSettings.willMerge", { name: into.name, count: g.count })}
        </div>
        <div className="ctl">
          <button type="submit" className="btn" disabled={!changed}>
            {into ? t("genreSettings.merge") : t("genreSettings.rename")}
          </button>
          {g.count === 0 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => act(api.deleteGenre(g.name), t("genreSettings.deleted", { name: g.name }))}
              aria-label={t("genreSettings.deleteLabel", { name: g.name })}
            >
              {t("common.delete")}
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <>
      <datalist id="genre-manage-options">
        {genres.map((g) => (
          <option key={g.name} value={g.name} />
        ))}
      </datalist>
      {genres.length === 0 && <p className="muted">{t("genreSettings.none")}</p>}
      <div className="grp">{genres.map(row)}</div>
      {status && (
        <p role="status" className="msg">
          {status}
        </p>
      )}
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </>
  );
}
