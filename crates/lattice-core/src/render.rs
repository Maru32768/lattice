//! Background rendering of JS-built pages: ingest only sees server HTML, so an article whose
//! extraction came out thin or empty gets one `render` job. The app's renderer (src-tauri,
//! it needs a webview) loads the page in a hidden webview and hands the DOM to `finish`.

use rusqlite::{OptionalExtension, params};

use crate::extract::extract;
use crate::fetch::Fetched;
use crate::ingest::{self, RENDERED_CONTENT_TYPE};
use crate::msg;
use crate::store::{Store, THIN_TEXT_CHARS};
use crate::{classify, embed};

pub const JOB_TYPE: &str = "render";
pub const JOBS: &[&str] = &[JOB_TYPE];
/// "off" disables rendering after a thin fetch; absent means on.
pub const AUTO_SETTING: &str = "auto_render";

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn auto_enabled(store: &Store) -> Result<bool, String> {
    Ok(store.setting(AUTO_SETTING).map_err(err)?.as_deref() != Some("off"))
}

pub fn set_auto(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(AUTO_SETTING, (!on).then_some("off")).map_err(err)
}

/// Manual 「描画して取り込み直す」.
pub fn enqueue(store: &Store, article_id: i64) -> Result<(), String> {
    store.enqueue_job(JOB_TYPE, article_id, "{}", &format!("{JOB_TYPE}:{article_id}")).map_err(err)
}

/// After a server fetch: queue a render if the page came back thin or unextractable, or was
/// refused with a status a real browser may get past (bot checks: 401, 403, 429, 5xx; not 404
/// or 410). The newest snapshot must not be a rendering, so a rendering never queues another
/// (one attempt per fetch), nor a PDF, which a browser shows but does not render into text.
/// Returns whether a job was queued.
pub fn enqueue_if_auto(store: &Store, article_id: i64) -> Result<bool, String> {
    let wanted: bool = store
        .conn()
        .query_row(
            "SELECT (fetch_status = 'ok' AND (extraction_status = 'failed' OR coalesce(text_length, 0) < ?2)
                    OR fetch_status = 'failed' AND last_error GLOB 'HTTP [45][0-9][0-9]*' AND substr(last_error, 6, 3) NOT IN ('404', '410'))
                AND coalesce((SELECT content_type FROM snapshots WHERE article_id = a.id ORDER BY id DESC LIMIT 1), '') NOT IN (?3, ?4)
             FROM articles a WHERE id = ?1",
            params![article_id, THIN_TEXT_CHARS, RENDERED_CONTENT_TYPE, crate::pdf::CONTENT_TYPE],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .unwrap_or(false);
    if !(wanted && auto_enabled(store)?) {
        return Ok(false);
    }
    enqueue(store, article_id)?;
    Ok(true)
}

/// Stores the rendered DOM `(final_url, html)` through the normal pipeline, or records on the
/// article why there is none. A rendering that extracts no more text than the server HTML did
/// is not stored, so it can never make an article worse. Returns the surviving article id.
pub fn finish(store: &Store, article_id: i64, rendered: Result<(String, String), String>, embed_model: &str) -> Result<i64, String> {
    let (url, html) = match rendered {
        Ok(r) => r,
        Err(e) => return record_failure(store, article_id, &msg!("render.failed", error = e)),
    };
    let rendered_len: i64 = match extract(&html, &url) {
        Ok(ir) => ir.blocks.iter().map(|b| b.text.chars().count() as i64).sum(),
        Err(e) => return record_failure(store, article_id, &msg!("render.noText", error = e.to_string())),
    };
    let current: i64 = store
        .conn()
        .query_row("SELECT CASE WHEN extraction_status = 'ok' THEN coalesce(text_length, 0) ELSE -1 END FROM articles WHERE id = ?1", [article_id], |r| {
            r.get(0)
        })
        .map_err(err)?;
    if rendered_len <= current {
        return record_failure(store, article_id, &msg!("render.noGain"));
    }
    let id = ingest::store_fetched(store, article_id, &Fetched { final_url: url, status: 200, content_type: Some(RENDERED_CONTENT_TYPE.into()), html })?;
    classify::enqueue_if_auto(store, id)?;
    embed::enqueue(store, id, embed_model)?;
    Ok(id)
}

fn record_failure(store: &Store, article_id: i64, error: &str) -> Result<i64, String> {
    store.conn().execute("UPDATE articles SET last_error = ?2 WHERE id = ?1", params![article_id, error]).map_err(err)?;
    Ok(article_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(body: &str) -> String {
        format!("<html><head><title>T</title></head><body><article>{body}</article></body></html>")
    }

    const PROSE: &str = "<p>Snapshot isolation prevents dirty reads but still permits write skew, which is why serializable snapshot isolation exists. This sentence pads the paragraph so that readability keeps it around.</p>";

    fn fetched(s: &Store, body: &str) -> i64 {
        let (id, _) = s.upsert_pending("https://example.com/app", "https://example.com/app", "example.com").unwrap();
        let f = Fetched { final_url: "https://example.com/app".into(), status: 200, content_type: Some("text/html".into()), html: page(body) };
        ingest::store_fetched(s, id, &f).unwrap()
    }

    fn claim(s: &Store) -> Option<i64> {
        let j = s.claim_next_job(JOBS).unwrap()?;
        s.finish_job(j.id, None).unwrap();
        j.article_id
    }

    #[test]
    fn thin_fetch_queues_one_render_and_rendering_never_requeues() {
        let s = Store::open_in_memory().unwrap();
        let id = fetched(&s, "<p>Loading the application, please wait for a moment.</p>");
        assert!(enqueue_if_auto(&s, id).unwrap());
        assert_eq!(claim(&s), Some(id));

        let rendered = page(&PROSE.repeat(3));
        assert_eq!(finish(&s, id, Ok(("https://example.com/app".into(), rendered)), "m").unwrap(), id);
        let a = s.article_row(id).unwrap().unwrap();
        assert!(!a.thin && a.last_error.is_none(), "{a:?}");
        assert!(s.claim_next_job(&[embed::JOB_TYPE]).unwrap().is_some(), "embed follows the rendering");

        // Newest snapshot is a rendering: no second attempt, even if it were still thin.
        s.exec_for_test(&format!("UPDATE articles SET text_length = 10 WHERE id = {id}"));
        assert!(!enqueue_if_auto(&s, id).unwrap());
        assert_eq!(claim(&s), None);
    }

    #[test]
    fn full_fetch_or_setting_off_queues_nothing() {
        let s = Store::open_in_memory().unwrap();
        let id = fetched(&s, &PROSE.repeat(3));
        assert!(!enqueue_if_auto(&s, id).unwrap());
        let thin = fetched(&s, "");
        set_auto(&s, false).unwrap();
        assert!(!enqueue_if_auto(&s, thin).unwrap());
        set_auto(&s, true).unwrap();
        assert!(enqueue_if_auto(&s, thin).unwrap(), "empty extraction counts");
    }

    #[test]
    fn failed_or_shorter_rendering_keeps_the_article() {
        let s = Store::open_in_memory().unwrap();
        let id = fetched(&s, &format!("<p>{}</p>", "Short server text, padded a little. ".repeat(4)));
        let before = s.get_article(id, "ja").unwrap().unwrap().blocks.len();

        finish(&s, id, Err("timed out".into()), "m").unwrap();
        assert!(s.article_row(id).unwrap().unwrap().last_error.unwrap().contains("timed out"));

        finish(&s, id, Ok(("https://example.com/app".into(), page("<p>Accept cookies?</p>"))), "m").unwrap();
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!((v.article.extraction_status.as_str(), v.blocks.len()), ("ok", before));
        assert_eq!(v.article.last_error.as_deref(), Some(msg!("render.noGain").as_str()));
        assert!(!s.latest_snapshot(id).unwrap().unwrap().html().contains("Accept cookies"), "not stored");
    }
}
