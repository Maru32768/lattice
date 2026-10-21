//! Feed folders (H25): named, ordered, not nested; a feed is in at most one, like most RSS
//! readers. Unrelated to groups (groups.rs), which collect articles. Lists, search and chat take
//! a folder as `ArticleFilter::Folder`. OPML folders are outlines holding the feeds' outlines.

use quick_xml::events::{BytesStart, Event};
use rusqlite::{ErrorCode, OptionalExtension, params};
use serde::Serialize;

use crate::msg;
use crate::store::Store;

pub const MAX_NAME_CHARS: usize = 100;

#[derive(Debug, Serialize)]
pub struct FolderRow {
    pub id: i64,
    pub name: String,
    /// Feeds in the folder.
    pub feeds: i64,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn clean(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(msg!("feedFolders.emptyName"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(msg!("feedFolders.nameTooLong", max = MAX_NAME_CHARS));
    }
    Ok(name)
}

/// Names are unique case-insensitively (the column is `COLLATE NOCASE`).
fn taken(name: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |e| match e.sqlite_error_code() {
        Some(ErrorCode::ConstraintViolation) => msg!("feedFolders.exists", name = name),
        _ => err(e),
    }
}

/// In the user's order.
pub fn list(store: &Store) -> Result<Vec<FolderRow>, String> {
    let c = store.conn();
    let mut st =
        c.prepare("SELECT id, name, (SELECT count(*) FROM feeds WHERE folder_id = feed_folders.id) FROM feed_folders ORDER BY position, id").map_err(err)?;
    st.query_map([], |r| Ok(FolderRow { id: r.get(0)?, name: r.get(1)?, feeds: r.get(2)? })).map_err(err)?.collect::<Result<_, _>>().map_err(err)
}

/// A new folder goes last.
pub fn create(store: &Store, name: &str) -> Result<i64, String> {
    let name = clean(name)?;
    let c = store.conn();
    c.execute("INSERT INTO feed_folders (name, position) VALUES (?1, (SELECT coalesce(max(position) + 1, 0) FROM feed_folders))", [name])
        .map_err(taken(name))?;
    Ok(c.last_insert_rowid())
}

pub fn rename(store: &Store, id: i64, name: &str) -> Result<(), String> {
    let name = clean(name)?;
    let n = store.conn().execute("UPDATE feed_folders SET name = ?2 WHERE id = ?1", params![id, name]).map_err(taken(name))?;
    if n == 0 { Err(msg!("feedFolders.notFound")) } else { Ok(()) }
}

/// Deletes the folder; its feeds stay, without a folder (`ON DELETE SET NULL`).
pub fn delete(store: &Store, id: i64) -> Result<(), String> {
    store.conn().execute("DELETE FROM feed_folders WHERE id = ?1", [id]).map(drop).map_err(err)
}

/// The folders in this order; ones left out keep their place after them.
pub fn reorder(store: &Store, ids: &[i64]) -> Result<(), String> {
    let mut c = store.conn();
    let tx = c.transaction().map_err(err)?;
    {
        let n = ids.len() as i64;
        tx.execute("UPDATE feed_folders SET position = position + ?1", [n]).map_err(err)?;
        let mut st = tx.prepare("UPDATE feed_folders SET position = ?2 WHERE id = ?1").map_err(err)?;
        for (i, id) in ids.iter().enumerate() {
            st.execute(params![id, i as i64]).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

/// Moves the feeds into `folder`, or out of any folder (`None`).
pub fn move_feeds(store: &Store, feeds: &[i64], folder: Option<i64>) -> Result<(), String> {
    let mut c = store.conn();
    let tx = c.transaction().map_err(err)?;
    {
        let mut st = tx.prepare("UPDATE feeds SET folder_id = ?2 WHERE id = ?1").map_err(err)?;
        for f in feeds {
            st.execute(params![f, folder]).map_err(not_found)?;
        }
    }
    tx.commit().map_err(err)
}

/// A folder id that no longer exists fails the foreign key.
pub(crate) fn not_found(e: rusqlite::Error) -> String {
    match e.sqlite_error_code() {
        Some(ErrorCode::ConstraintViolation) => msg!("feedFolders.notFound"),
        _ => err(e),
    }
}

/// The folder with this name (ignoring case), created last if there is none.
pub fn find_or_create(store: &Store, name: &str) -> Result<i64, String> {
    let found = store.conn().query_row("SELECT id FROM feed_folders WHERE name = ?1", [clean(name)?], |r| r.get(0)).optional().map_err(err)?;
    found.map_or_else(|| create(store, name), Ok)
}

/// One subscription in an OPML file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpmlFeed {
    pub url: String,
    pub folder: Option<i64>,
}

/// The feeds of an OPML file, in document order and each once, with the folders their outlines
/// sit in, created by name where missing. A feed nested in several outlines goes into the
/// innermost one: folders do not nest. Only the URLs and folder names are read.
pub fn import_opml(store: &Store, xml: &str) -> Result<Vec<OpmlFeed>, String> {
    let parsed = parse_opml(xml)?;
    let mut out: Vec<OpmlFeed> = Vec::new();
    for (url, folder) in parsed {
        if out.iter().any(|f| f.url == url) {
            continue;
        }
        let folder = folder.map(|n| find_or_create(store, &n)).transpose()?;
        out.push(OpmlFeed { url, folder });
    }
    Ok(out)
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref().eq_ignore_ascii_case(name))
        .and_then(|a| a.normalized_value(quick_xml::XmlVersion::Implicit1_0).ok().map(|v| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

/// (feed URL, innermost folder name) per feed outline.
fn parse_opml(xml: &str) -> Result<Vec<(String, Option<String>)>, String> {
    let mut reader = quick_xml::Reader::from_str(xml);
    // The enclosing outlines: a folder's name, or None for a feed outline with children.
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut out = Vec::new();
    loop {
        let event = reader.read_event().map_err(|e| msg!("feeds.badOpml", error = e.to_string()))?;
        let (e, open) = match &event {
            Event::Start(e) => (e, true),
            Event::Empty(e) => (e, false),
            Event::End(e) if e.local_name().as_ref().eq_ignore_ascii_case("outline") => {
                stack.pop();
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        if !e.local_name().as_ref().eq_ignore_ascii_case("outline") {
            continue;
        }
        let url = attr(e, "xmlUrl");
        if let Some(u) = &url {
            out.push((u.clone(), stack.iter().rev().find_map(Clone::clone)));
        }
        if open {
            stack.push(if url.is_some() { None } else { attr(e, "text").or_else(|| attr(e, "title")) });
        }
    }
    Ok(out)
}

fn escape(s: &str) -> std::borrow::Cow<'_, str> {
    quick_xml::escape::escape(s)
}

/// OPML 2.0 of every feed: folders as outlines holding their feeds, in the user's order, then
/// the feeds without a folder.
pub fn export_opml(store: &Store) -> Result<String, String> {
    let feeds = crate::feeds::list(store)?;
    let outline = |f: &crate::feeds::FeedRow, indent: &str| {
        let name = f.custom_title.as_deref().or(f.title.as_deref()).unwrap_or(&f.url);
        let site = f.site_url.as_deref().map(|s| format!(r#" htmlUrl="{}""#, escape(s))).unwrap_or_default();
        format!("{indent}<outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"{site}/>\n", escape(name), escape(&f.url))
    };
    let mut body = String::new();
    for folder in list(store)? {
        body += &format!("    <outline text=\"{0}\" title=\"{0}\">\n", escape(&folder.name));
        for f in feeds.iter().filter(|f| f.folder_id == Some(folder.id)) {
            body += &outline(f, "      ");
        }
        body += "    </outline>\n";
    }
    for f in feeds.iter().filter(|f| f.folder_id.is_none()) {
        body += &outline(f, "    ");
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head>\n    <title>Lattice feeds</title>\n  </head>\n  <body>\n{body}  </body>\n</opml>\n"
    ))
}

/// Writes `lattice-feeds-<UTC>.opml` into `dir` and returns its path.
pub fn export_opml_file(store: &Store, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let stamp: String = store.conn().query_row("SELECT strftime('%Y%m%dT%H%M%SZ','now')", [], |r| r.get(0)).map_err(err)?;
    let path = dir.join(format!("lattice-feeds-{stamp}.opml"));
    std::fs::write(&path, export_opml(store)?).map_err(err)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feeds;
    use crate::store::ArticleFilter;

    fn code<T: std::fmt::Debug>(r: Result<T, String>) -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(&r.unwrap_err()).unwrap()["code"].clone()
    }

    #[test]
    fn folders_are_named_ordered_and_deleting_one_keeps_its_feeds() {
        let s = Store::open_in_memory().unwrap();
        let tech = create(&s, " TechFeed ").unwrap();
        let news = create(&s, "News").unwrap();
        assert_eq!(code(create(&s, "techfeed")), "feedFolders.exists");
        assert_eq!(code(create(&s, " ")), "feedFolders.emptyName");
        assert_eq!(code(create(&s, &"x".repeat(MAX_NAME_CHARS + 1))), "feedFolders.nameTooLong");
        let names = || list(&s).unwrap().into_iter().map(|f| (f.name, f.feeds)).collect::<Vec<_>>();
        assert_eq!(names(), [("TechFeed".to_string(), 0), ("News".to_string(), 0)], "creation order");
        reorder(&s, &[news]).unwrap();
        assert_eq!(names()[0].0, "News");
        rename(&s, tech, "Tech").unwrap();
        assert_eq!(code(rename(&s, tech, "NEWS")), "feedFolders.exists");
        assert_eq!(code(rename(&s, 999, "x")), "feedFolders.notFound");

        let (a, _) = feeds::add(&s, "https://a.dev/feed", Some(tech)).unwrap();
        let (b, _) = feeds::add(&s, "https://b.dev/feed", None).unwrap();
        move_feeds(&s, &[b], Some(tech)).unwrap();
        assert_eq!(code(move_feeds(&s, &[a], Some(999))), "feedFolders.notFound");
        assert_eq!(names(), [("News".to_string(), 0), ("Tech".to_string(), 2)]);
        let row = feeds::list(&s).unwrap().into_iter().find(|f| f.id == a).unwrap();
        assert_eq!((row.folder_id, row.folder.as_deref()), (Some(tech), Some("Tech")));
        assert_eq!(feeds::add(&s, "https://a.dev/feed", None).unwrap(), (a, false));
        assert_eq!(feeds::list(&s).unwrap()[0].folder_id, Some(tech), "subscribing again without a folder leaves it in its folder");
        feeds::add(&s, "https://a.dev/feed", Some(news)).unwrap();
        assert_eq!(feeds::list(&s).unwrap()[0].folder_id, Some(news), "subscribing again into a folder moves it");

        delete(&s, news).unwrap();
        assert_eq!(feeds::list(&s).unwrap().len(), 2, "its feeds stay");
        assert_eq!(feeds::list(&s).unwrap()[0].folder_id, None);
        move_feeds(&s, &[b], None).unwrap();
        assert_eq!(names(), [("Tech".to_string(), 0)]);
    }

    #[test]
    fn a_folder_scopes_lists_and_search_to_its_feeds_articles() {
        let s = Store::open_in_memory().unwrap();
        let folder = create(&s, "TechFeed").unwrap();
        let (a, _) = feeds::add(&s, "https://a.dev/feed", Some(folder)).unwrap();
        let (b, _) = feeds::add(&s, "https://b.dev/feed", Some(folder)).unwrap();
        let (c, _) = feeds::add(&s, "https://c.dev/feed", None).unwrap();
        for (feed, url) in [(a, "https://a.dev/1"), (b, "https://b.dev/1"), (c, "https://c.dev/1")] {
            feeds::import(&s, feed, &[feeds::Entry { url: url.into(), ..Default::default() }]).unwrap();
        }
        s.upsert_pending("https://manual.dev/1", "https://manual.dev/1", "manual.dev").unwrap();
        let urls = |f: ArticleFilter| {
            let mut v = s.list_articles(&f).unwrap().into_iter().map(|r| (r.original_url, r.folder_id)).collect::<Vec<_>>();
            v.sort();
            v
        };
        assert_eq!(urls(ArticleFilter::Folder { id: folder }), [("https://a.dev/1".into(), Some(folder)), ("https://b.dev/1".into(), Some(folder))]);
        assert_eq!(s.article_ids(&ArticleFilter::Folder { id: folder }).unwrap().unwrap().len(), 2);
        move_feeds(&s, &[b], None).unwrap();
        assert_eq!(urls(ArticleFilter::Folder { id: folder }).len(), 1, "follows the feed, not the article");
        let serde: ArticleFilter = serde_json::from_str(r#"{"kind":"folder","id":7}"#).unwrap();
        assert_eq!(serde, ArticleFilter::Folder { id: 7 });
    }

    #[test]
    fn opml_round_trips_folders() {
        let s = Store::open_in_memory().unwrap();
        let existing = create(&s, "news").unwrap();
        let opml = r#"<?xml version="1.0"?><opml version="1.0"><head><title>TechFeed</title></head><body>
            <outline text="Loose" type="rss" xmlUrl="https://loose.dev/feed"/>
            <outline text="TechFeed &amp; co">
              <outline text="Rust" type="rss" XMLURL="https://techfeed.io/feeds/rust?x=1&amp;y=2"/>
              <outline text="Go" type="rss" xmlUrl="https://techfeed.io/feeds/go"></outline>
              <outline title="Deeper"><outline text="Inner" xmlUrl="https://inner.dev/feed"/></outline>
            </outline>
            <outline title="News"><outline text="dup" xmlUrl="https://loose.dev/feed"/><outline text="LWN" xmlUrl="https://lwn.net/rss"/></outline>
            <outline text="Empty folder"/>
            </body></opml>"#;
        let feeds_in = import_opml(&s, opml).unwrap();
        let tech = find_or_create(&s, "TechFeed & co").unwrap();
        let deeper = find_or_create(&s, "Deeper").unwrap();
        let want = |url: &str, folder: Option<i64>| OpmlFeed { url: url.into(), folder };
        assert_eq!(
            feeds_in,
            [
                want("https://loose.dev/feed", None),
                want("https://techfeed.io/feeds/rust?x=1&y=2", Some(tech)),
                want("https://techfeed.io/feeds/go", Some(tech)),
                want("https://inner.dev/feed", Some(deeper)),
                want("https://lwn.net/rss", Some(existing)),
            ],
            "folders by name, the innermost one, each feed once"
        );
        assert_eq!(list(&s).unwrap().len(), 3, "the empty outline is not a folder");
        assert!(import_opml(&s, "<opml><body><outline text=\"x\"></body>").is_err());

        for f in &feeds_in {
            feeds::add(&s, &f.url, f.folder).unwrap();
        }
        feeds::rename(&s, feeds::list(&s).unwrap().iter().find(|f| f.url.contains("lwn")).unwrap().id, Some("LWN <news>")).unwrap();
        let out = export_opml(&s).unwrap();
        assert!(out.contains(r#"text="LWN &lt;news&gt;""#), "{out}");
        let fresh = Store::open_in_memory().unwrap();
        let back = import_opml(&fresh, &out).unwrap();
        let named = |st: &Store, v: &[OpmlFeed]| {
            let names = list(st).unwrap();
            let mut v: Vec<(String, Option<String>)> =
                v.iter().map(|f| (f.url.clone(), f.folder.map(|id| names.iter().find(|n| n.id == id).unwrap().name.clone()))).collect();
            v.sort();
            v
        };
        assert_eq!(named(&fresh, &back), named(&s, &feeds_in));
        assert_eq!(list(&fresh).unwrap().iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["news", "TechFeed & co", "Deeper"], "in the user's order");
    }
}
