//! SQLite store. Concrete on purpose: SQLite is the system of record, not a swappable detail.
//! Swappable parts (search index, vectors) get their own boundary when they arrive.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::extract::EXTRACTION_VERSION;
use crate::fetch::Fetched;
use crate::ir::{ArticleIr, Block, Inline};

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
"#];

/// Jobs that keep failing stop retrying automatically; the user can re-enqueue them.
const MAX_ATTEMPTS: i64 = 5;

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
pub struct ArticleView {
    pub article: ArticleRow,
    pub blocks: Vec<StoredBlock>,
    pub jobs: Vec<JobRow>,
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

pub struct NewTranslation<'a> {
    pub block_id: i64,
    pub source_hash: &'a str,
    pub text: &'a str,
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
                // shortcut: blocks are replaced wholesale. Safe today because only never-extracted
                // articles get here (so no translations exist); a re-extract command must reuse ids
                // of blocks whose text_hash matches, or their translations cascade away.
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
                    (SELECT t.text FROM translations t
                     WHERE t.block_id = b.id AND t.target_language = ?2 AND t.source_hash = b.text_hash
                     ORDER BY t.id DESC LIMIT 1)
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
        Ok(Some(ArticleView { article, blocks, jobs }))
    }

    /// Translatable blocks of an article lacking a current translation in `target_language`.
    pub fn untranslated_blocks(&self, article_id: i64, target_language: &str, kinds: &[&str]) -> Result<Vec<PendingBlock>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT b.id, b.kind, b.text, b.text_hash, b.inlines FROM blocks b
             WHERE b.article_id = ?1 AND NOT EXISTS (
                 SELECT 1 FROM translations t
                 WHERE t.block_id = b.id AND t.target_language = ?2 AND t.source_hash = b.text_hash)
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

    pub fn insert_translations(
        &self,
        target_language: &str,
        provider: &str,
        model: Option<&str>,
        prompt_version: &str,
        items: &[NewTranslation],
    ) -> Result<()> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO translations (block_id, target_language, text, source_hash, provider, model, prompt_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for t in items {
                ins.execute(params![t.block_id, target_language, t.text, t.source_hash, provider, model, prompt_version])?;
            }
        }
        tx.commit()
    }

    /// Idempotent: an existing job with the same key is reset to pending (unless running).
    pub fn enqueue_job(&self, job_type: &str, article_id: i64, params: &str, dedup_key: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO processing_jobs (type, article_id, params, dedup_key) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', next_run_at = NULL
             WHERE status != 'running'",
            params![job_type, article_id, params, dedup_key],
        )?;
        Ok(())
    }

    /// Crash recovery: anything left `running` by a previous process gets picked up again.
    pub fn recover_running_jobs(&self) -> Result<usize> {
        self.conn().execute("UPDATE processing_jobs SET status = 'pending' WHERE status = 'running'", [])
    }

    pub fn claim_next_job(&self) -> Result<Option<JobRow>> {
        self.conn()
            .query_row(
                &format!(
                    "UPDATE processing_jobs
                     SET status = 'running', attempt_count = attempt_count + 1,
                         started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = (SELECT id FROM processing_jobs
                                 WHERE status = 'pending'
                                   AND (next_run_at IS NULL OR next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                                 ORDER BY id LIMIT 1)
                     RETURNING {JOB_COLS}"
                ),
                [],
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

    pub fn set_read_status(&self, id: i64, read: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE articles SET read_status = ?2 WHERE id = ?1",
            params![id, if read { "read" } else { "unread" }],
        )?;
        Ok(())
    }
}
