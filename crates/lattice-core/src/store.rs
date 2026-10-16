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
            "INSERT INTO snapshots (article_id, final_url, http_status, content_type, encoding, body)
             VALUES (?1, ?2, ?3, ?4, 'deflate', ?5)",
            params![id, fetched.final_url, fetched.status, fetched.content_type, deflate(&fetched.html)],
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
                // shortcut: blocks are replaced wholesale (translations are keyed by text hash, so they
                // survive); a re-extract command should reuse ids of unchanged blocks so search
                // results and embeddings keep pointing at them.
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
        Ok(Some(ArticleView { article, blocks, jobs }))
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

    /// Claims the oldest ready job whose type is in `types`.
    pub fn claim_next_job(&self, types: &[&str]) -> Result<Option<JobRow>> {
        self.conn()
            .query_row(
                &format!(
                    "UPDATE processing_jobs
                     SET status = 'running', attempt_count = attempt_count + 1,
                         started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     WHERE id = (SELECT id FROM processing_jobs
                                 WHERE status = 'pending'
                                   AND type IN (SELECT value FROM json_each(?1))
                                   AND (next_run_at IS NULL OR next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                                 ORDER BY id LIMIT 1)
                     RETURNING {JOB_COLS}"
                ),
                [json(&types)],
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
             ON CONFLICT(dedup_key) DO UPDATE SET status = 'pending', next_run_at = NULL WHERE status = 'succeeded'",
            params![job_type, model, json(&kinds)],
        )
    }

    /// Calls `f` for every stored vector of `model`.
    /// shortcut: brute-force scan, fine to ~10^5-10^6 blocks; move to sqlite-vec or an ANN index beyond that.
    pub fn scan_embeddings(&self, model: &str, mut f: impl FnMut(i64, &[f32])) -> Result<()> {
        let c = self.conn();
        let mut st = c.prepare("SELECT block_id, vector FROM embeddings WHERE model = ?1")?;
        let mut rows = st.query([model])?;
        let mut buf = Vec::new();
        while let Some(r) = rows.next()? {
            let blob = r.get_ref(1)?.as_blob()?;
            buf.clear();
            buf.extend(blob.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
            f(r.get(0)?, &buf);
        }
        Ok(())
    }

    /// Block ids ranked by FTS (best first), searching original text and translations.
    /// Terms of 3+ characters use the trigram index; shorter ones (e.g. 「索引」) filter by LIKE.
    pub fn lexical_search(&self, query: &str, limit: usize) -> Result<Vec<i64>> {
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
        let rank = if long.is_empty() { "0" } else { "bm25({t})" };
        let branch = |t: &str| format!("WHERE {}", conds.join(" AND ")).replace("{t}", t);
        let sql = format!(
            "SELECT block_id FROM (
                 SELECT rowid AS block_id, {r1} AS r FROM blocks_fts {w1}
                 UNION ALL
                 SELECT b.id, {r2} AS r FROM translations_fts
                     JOIN segment_translations st ON st.id = translations_fts.rowid
                     JOIN blocks b ON b.text_hash = st.source_hash {w2}
             ) GROUP BY block_id ORDER BY min(r), block_id DESC LIMIT {limit}",
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
                     ORDER BY st.id DESC LIMIT 1)
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
        assert_eq!(s.lexical_search("スナップショット", 10).unwrap(), [1]);
        let cached = s.cached_segments(&[hash.clone()], "ja").unwrap();
        assert_eq!(cached[&hash], [Unit { source: "Snapshot isolation".into(), translation: "スナップショット分離".into() }]);
    }
}
