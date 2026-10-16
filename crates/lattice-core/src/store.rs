//! SQLite store. Concrete on purpose: SQLite is the system of record, not a swappable detail.
//! Swappable parts (search index, vectors) get their own boundary when they arrive.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::extract::EXTRACTION_VERSION;
use crate::fetch::Fetched;
use crate::ir::{ArticleIr, Block};

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
"#];

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
}

#[derive(Debug, Serialize)]
pub struct StoredBlock {
    pub id: i64,
    pub ordinal: i64,
    pub heading_id: Option<i64>,
    #[serde(flatten)]
    pub block: Block,
}

#[derive(Debug, Serialize)]
pub struct ArticleView {
    pub article: ArticleRow,
    pub blocks: Vec<StoredBlock>,
}

const ARTICLE_COLS: &str = "id, original_url, canonical_url, domain, title, author, site_name, published_at, language, saved_at, fetch_status, extraction_status, last_error, read_status";

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
    })
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("IR types always serialize")
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

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic mid-transaction rolls back via Drop, so the connection is still usable.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
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

    /// Persists the snapshot and its extraction outcome atomically.
    /// Returns the surviving article id: if the canonical URL reveals an existing article,
    /// this row is dropped in favour of it.
    pub fn save_fetched(
        &self,
        id: i64,
        fetched: &Fetched,
        extracted: std::result::Result<ArticleIr, String>,
        canonical_normalized: Option<&str>,
    ) -> Result<i64> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        if let Some(canon) = canonical_normalized {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM articles WHERE id != ?1 AND extraction_status = 'ok'
                     AND (canonical_url = ?2 OR normalized_url = ?2) LIMIT 1",
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
        tx.execute(
            "INSERT INTO snapshots (article_id, final_url, http_status, content_type, html) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, fetched.final_url, fetched.status, fetched.content_type, fetched.html],
        )?;
        match extracted {
            Err(e) => {
                tx.execute(
                    "UPDATE articles SET fetch_status = 'ok', fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     extraction_status = 'failed', last_error = ?2 WHERE id = ?1",
                    params![id, e],
                )?;
            }
            Ok(ir) => {
                // shortcut: blocks are replaced wholesale; once translations reference block ids,
                // re-extraction must reuse ids of blocks whose text_hash matches.
                tx.execute("DELETE FROM blocks WHERE article_id = ?1", [id])?;
                let mut heading: Option<i64> = None;
                {
                    let mut ins = tx.prepare(
                        "INSERT INTO blocks (article_id, ordinal, kind, text, text_hash, inlines, attrs, heading_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )?;
                    for (i, b) in ir.blocks.iter().enumerate() {
                        let inlines = (!b.inlines.is_empty()).then(|| json(&b.inlines));
                        let attrs = json(&b.attrs);
                        let attrs = (attrs != "{}").then_some(attrs);
                        ins.execute(params![
                            id, i as i64, b.kind.as_str(), b.text, sha256_hex(&b.text), inlines, attrs, heading
                        ])?;
                        if b.kind == crate::ir::BlockKind::Heading {
                            heading = Some(tx.last_insert_rowid());
                        }
                    }
                }
                let content: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
                let m = &ir.meta;
                tx.execute(
                    "UPDATE articles SET fetch_status = 'ok', extraction_status = 'ok', last_error = NULL,
                     fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                     canonical_url = ?2, title = ?3, author = ?4, site_name = ?5, published_at = ?6,
                     language = ?7, content_hash = ?8, extraction_version = ?9
                     WHERE id = ?1",
                    params![
                        id, canonical_normalized, m.title, m.author, m.site_name, m.published_at,
                        m.language, sha256_hex(&content.join("\n")), EXTRACTION_VERSION
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn list_articles(&self) -> Result<Vec<ArticleRow>> {
        let c = self.conn();
        let mut st = c.prepare(&format!("SELECT {ARTICLE_COLS} FROM articles ORDER BY saved_at DESC, id DESC"))?;
        st.query_map([], article_row)?.collect()
    }

    pub fn get_article(&self, id: i64) -> Result<Option<ArticleView>> {
        let c = self.conn();
        let Some(article) = c
            .query_row(&format!("SELECT {ARTICLE_COLS} FROM articles WHERE id = ?1"), [id], article_row)
            .optional()?
        else {
            return Ok(None);
        };
        let mut st = c.prepare(
            "SELECT id, ordinal, heading_id, kind, text, inlines, attrs FROM blocks WHERE article_id = ?1 ORDER BY ordinal",
        )?;
        let blocks = st
            .query_map([id], |r| {
                let from_json = |i: usize| -> Result<Option<String>> { r.get(i) };
                let kind: String = r.get(3)?;
                let parse_err = |e: serde_json::Error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e));
                Ok(StoredBlock {
                    id: r.get(0)?,
                    ordinal: r.get(1)?,
                    heading_id: r.get(2)?,
                    block: Block {
                        kind: serde_json::from_value(serde_json::Value::String(kind)).map_err(parse_err)?,
                        text: r.get(4)?,
                        inlines: from_json(5)?.map(|s| serde_json::from_str(&s)).transpose().map_err(parse_err)?.unwrap_or_default(),
                        attrs: from_json(6)?.map(|s| serde_json::from_str(&s)).transpose().map_err(parse_err)?.unwrap_or_default(),
                    },
                })
            })?
            .collect::<Result<_>>()?;
        Ok(Some(ArticleView { article, blocks }))
    }

    pub fn set_read_status(&self, id: i64, read: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE articles SET read_status = ?2 WHERE id = ?1",
            params![id, if read { "read" } else { "unread" }],
        )?;
        Ok(())
    }
}
