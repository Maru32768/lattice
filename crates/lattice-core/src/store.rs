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
use crate::ir::{ArticleIr, Block, Inline};
use crate::segments::{Unit, plain_text};

/// Append-only: each entry upgrades `PRAGMA user_version` by one.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE articles (
    id                 INTEGER PRIMARY KEY,
    original_url       TEXT NOT NULL,
    normalized_url     TEXT NOT NULL UNIQUE,
    canonical_url      TEXT,
    domain             TEXT NOT NULL,
    title              TEXT,
    author             TEXT,
    site_name          TEXT,
    published_at       TEXT,
    language           TEXT,
    saved_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    fetched_at         TEXT,
    fetch_status       TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending','ok','failed')),
    extraction_status  TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending','ok','failed')),
    last_error         TEXT,
    content_hash       TEXT,
    extraction_version INTEGER,
    read_status        TEXT NOT NULL DEFAULT 'unread' CHECK (read_status IN ('unread','read')),
    favorite           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX articles_canonical ON articles(canonical_url);
CREATE INDEX articles_content_hash ON articles(content_hash);
CREATE INDEX articles_saved_at ON articles(saved_at);

-- Raw HTML as fetched: lets us re-extract without the network and survive link rot.
CREATE TABLE snapshots (
    id           INTEGER PRIMARY KEY,
    article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    final_url    TEXT NOT NULL,
    http_status  INTEGER NOT NULL,
    content_type TEXT,
    html         TEXT NOT NULL
);
CREATE INDEX snapshots_article ON snapshots(article_id);

CREATE TABLE blocks (
    id          INTEGER PRIMARY KEY,
    article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    text_hash   TEXT NOT NULL,
    inlines     TEXT,
    attrs       TEXT,
    heading_id  INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    UNIQUE (article_id, ordinal)
);
"#, r#"
-- Derived data: several translations per block may coexist; readers pick the newest
-- whose source_hash still matches blocks.text_hash.
CREATE TABLE translations (
    id              INTEGER PRIMARY KEY,
    block_id        INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_language TEXT NOT NULL,
    text            TEXT NOT NULL,
    source_hash     TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT,
    prompt_version  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX translations_block ON translations(block_id, target_language);

CREATE TABLE processing_jobs (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL,
    article_id    INTEGER REFERENCES articles(id) ON DELETE CASCADE,
    params        TEXT,
    dedup_key     TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_run_at   TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at    TEXT,
    completed_at  TEXT
);
CREATE INDEX processing_jobs_ready ON processing_jobs(status, next_run_at);
CREATE INDEX processing_jobs_article ON processing_jobs(article_id);
"#, r#"
-- Lexical search. trigram tokenizes Japanese and identifiers like pg_visibility alike;
-- terms under 3 characters fall back to LIKE (see lexical_search).
CREATE VIRTUAL TABLE blocks_fts USING fts5(text, content='blocks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF text ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO blocks_fts(rowid, text) VALUES (new.id, new.text);
END;
INSERT INTO blocks_fts(blocks_fts) VALUES ('rebuild');

-- Translations are indexed too, so a Japanese query finds English articles lexically.
CREATE VIRTUAL TABLE translations_fts USING fts5(text, content='translations', content_rowid='id', tokenize='trigram');
CREATE TRIGGER translations_fts_ai AFTER INSERT ON translations BEGIN
    INSERT INTO translations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER translations_fts_ad AFTER DELETE ON translations BEGIN
    INSERT INTO translations_fts(translations_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
INSERT INTO translations_fts(translations_fts) VALUES ('rebuild');

-- One vector per (block, model): switching models re-embeds without losing the old index.
CREATE TABLE embeddings (
    block_id    INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    vector      BLOB NOT NULL,   -- little-endian f32, L2-normalized
    source_hash TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (block_id, model)
);
"#, r#"
-- Snapshots get compressed (raw HTML is 100KB-1MB per article). Existing rows stay as-is.
CREATE TABLE snapshots_v2 (
    id           INTEGER PRIMARY KEY,
    article_id   INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    fetched_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    final_url    TEXT NOT NULL,
    http_status  INTEGER NOT NULL,
    content_type TEXT,
    encoding     TEXT NOT NULL CHECK (encoding IN ('identity', 'deflate')),
    body         BLOB NOT NULL
);
INSERT INTO snapshots_v2 (id, article_id, fetched_at, final_url, http_status, content_type, encoding, body)
    SELECT id, article_id, fetched_at, final_url, http_status, content_type, 'identity', CAST(html AS BLOB) FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_v2 RENAME TO snapshots;
CREATE INDEX snapshots_article ON snapshots(article_id);
"#, r#"
-- Translations become a cache keyed by the paragraph's plain-text hash (= blocks.text_hash),
-- holding reading units [{source, translation}] as HTML. Shared by the live page overlay,
-- the reader and search; independent of articles, so it also survives re-extraction.
CREATE TABLE segment_translations (
    id              INTEGER PRIMARY KEY,
    source_hash     TEXT NOT NULL,
    target_language TEXT NOT NULL,
    units           TEXT NOT NULL,
    text            TEXT NOT NULL,   -- plain translated text, for search and the reader view
    provider        TEXT NOT NULL,
    model           TEXT,
    prompt_version  TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX segment_translations_hash ON segment_translations(source_hash, target_language);
INSERT INTO segment_translations (source_hash, target_language, units, text, provider, model, prompt_version, created_at)
    SELECT t.source_hash, t.target_language, json_array(json_object('source', b.text, 'translation', t.text)),
           t.text, t.provider, t.model, t.prompt_version, t.created_at
    FROM translations t JOIN blocks b ON b.id = t.block_id ORDER BY t.id;
DROP TRIGGER translations_fts_ai;
DROP TRIGGER translations_fts_ad;
DROP TABLE translations_fts;
DROP TABLE translations;
CREATE VIRTUAL TABLE translations_fts USING fts5(text, content='segment_translations', content_rowid='id', tokenize='trigram');
CREATE TRIGGER translations_fts_ai AFTER INSERT ON segment_translations BEGIN
    INSERT INTO translations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER translations_fts_ad AFTER DELETE ON segment_translations BEGIN
    INSERT INTO translations_fts(translations_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
INSERT INTO translations_fts(translations_fts) VALUES ('rebuild');
CREATE INDEX blocks_text_hash ON blocks(text_hash);
"#, r#"
CREATE TABLE tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE article_tags (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);
CREATE INDEX article_tags_tag ON article_tags(tag_id);
CREATE INDEX articles_inbox ON articles(read_status, favorite, saved_at);
"#, r#"
CREATE TABLE summaries (
    id             INTEGER PRIMARY KEY,
    article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    type           TEXT NOT NULL,
    text           TEXT NOT NULL,
    source_hash    TEXT NOT NULL,   -- articles.content_hash when generated
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX summaries_article ON summaries(article_id, type);
"#, r#"
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#, r#"
-- Chat over saved articles (F9). Scope and citations are JSON; citations copy the cited
-- block's title/heading/text so old answers still render after re-extraction or deletion.
CREATE TABLE chat_threads (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE chat_messages (
    id             INTEGER PRIMARY KEY,
    thread_id      INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    question       TEXT NOT NULL,
    answer         TEXT NOT NULL,
    citations      TEXT NOT NULL,
    scope          TEXT NOT NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('full', 'retrieval', 'none')),
    provider       TEXT,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id);
"#, r#"
-- Genres (§11 topic): one per article. genre_source 'manual' pins the user's choice against auto runs.
CREATE TABLE genres (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
INSERT INTO genres (name) VALUES ('Database'), ('Distributed Systems'), ('Linux'), ('Networking'),
    ('Programming Languages'), ('Security'), ('Web'), ('AI/ML'), ('DevOps'), ('Hardware'), ('Career'), ('Other');
ALTER TABLE articles ADD COLUMN genre_id INTEGER REFERENCES genres(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN genre_source TEXT CHECK (genre_source IN ('auto', 'manual'));
CREATE INDEX articles_genre ON articles(genre_id);
CREATE INDEX articles_published_at ON articles(published_at);
-- Derived data: every auto classification, as summaries keep theirs.
CREATE TABLE classifications (
    id             INTEGER PRIMARY KEY,
    article_id     INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    genre          TEXT NOT NULL,
    tags           TEXT NOT NULL,   -- JSON array
    provider       TEXT NOT NULL,
    model          TEXT,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX classifications_article ON classifications(article_id);
"#, r#"
CREATE TABLE feeds (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,
    site_url        TEXT,
    etag            TEXT,
    last_modified   TEXT,
    last_fetched_at TEXT,   -- last successful fetch
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every entry URL a feed has listed, imported or not: only unseen entries get imported.
CREATE TABLE feed_items (
    feed_id        INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    normalized_url TEXT NOT NULL,
    PRIMARY KEY (feed_id, normalized_url)
);
-- Removing a feed keeps its articles (they fall back to manually added).
ALTER TABLE articles ADD COLUMN feed_id INTEGER REFERENCES feeds(id) ON DELETE SET NULL;
CREATE INDEX articles_feed ON articles(feed_id);
"#, r#"
-- Extracted text length (characters): flags pages whose server HTML has almost no content
-- (JS-rendered), so the user can re-save them from the in-app browser.
ALTER TABLE articles ADD COLUMN text_length INTEGER;
UPDATE articles SET text_length = (SELECT coalesce(sum(length(text)), 0) FROM blocks WHERE article_id = articles.id)
    WHERE extraction_status = 'ok';
"#, r#"
-- Jobs view: counts per (status, type) and the backed-off list without touching table rows.
CREATE INDEX processing_jobs_status_type ON processing_jobs(status, type, next_run_at);
"#, r#"
-- Difficulty for a working software engineer, 1 (入門) to 5 (専門), from the classify job.
-- difficulty_source 'manual' pins the user's choice against auto runs, as genre_source does.
ALTER TABLE articles ADD COLUMN difficulty INTEGER CHECK (difficulty BETWEEN 1 AND 5);
ALTER TABLE articles ADD COLUMN difficulty_source TEXT CHECK (difficulty_source IN ('auto', 'manual'));
ALTER TABLE classifications ADD COLUMN difficulty INTEGER;
"#, r#"
-- Article images (§6), stored once per content hash (sha256 of the bytes) across articles.
-- Raster formats only (sniffed): SVG can carry script and stays a link.
CREATE TABLE images (
    hash       TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every image URL an article's blocks reference, tried or stored. Keyed by URL, not block id:
-- re-extraction matches image blocks by their alt text (often empty), so their ids can swap.
CREATE TABLE article_images (
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    src        TEXT NOT NULL,
    hash       TEXT,   -- NULL: not stored; error says why
    error      TEXT,
    PRIMARY KEY (article_id, src)
);
CREATE INDEX article_images_hash ON article_images(hash);
-- Garbage collection: bytes go when their last mapping does (article deleted or image dropped).
CREATE TRIGGER article_images_gc AFTER DELETE ON article_images WHEN old.hash IS NOT NULL BEGIN
    DELETE FROM images WHERE hash = old.hash AND NOT EXISTS (SELECT 1 FROM article_images WHERE hash = old.hash);
END;
"#];

fn deflate(s: &str) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(s.as_bytes()).expect("writing to a Vec cannot fail");
    e.finish().expect("writing to a Vec cannot fail")
}

fn inflate(encoding: &str, body: &[u8]) -> std::io::Result<String> {
    use std::io::Read;
    let mut out = String::new();
    match encoding {
        "deflate" => flate2::read::DeflateDecoder::new(body).read_to_string(&mut out).map(|_| out),
        _ => String::from_utf8(body.to_vec()).map_err(std::io::Error::other),
    }
}

/// The newest stored HTML of an article, for re-extraction without the network.
pub struct Snapshot {
    pub final_url: String,
    pub html: String,
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

#[derive(Debug, Serialize)]
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
    pub fetch_status: String,
    pub extraction_status: String,
    pub last_error: Option<String>,
    pub read_status: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub genre: Option<String>,
    /// The user chose the genre; auto classification leaves it alone.
    pub genre_manual: bool,
    /// 1 (入門) to 5 (専門).
    pub difficulty: Option<i64>,
    pub difficulty_manual: bool,
    pub feed_id: Option<i64>,
    pub feed_title: Option<String>,
    /// Extracted, but with almost no text: probably a JS-rendered page.
    pub thin: bool,
}

/// Inbox views (§12). "Recently added" is `All`, which is already newest first.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArticleFilter {
    All,
    Unread,
    Favorites,
    Tag { name: String },
    /// `None`: 未分類.
    Genre { name: Option<String> },
    /// `None`: 手動追加 (not from a feed).
    Feed { id: Option<i64> },
}

/// SQL condition on `articles` for `filter`, with its one parameter (`?1`) if any.
fn filter_cond(filter: &ArticleFilter) -> (&'static str, Option<rusqlite::types::Value>) {
    match filter {
        ArticleFilter::All => ("1", None),
        ArticleFilter::Unread => ("read_status = 'unread'", None),
        ArticleFilter::Favorites => ("favorite = 1", None),
        ArticleFilter::Tag { name } => (
            "EXISTS (SELECT 1 FROM article_tags x JOIN tags t ON t.id = x.tag_id WHERE x.article_id = articles.id AND t.name = ?1)",
            Some(name.clone().into()),
        ),
        ArticleFilter::Genre { name: Some(n) } => ("genre_id = (SELECT id FROM genres WHERE name = ?1)", Some(n.clone().into())),
        ArticleFilter::Genre { name: None } => ("genre_id IS NULL", None),
        ArticleFilter::Feed { id: Some(id) } => ("feed_id = ?1", Some((*id).into())),
        ArticleFilter::Feed { id: None } => ("feed_id IS NULL", None),
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArticleSort {
    #[default]
    SavedDesc,
    SavedAsc,
    /// Articles without a published date come last.
    PublishedDesc,
    /// Easiest first; articles without a difficulty come last.
    DifficultyAsc,
}

#[derive(Debug, Serialize)]
pub struct TagCount {
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct StoredBlock {
    pub id: i64,
    pub ordinal: i64,
    pub heading_id: Option<i64>,
    #[serde(flatten)]
    pub block: Block,
    /// Current translation in the requested language, if any.
    pub translation: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobRow {
    pub id: i64,
    #[serde(rename = "type")]
    pub job_type: String,
    pub article_id: Option<i64>,
    pub params: Option<String>,
    pub status: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_run_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SummaryView {
    pub text: String,
    pub created_at: String,
    /// The article was re-extracted with different content since this summary was made.
    pub stale: bool,
}

#[derive(Debug, Serialize)]
pub struct ArticleView {
    pub article: ArticleRow,
    pub blocks: Vec<StoredBlock>,
    pub jobs: Vec<JobRow>,
    pub summary: Option<SummaryView>,
}

pub struct SummarySource {
    pub title: String,
    pub content_hash: String,
    /// (kind, text) of headings and prose blocks in order.
    pub blocks: Vec<(String, String)>,
}

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

#[derive(Debug, Serialize)]
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

const ARTICLE_COLS: &str = "id, original_url, canonical_url, domain, title, author, site_name, published_at, language, saved_at, fetch_status, extraction_status, last_error, read_status, favorite,
    (SELECT json_group_array(name) FROM (SELECT t.name FROM article_tags x JOIN tags t ON t.id = x.tag_id WHERE x.article_id = articles.id ORDER BY t.name)),
    (SELECT name FROM genres WHERE id = articles.genre_id), genre_source IS 'manual', feed_id,
    (SELECT coalesce(title, url) FROM feeds WHERE id = articles.feed_id), text_length, difficulty, difficulty_source IS 'manual'";

fn article_row(r: &rusqlite::Row) -> Result<ArticleRow> {
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
        genre: r.get(16)?,
        genre_manual: r.get(17)?,
        difficulty: r.get(21)?,
        difficulty_manual: r.get(22)?,
        feed_id: r.get(18)?,
        feed_title: r.get(19)?,
        thin: r.get::<_, String>(11)? == "ok" && r.get::<_, Option<i64>>(20)?.unwrap_or(0) < THIN_TEXT_CHARS,
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

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("IR types always serialize")
}

fn from_json_col<T: serde::de::DeserializeOwned>(r: &rusqlite::Row, i: usize, wrap: impl Fn(&str) -> String) -> Result<T> {
    let s: String = r.get(i)?;
    serde_json::from_str(&wrap(&s))
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(e)))
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
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
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
            .query_row(
                "SELECT coalesce(title, original_url), content_hash FROM articles WHERE id = ?1 AND extraction_status = 'ok'",
                [article_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let mut st = c.prepare(
            "SELECT kind, text FROM blocks WHERE article_id = ?1 AND kind IN (SELECT value FROM json_each(?2)) ORDER BY ordinal",
        )?;
        let blocks = st.query_map(params![article_id, json(&crate::ir::PROSE_KINDS)], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_>>()?;
        Ok(Some(SummarySource { title, content_hash, blocks }))
    }

    #[allow(clippy::too_many_arguments)]
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

    /// Consistent single-file copy of the whole database (safe while the app is running).
    /// Settings under `SECRET_PREFIX` (API keys) are removed from the copy.
    pub fn backup_to(&self, path: &Path) -> Result<()> {
        self.conn().execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
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
            .query_row(
                "SELECT id FROM articles WHERE normalized_url = ?1 OR canonical_url = ?1 ORDER BY id LIMIT 1",
                [normalized_url],
                |r| r.get(0),
            )
            .optional()
    }

    /// Returns the article id and whether it still needs fetching/extraction.
    pub fn upsert_pending(&self, original_url: &str, normalized_url: &str, domain: &str) -> Result<(i64, bool)> {
        let c = self.conn();
        c.execute(
            "INSERT INTO articles (original_url, normalized_url, domain) VALUES (?1, ?2, ?3)
             ON CONFLICT(normalized_url) DO NOTHING",
            params![original_url, normalized_url, domain],
        )?;
        c.query_row(
            "SELECT id, extraction_status != 'ok' FROM articles WHERE normalized_url = ?1",
            [normalized_url],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    }

    pub fn record_fetch_failure(&self, id: i64, error: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE articles SET fetch_status = 'failed', last_error = ?2 WHERE id = ?1",
            params![id, error],
        )?;
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
                params![id, f.final_url, f.status, f.content_type, deflate(&f.html)],
            )?;
            tx.execute(
                "UPDATE articles SET fetch_status = 'ok', fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
                [id],
            )?;
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
                     canonical_url = ?2, title = ?3, author = ?4, site_name = ?5, published_at = ?6,
                     language = ?7, content_hash = ?8, extraction_version = ?9, text_length = ?10
                     WHERE id = ?1",
                    params![
                        id, canonical_normalized, m.title, m.author, m.site_name, m.published_at,
                        m.language, sha256_hex(&content.join("\n")), EXTRACTION_VERSION, text_length as i64
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn latest_snapshot(&self, article_id: i64) -> Result<Option<Snapshot>> {
        let row: Option<(String, String, Vec<u8>)> = self
            .conn()
            .query_row(
                "SELECT final_url, encoding, body FROM snapshots WHERE article_id = ?1 ORDER BY id DESC LIMIT 1",
                [article_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        row.map(|(final_url, enc, body)| {
            let html = inflate(&enc, &body)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Blob, Box::new(e)))?;
            Ok(Snapshot { final_url, html })
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
        tx.execute(
            "INSERT OR IGNORE INTO article_tags (article_id, tag_id) SELECT ?1, id FROM tags WHERE name = ?2",
            params![article_id, name],
        )?;
        tx.commit()
    }

    /// Unused tags are deleted so the tag list only shows tags in use.
    pub fn remove_tag(&self, article_id: i64, name: &str) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM article_tags WHERE article_id = ?1 AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
            params![article_id, name.trim()],
        )?;
        tx.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM article_tags)", [])?;
        tx.commit()
    }

    pub fn list_tags(&self) -> Result<Vec<TagCount>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT t.name, count(*) FROM tags t JOIN article_tags x ON x.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE",
        )?;
        st.query_map([], |r| Ok(TagCount { name: r.get(0)?, count: r.get(1)? }))?.collect()
    }

    pub fn get_article(&self, id: i64, target_language: &str) -> Result<Option<ArticleView>> {
        let c = self.conn();
        let Some(article) = c
            .query_row(&format!("SELECT {ARTICLE_COLS} FROM articles WHERE id = ?1"), [id], article_row)
            .optional()?
        else {
            return Ok(None);
        };
        let mut st = c.prepare(
            "SELECT b.id, b.ordinal, b.heading_id, b.kind, b.text, b.inlines, b.attrs,
                    (SELECT st.text FROM segment_translations st
                     WHERE st.source_hash = b.text_hash AND st.target_language = ?2
                     ORDER BY st.id DESC LIMIT 1)
             FROM blocks b WHERE b.article_id = ?1 ORDER BY b.ordinal",
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
                })
            })?
            .collect::<Result<_>>()?;
        let mut st = c.prepare(&format!("SELECT {JOB_COLS} FROM processing_jobs WHERE article_id = ?1 ORDER BY id"))?;
        let jobs = st.query_map([id], job_row)?.collect::<Result<_>>()?;
        let summary = c
            .query_row(
                "SELECT s.text, s.created_at, s.source_hash IS NOT a.content_hash FROM summaries s JOIN articles a ON a.id = s.article_id
                 WHERE s.article_id = ?1 AND s.type = 'normal' ORDER BY s.id DESC LIMIT 1",
                [id],
                |r| Ok(SummaryView { text: r.get(0)?, created_at: r.get(1)?, stale: r.get(2)? }),
            )
            .optional()?;
        Ok(Some(ArticleView { article, blocks, jobs, summary }))
    }

    /// Translatable blocks of an article lacking a current translation in `target_language`.
    pub fn untranslated_blocks(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<Vec<PendingBlock>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT b.id, b.kind, b.text, b.text_hash, b.inlines FROM blocks b
             WHERE b.article_id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM segment_translations st
                 WHERE st.source_hash = b.text_hash AND st.target_language = ?2)
             ORDER BY b.ordinal",
        )?;
        let rows = st.query_map(params![article_id, target_language], |r| {
            Ok(PendingBlock {
                id: r.get(0)?,
                kind: r.get(1)?,
                text: r.get(2)?,
                text_hash: r.get(3)?,
                inlines: opt_json_col(r, 4)?,
            })
        })?;
        rows.filter(|b| b.as_ref().map_or(true, |b| kinds.contains(&b.kind.as_str()))).collect()
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

    pub fn insert_segments(
        &self,
        target_language: &str,
        provider: &str,
        model: Option<&str>,
        prompt_version: &str,
        items: &[(&str, &[Unit])],
    ) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO segment_translations (source_hash, target_language, units, text, provider, model, prompt_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (hash, units) in items {
                let text = plain_text(&units.iter().map(|u| u.translation.as_str()).collect::<String>());
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
                                   AND NOT (j.type IN (?2, ?3) AND EXISTS (
                                       SELECT 1 FROM processing_jobs r
                                       JOIN articles ra ON ra.id = r.article_id
                                       JOIN articles ja ON ja.id = j.article_id
                                       WHERE r.status = 'running' AND r.type IN (?2, ?3) AND ra.domain = ja.domain))
                                 ORDER BY j.id LIMIT 1)
                     RETURNING {JOB_COLS}"
                ),
                params![json(&types), crate::ingest::JOB_TYPE, crate::images::JOB_TYPE],
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
            let mut ins = tx.prepare(
                "INSERT OR REPLACE INTO embeddings (block_id, model, vector, source_hash) VALUES (?1, ?2, ?3, ?4)",
            )?;
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
                buf.extend(blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
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
        let rank = if long.is_empty() { "0" } else { "bm25({t})" };
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

    /// Display data for search hits, in the order of `block_ids`.
    pub fn hit_details(&self, block_ids: &[i64], target_language: &str) -> Result<Vec<HitDetail>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT b.id, b.article_id, coalesce(a.title, a.original_url), h.text, b.text,
                    (SELECT st.text FROM segment_translations st
                     WHERE st.source_hash = b.text_hash AND st.target_language = ?2
                     ORDER BY st.id DESC LIMIT 1), b.ordinal
             FROM blocks b JOIN articles a ON a.id = b.article_id LEFT JOIN blocks h ON h.id = b.heading_id
             WHERE b.id IN (SELECT value FROM json_each(?1))",
        )?;
        let mut rows: Vec<HitDetail> = st
            .query_map(params![json(&block_ids), target_language], |r| {
                Ok(HitDetail {
                    block_id: r.get(0)?,
                    article_id: r.get(1)?,
                    article_title: r.get(2)?,
                    heading: r.get(3)?,
                    text: r.get(4)?,
                    translation: r.get(5)?,
                    ordinal: r.get(6)?,
                })
            })?
            .collect::<Result<_>>()?;
        rows.sort_by_key(|h| block_ids.iter().position(|&id| id == h.block_id));
        Ok(rows)
    }

    #[cfg(test)]
    pub(crate) fn exec_for_test(&self, sql: &str) {
        self.conn().execute_batch(sql).unwrap();
    }

    pub fn set_read_status(&self, id: i64, read: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE articles SET read_status = ?2 WHERE id = ?1",
            params![id, if read { "read" } else { "unread" }],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!((snap.final_url.as_str(), snap.html.as_str()), ("https://x/", "<p>日本語</p>"));
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
        let cached = s.cached_segments(&[hash.clone()], "ja").unwrap();
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
        let mut owners = s.hit_details(&hits, "ja").unwrap().into_iter().map(|h| h.article_id).collect::<Vec<_>>();
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
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
