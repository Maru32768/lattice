import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleRow, type FeedCandidate, type FeedRow } from "./api";
import { relTime } from "./time";
import { Favicon, feedIconChanged, hostOf } from "./Favicon";
import "./manage.css";
import { useT } from "./i18n";

const bare = (url: string) => url.replace(/^https?:\/\//, "");
const feedName = (f: FeedRow) => f.custom_title ?? f.title ?? bare(f.url);
const MAX_ICON_BYTES = 1024 * 1024;
const ICON_TYPES = ".png,.jpg,.jpeg,.gif,.webp,.svg,.ico,image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon";

/** Display name and icon of one feed, below its row in the table. */
function FeedEditor({ feed: f, onSaved, onClose }: { feed: FeedRow; onSaved: () => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(f.custom_title ?? "");
  const [error, setError] = useState<string | null>(null);
  const own = f.title ?? bare(f.url);

  async function act(task: () => Promise<void>) {
    setError(null);
    try {
      await task();
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }
  const rename = (n: string | null) => act(() => api.renameFeed(f.id, n));
  // Reading the file happens inside act, so a failed read shows like a failed save.
  const setIcon = (bytes: () => Promise<number[] | null>) => act(async () => {
    await api.setFeedIcon(f.id, await bytes());
    feedIconChanged(f.id);
  });
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) return setError(t("feedsView.iconTooLarge"));
    void setIcon(async () => Array.from(new Uint8Array(await file.arrayBuffer())));
  };

  return (
    <form className="feed-edit" aria-label={t("feedsView.editorTitle", { feedName: feedName(f) })} onSubmit={(e) => { e.preventDefault(); void rename(name); }}>
      <label htmlFor={`feed-name-${f.id}`}>{t("feedsView.displayName")}</label>
      <div className="line">
        <input id={`feed-name-${f.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={own} maxLength={200} autoFocus />
        <button type="submit" className="btn sm pri" disabled={name.trim() === (f.custom_title ?? "")}>{t("common.save")}</button>
        {f.custom_title && <button type="button" className="btn sm" onClick={() => { setName(""); void rename(null); }}>{t("feedsView.revert")}</button>}
      </div>
      <div className="fs">{t("feedsView.ownName", { own })}</div>
      <span className="lbl">{t("feedsView.icon")}</span>
      <div className="line">
        <Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} />
        <label className="btn sm">
          {t("feedsView.pickImage")}
          <input type="file" className="vh" accept={ICON_TYPES} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {f.has_icon && <button type="button" className="btn sm" onClick={() => setIcon(async () => null)}>{t("feedsView.siteIcon")}</button>}
        <span className="muted">{t("feedsView.iconFormats")}</span>
      </div>
      {error && <p role="alert" className="error-text">{t.msg(error)}</p>}
      <div><button type="button" className="btn sm" onClick={onClose}>{t("common.close")}</button></div>
    </form>
  );
}

/** RSS / Atom subscriptions. Polling runs in the background every 30 minutes and at startup. */
export function FeedsView({ articles, onChanged, onShowFeed, initialUrl }: {
  articles: ArticleRow[];
  onChanged: () => void;
  onShowFeed: (id: number) => void;
  initialUrl?: string;
}) {
  const t = useT();
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [candidates, setCandidates] = useState<FeedCandidate[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const load = () => api.listFeeds().then(setFeeds).catch((e) => setError(String(e)));
  useEffect(() => {
    void load();
    if (initialUrl?.trim()) void detect(initialUrl);
    const sub = listen("feeds-changed", () => { void load(); onChanged(); });
    return () => { void sub.then((f) => f()); };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount only: the view is keyed on initialUrl
  }, []);

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await task());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      void load();
      onChanged();
    }
  }

  // A site or article URL works too: the backend finds the feeds it links.
  const detect = (u: string) => run(async () => {
    setCandidates([]);
    const found = await api.discoverFeeds(u.trim());
    if (found.length === 0) throw t("feedsView.notFound");
    setCandidates(found);
    setPicked(found[0].url);
    return null;
  });

  const subscribe = () => {
    const c = candidates.find((x) => x.url === picked);
    if (c) void run(async () => {
      await api.addFeed(c.url);
      const rest = candidates.filter((x) => x.url !== c.url);
      setCandidates(rest);
      setPicked(rest[0]?.url ?? null);
      if (rest.length === 0) setUrl("");
      return t("feedsView.added", { name: c.title ?? c.url });
    });
  };

  // OPML: subscriptions are the outline elements' xmlUrl attributes.
  const importOpml = (file: File | undefined) => file && run(async () => {
    const urls = [...(await file.text()).matchAll(/xmlUrl\s*=\s*"([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    let ok = 0;
    const failed: string[] = [];
    for (const u of urls) {
      setStatus(t("feedsView.adding", { x: ok + failed.length + 1, length: urls.length }));
      try {
        await api.addFeed(u);
        ok++;
      } catch {
        failed.push(u);
      }
    }
    return t("feedsView.opmlDone", { total: urls.length, ok }) + (failed.length ? t("feedsView.opmlFailed", { urls: failed.join(", ") }) : "");
  });

  const refreshAll = () => run(async () => t("feedsView.refreshed", { x: await api.refreshFeeds() }));

  async function remove(f: FeedRow) {
    setConfirming(null);
    try {
      await api.removeFeed(f.id);
    } catch (e) {
      setError(String(e));
    }
    void load();
    onChanged();
  }

  const unread = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of articles) if (a.feed_id != null && a.read_status === "unread") m.set(a.feed_id, (m.get(a.feed_id) ?? 0) + 1);
    return m;
  }, [articles]);
  const newest = feeds.flatMap((f) => (f.last_fetched_at ? [f.last_fetched_at] : [])).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const errorCount = feeds.filter((f) => f.last_error).length;
  const needle = query.trim().toLowerCase();
  const shown = feeds.filter((f) => (!onlyErrors || f.last_error)
    && (!needle || `${f.custom_title ?? ""} ${f.title ?? ""} ${f.url} ${f.site_url ?? ""}`.toLowerCase().includes(needle)));

  return (
    <main className="manage">
      <div className="wrap">
        <header className="head">
          <div>
            <h1>{t("nav.manageFeeds")}</h1>
            <p className="sub">{t("feedsView.sub", { length: feeds.length, relTime: relTime(newest, t) })}</p>
          </div>
          <div className="acts">
            <label className="btn lg">
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 19h16" /></svg>
              {t("feedsView.opml")}
              <input type="file" className="vh" accept=".opml,.xml" disabled={busy} onChange={(e) => importOpml(e.target.files?.[0])} />
            </label>
            <button className="btn lg" onClick={refreshAll} disabled={busy || feeds.length === 0}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4v4h-4" /></svg>
              {t("feedsView.refreshAll")}
            </button>
          </div>
        </header>

        <form className="card add" aria-label={t("feedsView.add")} onSubmit={(e) => { e.preventDefault(); if (url.trim()) void detect(url); }}>
          <label htmlFor="feed-url">{t("feedsView.detectHint")}</label>
          <div className="line">
            <input id="feed-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("feedsView.urlPlaceholder")} spellCheck={false} />
            <button type="submit" className="btn pri lg" disabled={busy || !url.trim()}>{t("feedsView.detect")}</button>
          </div>
          {candidates.length > 0 && (
            <fieldset className="cands">
              <legend>{t("feedsView.candidates", { length: candidates.length })}</legend>
              {candidates.map((c) => (
                <label key={c.url}>
                  <input type="radio" name="feed-candidate" checked={picked === c.url} onChange={() => setPicked(c.url)} />
                  <span>{c.title ?? bare(c.url)}</span>
                  {c.title && <span className="fs">{bare(c.url)}</span>}
                </label>
              ))}
              <div><button type="button" className="btn sm pri" onClick={subscribe} disabled={busy || !picked}>{t("feedsView.subscribe")}</button></div>
            </fieldset>
          )}
        </form>
        {status && <p role="status" className="msg muted">{status}</p>}
        {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}

        <div className="filter">
          <button className={`btn sm${onlyErrors ? "" : " on"}`} aria-pressed={!onlyErrors} onClick={() => setOnlyErrors(false)}>{t("feedsView.all", { length: feeds.length })}</button>
          <button className={`btn sm${onlyErrors ? " on" : ""}`} aria-pressed={onlyErrors} onClick={() => setOnlyErrors(true)}>{t("feedsView.errors", { errorCount })}</button>
          <label htmlFor="feed-filter" className="vh">{t("feedsView.filter")}</label>
          <input id="feed-filter" className="input sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("feedsView.filterPlaceholder")} />
        </div>

        <div className="card scroll">
          <table className="tbl">
            <thead><tr><th>{t("common.feed")}</th><th>{t("jobsView.state")}</th><th>{t("feedsView.updated")}</th><th className="num">{t("feedsView.unreadTotal")}</th><th><span className="vh">{t("common.actions")}</span></th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="muted">{feeds.length === 0 ? t("feedsView.empty") : t("feedsView.noMatch")}</td></tr>}
              {shown.map((f) => confirming === f.id ? (
                <tr key={f.id} className="confirm">
                  <td colSpan={5}>
                    <div className="confirm-line">
                      <div>
                        <div className="fn">{t("feedsView.confirmDelete", { feedName: feedName(f) })}</div>
                        <div className="muted">{t("feedsView.deleteDesc", { article_count: f.article_count })}</div>
                      </div>
                      <div className="acts">
                        <button className="btn sm" onClick={() => setConfirming(null)}>{t("common.cancel")}</button>
                        <button className="btn sm danger" onClick={() => remove(f)}>{t("feedsView.delete")}</button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : [
                <tr key={f.id} className={f.last_error ? "err" : undefined}>
                  <td><div className="fn with-ico"><Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} />{feedName(f)}</div><div className="fs">{bare(f.url)}</div></td>
                  <td>{f.last_error ? <span className="st err"><i />{t.msg(f.last_error)}</span> : <span className="st"><i />{t("feedsView.ok")}</span>}</td>
                  <td className="num when">{relTime(f.last_fetched_at, t)}</td>
                  <td className="num">{unread.get(f.id) ?? 0} / {f.article_count}</td>
                  <td className="row-acts">
                    <button className="btn sm ghost" onClick={() => onShowFeed(f.id)} aria-label={t("feedsView.viewArticlesOf", { feedName: feedName(f) })}>{t("feedsView.viewArticles")}</button>
                    <button className="btn sm ghost" onClick={() => setEditing(editing === f.id ? null : f.id)} aria-expanded={editing === f.id}
                      aria-label={t("feedsView.editOf", { feedName: feedName(f) })}>{t("nav.edit")}</button>
                    <button className="btn sm ghost" onClick={() => setConfirming(f.id)} aria-label={t("feedsView.deleteOf", { feedName: feedName(f) })}>{t("common.delete")}</button>
                  </td>
                </tr>,
                editing === f.id && (
                  <tr key={`${f.id}-edit`} className="edit">
                    <td colSpan={5}><FeedEditor feed={f} onSaved={() => { void load(); onChanged(); }} onClose={() => setEditing(null)} /></td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
