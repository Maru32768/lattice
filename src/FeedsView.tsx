import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type ArticleRow, type FeedCandidate, type FeedRow, type FolderRow } from "./api";
import { relTime } from "./time";
import { Favicon, feedIconChanged, hostOf } from "./Favicon";
import { FilterEditor, RejectedList } from "./FeedFilterEditor";
import { FeedFoldersCard } from "./FeedFoldersCard";
import { feedGroups, feedStep, feedUrls, folderTree } from "./feedFolders";
import { Icon } from "./Icon";
import { skippedLines } from "./urlLines";
import "./manage.css";
import { useT } from "./i18n";

const bare = (url: string) => url.replace(/^https?:\/\//, "");
const feedName = (f: FeedRow) => f.custom_title ?? f.title ?? bare(f.url);
const MAX_ICON_BYTES = 1024 * 1024;
const ICON_TYPES = ".png,.jpg,.jpeg,.gif,.webp,.svg,.ico,image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon";

/** Display name and icon of one feed, below its row in the table. */
function FeedEditor({ feed: f, onSaved }: { feed: FeedRow; onSaved: () => void }) {
  const t = useT();
  const own = f.title ?? bare(f.url);
  // The field starts with the name shown now, to edit rather than retype; the feed's own name (or
  // an empty field) saves as no custom name.
  const [name, setName] = useState(f.custom_title ?? own);
  const [error, setError] = useState<string | null>(null);

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
    <form className="feed-edit" aria-label={t("feedsView.editorTitle", { feedName: feedName(f) })} onSubmit={(e) => { e.preventDefault(); void rename([own, ""].includes(name.trim()) ? null : name); }}>
      <label htmlFor={`feed-name-${f.id}`}>{t("feedsView.displayName")}</label>
      <div className="line">
        <input id={`feed-name-${f.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={own} maxLength={200} autoFocus />
        <button type="submit" className="btn sm pri" disabled={(name.trim() || own) === (f.custom_title ?? own)}>{t("common.save")}</button>
        {f.custom_title && <button type="button" className="btn sm" onClick={() => { setName(own); void rename(null); }}>{t("feedsView.revert")}</button>}
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
    </form>
  );
}

/** RSS / Atom subscriptions. Polling runs in the background every 30 minutes and at startup. */
export function FeedsView({ articles, navFeeds, onChanged, onShowFeed, initialUrl }: {
  articles: ArticleRow[];
  /** The sidebar's copy: when a move there (H26) changes it, this screen loads the feeds again. */
  navFeeds: FeedRow[];
  onChanged: () => void;
  onShowFeed: (id: number) => void;
  initialUrl?: string;
}) {
  const t = useT();
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  /** The folder new subscriptions go into. */
  const [addFolder, setAddFolder] = useState<number | null>(null);
  /** Feeds ticked for 「フォルダへ移動」. */
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [url, setUrl] = useState(initialUrl ?? "");
  const [candidates, setCandidates] = useState<FeedCandidate[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The add form's own error (Find, subscribe), shown under its field. */
  const [addError, setAddError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const load = () => Promise.all([api.listFeeds().then(setFeeds), api.listFeedFolders().then(setFolders)]).catch((e) => setError(String(e)));
  useEffect(() => {
    if (initialUrl?.trim()) void detect(initialUrl);
    const sub = listen("feeds-changed", () => { void load(); onChanged(); });
    return () => { void sub.then((f) => f()); };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount only: the view is keyed on initialUrl
  }, []);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- load only reads setters
  useEffect(() => void load(), [navFeeds]); // on mount too

  async function run(task: () => Promise<string | null>, fail = setError) {
    setBusy(true);
    setError(null);
    setAddError(null);
    setStatus(null);
    try {
      setStatus(await task());
    } catch (e) {
      fail(String(e));
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
  }, setAddError);

  const subscribe = () => {
    const c = candidates.find((x) => x.url === picked);
    if (c) void run(async () => {
      await api.addFeed(c.url, addFolder);
      const rest = candidates.filter((x) => x.url !== c.url);
      setCandidates(rest);
      setPicked(rest[0]?.url ?? null);
      if (rest.length === 0) setUrl("");
      return t("feedsView.added", { name: c.title ?? c.url });
    }, setAddError);
  };

  /** Subscribes to each feed in turn, reporting progress; a failed one does not stop the rest. */
  async function addAll(list: { url: string; folder: number | null }[]) {
    let ok = 0;
    const failed: string[] = [];
    for (const f of list) {
      setStatus(t("feedsView.adding", { x: ok + failed.length + 1, length: list.length }));
      try {
        await api.addFeed(f.url, f.folder);
        ok++;
      } catch {
        failed.push(f.url);
      }
    }
    return t("feedsView.opmlDone", { total: list.length, ok }) + (failed.length ? t("feedsView.opmlFailed", { urls: failed.join(", ") }) : "");
  }

  // OPML: the backend reads the feeds and makes their outline folders; each is then subscribed.
  const importOpml = (file: File) => run(async () => addAll(await api.importOpml(await file.text())));
  const exportOpml = () => run(async () => t("feedsView.exportedOpml", { path: await api.exportOpml() }));

  // Several URLs, one per line: each is taken as a feed URL (TechFeed's per-channel feeds) and subscribed as is.
  // Lines without an http(s) URL are skipped and reported, not sent to fail one by one.
  const lines = feedUrls(url);
  const many = lines.length > 1;
  const urls = lines.filter((l) => /https?:\/\//u.test(l));
  const addMany = () => run(async () => {
    setCandidates([]);
    const { scheme, noUrl } = skippedLines(url);
    const done = await addAll(urls.map((u) => ({ url: u, folder: addFolder })));
    setUrl("");
    return done + (scheme ? t("common.skippedScheme", { n: scheme }) : "") + (noUrl ? t("common.skippedNoUrl", { n: noUrl }) : "");
  }, setAddError);
  const move = (ids: number[], folder: number | null) => run(async () => {
    await api.moveFeedsToFolder(ids, folder);
    setSelected(new Set());
    const name = folders.find((f) => f.id === folder)?.name;
    return name == null ? t("feedsView.movedOut", { n: ids.length }) : t("feedsView.moved", { n: ids.length, folder: name });
  });
  // The sidebar's order (H26): ↑ ↓ move a feed one place, past a folder's ends into the next one.
  const groups = feedGroups(folderTree(feeds, folders, new Map()));
  const step = (f: FeedRow, d: -1 | 1) => {
    const order = feedStep(groups, f.id, d);
    if (order) void run(async () => { await api.reorderFeeds(order.folder, order.ids); return null; });
  };
  const folderOptions = folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>);
  const pickFolder = (v: string) => (v === "" ? null : Number(v));

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
              <input type="file" className="vh" accept=".opml,.xml" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importOpml(file); }} />
            </label>
            <button className="btn lg" onClick={exportOpml} disabled={busy || feeds.length === 0}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 19h16" /></svg>
              {t("feedsView.exportOpml")}
            </button>
            <button className="btn lg" onClick={refreshAll} disabled={busy || feeds.length === 0}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.1-5" /><path d="M19 4v4h-4" /></svg>
              {t("feedsView.refreshAll")}
            </button>
          </div>
        </header>

        <form className="card add" aria-label={t("feedsView.add")} onSubmit={(e) => {
          e.preventDefault();
          if (many) { if (urls.length > 0) void addMany(); }
          else if (url.trim()) void detect(url);
        }}>
          <label htmlFor="feed-url">{t("feedsView.detectHint")}</label>
          <div className="line">
            <textarea id="feed-url" className="input mono" rows={Math.min(8, url.split("\n").length)} value={url} onChange={(e) => { setUrl(e.target.value); setAddError(null); }}
              placeholder={t("feedsView.urlPlaceholder")} spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            {folders.length > 0 && (
              <select className="select" value={addFolder ?? ""} onChange={(e) => setAddFolder(pickFolder(e.target.value))} aria-label={t("feedsView.addFolder")}>
                <option value="">{t("feedsView.noFolder")}</option>
                {folderOptions}
              </select>
            )}
            <button type="submit" className="btn pri lg" disabled={busy || lines.length === 0 || (many && urls.length === 0)}>
              {many ? t("feedsView.subscribeAll", { n: urls.length }) : t("feedsView.detect")}
            </button>
          </div>
          {addError && <p role="alert" className="msg error-text">{t.msg(addError)}</p>}
          <span className="fs">{t("feedsView.manyHint")}</span>
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
        <FeedFoldersCard folders={folders} onChanged={() => { void load(); onChanged(); }} onError={(e) => setError(String(e))} />
        {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}

        <div className="filter">
          <button className={`btn sm${onlyErrors ? "" : " on"}`} aria-pressed={!onlyErrors} onClick={() => setOnlyErrors(false)}>{t("feedsView.all", { length: feeds.length })}</button>
          <button className={`btn sm${onlyErrors ? " on" : ""}`} aria-pressed={onlyErrors} onClick={() => setOnlyErrors(true)}>{t("feedsView.errors", { errorCount })}</button>
          <label htmlFor="feed-filter" className="vh">{t("feedsView.filter")}</label>
          <input id="feed-filter" className="input sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("feedsView.filterPlaceholder")} />
        </div>
        {selected.size > 0 && (
          <div className="filter bulk" role="group" aria-label={t("feedsView.selected", { n: selected.size })}>
            <span>{t("feedsView.selected", { n: selected.size })}</span>
            <select className="select" value="" disabled={busy} aria-label={t("feedsView.moveTo")}
              onChange={(e) => { if (e.target.value !== "") void move([...selected], e.target.value === "none" ? null : Number(e.target.value)); }}>
              <option value="">{t("feedsView.moveTo")}</option>
              <option value="none">{t("feedsView.noFolder")}</option>
              {folderOptions}
            </select>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>{t("feedsView.clearSelection")}</button>
          </div>
        )}

        <div className="card scroll">
          <table className="tbl">
            <thead><tr>
              <th className="pick"><input type="checkbox" aria-label={t("feedsView.selectAll")} checked={shown.length > 0 && shown.every((f) => selected.has(f.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((f) => f.id)) : new Set())} /></th>
              <th>{t("common.feed")}</th><th>{t("common.folder")}</th><th>{t("jobsView.state")}</th><th>{t("feedsView.updated")}</th><th className="num">{t("feedsView.unreadTotal")}</th><th><span className="vh">{t("common.actions")}</span></th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={7} className="muted">{feeds.length === 0 ? t("feedsView.empty") : t("feedsView.noMatch")}</td></tr>}
              {shown.map((f, i) => [
                folders.length > 0 && f.folder_id !== (i > 0 ? shown[i - 1].folder_id : undefined) && (
                  <tr key={`folder-${f.folder_id}`} className="grp">
                    <th colSpan={7} scope="colgroup"><Icon name="folder" size="sm" />{f.folder ?? t("feedsView.noFolder")}</th>
                  </tr>
                ),
                confirming === f.id ? (
                <tr key={f.id} className="confirm">
                  <td colSpan={7}>
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
                  <td className="pick"><input type="checkbox" aria-label={t("feedsView.selectFeed", { feedName: feedName(f) })} checked={selected.has(f.id)}
                    onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} /></td>
                  <td><div className="fn with-ico"><Favicon domain={hostOf(f.site_url ?? f.url)} feed={f.id} />{feedName(f)}</div><div className="fs">{bare(f.url)}</div></td>
                  <td>
                    <select className="select" value={f.folder_id ?? ""} disabled={busy} aria-label={t("feedsView.folderOf", { feedName: feedName(f) })}
                      onChange={(e) => void move([f.id], pickFolder(e.target.value))}>
                      <option value="">{t("feedsView.noFolder")}</option>
                      {folderOptions}
                    </select>
                  </td>
                  <td>
                    {f.last_error ? <span className="st err"><i />{t.msg(f.last_error)}</span> : <span className="st"><i />{t("feedsView.ok")}</span>}
                    {f.filter_note && <div className="st warn">{t.msg(f.filter_note)}</div>}
                    {f.rejected > 0 && (
                      <div><button className="btn sm ghost" onClick={() => setEditing(f.id)} aria-label={t("feedsView.rejectedOf", { feedName: feedName(f), n: f.rejected })}>
                        {t("feedsView.rejected", { n: f.rejected })}
                      </button></div>
                    )}
                  </td>
                  <td className="num when">{relTime(f.last_fetched_at, t)}</td>
                  <td className="num">{unread.get(f.id) ?? 0} / {f.article_count}</td>
                  <td className="row-acts">
                    <button className="ib" onClick={() => step(f, -1)} disabled={busy || !feedStep(groups, f.id, -1)} aria-label={t("feedsView.feedUp", { feedName: feedName(f) })}><Icon name="up" size="sm" /></button>
                    <button className="ib" onClick={() => step(f, 1)} disabled={busy || !feedStep(groups, f.id, 1)} aria-label={t("feedsView.feedDown", { feedName: feedName(f) })}><Icon name="down" size="sm" /></button>
                    <button className="btn sm ghost" onClick={() => onShowFeed(f.id)} aria-label={t("feedsView.viewArticlesOf", { feedName: feedName(f) })}>{t("feedsView.viewArticles")}</button>
                    <button className="btn sm ghost" onClick={() => setEditing(editing === f.id ? null : f.id)} aria-expanded={editing === f.id}
                      aria-label={t("feedsView.editOf", { feedName: feedName(f) })}>{t("nav.edit")}</button>
                    <button className="btn sm ghost" onClick={() => setConfirming(f.id)} aria-label={t("feedsView.deleteOf", { feedName: feedName(f) })}>{t("common.delete")}</button>
                  </td>
                </tr>,
                editing === f.id && (
                  <tr key={`${f.id}-edit`} className="edit">
                    <td colSpan={7}>
                      <div className="feed-edit">
                        <FeedEditor feed={f} onSaved={() => { void load(); onChanged(); }} />
                        <FilterEditor feedId={f.id} onSaved={() => { void load(); onChanged(); }} />
                        <RejectedList feed={f} onChanged={() => { void load(); onChanged(); }} />
                        <div><button type="button" className="btn sm" onClick={() => setEditing(null)}>{t("common.close")}</button></div>
                      </div>
                    </td>
                  </tr>
                ),
              ]])}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
