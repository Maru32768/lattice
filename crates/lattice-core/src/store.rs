//! SQLite store. Concrete on purpose: SQLite is the system of record, not a swappable detail.
//! Swappable parts (search index, vectors) get their own boundary when they arrive.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::extract::EXTRACTION_VERSION;
use crate::fetch::Fetched;
use crate::ingest::FEED_CONTENT_TYPE;
use crate::ir::{ArticleIr, Block, Inline};
use crate::segments::{Target, Unit, plain_text};
use ts_rs::TS;

/// Append-only: each entry upgrades `PRAGMA user_version` by one.
const MIGRATIONS: &[&str] = &[
    include_str!("../db/migrations/00001_init_articles.sql"),
    include_str!("../db/migrations/00002_translations_jobs.sql"),
    include_str!("../db/migrations/00003_blocks_fts.sql"),
    include_str!("../db/migrations/00004_compress_snapshots.sql"),
    include_str!("../db/migrations/00005_segment_translations.sql"),
    include_str!("../db/migrations/00006_tags.sql"),
    include_str!("../db/migrations/00007_summaries.sql"),
    include_str!("../db/migrations/00008_settings.sql"),
    include_str!("../db/migrations/00009_chat.sql"),
    include_str!("../db/migrations/00010_genres.sql"),
    include_str!("../db/migrations/00011_feeds.sql"),
    include_str!("../db/migrations/00012_text_length.sql"),
    include_str!("../db/migrations/00013_jobs_status_index.sql"),
    include_str!("../db/migrations/00014_difficulty.sql"),
    include_str!("../db/migrations/00015_images.sql"),
    include_str!("../db/migrations/00016_feed_item_published_at.sql"),
    include_str!("../db/migrations/00017_favicons.sql"),
    include_str!("../db/migrations/00018_feed_item_content.sql"),
    include_str!("../db/migrations/00019_feed_custom_title_icon.sql"),
    include_str!("../db/migrations/00020_quizzes.sql"),
    include_str!("../db/migrations/00021_vocab.sql"),
    include_str!("../db/migrations/00022_groups.sql"),
    include_str!("../db/migrations/00023_relevance.sql"),
    include_str!("../db/migrations/00024_feed_filters.sql"),
    include_str!("../db/migrations/00025_drop_cloze_cards.sql"),
    include_str!("../db/migrations/00026_feed_folders.sql"),
    include_str!("../db/migrations/00027_feed_position.sql"),
    include_str!("../db/migrations/00028_renormalize_https.sql"),
    include_str!("../db/migrations/00029_article_notes.sql"),
    include_str!("../db/migrations/00030_relevance_axes.sql"),
];
/// Stored URLs are normalized again after these many migrations, so feed entries and pages keep
/// matching the articles and items saved before: `url_norm` started dropping `source=rss…` (18),
/// then folding http into https (28; a feed linking http:// showed its saved page as unsaved).
const RENORMALIZE_AT: [usize; 2] = [18, 28];

/// `UPDATE OR IGNORE`: a URL whose new form is already taken keeps its old one.
fn renormalize_urls(tx: &rusqlite::Transaction) -> Result<()> {
    for (table, col) in [("articles", "normalized_url"), ("articles", "canonical_url"), ("feed_items", "normalized_url")] {
        let urls: Vec<String> = tx
            .prepare(&format!("SELECT DISTINCT {col} FROM {table} WHERE {col} LIKE '%source=%' OR {col} LIKE 'http://%'"))?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_>>()?;
        for old in urls {
            if let Ok(new) = crate::url_norm::normalize(&old).map(String::from)
                && new != old
            {
                tx.execute(&format!("UPDATE OR IGNORE {table} SET {col} = ?2 WHERE {col} = ?1"), params![old, new])?;
            }
        }
    }
    Ok(())
}

pub(crate) fn deflate(body: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(body).expect("writing to a Vec cannot fail");
    e.finish().expect("writing to a Vec cannot fail")
}

pub(crate) fn inflate(encoding: &str, body: &[u8]) -> std::io::Result<String> {
    String::from_utf8(inflate_bytes(encoding, body)?).map_err(std::io::Error::other)
}

fn inflate_bytes(encoding: &str, body: &[u8]) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    match encoding {
        "deflate" => flate2::read::DeflateDecoder::new(body).read_to_end(&mut out).map(|_| out),
        _ => Ok(body.to_vec()),
    }
}

/// The newest stored source of an article (HTML, Markdown or a PDF's bytes), for re-extraction
/// without the network.
pub struct Snapshot {
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl Snapshot {
    pub fn html(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A source to store with its extraction: fetched HTML or Markdown text, or a PDF's bytes.
pub struct NewSnapshot<'a> {
    pub final_url: &'a str,
    pub status: u16,
    pub content_type: Option<&'a str>,
    pub body: &'a [u8],
}

/// Jobs that keep failing stop retrying automatically; the user can re-enqueue them.
const MAX_ATTEMPTS: i64 = 5;
/// Extractions shorter than this (characters) are flagged `thin`: likely rendered by JS.
pub const THIN_TEXT_CHARS: i64 = 300;
/// Settings keys holding credentials (API keys, R2 secret). Never leave the machine in backups.
pub const SECRET_PREFIX: &str = "secret.";

pub type Result<T> = rusqlite::Result<T>;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ArticleRow {
    pub id: i64,
    pub original_url: String,
    pub canonical_url: Option<String>,
    pub domain: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub site_name: Option<String>,
    pub published_at: Option<String>,
    pub language: Option<String>,
    pub saved_at: String,
    #[ts(type = "\"pending\" | \"ok\" | \"failed\"")]
    pub fetch_status: String,
    #[ts(type = "\"pending\" | \"ok\" | \"failed\"")]
    pub extraction_status: String,
    pub last_error: Option<String>,
    #[ts(type = "\"unread\" | \"read\"")]
    pub read_status: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    /// Ids of the groups the article is in (`groups.rs`).
    pub groups: Vec<i64>,
    pub genre: Option<String>,
    /// The user chose the genre; auto classification leaves it alone.
    pub genre_manual: bool,
    /// 1 (入門) to 5 (専門).
    pub difficulty: Option<i64>,
    pub difficulty_manual: bool,
    pub feed_id: Option<i64>,
    pub feed_title: Option<String>,
    /// The folder of the article's feed (feed_folders.rs).
    pub folder_id: Option<i64>,
    /// Extracted, but with almost no text: probably a JS-rendered page.
    pub thin: bool,
    /// The text is the feed entry's copy: the page could not be fetched or had no text.
    pub from_feed: bool,
    /// Extracted from a PDF (a URL's or an imported file's), kept as the snapshot.
    pub pdf: bool,
    /// Importance for the reader, 1-5 (relevance.rs), and why.
    pub relevance: Option<i64>,
    pub relevance_reason: Option<String>,
    /// Judged against another profile than the current one.
    pub relevance_stale: bool,
}

/// Inbox views (§12). "Recently added" is `All`, which is already newest first.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArticleFilter {
    All,
    Unread,
    Favorites,
    Tag {
        name: String,
    },
    /// `None`: 未分類.
    Genre {
        name: Option<String>,
    },
    /// `None`: 手動追加 (not from a feed).
    Feed {
        id: Option<i64>,
    },
    Group {
        id: i64,
    },
    /// The articles of a feed folder's feeds (feed_folders.rs).
    Folder {
        id: i64,
    },
    /// 重要: importance at least `min`.
    Important {
        min: i64,
    },
}

/// SQL condition on `articles` for `filter`, with its one parameter (`?1`) if any.
fn filter_cond(filter: &ArticleFilter) -> (&'static str, Option<rusqlite::types::Value>) {
    match filter {
        ArticleFilter::All => ("1", None),
        ArticleFilter::Unread => ("read_status = 'unread'", None),
        ArticleFilter::Favorites => ("favorite = 1", None),
        ArticleFilter::Tag { name } => {
            ("EXISTS (SELECT 1 FROM article_tags x JOIN tags t ON t.id = x.tag_id WHERE x.article_id = articles.id AND t.name = ?1)", Some(name.clone().into()))
        }
        ArticleFilter::Genre { name: Some(n) } => ("genre_id = (SELECT id FROM genres WHERE name = ?1)", Some(n.clone().into())),
        ArticleFilter::Genre { name: None } => ("genre_id IS NULL", None),
        ArticleFilter::Feed { id: Some(id) } => ("feed_id = ?1", Some((*id).into())),
        ArticleFilter::Feed { id: None } => ("feed_id IS NULL", None),
        ArticleFilter::Group { id } => ("EXISTS (SELECT 1 FROM group_articles WHERE article_id = articles.id AND group_id = ?1)", Some((*id).into())),
        ArticleFilter::Important { min } => ("EXISTS (SELECT 1 FROM relevance WHERE article_id = articles.id AND score >= ?1)", Some((*min).into())),
        ArticleFilter::Folder { id } => ("feed_id IN (SELECT id FROM feeds WHERE folder_id = ?1)", Some((*id).into())),
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ArticleSort {
    #[default]
    SavedDesc,
    SavedAsc,
    /// Articles without a published date come last.
    PublishedDesc,
    /// Easiest first; articles without a difficulty come last.
    DifficultyAsc,
    /// Most important first; unscored articles come last.
    RelevanceDesc,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, rename = "Block")]
pub struct StoredBlock {
    pub id: i64,
    pub ordinal: i64,
    pub heading_id: Option<i64>,
    #[serde(flatten)]
    pub block: Block,
    /// Current translation in the requested language, if any.
    pub translation: Option<String>,
    /// That translation's sentences as plain text (source and translation), for mixing by sentence.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub units: Vec<Unit>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct JobRow {
    pub id: i64,
    #[serde(rename = "type")]
    pub job_type: String,
    pub article_id: Option<i64>,
    pub params: Option<String>,
    #[ts(type = "\"pending\" | \"running\" | \"succeeded\" | \"failed\"")]
    pub status: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct SummaryView {
    pub text: String,
    pub created_at: String,
    /// The article was re-extracted with different content since this summary was made
    /// (`summarize::mark_stale` adds changed instructions).
    pub stale: bool,
    #[serde(skip)]
    pub prompt_version: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ArticleView {
    pub article: ArticleRow,
    /// Language of `blocks[].translation`: "en" for a Japanese article, else "ja".
    #[ts(type = "\"ja\" | \"en\"")]
    pub target_language: &'static str,
    pub blocks: Vec<StoredBlock>,
    pub jobs: Vec<JobRow>,
    pub summary: Option<SummaryView>,
    /// The user's memo (`set_note`).
    pub note: Option<String>,
}

pub struct SummarySource {
    pub title: String,
    pub content_hash: String,
    /// (kind, text) of headings and prose blocks in order.
    pub blocks: Vec<(String, String)>,
}

/// (source_hash, units, provider, model) of one cached translation.
pub type SegmentRow<'a> = (&'a str, &'a [Unit], &'a str, Option<&'a str>);

/// A block awaiting translation, as handed to the LLM.
#[derive(Debug, Clone)]
pub struct PendingBlock {
    pub id: i64,
    pub kind: String,
    pub text: String,
    pub text_hash: String,
    pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone)]
pub struct EmbedSource {
    pub block_id: i64,
    pub text_hash: String,
    pub text: String,
    pub heading: Option<String>,
}

#[derive(Debug, Serialize, TS)]
pub struct HitDetail {
    pub block_id: i64,
    pub article_id: i64,
    pub article_title: String,
    pub heading: Option<String>,
    pub text: String,
    pub translation: Option<String>,
    pub ordinal: i64,
}

const JOB_COLS: &str = "id, type, article_id, params, status, attempt_count, last_error, next_run_at";

fn job_row(r: &rusqlite::Row) -> Result<JobRow> {
    Ok(JobRow {
        id: r.get(0)?,
        job_type: r.get(1)?,
        article_id: r.get(2)?,
        params: r.get(3)?,
        status: r.get(4)?,
        attempt_count: r.get(5)?,
        last_error: r.get(6)?,
        next_run_at: r.get(7)?,
    })
}

/// A not yet extracted article shows its feed entry's title.
const ARTICLE_COLS: &str = concat!(
    "id, original_url, canonical_url, domain,
    coalesce(title, (SELECT title FROM feed_items WHERE feed_id = articles.feed_id AND normalized_url = articles.normalized_url)), author, site_name, published_at, language, saved_at, fetch_status, extraction_status, last_error, read_status, favorite,
    (SELECT json_group_array(name) FROM (SELECT t.name FROM article_tags x JOIN tags t ON t.id = x.tag_id WHERE x.article_id = articles.id ORDER BY t.name)),
    (SELECT name FROM genres WHERE id = articles.genre_id), genre_source IS 'manual', feed_id,
    (SELECT coalesce(custom_title, title, url) FROM feeds WHERE id = articles.feed_id), text_length, difficulty, difficulty_source IS 'manual',
    (SELECT content_type FROM snapshots WHERE article_id = articles.id ORDER BY id DESC LIMIT 1),
    (SELECT json_group_array(group_id) FROM (SELECT group_id FROM group_articles WHERE article_id = articles.id ORDER BY group_id)),
    (SELECT score FROM relevance WHERE article_id = articles.id), (SELECT reason FROM relevance WHERE article_id = articles.id),
    coalesce((SELECT NOT ",
    crate::relevance::current_sql!(),
    " FROM relevance WHERE article_id = articles.id), 0),
    (SELECT folder_id FROM feeds WHERE id = articles.feed_id)"
);

fn article_row(r: &rusqlite::Row) -> Result<ArticleRow> {
    let snapshot_type: Option<String> = r.get(23)?;
    Ok(ArticleRow {
        id: r.get(0)?,
        original_url: r.get(1)?,
        canonical_url: r.get(2)?,
        domain: r.get(3)?,
        title: r.get(4)?,
        author: r.get(5)?,
        site_name: r.get(6)?,
        published_at: r.get(7)?,
        language: r.get(8)?,
        saved_at: r.get(9)?,
        fetch_status: r.get(10)?,
        extraction_status: r.get(11)?,
        last_error: r.get(12)?,
        read_status: r.get(13)?,
        favorite: r.get(14)?,
        tags: from_json_col(r, 15, str::to_string)?,
        groups: from_json_col(r, 24, str::to_string)?,
        genre: r.get(16)?,
        genre_manual: r.get(17)?,
        difficulty: r.get(21)?,
        difficulty_manual: r.get(22)?,
        feed_id: r.get(18)?,
        feed_title: r.get(19)?,
        folder_id: r.get(28)?,
        // A short local note is complete, and so is a PDF; only a page can have more text than
        // was extracted.
        thin: r.get::<_, String>(11)? == "ok"
            && r.get::<_, Option<i64>>(20)?.unwrap_or(0) < THIN_TEXT_CHARS
            && !crate::markdown::is_local(&r.get::<_, String>(1)?)
            && snapshot_type.as_deref() != Some(crate::pdf::CONTENT_TYPE),
        from_feed: snapshot_type.as_deref() == Some(FEED_CONTENT_TYPE),
        pdf: snapshot_type.as_deref() == Some(crate::pdf::CONTENT_TYPE),
        relevance: r.get(25)?,
        relevance_reason: r.get(26)?,
        relevance_stale: r.get(27)?,
    })
}

/// Writes an article's blocks, reusing the id of each old block whose text is unchanged so
/// embeddings and search hits keep pointing at it. Duplicate texts are matched in order.
// shortcut: a reused block whose section heading changed keeps its old embedding (the heading is
// part of the passage); key embeddings on heading + text if that shows up in search quality.
fn replace_blocks(tx: &rusqlite::Transaction, article_id: i64, blocks: &[Block]) -> Result<()> {
    let mut old: HashMap<String, std::collections::VecDeque<i64>> = HashMap::new();
    {
        let mut st = tx.prepare("SELECT id, text_hash FROM blocks WHERE article_id = ?1 ORDER BY ordinal")?;
        for row in st.query_map([article_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, hash) = row?;
            old.entry(hash).or_default().push_back(id);
        }
    }
    // Park old rows on negative ordinals so moved rows never collide on UNIQUE(article_id, ordinal).
    tx.execute("UPDATE blocks SET ordinal = -1 - ordinal WHERE article_id = ?1", [article_id])?;
    let mut ins = tx.prepare(
        "INSERT INTO blocks (article_id, ordinal, kind, text, text_hash, inlines, attrs, heading_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    let mut upd = tx.prepare("UPDATE blocks SET ordinal = ?2, kind = ?3, inlines = ?4, attrs = ?5, heading_id = ?6 WHERE id = ?1")?;
    let mut heading: Option<i64> = None;
    for (i, b) in blocks.iter().enumerate() {
        let hash = sha256_hex(&b.text);
        let inlines = (!b.inlines.is_empty()).then(|| json(&b.inlines));
        let attrs = json(&b.attrs);
        let attrs = (attrs != "{}").then_some(attrs);
        let id = match old.get_mut(&hash).and_then(|ids| ids.pop_front()) {
            Some(id) => {
                upd.execute(params![id, i as i64, b.kind.as_str(), inlines, attrs, heading])?;
                id
            }
            None => {
                ins.execute(params![article_id, i as i64, b.kind.as_str(), b.text, hash, inlines, attrs, heading])?;
                tx.last_insert_rowid()
            }
        };
        if b.kind == crate::ir::BlockKind::Heading {
            heading = Some(id);
        }
    }
    tx.execute("DELETE FROM blocks WHERE article_id = ?1 AND ordinal < 0", [article_id])?;
    Ok(())
}

fn article_is_japanese(c: &Connection, id: i64) -> Result<bool> {
    let (declared, sample): (Option<String>, String) = c.query_row(
        "SELECT language, (SELECT coalesce(group_concat(text, ' '), '') FROM (SELECT text FROM blocks WHERE article_id = ?1
             AND kind IN (SELECT value FROM json_each(?2)) ORDER BY ordinal LIMIT 20))
         FROM articles WHERE id = ?1",
        params![id, json(&crate::ir::PROSE_KINDS)],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(crate::segments::is_japanese(declared.as_deref(), &sample))
}

pub fn sha256_hex(s: impl AsRef<[u8]>) -> String {
    hex(&Sha256::digest(s.as_ref()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `?1` article, `?2` target language, `?3` block kinds as a JSON array.
const UNTRANSLATED: &str = "b.article_id = ?1 AND b.kind IN (SELECT value FROM json_each(?3))
    AND NOT EXISTS (SELECT 1 FROM segment_translations st WHERE st.source_hash = b.text_hash AND st.target_language = ?2)";

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("IR types always serialize")
}

fn from_json_col<T: serde::de::DeserializeOwned>(r: &rusqlite::Row, i: usize, wrap: impl Fn(&str) -> String) -> Result<T> {
    let s: String = r.get(i)?;
    serde_json::from_str(&wrap(&s)).map_err(|e| rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(e)))
}

/// NULL JSON columns decode to the type's default.
fn opt_json_col<T: serde::de::DeserializeOwned + Default>(r: &rusqlite::Row, i: usize) -> Result<T> {
    match r.get::<_, Option<String>>(i)? {
        None => Ok(T::default()),
        Some(_) => from_json_col(r, i, str::to_string),
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version as usize > MIGRATIONS.len() {
            return Err(rusqlite::Error::ToSqlConversionFailure(format!("database version {version} is newer than this build ({})", MIGRATIONS.len()).into()));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            if RENORMALIZE_AT.contains(&(i + 1)) {
                renormalize_urls(&tx)?;
            }
            tx.pragma_update(None, "user_version", i as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub(crate) fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic mid-transaction rolls back via Drop, so the connection is still usable.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn summary_source(&self, article_id: i64) -> Result<Option<SummarySource>> {
        let c = self.conn();
        let Some((title, content_hash)) = c
            .query_row("SELECT coalesce(title, original_url), content_hash FROM articles WHERE id = ?1 AND extraction_status = 'ok'", [article_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .optional()?
        else {
            return Ok(None);
        };
        let mut st = c.prepare("SELECT kind, text FROM blocks WHERE article_id = ?1 AND kind IN (SELECT value FROM json_each(?2)) ORDER BY ordinal")?;
        let blocks = st.query_map(params![article_id, json(&crate::ir::PROSE_KINDS)], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_>>()?;
        Ok(Some(SummarySource { title, content_hash, blocks }))
    }

    #[allow(clippy::too_many_arguments, reason = "the columns of one row")]
    pub fn insert_summary(
        &self,
        article_id: i64,
        kind: &str,
        text: &str,
        source_hash: &str,
        provider: &str,
        model: Option<&str>,
        prompt_version: &str,
    ) -> Result<()> {
        self.conn().execute(
            "INSERT INTO summaries (article_id, type, text, source_hash, provider, model, prompt_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![article_id, kind, text, source_hash, provider, model, prompt_version],
        )?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()
    }

    pub fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let c = self.conn();
        match value {
            Some(v) => c.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", [key, v])?,
            None => c.execute("DELETE FROM settings WHERE key = ?1", [key])?,
        };
        Ok(())
    }

    /// Consistent single-file copy of the whole database, secrets included (safe while the app
    /// is running). For moving the data folder; backups use `backup_to`.
    pub fn copy_to(&self, path: &Path) -> Result<()> {
        self.conn().execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
        Ok(())
    }

    /// `copy_to` with the settings under `SECRET_PREFIX` (API keys) removed from the copy.
    pub fn backup_to(&self, path: &Path) -> Result<()> {
        self.copy_to(path)?;
        let copy = Connection::open(path)?;
        copy.execute("DELETE FROM settings WHERE key LIKE ?1 || '%'", [SECRET_PREFIX])?;
        copy.execute_batch("VACUUM")
    }

    pub fn article_row(&self, id: i64) -> Result<Option<ArticleRow>> {
        self.conn().query_row(&format!("SELECT {ARTICLE_COLS} FROM articles WHERE id = ?1"), [id], article_row).optional()
    }

    pub fn article_url(&self, id: i64) -> Result<Option<String>> {
        self.conn().query_row("SELECT original_url FROM articles WHERE id = ?1", [id], |r| r.get(0)).optional()
    }

    /// The saved article for a normalized URL (matching either its own or its canonical URL).
    pub fn find_article_by_url(&self, normalized_url: &str) -> Result<Option<i64>> {
        self.conn()
            .query_row("SELECT id FROM articles WHERE normalized_url = ?1 OR canonical_url = ?1 ORDER BY id LIMIT 1", [normalized_url], |r| r.get(0))
            .optional()
    }

    /// Returns the article id and whether it still needs fetching/extraction: also when its text
    /// is the feed's copy, so saving the URL again retries the page.
    pub fn upsert_pending(&self, original_url: &str, normalized_url: &str, domain: &str) -> Result<(i64, bool)> {
        let c = self.conn();
        c.execute(
            "INSERT INTO articles (original_url, normalized_url, domain) VALUES (?1, ?2, ?3)
             ON CONFLICT(normalized_url) DO NOTHING",
            params![original_url, normalized_url, domain],
        )?;
        c.query_row(
            "SELECT id, extraction_status != 'ok'
                 OR (SELECT content_type FROM snapshots WHERE article_id = articles.id ORDER BY id DESC LIMIT 1) IS ?2
             FROM articles WHERE normalized_url = ?1",
            params![normalized_url, FEED_CONTENT_TYPE],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    pub fn record_fetch_failure(&self, id: i64, error: &str) -> Result<()> {
        self.conn().execute("UPDATE articles SET fetch_status = 'failed', last_error = ?2 WHERE id = ?1", params![id, error])?;
        Ok(())
    }

    /// Persists the snapshot (`None` when re-extracting the stored one) and its extraction
    /// outcome atomically. Returns the surviving article id: if a new fetch's canonical URL
    /// reveals an existing article, this row is dropped in favour of it.
    pub fn save_fetched(
        &self,
        id: i64,
        snapshot: Option<&Fetched>,
        extracted: std::result::Result<ArticleIr, String>,
        canonical_normalized: Option<&str>,
    ) -> Result<i64> {
        let snapshot =
            snapshot.map(|f| NewSnapshot { final_url: &f.final_url, status: f.status, content_type: f.content_type.as_deref(), body: f.html.as_bytes() });
        self.save_snapshot(id, snapshot.as_ref(), extracted, canonical_normalized)
    }

    /// `save_fetched` for any source, a PDF's bytes included.
    pub fn save_snapshot(
        &self,
        id: i64,
        snapshot: Option<&NewSnapshot>,
        extracted: std::result::Result<ArticleIr, String>,
        canonical_normalized: Option<&str>,
    ) -> Result<i64> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        // Only a not-yet-extracted row merges: re-extraction and re-saves (rendered or refetched)
        // must not delete an article the user already has, with its tags, favorite and summaries.
        if let (Some(canon), Some(_)) = (canonical_normalized, snapshot) {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM articles WHERE id != ?1 AND extraction_status = 'ok'
                     AND (canonical_url = ?2 OR normalized_url = ?2)
                     AND (SELECT extraction_status FROM articles WHERE id = ?1) IS NOT 'ok' LIMIT 1",
                    params![id, canon],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                tx.execute("DELETE FROM articles WHERE id = ?1", [id])?;
                tx.commit()?;
                return Ok(existing);
            }
        }
        if let Some(f) = snapshot {
            tx.execute(
                "INSERT INTO snapshots (article_id, final_url, http_status, content_type, encoding, body)
                 VALUES (?1, ?2, ?3, ?4, 'deflate', ?5)",
                params![id, f.final_url, f.status, f.content_type, deflate(f.body)],
            )?;
            tx.execute("UPDATE articles SET fetch_status = 'ok', fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1", [id])?;
        }
        match extracted {
            Err(e) => {
                tx.execute("UPDATE articles SET extraction_status = 'failed', last_error = ?2 WHERE id = ?1", params![id, e])?;
            }
            Ok(ir) => {
                replace_blocks(&tx, id, &ir.blocks)?;
                let content: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
                let text_length: usize = ir.blocks.iter().map(|b| b.text.chars().count()).sum();
                let m = &ir.meta;
                tx.execute(
                    "UPDATE articles SET extraction_status = 'ok', last_error = NULL,
                     canonical_url = ?2, author = ?4, site_name = ?5,
                     -- The feed entry's title is clean; a page <title> often carries the site name.
                     title = coalesce((SELECT title FROM feed_items
                                       WHERE feed_id = articles.feed_id AND normalized_url = articles.normalized_url), ?3),
                     published_at = coalesce(?6, (SELECT published_at FROM feed_items
                                                  WHERE feed_id = articles.feed_id AND normalized_url = articles.normalized_url)),
                     language = ?7, content_hash = ?8, extraction_version = ?9, text_length = ?10
                     WHERE id = ?1",
                    params![
                        id,
                        canonical_normalized,
                        m.title,
                        m.author,
                        m.site_name,
                        m.published_at,
                        m.language,
                        sha256_hex(content.join("\n")),
                        EXTRACTION_VERSION,
                        text_length as i64
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn latest_snapshot(&self, article_id: i64) -> Result<Option<Snapshot>> {
        let row: Option<(String, Option<String>, String, Vec<u8>)> = self
            .conn()
            .query_row("SELECT final_url, content_type, encoding, body FROM snapshots WHERE article_id = ?1 ORDER BY id DESC LIMIT 1", [article_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        row.map(|(final_url, content_type, enc, body)| {
            let body = inflate_bytes(&enc, &body).map_err(|e| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Blob, Box::new(e)))?;
            Ok(Snapshot { final_url, content_type, body })
        })
        .transpose()
    }

    pub fn list_articles(&self, filter: &ArticleFilter) -> Result<Vec<ArticleRow>> {
        self.list_articles_sorted(filter, ArticleSort::default())
    }

    pub fn list_articles_sorted(&self, filter: &ArticleFilter, sort: ArticleSort) -> Result<Vec<ArticleRow>> {
        let order = match sort {
            ArticleSort::SavedDesc => "saved_at DESC, id DESC",
            ArticleSort::SavedAsc => "saved_at, id",
            // shortcut: published_at is whatever the page declared (usually ISO 8601); normalize at extraction if odd formats show up.
            ArticleSort::PublishedDesc => "published_at DESC, saved_at DESC, id DESC", // NULLs sort last when descending
            ArticleSort::DifficultyAsc => "difficulty IS NULL, difficulty, saved_at DESC, id DESC",
            ArticleSort::RelevanceDesc => "(SELECT score FROM relevance WHERE article_id = articles.id) DESC NULLS LAST, saved_at DESC, id DESC",
        };
        let (cond, arg) = filter_cond(filter);
        let c = self.conn();
        let mut st = c.prepare(&format!("SELECT {ARTICLE_COLS} FROM articles WHERE {cond} ORDER BY {order}"))?;
        let rows = st.query_map(rusqlite::params_from_iter(arg), article_row)?;
        rows.collect()
    }

    /// Ids of the articles in `filter`, as a search/chat restriction: `None` for `All`, so
    /// unfiltered search stays on its fast path.
    pub fn article_ids(&self, filter: &ArticleFilter) -> Result<Option<Vec<i64>>> {
        if *filter == ArticleFilter::All {
            return Ok(None);
        }
        let (cond, arg) = filter_cond(filter);
        let c = self.conn();
        let mut st = c.prepare(&format!("SELECT id FROM articles WHERE {cond}"))?;
        let ids = st.query_map(rusqlite::params_from_iter(arg), |r| r.get(0))?.collect::<Result<_>>()?;
        Ok(Some(ids))
    }

    /// Deletes an article and everything hanging off it. Snapshots, blocks (with their FTS rows
    /// and embeddings), jobs, tag links, summaries, classifications and image mappings cascade;
    /// image bytes go by trigger; translations no other block uses and tags no other article
    /// uses are deleted here. Feed items stay, so the feed does not import the article again,
    /// and chat answers keep their copied citations. Returns whether the article existed.
    pub fn delete_article(&self, id: i64) -> Result<bool> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM segment_translations WHERE source_hash IN (SELECT text_hash FROM blocks WHERE article_id = ?1)
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.text_hash = source_hash AND b.article_id != ?1)",
            [id],
        )?;
        let n = tx.execute("DELETE FROM articles WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM article_tags)", [])?;
        tx.commit()?;
        Ok(n > 0)
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<()> {
        self.conn().execute("UPDATE articles SET favorite = ?2 WHERE id = ?1", params![id, favorite])?;
        Ok(())
    }

    /// Tag names are trimmed and matched case-insensitively; empty names are ignored.
    pub fn add_tag(&self, article_id: i64, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute("INSERT INTO tags (name) VALUES (?1) ON CONFLICT(name) DO NOTHING", [name])?;
        tx.execute("INSERT OR IGNORE INTO article_tags (article_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2", params![article_id, name])?;
        tx.commit()
    }

    /// Unused tags are deleted so the tag list only shows tags in use.
    pub fn remove_tag(&self, article_id: i64, name: &str) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM article_tags WHERE article_id = ?1 AND tag_id = (SELECT id FROM tags WHERE name = ?2)", params![article_id, name.trim()])?;
        tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM article_tags)", [])?;
        tx.commit()
    }

    pub fn list_tags(&self) -> Result<Vec<TagCount>> {
        let c = self.conn();
        let mut st = c.prepare("SELECT t.name, count(*) FROM tags t JOIN article_tags x ON x.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE")?;
        st.query_map([], |r| Ok(TagCount { name: r.get(0)?, count: r.get(1)? }))?.collect()
    }

    /// Whether the article is Japanese (`segments::is_japanese`), from its declared language or its opening prose.
    pub fn article_is_japanese(&self, id: i64) -> Result<bool> {
        article_is_japanese(&self.conn(), id)
    }

    /// `target_language` is a `Target::key`.
    pub fn get_article(&self, id: i64, target_language: &str) -> Result<Option<ArticleView>> {
        let c = self.conn();
        let Some(article) = c.query_row(&format!("SELECT {ARTICLE_COLS} FROM articles WHERE id = ?1"), [id], article_row).optional()? else {
            return Ok(None);
        };
        let mut st = c.prepare(
            "SELECT b.id, b.ordinal, b.heading_id, b.kind, b.text, b.inlines, b.attrs,
                    st.text, st.units
             FROM blocks b
             LEFT JOIN segment_translations st ON st.id = (SELECT id FROM segment_translations
                 WHERE source_hash = b.text_hash AND target_language = ?2 ORDER BY id DESC LIMIT 1)
             WHERE b.article_id = ?1 ORDER BY b.ordinal",
        )?;
        let blocks = st
            .query_map(params![id, target_language], |r| {
                Ok(StoredBlock {
                    id: r.get(0)?,
                    ordinal: r.get(1)?,
                    heading_id: r.get(2)?,
                    block: Block {
                        kind: from_json_col(r, 3, |s| format!("\"{s}\""))?,
                        text: r.get(4)?,
                        inlines: opt_json_col(r, 5)?,
                        attrs: opt_json_col(r, 6)?,
                    },
                    translation: r.get(7)?,
                    units: opt_json_col::<Vec<Unit>>(r, 8)?
                        .into_iter()
                        .map(|u| Unit { source: plain_text(&u.source), translation: plain_text(&u.translation) })
                        .collect(),
                })
            })?
            .collect::<Result<_>>()?;
        let mut st = c.prepare(&format!("SELECT {JOB_COLS} FROM processing_jobs WHERE article_id = ?1 ORDER BY id"))?;
        let jobs = st.query_map([id], job_row)?.collect::<Result<_>>()?;
        let summary = c
            .query_row(
                "SELECT s.text, s.created_at, s.source_hash IS NOT a.content_hash, s.prompt_version FROM summaries s JOIN articles a ON a.id = s.article_id
                 WHERE s.article_id = ?1 AND s.type = 'normal' ORDER BY s.id DESC LIMIT 1",
                [id],
                |r| Ok(SummaryView { text: r.get(0)?, created_at: r.get(1)?, stale: r.get(2)?, prompt_version: r.get(3)? }),
            )
            .optional()?;
        let note = c.query_row("SELECT body FROM article_notes WHERE article_id = ?1", [id], |r| r.get(0)).optional()?;
        Ok(Some(ArticleView { article, target_language: Target::from_key(target_language, "").language, blocks, jobs, summary, note }))
    }

    /// The user's memo on an article; a blank one is removed.
    pub fn set_note(&self, article_id: i64, body: &str) -> Result<()> {
        let c = self.conn();
        if body.trim().is_empty() {
            c.execute("DELETE FROM article_notes WHERE article_id = ?1", [article_id])?;
        } else {
            c.execute(
                "INSERT INTO article_notes (article_id, body) VALUES (?1, ?2)
                 ON CONFLICT(article_id) DO UPDATE SET body = excluded.body, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                params![article_id, body],
            )?;
        }
        Ok(())
    }

    /// Blocks of `kinds` of an article lacking a current translation in `target_language`.
    pub fn untranslated_blocks(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<Vec<PendingBlock>> {
        let c = self.conn();
        let mut st = c.prepare(&format!("SELECT b.id, b.kind, b.text, b.text_hash, b.inlines FROM blocks b WHERE {UNTRANSLATED} ORDER BY b.ordinal"))?;
        let rows = st.query_map(params![article_id, target_language, json(&kinds)], |r| {
            Ok(PendingBlock { id: r.get(0)?, kind: r.get(1)?, text: r.get(2)?, text_hash: r.get(3)?, inlines: opt_json_col(r, 4)? })
        })?;
        rows.collect()
    }

    /// The texts of [`untranslated_blocks`](Self::untranslated_blocks), for counting what is left.
    pub fn untranslated_texts(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<Vec<String>> {
        let c = self.conn();
        let mut st = c.prepare(&format!("SELECT b.text FROM blocks b WHERE {UNTRANSLATED}"))?;
        let rows = st.query_map(params![article_id, target_language, json(&kinds)], |r| r.get(0))?;
        rows.collect()
    }

    /// Jobs of `job_type` queued or running, not waiting to retry after an error, oldest first.
    pub fn active_jobs(&self, job_type: &str) -> Result<Vec<JobRow>> {
        let c = self.conn();
        let mut st = c.prepare(&format!(
            "SELECT {JOB_COLS} FROM processing_jobs
             WHERE type = ?1 AND (status = 'running' OR (status = 'pending' AND last_error IS NULL)) ORDER BY id"
        ))?;
        st.query_map([job_type], job_row)?.collect()
    }

    /// How many of the article's blocks of `kinds` have a translation into `target_language`.
    pub fn translated_count(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<usize> {
        self.conn()
            .query_row(
                "SELECT count(*) FROM blocks b WHERE b.article_id = ?1 AND b.kind IN (SELECT value FROM json_each(?3)) AND EXISTS (
                 SELECT 1 FROM segment_translations st WHERE st.source_hash = b.text_hash AND st.target_language = ?2)",
                params![article_id, target_language, json(&kinds)],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n as usize)
    }

    /// Deletes the cached translations into `target_language` of the article's blocks of `kinds`.
    /// The cache is keyed by text, so other articles with the same paragraph lose it too.
    pub fn drop_translations(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<usize> {
        self.conn().execute(
            "DELETE FROM segment_translations WHERE target_language = ?2 AND source_hash IN (
                 SELECT text_hash FROM blocks WHERE article_id = ?1 AND kind IN (SELECT value FROM json_each(?3)))",
            params![article_id, target_language, json(&kinds)],
        )
    }

    /// Newest cached reading units per source hash.
    pub fn cached_segments(&self, hashes: &[String], target_language: &str) -> Result<HashMap<String, Vec<Unit>>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT source_hash, units FROM segment_translations
             WHERE source_hash IN (SELECT value FROM json_each(?1)) AND target_language = ?2 ORDER BY id",
        )?;
        let mut out = HashMap::new();
        for row in st.query_map(params![json(&hashes), target_language], |r| Ok((r.get::<_, String>(0)?, opt_json_col::<Vec<Unit>>(r, 1)?)))? {
            let (hash, units) = row?;
            out.insert(hash, units); // later rows win: newest translation
        }
        Ok(out)
    }

    pub fn insert_segments(&self, target_language: &str, prompt_version: &str, items: &[SegmentRow]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO segment_translations (source_hash, target_language, units, text, provider, model, prompt_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (hash, units, provider, model) in items {
                let text = plain_text(&crate::segments::joined_translation(units));
                ins.execute(params![hash, target_language, json(units), text, provider, model, prompt_version])?;
            }
        }
        tx.commit()
    }

    /// Idempotent: an existing job with the same key is reset to pending (unless running).
    pub fn enqueue_job(&self, job_type: &str, article_id: i64, params: &str, dedup_key: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO processing_jobs (type, article_id, params, dedup_key) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE status != 'running'",
            params![job_type, article_id, params, dedup_key],
        )?;
        Ok(())
    }

    /// Crash recovery: anything left `running` by a previous process gets picked up again.
    pub fn recover_running_jobs(&self) -> Result<usize> {
        self.conn().execute("UPDATE processing_jobs SET status = 'pending' WHERE status = 'running'", [])
    }

    /// Claims the oldest ready job whose type is in `types`. Ingest and image jobs are skipped
    /// while another one for an article of the same host is running (one fetch per site at a time).
    pub fn claim_next_job(&self, types: &[&str]) -> Result<Option<JobRow>> {
        self.claim_job(types, None)
    }

    /// `claim_next_job` limited to one article's jobs (the CLI's `save --run`).
    pub fn claim_article_job(&self, types: &[&str], article_id: i64) -> Result<Option<JobRow>> {
        self.claim_job(types, Some(article_id))
    }

    fn claim_job(&self, types: &[&str], article_id: Option<i64>) -> Result<Option<JobRow>> {
        self.conn()
            .query_row(
                &format!(
                    "UPDATE processing_jobs
                     SET status = 'running', attempt_count = attempt_count + 1,
                         started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = (SELECT j.id FROM processing_jobs j
                                 WHERE j.status = 'pending'
                                   AND j.type IN (SELECT value FROM json_each(?1))
                                   AND (j.next_run_at IS NULL OR j.next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                                   AND (?4 IS NULL OR j.article_id = ?4)
                                   AND NOT (j.type IN (?2, ?3) AND EXISTS (
                                       SELECT 1 FROM processing_jobs r
                                       JOIN articles ra ON ra.id = r.article_id
                                       JOIN articles ja ON ja.id = j.article_id
                                       WHERE r.status = 'running' AND r.type IN (?2, ?3) AND ra.domain = ja.domain))
                                 ORDER BY j.id LIMIT 1)
                     RETURNING {JOB_COLS}"
                ),
                params![json(&types), crate::ingest::JOB_TYPE, crate::images::JOB_TYPE, article_id],
                job_row,
            )
            .optional()
    }

    /// Failures retry with exponential backoff (2, 4, 8, ... minutes) until MAX_ATTEMPTS.
    pub fn finish_job(&self, id: i64, error: Option<&str>) -> Result<()> {
        let c = self.conn();
        match error {
            None => c.execute(
                "UPDATE processing_jobs SET status = 'succeeded', last_error = NULL, next_run_at = NULL,
                 completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
                [id],
            )?,
            Some(e) => c.execute(
                "UPDATE processing_jobs SET last_error = ?2,
                 status = CASE WHEN attempt_count >= ?3 THEN 'failed' ELSE 'pending' END,
                 next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || (1 << attempt_count) || ' minutes'),
                 completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id = ?1",
                params![id, e, MAX_ATTEMPTS],
            )?,
        };
        Ok(())
    }

    /// Blocks of `kinds` lacking a current embedding for `model`, with their section heading.
    pub fn unembedded_blocks(&self, article_id: i64, model: &str, kinds: &[&str]) -> Result<Vec<EmbedSource>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT b.id, b.text_hash, b.text, h.text FROM blocks b LEFT JOIN blocks h ON h.id = b.heading_id
             WHERE b.article_id = ?1 AND b.kind IN (SELECT value FROM json_each(?3)) AND NOT EXISTS (
                 SELECT 1 FROM embeddings e WHERE e.block_id = b.id AND e.model = ?2 AND e.source_hash = b.text_hash)
             ORDER BY b.ordinal",
        )?;
        st.query_map(params![article_id, model, json(&kinds)], |r| {
            Ok(EmbedSource { block_id: r.get(0)?, text_hash: r.get(1)?, text: r.get(2)?, heading: r.get(3)? })
        })?
        .collect()
    }

    pub fn upsert_embeddings(&self, model: &str, items: &[(&EmbedSource, &[f32])]) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare("INSERT OR REPLACE INTO embeddings (block_id, model, vector, source_hash) VALUES (?1, ?2, ?3, ?4)")?;
            for (src, v) in items {
                let blob: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
                ins.execute(params![src.block_id, model, blob, src.text_hash])?;
            }
        }
        tx.commit()
    }

    /// Enqueues an embed job for every extracted article that has blocks missing a current
    /// embedding for `model`. Cheap to call at startup; covers model switches and backfill.
    pub fn enqueue_missing_embeddings(&self, job_type: &str, model: &str, kinds: &[&str]) -> Result<usize> {
        self.conn().execute(
            "INSERT INTO processing_jobs (type, article_id, params, dedup_key)
             SELECT ?1, a.id, json_object('model', ?2), ?1 || ':' || a.id || ':' || ?2 FROM articles a
             WHERE a.extraction_status = 'ok' AND EXISTS (
                 SELECT 1 FROM blocks b WHERE b.article_id = a.id AND b.kind IN (SELECT value FROM json_each(?3))
                 AND NOT EXISTS (SELECT 1 FROM embeddings e
                                 WHERE e.block_id = b.id AND e.model = ?2 AND e.source_hash = b.text_hash))
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', attempt_count = 0, last_error = NULL, next_run_at = NULL
             WHERE status = 'succeeded'",
            params![job_type, model, json(&kinds)],
        )
    }

    /// Calls `f` for every stored vector of `model`, only for blocks of `articles` when given.
    /// shortcut: brute-force scan, fine to ~10^5-10^6 blocks; move to sqlite-vec or an ANN index beyond that.
    pub fn scan_embeddings(&self, model: &str, articles: Option<&[i64]>, mut f: impl FnMut(i64, &[f32])) -> Result<()> {
        // Chunked by rowid and scored after the lock is released: a full scan must not stall
        // every other store user (list, reader, job runners) for its whole duration.
        const CHUNK: i64 = 2048;
        let ids = articles.map(|a| json(&a));
        let (mut after, mut buf) = (0i64, Vec::new());
        loop {
            let chunk: Vec<(i64, i64, Vec<u8>)> = {
                let c = self.conn();
                let row = |r: &rusqlite::Row| Ok((r.get(0)?, r.get(1)?, r.get(2)?));
                match &ids {
                    None => c
                        .prepare_cached("SELECT rowid, block_id, vector FROM embeddings WHERE model = ?1 AND rowid > ?2 ORDER BY rowid LIMIT ?3")?
                        .query_map(params![model, after, CHUNK], row)?
                        .collect::<rusqlite::Result<_>>()?,
                    Some(ids) => c
                        .prepare_cached(
                            "SELECT e.rowid, e.block_id, e.vector FROM blocks b JOIN embeddings e ON e.block_id = b.id AND e.model = ?1
                             WHERE b.article_id IN (SELECT value FROM json_each(?4)) AND e.rowid > ?2 ORDER BY e.rowid LIMIT ?3",
                        )?
                        .query_map(params![model, after, CHUNK, ids], row)?
                        .collect::<rusqlite::Result<_>>()?,
                }
            };
            for (_, block_id, blob) in &chunk {
                buf.clear();
                buf.extend(blob.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)));
                f(*block_id, &buf);
            }
            match chunk.last() {
                Some(&(rowid, ..)) if chunk.len() as i64 == CHUNK => after = rowid,
                _ => return Ok(()),
            }
        }
    }

    /// Block ids ranked by FTS (best first), searching original text and translations.
    /// Terms of 3+ characters use the trigram index; shorter ones (e.g. 「索引」) filter by LIKE.
    /// `articles` restricts hits to blocks of those articles (metadata filter).
    pub fn lexical_search(&self, query: &str, articles: Option<&[i64]>, limit: usize) -> Result<Vec<i64>> {
        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let (long, short): (Vec<&str>, Vec<&str>) = terms.into_iter().partition(|t| t.chars().count() >= 3);
        let mut args: Vec<String> = Vec::new();
        let mut conds = Vec::new();
        if !long.is_empty() {
            // Quote every term so FTS5 syntax characters in user input are literal.
            args.push(long.iter().map(|t| format!("\"{}\"", t.replace('"', "\"\""))).collect::<Vec<_>>().join(" "));
            conds.push(format!("{{t}} MATCH ?{}", args.len()));
        }
        for t in &short {
            args.push(format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
            conds.push(format!("{{t}}.text LIKE ?{} ESCAPE '\\'", args.len()));
        }
        let scope = match articles {
            None => String::new(),
            Some(ids) => {
                args.push(json(&ids));
                format!("WHERE block_id IN (SELECT id FROM blocks WHERE article_id IN (SELECT value FROM json_each(?{})))", args.len())
            }
        };
        let rank = if long.is_empty() {
            "0"
        } else {
            "bm25({t})"
        };
        let branch = |t: &str| format!("WHERE {}", conds.join(" AND ")).replace("{t}", t);
        let sql = format!(
            "SELECT block_id FROM (
                 SELECT rowid AS block_id, {r1} AS r FROM blocks_fts {w1}
                 UNION ALL
                 SELECT b.id, {r2} AS r FROM translations_fts
                     JOIN segment_translations st ON st.id = translations_fts.rowid
                     JOIN blocks b ON b.text_hash = st.source_hash {w2}
             ) {scope} GROUP BY block_id ORDER BY min(r), block_id DESC LIMIT {limit}",
            r1 = rank.replace("{t}", "blocks_fts"),
            r2 = rank.replace("{t}", "translations_fts"),
            w1 = branch("blocks_fts"),
            w2 = branch("translations_fts"),
        );
        let c = self.conn();
        let mut st = c.prepare(&sql)?;
        st.query_map(rusqlite::params_from_iter(args), |r| r.get(0))?.collect()
    }

    /// Display data for search hits, in the order of `block_ids`. Each hit's translation is in its
    /// article's target language (`settings` adapted per article).
    pub fn hit_details(&self, block_ids: &[i64], settings: &Target) -> Result<Vec<HitDetail>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT b.id, b.article_id, coalesce(a.title, a.original_url), h.text, b.text, b.text_hash, b.ordinal
             FROM blocks b JOIN articles a ON a.id = b.article_id LEFT JOIN blocks h ON h.id = b.heading_id
             WHERE b.id IN (SELECT value FROM json_each(?1))",
        )?;
        let rows: Vec<(HitDetail, String)> = st
            .query_map(params![json(&block_ids)], |r| {
                let hit = HitDetail {
                    block_id: r.get(0)?,
                    article_id: r.get(1)?,
                    article_title: r.get(2)?,
                    heading: r.get(3)?,
                    text: r.get(4)?,
                    translation: None,
                    ordinal: r.get(6)?,
                };
                Ok((hit, r.get(5)?))
            })?
            .collect::<Result<_>>()?;
        let mut keys: HashMap<i64, String> = HashMap::new();
        let mut tr = c.prepare("SELECT text FROM segment_translations WHERE source_hash = ?1 AND target_language = ?2 ORDER BY id DESC LIMIT 1")?;
        let mut out = Vec::with_capacity(rows.len());
        for (mut hit, hash) in rows {
            let key = match keys.get(&hit.article_id) {
                Some(k) => k.clone(),
                None => {
                    let k = settings.for_source(article_is_japanese(&c, hit.article_id)?).key();
                    keys.insert(hit.article_id, k.clone());
                    k
                }
            };
            hit.translation = tr.query_row(params![hash, key], |r| r.get(0)).optional()?;
            out.push(hit);
        }
        out.sort_by_key(|h| block_ids.iter().position(|&id| id == h.block_id));
        Ok(out)
    }

    #[cfg(test)]
    pub(crate) fn exec_for_test(&self, sql: &str) {
        self.conn().execute_batch(sql).unwrap();
    }

    pub fn set_read_status(&self, id: i64, read: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE articles SET read_status = ?2 WHERE id = ?1",
            params![
                id,
                if read {
                    "read"
                } else {
                    "unread"
                }
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `db/master.sql` is the schema all migrations build, for reading only (the app never runs it).
    /// `UPDATE_MASTER_SQL=1 cargo test -p lattice-core master_sql` rewrites it.
    #[test]
    fn master_sql_matches_migrations() {
        let s = Store::open_in_memory().unwrap();
        let c = s.conn();
        // FTS5 shadow tables are created by their virtual table, not by a statement of ours.
        let mut st = c
            .prepare(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN (SELECT name FROM pragma_table_list WHERE type = 'shadow')
                 ORDER BY tbl_name, type <> 'table', type, name",
            )
            .unwrap();
        let ddl = st.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap() + ";\n").collect::<Vec<_>>();
        let master = format!(
            "-- Generated by store::tests::master_sql_matches_migrations; do not edit.\n-- PRAGMA user_version = {}\n\n{}",
            MIGRATIONS.len(),
            ddl.join("\n")
        );
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("db/master.sql");
        if std::env::var_os("UPDATE_MASTER_SQL").is_some() {
            std::fs::write(&path, &master).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap_or_default(), master, "db/master.sql is stale: rerun with UPDATE_MASTER_SQL=1");
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_on_open() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1).unwrap();
        let e = Store::init(conn).err().expect("refused").to_string();
        assert!(e.contains("newer than this build"), "{e}");
    }

    /// Migration 4 rewrites the snapshots table; pre-existing raw HTML must survive it.
    #[test]
    fn snapshot_migration_keeps_old_rows() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..3] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute_batch(
            "INSERT INTO articles (original_url, normalized_url, domain) VALUES ('u', 'u', 'd');
             INSERT INTO snapshots (article_id, final_url, http_status, html) VALUES (1, 'https://x/', 200, '<p>日本語</p>');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let snap = s.latest_snapshot(1).unwrap().unwrap();
        assert_eq!((snap.final_url.as_str(), snap.html().as_str()), ("https://x/", "<p>日本語</p>"));
    }

    #[test]
    fn upgrades_a_database_from_the_last_release_schema() {
        // Version 8 is the schema shipped before the parallel feature branches were merged.
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..8] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 8).unwrap();
        conn.execute_batch(
            "INSERT INTO articles (original_url, normalized_url, domain, extraction_status, fetch_status, title)
                 VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev', 'ok', 'ok', 'WAL');
             INSERT INTO blocks (article_id, ordinal, kind, text, text_hash) VALUES (1, 0, 'paragraph', 'Write-ahead logging', 'h');
             INSERT INTO settings (key, value) VALUES ('claude_model', 'sonnet');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let rows = s.list_articles(&ArticleFilter::All).unwrap();
        assert_eq!((rows.len(), rows[0].thin, rows[0].genre.as_deref()), (1, true, None), "text_length backfilled");
        assert_eq!(s.get_article(1, "ja").unwrap().unwrap().blocks.len(), 1);
        assert_eq!(s.setting("claude_model").unwrap().as_deref(), Some("sonnet"));
    }

    #[test]
    fn quiz_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("CREATE TABLE quizzes")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch("INSERT INTO articles (original_url, normalized_url, domain) VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev');").unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!(s.list_articles(&ArticleFilter::All).unwrap().len(), 1);
        assert!(crate::quiz::get(&s, 1).unwrap().is_none());
        assert_eq!(crate::review::overview(&s, 0).unwrap().due, 0);
    }

    #[test]
    fn vocab_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("CREATE TABLE vocab_entries")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch(
            "INSERT INTO articles (original_url, normalized_url, domain) VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev');
             INSERT INTO quizzes (article_id, source_hash, provider, prompt_version) VALUES (1, 'h', 'fake', 'quiz-v1');
             INSERT INTO quiz_questions (quiz_id, ordinal, kind, question, options, answer, explanation, block_ids) VALUES (1, 0, 'recall', 'q', '[]', 'a', '', '[]');
             INSERT INTO review_cards (question_id, ease, interval_minutes, reps, lapses, due_at) VALUES (1, 2500, 0, 0, 0, 0);",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert!(crate::vocab::list(&s).unwrap().is_empty());
        assert_eq!(crate::review::overview(&s, 0).unwrap().due, 1, "the quiz card is still due");
    }

    #[test]
    fn cloze_cards_go_and_meaning_cards_keep_their_history() {
        let at = MIGRATIONS.iter().position(|m| m.contains("DELETE FROM vocab_cards WHERE kind = 'cloze'")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch(
            "INSERT INTO vocab_entries (id, headword, state, meaning) VALUES (1, 'skew', 'ready', '歪み');
             INSERT INTO vocab_contexts (entry_id, surface, sentence) VALUES (1, 'skew', 'Write skew.');
             INSERT INTO vocab_cards (id, entry_id, kind, ease, interval_minutes, reps, lapses, due_at) VALUES
                 (10, 1, 'cloze', 2500, 1440, 1, 0, 100), (11, 1, 'meaning', 2600, 4320, 2, 0, 200);
             INSERT INTO vocab_log (card_id, grade, prev_interval_minutes, interval_minutes, ease, reviewed_at) VALUES
                 (10, 'good', 0, 1440, 2500, 50), (11, 'good', 0, 1440, 2500, 60), (11, 'easy', 1440, 4320, 2600, 70);",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let c = s.conn();
        let cards: Vec<(i64, String, i64, i64, i64)> = c
            .prepare("SELECT id, kind, ease, interval_minutes, due_at FROM vocab_cards")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(cards, [(11, "meaning".to_string(), 2600, 4320, 200)]);
        let log: Vec<i64> =
            c.prepare("SELECT reviewed_at FROM vocab_log ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(log, [60, 70], "the cloze card's answer went with it");
    }

    #[test]
    fn group_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("CREATE TABLE groups")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch("INSERT INTO articles (original_url, normalized_url, domain) VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev');").unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!(s.article_row(1).unwrap().unwrap().groups, Vec::<i64>::new());
        let g = crate::groups::create(&s, "Reading").unwrap();
        crate::groups::add(&s, g, &[1]).unwrap();
        assert_eq!(s.list_articles(&ArticleFilter::Group { id: g }).unwrap().len(), 1);
    }

    #[test]
    fn relevance_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("CREATE TABLE relevance")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch("INSERT INTO articles (original_url, normalized_url, domain) VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev');").unwrap();
        let s = Store::init(conn).unwrap();
        let rows = s.list_articles_sorted(&ArticleFilter::All, ArticleSort::RelevanceDesc).unwrap();
        assert_eq!((rows.len(), rows[0].relevance, rows[0].relevance_stale), (1, None, false));
        assert_eq!(s.article_ids(&ArticleFilter::Important { min: 4 }).unwrap(), Some(vec![]));
    }

    #[test]
    fn feed_folder_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("CREATE TABLE feed_folders")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch(
            "INSERT INTO feeds (url) VALUES ('https://a.dev/feed');
             INSERT INTO articles (original_url, normalized_url, domain, feed_id) VALUES ('https://a.dev/1', 'https://a.dev/1', 'a.dev', 1);",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!((crate::feeds::list(&s).unwrap()[0].folder_id, s.article_row(1).unwrap().unwrap().folder_id), (None, None));
        let f = crate::feed_folders::create(&s, "TechFeed").unwrap();
        crate::feed_folders::move_feeds(&s, &[1], Some(f)).unwrap();
        assert_eq!(s.article_row(1).unwrap().unwrap().folder_id, Some(f));
        assert_eq!(s.list_articles(&ArticleFilter::Folder { id: f }).unwrap().len(), 1);
    }

    #[test]
    fn feed_order_migration_keeps_the_order_by_name() {
        let at = MIGRATIONS.iter().position(|m| m.contains("ALTER TABLE feeds ADD COLUMN position")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch(
            "INSERT INTO feed_folders (name, position) VALUES ('Tech', 0);
             INSERT INTO feeds (url, title) VALUES ('https://c.dev/feed', 'charlie'), ('https://a.dev/feed', 'Alpha'), ('https://b.dev/feed', NULL);
             INSERT INTO feeds (url, title, custom_title, folder_id) VALUES ('https://y.dev/feed', 'y', 'Yankee', 1), ('https://x.dev/feed', 'X-ray', NULL, 1);",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let urls = crate::feeds::list(&s).unwrap().into_iter().map(|f| f.url).collect::<Vec<_>>();
        assert_eq!(urls, ["https://x.dev/feed", "https://y.dev/feed", "https://a.dev/feed", "https://c.dev/feed", "https://b.dev/feed"]);
        let (d, _) = crate::feeds::add(&s, "https://0.dev/feed", None).unwrap();
        assert_eq!(crate::feeds::list(&s).unwrap().last().unwrap().id, d, "a new feed goes last");
    }

    #[test]
    fn feed_filter_migration_upgrades_an_existing_library() {
        let at = MIGRATIONS.iter().position(|m| m.contains("ALTER TABLE feeds ADD COLUMN filter TEXT")).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64).unwrap();
        conn.execute_batch(
            "INSERT INTO feeds (url) VALUES ('https://a.dev/feed'); INSERT INTO feed_items (feed_id, normalized_url) VALUES (1, 'https://a.dev/1');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let feeds = crate::feeds::list(&s).unwrap();
        assert_eq!((feeds[0].rejected, feeds[0].filtered, feeds[0].filter_note.as_deref()), (0, false, None));
        assert_eq!(crate::feeds::import(&s, 1, &[crate::feeds::Entry { url: "https://a.dev/1".into(), ..Default::default() }]).unwrap(), 0, "seen before");
    }

    #[test]
    fn medium_feed_links_are_normalized_again() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..RENORMALIZE_AT[0] - 1] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", RENORMALIZE_AT[0] as i64 - 1).unwrap();
        conn.execute_batch(
            "INSERT INTO feeds (url, etag) VALUES ('https://m.dev/feed', 'W/1');
             INSERT INTO articles (original_url, normalized_url, domain, feed_id) VALUES
                 ('https://m.dev/a?source=rss----x---4', 'https://m.dev/a?source=rss----x---4', 'm.dev', 1),
                 ('https://m.dev/b', 'https://m.dev/b', 'm.dev', NULL),
                 ('https://m.dev/b?source=rss----x---4', 'https://m.dev/b?source=rss----x---4', 'm.dev', 1);
             INSERT INTO feed_items (feed_id, normalized_url) VALUES (1, 'https://m.dev/a?source=rss----x---4');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let urls: Vec<String> =
            s.conn().prepare("SELECT normalized_url FROM articles ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(urls, ["https://m.dev/a", "https://m.dev/b", "https://m.dev/b?source=rss----x---4"], "a taken URL keeps its old form");
        let item: String = s.conn().query_row("SELECT normalized_url FROM feed_items", [], |r| r.get(0)).unwrap();
        assert_eq!(item, "https://m.dev/a");
        let etag: Option<String> = s.conn().query_row("SELECT etag FROM feeds", [], |r| r.get(0)).unwrap();
        assert_eq!(etag, None, "the next poll fetches the feed in full");
    }

    #[test]
    fn a_blank_note_is_removed() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        s.set_note(id, "first").unwrap();
        s.set_note(id, "second").unwrap();
        assert_eq!(s.get_article(id, "ja").unwrap().unwrap().note.as_deref(), Some("second"));
        s.set_note(
            id, "  
",
        )
        .unwrap();
        assert_eq!(s.get_article(id, "ja").unwrap().unwrap().note, None);
        let rows: i64 = s.conn().query_row("SELECT count(*) FROM article_notes", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    /// A feed linking http:// saved its articles under http keys; the browser lands on https.
    #[test]
    fn http_urls_are_keyed_as_https_again() {
        let at = MIGRATIONS.iter().position(|m| m.contains("folds http into https")).unwrap() + 1;
        assert!(RENORMALIZE_AT.contains(&at));
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..at - 1] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", at as i64 - 1).unwrap();
        conn.execute_batch(
            "INSERT INTO feeds (url) VALUES ('https://b.dev/rss.xml');
             INSERT INTO articles (original_url, normalized_url, domain, feed_id) VALUES
                 ('http://b.dev/a.html', 'http://b.dev/a.html', 'b.dev', 1),
                 ('http://b.dev/b.html', 'http://b.dev/b.html', 'b.dev', 1),
                 ('https://b.dev/b.html', 'https://b.dev/b.html', 'b.dev', NULL);
             INSERT INTO feed_items (feed_id, normalized_url) VALUES (1, 'http://b.dev/a.html');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!(s.find_article_by_url("https://b.dev/a.html").unwrap(), Some(1));
        assert_eq!(s.find_article_by_url("https://b.dev/b.html").unwrap(), Some(3), "the http copy keeps its key; the saved https one matches");
        let item: String = s.conn().query_row("SELECT normalized_url FROM feed_items", [], |r| r.get(0)).unwrap();
        assert_eq!(item, "https://b.dev/a.html");
        let original: String = s.conn().query_row("SELECT original_url FROM articles WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(original, "http://b.dev/a.html", "pages are still fetched from where the feed points");
    }

    /// Migration 5 moves block translations into the hash-keyed segment cache.
    #[test]
    fn translation_migration_keeps_rows_searchable() {
        let conn = Connection::open_in_memory().unwrap();
        for sql in &MIGRATIONS[..4] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 4).unwrap();
        let hash = sha256_hex("Snapshot isolation");
        conn.execute_batch(&format!(
            "INSERT INTO articles (original_url, normalized_url, domain, extraction_status) VALUES ('u', 'u', 'd', 'ok');
             INSERT INTO blocks (article_id, ordinal, kind, text, text_hash) VALUES (1, 0, 'paragraph', 'Snapshot isolation', '{hash}');
             INSERT INTO translations (block_id, target_language, text, source_hash, provider, prompt_version)
                 VALUES (1, 'ja', 'スナップショット分離', '{hash}', 'claude-cli', 'translate-v1');"
        ))
        .unwrap();
        let s = Store::init(conn).unwrap();
        let v = s.get_article(1, "ja").unwrap().unwrap();
        assert_eq!(v.blocks[0].translation.as_deref(), Some("スナップショット分離"));
        assert_eq!(s.lexical_search("スナップショット", None, 10).unwrap(), [1]);
        let cached = s.cached_segments(std::slice::from_ref(&hash), "ja").unwrap();
        assert_eq!(cached[&hash], [Unit { source: "Snapshot isolation".into(), translation: "スナップショット分離".into() }]);
    }

    #[test]
    fn re_extraction_reuses_ids_of_unchanged_blocks() {
        use crate::ir::BlockKind::{Heading, Paragraph};
        let b = |kind, text: &str| Block { kind, text: text.into(), inlines: vec![], attrs: Default::default() };
        let ir = |blocks| Ok(ArticleIr { meta: Default::default(), blocks });
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        let f = Fetched { final_url: "https://a.dev/1".into(), status: 200, content_type: None, html: "<p>x</p>".into() };
        let first = vec![b(Heading, "Alpha"), b(Paragraph, "first para"), b(Paragraph, "second para"), b(Heading, "Beta"), b(Paragraph, "third para")];
        s.save_fetched(id, Some(&f), ir(first), None).unwrap();
        let rows = || {
            let v = s.get_article(id, "ja").unwrap().unwrap();
            v.blocks.into_iter().map(|b| (b.block.text, b.id, b.heading_id)).collect::<Vec<_>>()
        };
        let old = rows();
        let old_id = |t: &str| old.iter().find(|r| r.0 == t).unwrap().1;
        let src = |t: &str| EmbedSource { block_id: old_id(t), text_hash: sha256_hex(t), text: t.into(), heading: None };
        let (keep, gone) = (src("second para"), src("first para"));
        s.upsert_embeddings("m", &[(&keep, &[1.0][..]), (&gone, &[1.0][..])]).unwrap();

        // Alpha removed, first para edited, Beta moved to the top, third para unchanged.
        let second = vec![b(Heading, "Beta"), b(Paragraph, "second para"), b(Paragraph, "first para, edited"), b(Paragraph, "third para")];
        s.save_fetched(id, None, ir(second), None).unwrap();
        let new = rows();
        let beta = old_id("Beta");
        assert_eq!(new[0], ("Beta".into(), beta, None));
        assert_eq!(new[1], ("second para".into(), old_id("second para"), Some(beta)));
        assert!(!old.iter().any(|r| r.1 == new[2].1), "edited block gets a new id");
        assert_eq!(new[2].2, Some(beta));
        assert_eq!(new[3], ("third para".into(), old_id("third para"), Some(beta)));

        let mut vecs = Vec::new();
        s.scan_embeddings("m", None, |bid, _| vecs.push(bid)).unwrap();
        assert_eq!(vecs, [old_id("second para")], "embedding of the reused block survives, the dropped one cascades");
        assert_eq!(s.lexical_search("edited", None, 10).unwrap(), [new[2].1]);
        assert!(s.lexical_search("Alpha", None, 10).unwrap().is_empty());
        let snaps: i64 = s.conn().query_row("SELECT count(*) FROM snapshots", [], |r| r.get(0)).unwrap();
        assert_eq!(snaps, 1, "re-extraction stores no new snapshot");
    }

    #[test]
    fn deleting_an_article_leaves_nothing_orphaned() {
        use crate::ir::BlockKind::Paragraph;
        let s = Store::open_in_memory().unwrap();
        let save = |url: &str, texts: &[&str]| {
            let (id, _) = s.upsert_pending(url, url, "a.dev").unwrap();
            let blocks = texts.iter().map(|t| Block { kind: Paragraph, text: t.to_string(), inlines: vec![], attrs: Default::default() }).collect();
            let f = Fetched { final_url: url.into(), status: 200, content_type: None, html: "<p>x</p>".into() };
            s.save_fetched(id, Some(&f), Ok(ArticleIr { meta: Default::default(), blocks }), None).unwrap();
            id
        };
        let a = save("https://a.dev/1", &["shared paragraph", "only in the deleted article"]);
        let b = save("https://a.dev/2", &["shared paragraph"]);
        let unit = |t: &str| vec![Unit { source: t.into(), translation: format!("訳: {t}") }];
        let (shared, only) = (unit("shared paragraph"), unit("only in the deleted article"));
        let (hs, ho) = (sha256_hex("shared paragraph"), sha256_hex("only in the deleted article"));
        s.insert_segments("ja", "v", &[(hs.as_str(), &shared[..], "p", None), (ho.as_str(), &only[..], "p", None)]).unwrap();
        let blocks = s.get_article(a, "ja").unwrap().unwrap().blocks;
        let srcs: Vec<EmbedSource> =
            blocks.iter().map(|b| EmbedSource { block_id: b.id, text_hash: sha256_hex(&b.block.text), text: b.block.text.clone(), heading: None }).collect();
        s.upsert_embeddings("m", &srcs.iter().map(|e| (e, &[1.0f32][..])).collect::<Vec<_>>()).unwrap();
        s.add_tag(a, "mine").unwrap();
        s.add_tag(a, "both").unwrap();
        s.add_tag(b, "both").unwrap();
        s.insert_summary(a, "normal", "要約", "h", "p", None, "v").unwrap();
        s.enqueue_job("translate", a, "{}", "translate:a").unwrap();
        crate::images::save(&s, a, "https://a.dev/x.png", "image/png", b"\x89PNG only-a").unwrap();
        s.exec_for_test(&format!(
            "INSERT INTO classifications (article_id, genre, tags, provider, prompt_version) VALUES ({a}, 'Database', '[]', 'p', 'v');
             INSERT INTO feeds (url) VALUES ('https://a.dev/feed');
             INSERT INTO feed_items (feed_id, normalized_url) VALUES (1, 'https://a.dev/1');
             UPDATE articles SET feed_id = 1 WHERE id = {a};"
        ));

        assert!(s.delete_article(a).unwrap());
        assert!(!s.delete_article(a).unwrap(), "already gone");
        let count = |sql: &str| s.conn().query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        for table in ["snapshots", "blocks", "processing_jobs", "article_tags", "summaries", "classifications", "article_images"] {
            assert_eq!(count(&format!("SELECT count(*) FROM {table} WHERE article_id NOT IN (SELECT id FROM articles)")), 0, "{table}");
        }
        assert_eq!(count("SELECT count(*) FROM embeddings WHERE block_id NOT IN (SELECT id FROM blocks)"), 0);
        assert_eq!(count("SELECT count(*) FROM embeddings"), 0);
        assert_eq!(count("SELECT count(*) FROM images"), 0, "unused image bytes collected");
        assert_eq!(count("SELECT count(*) FROM snapshots"), 1, "the other article's snapshot stays");
        assert_eq!(s.list_tags().unwrap().iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["both"]);
        assert_eq!(s.cached_segments(&[hs.clone(), ho.clone()], "ja").unwrap().into_keys().collect::<Vec<_>>(), [hs], "a translation still in use stays");
        assert!(s.lexical_search("deleted", None, 10).unwrap().is_empty(), "block FTS rows gone");
        assert_eq!(count("SELECT count(*) FROM translations_fts WHERE translations_fts MATCH '\"deleted article\"'"), 0, "translation FTS rows gone");
        assert_eq!(count("SELECT count(*) FROM translations_fts WHERE translations_fts MATCH '\"shared paragraph\"'"), 1);
        assert_eq!(s.lexical_search("shared", None, 10).unwrap().len(), 1);
        assert_eq!(count("SELECT count(*) FROM feed_items"), 1, "the feed does not import it again");
    }

    #[test]
    fn re_enqueue_gives_a_failed_job_fresh_attempts() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        s.enqueue_job("t", id, "{}", "t:1").unwrap();
        s.exec_for_test("UPDATE processing_jobs SET status = 'failed', attempt_count = 5, last_error = 'boom'");
        s.enqueue_job("t", id, "{}", "t:1").unwrap();
        let job = s.claim_next_job(&["t"]).unwrap().unwrap();
        assert_eq!((job.attempt_count, job.last_error), (1, None));
        s.finish_job(job.id, Some("again")).unwrap();
        let status: String = s.conn().query_row("SELECT status FROM processing_jobs", [], |r| r.get(0)).unwrap();
        assert_eq!(status, "pending", "retried with backoff, not failed at once");
        // A running job is left alone.
        s.exec_for_test("UPDATE processing_jobs SET status = 'running', attempt_count = 3");
        s.enqueue_job("t", id, "{}", "t:1").unwrap();
        let row: (String, i64) = s.conn().query_row("SELECT status, attempt_count FROM processing_jobs", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(row, ("running".into(), 3));
    }

    #[test]
    fn a_job_that_keeps_failing_backs_off_doubling_then_fails_for_good() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        s.enqueue_job("t", id, "{}", "t:1").unwrap();
        let mut seen = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            let job = s.claim_next_job(&["t"]).unwrap().expect("ready once its backoff has elapsed");
            s.finish_job(job.id, Some("boom")).unwrap();
            assert!(s.claim_next_job(&["t"]).unwrap().is_none(), "not ready during the backoff");
            seen.push(
                s.conn()
                    .query_row(
                        "SELECT status, CAST(round((julianday(next_run_at) - julianday(completed_at)) * 1440) AS INTEGER) FROM processing_jobs",
                        [],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
                    )
                    .unwrap(),
            );
            s.exec_for_test("UPDATE processing_jobs SET next_run_at = '2000-01-01T00:00:00.000Z'");
        }
        let pending = |m| ("pending".to_string(), m);
        assert_eq!(seen[..4], [pending(2), pending(4), pending(8), pending(16)]);
        assert_eq!(seen[4].0, "failed");
        assert!(s.claim_next_job(&["t"]).unwrap().is_none(), "a failed job is never claimed again");
    }

    #[test]
    fn only_fetch_jobs_wait_for_a_running_fetch_on_the_same_host() {
        use crate::{images, ingest};
        let s = Store::open_in_memory().unwrap();
        let (a1, _) = s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        let (a2, _) = s.upsert_pending("https://a.dev/2", "https://a.dev/2", "a.dev").unwrap();
        s.enqueue_job(ingest::JOB_TYPE, a1, "{}", "ingest:1").unwrap();
        s.enqueue_job(images::JOB_TYPE, a2, "{}", "images:2").unwrap();
        s.enqueue_job("translate", a2, "{}", "translate:2").unwrap();
        let types = [ingest::JOB_TYPE, images::JOB_TYPE, "translate"];
        let claim = || s.claim_next_job(&types).unwrap().map(|j| (j.id, j.job_type));
        let (fetch, kind) = claim().unwrap();
        assert_eq!(kind, ingest::JOB_TYPE);
        assert_eq!(claim().map(|j| j.1).as_deref(), Some("translate"), "the image fetch on a.dev waits, translation does not");
        assert_eq!(claim(), None);
        s.finish_job(fetch, None).unwrap();
        assert_eq!(claim().map(|j| j.1).as_deref(), Some(images::JOB_TYPE));
    }

    #[test]
    fn inbox_filters_and_tags() {
        let s = Store::open_in_memory().unwrap();
        for u in ["https://a.dev/1", "https://a.dev/2", "https://a.dev/3"] {
            s.upsert_pending(u, u, "a.dev").unwrap();
        }
        s.set_read_status(1, true).unwrap();
        s.set_favorite(2, true).unwrap();
        s.add_tag(2, " Database ").unwrap();
        s.add_tag(3, "database").unwrap(); // same tag, case-insensitive
        s.add_tag(3, "Linux").unwrap();
        s.add_tag(3, "  ").unwrap();
        let ids = |f: ArticleFilter| s.list_articles(&f).unwrap().iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(ArticleFilter::All), [3, 2, 1]);
        assert_eq!(ids(ArticleFilter::Unread), [3, 2]);
        assert_eq!(ids(ArticleFilter::Favorites), [2]);
        assert_eq!(ids(ArticleFilter::Tag { name: "DATABASE".into() }), [3, 2]);
        let a3 = s.list_articles(&ArticleFilter::All).unwrap().remove(0);
        assert_eq!(a3.tags, ["Database", "Linux"]);
        assert_eq!(s.list_tags().unwrap().iter().map(|t| (t.name.as_str(), t.count)).collect::<Vec<_>>(), [("Database", 2), ("Linux", 1)]);
        s.remove_tag(3, "Linux").unwrap();
        assert_eq!(s.list_tags().unwrap().len(), 1, "unused tag removed");
    }

    #[test]
    fn genre_and_feed_filters_restrict_lists_and_search() {
        use std::collections::HashSet;
        let s = Store::open_in_memory().unwrap();
        for u in ["https://a.dev/1", "https://a.dev/2", "https://a.dev/3"] {
            let (id, _) = s.upsert_pending(u, u, "a.dev").unwrap();
            let f = Fetched { final_url: u.into(), status: 200, content_type: None, html: "<p>x</p>".into() };
            let p = Block { kind: crate::ir::BlockKind::Paragraph, text: format!("checkpoint tuning {id}"), inlines: vec![], attrs: Default::default() };
            s.save_fetched(id, Some(&f), Ok(ArticleIr { meta: Default::default(), blocks: vec![p] }), None).unwrap();
        }
        s.exec_for_test(
            "INSERT INTO feeds (url) VALUES ('https://a.dev/feed');
             UPDATE articles SET genre_id = (SELECT id FROM genres WHERE name = 'Database') WHERE id IN (1, 3);
             UPDATE articles SET feed_id = 1 WHERE id = 2;",
        );
        let ids = |f: ArticleFilter| s.list_articles(&f).unwrap().iter().map(|a| a.id).collect::<Vec<_>>();
        let set = |f: ArticleFilter| s.article_ids(&f).unwrap().map(|v| v.into_iter().collect::<HashSet<_>>());
        let db = ArticleFilter::Genre { name: Some("database".into()) };
        assert_eq!(ids(db.clone()), [3, 1], "genre names match case-insensitively");
        assert_eq!(ids(ArticleFilter::Genre { name: None }), [2]);
        assert_eq!(ids(ArticleFilter::Feed { id: Some(1) }), [2]);
        assert_eq!(ids(ArticleFilter::Feed { id: None }), [3, 1]);
        assert_eq!(set(db.clone()), Some(HashSet::from([1, 3])));
        assert_eq!(set(ArticleFilter::Genre { name: Some("Linux".into()) }), Some(HashSet::new()));
        assert_eq!(set(ArticleFilter::All), None, "unfiltered stays on the fast path");

        let restricted = s.article_ids(&db).unwrap();
        let hits = s.lexical_search("checkpoint", restricted.as_deref(), 10).unwrap();
        let mut owners = s.hit_details(&hits, &Target::default()).unwrap().into_iter().map(|h| h.article_id).collect::<Vec<_>>();
        owners.sort();
        assert_eq!(owners, [1, 3]);
        assert_eq!(s.lexical_search("checkpoint", None, 10).unwrap().len(), 3);
        let serde: ArticleFilter = serde_json::from_str(r#"{"kind":"feed","id":null}"#).unwrap();
        assert_eq!(serde, ArticleFilter::Feed { id: None });
    }

    #[test]
    fn sorts_by_saved_and_published() {
        let s = Store::open_in_memory().unwrap();
        for u in ["https://a.dev/1", "https://a.dev/2", "https://a.dev/3"] {
            s.upsert_pending(u, u, "a.dev").unwrap();
        }
        s.exec_for_test("UPDATE articles SET published_at = '2024-01-01' WHERE id = 1; UPDATE articles SET published_at = '2023-01-01' WHERE id = 3;");
        let ids = |o| s.list_articles_sorted(&ArticleFilter::All, o).unwrap().iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(ArticleSort::SavedDesc), [3, 2, 1]);
        assert_eq!(ids(ArticleSort::SavedAsc), [1, 2, 3]);
        assert_eq!(ids(ArticleSort::PublishedDesc), [1, 3, 2], "undated last");
        s.exec_for_test("UPDATE articles SET difficulty = 4 WHERE id = 1; UPDATE articles SET difficulty = 2 WHERE id = 2;");
        assert_eq!(ids(ArticleSort::DifficultyAsc), [2, 1, 3], "unrated last");
    }

    #[test]
    fn settings_and_backup() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.setting("claude_model").unwrap(), None);
        s.set_setting("claude_model", Some("sonnet")).unwrap();
        s.set_setting("claude_model", Some("haiku")).unwrap();
        assert_eq!(s.setting("claude_model").unwrap().as_deref(), Some("haiku"));
        s.set_setting("claude_model", None).unwrap();
        assert_eq!(s.setting("claude_model").unwrap(), None);

        s.upsert_pending("https://a.dev/1", "https://a.dev/1", "a.dev").unwrap();
        s.set_setting("secret.openai_api_key", Some("sk-test")).unwrap();
        s.set_setting("claude_model", Some("haiku")).unwrap();
        let dir = std::env::temp_dir().join(format!("lattice-backup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("b.db");
        let _ = std::fs::remove_file(&path);
        s.backup_to(&path).unwrap();
        let copy = Store::open(&path).unwrap();
        assert_eq!(copy.list_articles(&ArticleFilter::All).unwrap().len(), 1);
        assert_eq!(copy.setting("secret.openai_api_key").unwrap(), None, "secrets are not backed up");
        assert_eq!(copy.setting("claude_model").unwrap().as_deref(), Some("haiku"));
        assert_eq!(s.setting("secret.openai_api_key").unwrap().as_deref(), Some("sk-test"));
        drop(copy);
        let moved = dir.join("moved.db");
        let _ = std::fs::remove_file(&moved);
        s.copy_to(&moved).unwrap();
        assert_eq!(Store::open(&moved).unwrap().setting("secret.openai_api_key").unwrap().as_deref(), Some("sk-test"), "moving keeps secrets");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
