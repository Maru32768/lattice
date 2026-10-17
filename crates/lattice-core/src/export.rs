//! JSON export (§17): articles, their translations and summaries, and chat, in an open format,
//! so none of it lives only in this database or at an LLM provider. One JSON object per line,
//! gzip-compressed, written article by article: 10^5 articles never sit in memory at once.
//! Left out: settings (API keys and other secrets), raw HTML snapshots, image bytes, embeddings
//! and jobs; the database backup has the snapshots, images and embeddings. Image blocks carry
//! `image_hash` (sha256 of the stored bytes) when the image was saved.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::store::Store;

pub const FORMAT: &str = "lattice-export/1";

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn line(out: &mut impl Write, v: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *out, v).map_err(err)?;
    out.write_all(b"\n").map_err(err)
}

/// Blocks in order, each with the newest translation per target language whose source is the
/// block's current text (as the reader shows it).
const BLOCKS: &str = "SELECT json_group_array(json_object(
        'ordinal', b.ordinal, 'kind', b.kind, 'text', b.text,
        'inlines', json(coalesce(b.inlines, '[]')), 'attrs', json(coalesce(b.attrs, '{}')),
        'image_hash', (SELECT ai.hash FROM article_images ai WHERE ai.article_id = b.article_id AND ai.src = json_extract(b.attrs, '$.src')),
        'translations', json((SELECT json_group_array(json_object(
            'target_language', st.target_language, 'text', st.text, 'units', json(st.units),
            'provider', st.provider, 'model', st.model, 'prompt_version', st.prompt_version, 'created_at', st.created_at))
            FROM segment_translations st WHERE st.id IN (
                SELECT max(id) FROM segment_translations WHERE source_hash = b.text_hash GROUP BY target_language))))
        ORDER BY b.ordinal)
    FROM blocks b WHERE b.article_id = ?1";

/// Every summary ever made; `stale` ones predate the current extraction.
const SUMMARIES: &str = "SELECT json_group_array(json_object(
        'type', s.type, 'text', s.text, 'stale', json(iif(s.source_hash IS a.content_hash, 'false', 'true')),
        'provider', s.provider, 'model', s.model, 'prompt_version', s.prompt_version, 'created_at', s.created_at)
        ORDER BY s.id)
    FROM summaries s JOIN articles a ON a.id = s.article_id WHERE s.article_id = ?1";

/// Writes the export as JSON lines: a header (`format`), then `feed`, `article` and `chat_thread`
/// objects. Returns the number of articles written.
// shortcut: not a snapshot (the store lock is taken per article so jobs and the UI keep going);
// changes made during an export may be half in it. Export from a `backup_to` copy if that matters.
pub fn export_to(store: &Store, out: &mut impl Write) -> Result<usize, String> {
    let exported_at: String = store.conn().query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| r.get(0)).map_err(err)?;
    line(out, &json!({"format": FORMAT, "exported_at": exported_at}))?;

    let feeds: Vec<Value> = {
        let c = store.conn();
        let mut st = c.prepare("SELECT id, url, title, site_url, created_at FROM feeds ORDER BY id").map_err(err)?;
        st.query_map([], |r| {
            Ok(json!({"type": "feed", "id": r.get::<_, i64>(0)?, "url": r.get::<_, String>(1)?, "title": r.get::<_, Option<String>>(2)?,
                      "site_url": r.get::<_, Option<String>>(3)?, "created_at": r.get::<_, String>(4)?}))
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?
    };
    for f in &feeds {
        line(out, f)?;
    }

    let ids: Vec<i64> = {
        let c = store.conn();
        let mut st = c.prepare("SELECT id FROM articles ORDER BY id").map_err(err)?;
        st.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?
    };
    let mut n = 0;
    for id in ids {
        let Some(article) = store.article_row(id).map_err(err)? else { continue }; // deleted meanwhile
        let (blocks, summaries): (String, String) = {
            let c = store.conn();
            let q = |sql: &str| c.query_row(sql, [id], |r| r.get::<_, String>(0)).map_err(err);
            (q(BLOCKS)?, q(SUMMARIES)?)
        };
        let mut v = json!({"type": "article"});
        v.as_object_mut().expect("object").extend(serde_json::to_value(article).map_err(err)?.as_object().cloned().unwrap_or_default());
        v["blocks"] = serde_json::from_str(&blocks).map_err(err)?;
        v["summaries"] = serde_json::from_str(&summaries).map_err(err)?;
        line(out, &v)?;
        n += 1;
    }

    for t in store.chat_threads().map_err(err)? {
        let messages = store.chat_messages(t.id).map_err(err)?;
        line(out, &json!({"type": "chat_thread", "id": t.id, "title": t.title, "updated_at": t.updated_at, "messages": messages}))?;
    }
    Ok(n)
}

/// Writes `lattice-export-<UTC>.jsonl.gz` into `dir` and returns its path. A failed export
/// leaves no partial file behind.
pub fn export_file(store: &Store, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let stamp: String = store.conn().query_row("SELECT strftime('%Y%m%dT%H%M%SZ','now')", [], |r| r.get(0)).map_err(err)?;
    let path = dir.join(format!("lattice-export-{stamp}.jsonl.gz"));
    let part = dir.join(format!("lattice-export-{stamp}.part"));
    let write = || -> Result<usize, String> {
        let file = std::io::BufWriter::new(std::fs::File::create(&part).map_err(err)?);
        let mut gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let n = export_to(store, &mut gz)?;
        gz.finish().map_err(err)?.into_inner().map_err(err)?.sync_all().map_err(err)?;
        std::fs::rename(&part, &path).map_err(err)?;
        Ok(n)
    };
    match write() {
        Ok(n) => {
            log::info!("exported {n} articles to {}", path.display());
            Ok(path)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::segments::{Unit, source_hash};
    use crate::store::SECRET_PREFIX;

    #[test]
    fn exports_articles_translations_and_chat_without_secrets_or_html() {
        let s = Store::open_in_memory().unwrap();
        let url = "https://example.com/a";
        let (id, _) = s.upsert_pending(url, url, "example.com").unwrap();
        let html = "<html><head><title>Post</title></head><body><article><h2>Intro</h2><p>Snapshot isolation permits <code>write skew</code>, which serializable snapshot isolation prevents at commit time. Padding so readability keeps it.</p></article></body></html>";
        store_fetched(&s, id, &Fetched { final_url: url.into(), status: 200, content_type: None, html: html.into() }).unwrap();
        s.add_tag(id, "mvcc").unwrap();
        let units = [Unit { source: "Intro".into(), translation: "旧訳".into() }];
        let newer = [Unit { source: "Intro".into(), translation: "はじめに".into() }];
        let hash = source_hash("Intro");
        s.insert_segments("ja", "fake", None, "v1", &[(hash.as_str(), &units[..])]).unwrap();
        s.insert_segments("ja", "fake", Some("m"), "v1", &[(hash.as_str(), &newer[..])]).unwrap();
        s.insert_summary(id, "normal", "要約", "old-hash", "fake", None, "s1").unwrap();
        s.set_setting(&format!("{SECRET_PREFIX}openai"), Some("sk-TOPSECRET")).unwrap();
        s.exec_for_test(&format!(
            "INSERT INTO chat_threads (id, title) VALUES (1, 'q');
             INSERT INTO chat_messages (thread_id, question, answer, citations, scope, mode, prompt_version)
             VALUES (1, 'what?', 'answer [1]', '[]', '{{\"kind\":\"article\",\"id\":{id}}}', 'full', 'c1');"
        ));

        let mut out = Vec::new();
        assert_eq!(export_to(&s, &mut out).unwrap(), 1);
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains("sk-TOPSECRET") && !text.contains("<article>"), "{text}");
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["format"], FORMAT);
        let a = &lines[1];
        assert_eq!((a["type"].as_str(), a["title"].as_str(), a["tags"].clone()), (Some("article"), Some("Post"), json!(["mvcc"])));
        let intro = &a["blocks"][0];
        assert_eq!((intro["kind"].as_str(), intro["text"].as_str()), (Some("heading"), Some("Intro")));
        assert_eq!(intro["translations"], json!([{"target_language": "ja", "text": "はじめに", "units": [{"source": "Intro", "translation": "はじめに"}],
            "provider": "fake", "model": "m", "prompt_version": "v1", "created_at": intro["translations"][0]["created_at"]}]));
        assert_eq!(a["blocks"][1]["inlines"][1], json!({"t": "code", "v": "write skew"}));
        assert_eq!((a["summaries"][0]["text"].as_str(), a["summaries"][0]["stale"].as_bool()), (Some("要約"), Some(true)));
        let chat = &lines[2];
        assert_eq!((chat["type"].as_str(), chat["messages"][0]["answer"].as_str()), (Some("chat_thread"), Some("answer [1]")));
        assert_eq!(lines.len(), 3);
    }
}
