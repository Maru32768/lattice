//! Article translation job: translates an article's prose blocks with the reading-unit
//! algorithm (`segments.rs`), in batches sent a few at a time and persisted in order, so a usage limit
//! mid-article loses nothing and a retry only sends what is still missing.

use crate::ir::PROSE_KINDS;
use crate::llm::LlmProvider;
use crate::msg;
use crate::pdf;
use crate::segments::{self, PROMPT_VERSION, Target, Unit, snippet_from_inlines};
use crate::store::{PendingBlock, SegmentRow, Store};
use futures::{StreamExt, stream};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::{HashMap, hash_map::Entry};
use ts_rs::TS;

pub const JOB_TYPE: &str = "translate";
pub const TARGET_LANGUAGE: &str = "ja";
/// "off" translates technical terms too; absent means keep them in English (§8).
pub const KEEP_TERMS_SETTING: &str = "translate_keep_terms";
/// The user's extra instructions for the translation prompt; absent means none.
pub const INSTRUCTIONS_SETTING: &str = "translate_instructions";
pub const MAX_INSTRUCTION_CHARS: usize = 2000;
/// "on" translates each saved article once it is extracted; absent means off, since it spends LLM usage.
pub const AUTO_SETTING: &str = "auto_translate";
/// "on" also auto-translates articles written in the display language (into the other one, e.g. a
/// Japanese article into English for a Japanese reader); absent means off.
pub const AUTO_OWN_LANGUAGE_SETTING: &str = "auto_translate_own_language";
/// The display language ("ja" or "en", G51), stored by the app once it has detected or been given one.
pub const UI_LANGUAGE_SETTING: &str = "ui_language";
const BATCH_CHARS: usize = 6000;
const BATCH_ITEMS: usize = 12;
/// How many batches of one article are in flight at once (設定 › 翻訳); absent means `DEFAULT_PARALLEL`.
/// More finishes a long article sooner; fewer spares a provider that runs one CLI process per call or
/// rate-limits an API (and a batch's single retries add to the calls in flight).
pub const PARALLEL_SETTING: &str = "translate_parallel";
pub const DEFAULT_PARALLEL: usize = 3;
pub const MAX_PARALLEL: usize = 8;
/// Pages the in-app browser never translates, one pattern per line (`page_skipped`); absent means
/// `DEFAULT_PAGE_SKIP_SITES`: result pages are mostly titles, and translating every search spends usage.
pub const PAGE_SKIP_SETTING: &str = "page_translate_skip_sites";
/// `www.google.*` and not `google.*`: Docs, Groups and the like are pages worth translating.
pub const DEFAULT_PAGE_SKIP_SITES: &[&str] =
    &["www.google.*", "bing.com", "duckduckgo.com", "search.brave.com", "kagi.com", "search.yahoo.co.jp", "search.yahoo.com"];
const MAX_PAGE_SKIP_SITES: usize = 500;

pub fn keep_terms(store: &Store) -> Result<bool, String> {
    Ok(store.setting(KEEP_TERMS_SETTING).map_err(|e| e.to_string())?.as_deref() != Some("off"))
}

pub fn set_keep_terms(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(KEEP_TERMS_SETTING, (!on).then_some("off")).map_err(|e| e.to_string())
}

pub fn instructions(store: &Store) -> Result<String, String> {
    Ok(store.setting(INSTRUCTIONS_SETTING).map_err(|e| e.to_string())?.unwrap_or_default())
}

pub fn set_instructions(store: &Store, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(msg!("translate.instructionsTooLong", max = MAX_INSTRUCTION_CHARS));
    }
    store.set_setting(INSTRUCTIONS_SETTING, (!text.is_empty()).then_some(text)).map_err(|e| e.to_string())
}

pub fn parallel(store: &Store) -> Result<usize, String> {
    let stored = store.setting(PARALLEL_SETTING).map_err(|e| e.to_string())?;
    Ok(stored.and_then(|v| v.parse().ok()).filter(|n| (1..=MAX_PARALLEL).contains(n)).unwrap_or(DEFAULT_PARALLEL))
}

pub fn set_parallel(store: &Store, n: usize) -> Result<(), String> {
    if !(1..=MAX_PARALLEL).contains(&n) {
        return Err(msg!("translate.parallelRange", max = MAX_PARALLEL));
    }
    store.set_setting(PARALLEL_SETTING, (n != DEFAULT_PARALLEL).then(|| n.to_string()).as_deref()).map_err(|e| e.to_string())
}

pub fn auto_enabled(store: &Store) -> Result<bool, String> {
    Ok(store.setting(AUTO_SETTING).map_err(|e| e.to_string())?.as_deref() == Some("on"))
}

pub fn set_auto(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(AUTO_SETTING, on.then_some("on")).map_err(|e| e.to_string())
}

pub fn auto_own_language(store: &Store) -> Result<bool, String> {
    Ok(store.setting(AUTO_OWN_LANGUAGE_SETTING).map_err(|e| e.to_string())?.as_deref() == Some("on"))
}

pub fn set_auto_own_language(store: &Store, on: bool) -> Result<(), String> {
    store.set_setting(AUTO_OWN_LANGUAGE_SETTING, on.then_some("on")).map_err(|e| e.to_string())
}

pub fn page_skip_sites(store: &Store) -> Result<Vec<String>, String> {
    Ok(match store.setting(PAGE_SKIP_SETTING).map_err(|e| e.to_string())? {
        Some(v) => v.lines().map(str::to_owned).collect(),
        None => DEFAULT_PAGE_SKIP_SITES.iter().map(|s| (*s).to_owned()).collect(),
    })
}

/// Stores the patterns in `text` (one per line), returning them as stored. A repeated line keeps only
/// its last place, which is the one that decides under last-match-wins.
pub fn set_page_skip_sites(store: &Store, text: &str) -> Result<Vec<String>, String> {
    let mut sites: Vec<String> = Vec::new();
    for line in text.lines() {
        let pattern = line.trim().to_ascii_lowercase();
        if !pattern.is_empty() {
            sites.retain(|s| *s != pattern);
            sites.push(pattern);
        }
    }
    sites.truncate(MAX_PAGE_SKIP_SITES);
    let default = sites.iter().map(String::as_str).eq(DEFAULT_PAGE_SKIP_SITES.iter().copied());
    // Empty is stored as "": clearing the list must not bring the defaults back.
    store.set_setting(PAGE_SKIP_SETTING, (!default).then(|| sites.join("\n")).as_deref()).map_err(|e| e.to_string())?;
    Ok(sites)
}

/// `https://www.Example.com/path` → `www.example.com`.
fn site_host(line: &str) -> String {
    let s = line.trim();
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let s = s.split(['/', '?', '#']).next().unwrap_or_default();
    let s = s.rsplit_once('@').map_or(s, |(_, host)| host);
    let s = s.split(':').next().unwrap_or_default();
    s.trim_matches('.').to_ascii_lowercase()
}

/// Whether the page at `url` matches one of `sites`, where `*` stands for any text. A pattern without
/// `/` is a host and covers its subdomains (`example.com`, `www.google.*`); one with `/` is matched
/// against the whole URL, with or without its scheme (`https://www.google.com/search*`, `example.com/docs/*`).
/// As in .gitignore, a pattern starting with `!` translates what it matches, and the last matching line wins:
/// `x.com/*` then `!x.com/*/status/*` skips X except its posts.
pub fn page_skipped(sites: &[String], url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    let host = site_host(&url);
    let rest = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
    let matches = |p: &str| {
        if p.contains("://") {
            glob(p, &url)
        } else if p.contains('/') {
            glob(p, rest)
        } else {
            glob(p, &host) || host.match_indices('.').any(|(i, _)| glob(p, &host[i + 1..]))
        }
    };
    sites
        .iter()
        .rev()
        .find_map(|p| match p.strip_prefix('!') {
            Some(p) => matches(p).then_some(false),
            None => matches(p).then_some(true),
        })
        .unwrap_or(false)
}

/// `*` matches any run of bytes, everything else itself. Greedy with one backtrack point, so a
/// pattern full of `*` stays linear-ish instead of exponential on every page load.
fn glob(pattern: &str, s: &str) -> bool {
    let (p, s) = (pattern.as_bytes(), s.as_bytes());
    let (mut pi, mut si) = (0, 0);
    let mut back: Option<(usize, usize)> = None;
    while si < s.len() {
        if p.get(pi) == Some(&b'*') {
            back = Some((pi + 1, si));
            pi += 1;
        } else if p.get(pi) == s.get(si) {
            pi += 1;
            si += 1;
        } else if let Some((bp, bs)) = back {
            (pi, si) = (bp, bs + 1);
            back = Some((bp, bs + 1));
        } else {
            return false;
        }
    }
    p.get(pi..).is_some_and(|rest| rest.iter().all(|&b| b == b'*'))
}

/// "ja" until the app has stored one.
fn display_language(store: &Store) -> Result<&'static str, String> {
    Ok(match store.setting(UI_LANGUAGE_SETTING).map_err(|e| e.to_string())?.as_deref() {
        Some("en") => "en",
        _ => "ja",
    })
}

/// After ingest: queue an extracted article's translation if auto translation is on. Only when the
/// translation is in the display language, unless `AUTO_OWN_LANGUAGE_SETTING` is on: an article whose
/// translation is not is one the reader reads as it is (in the display language, as far as Japanese and
/// English go), and translating it would only cost usage. Never for an article set to `set_manual`.
pub fn enqueue_if_auto(store: &Store, article_id: i64) -> Result<(), String> {
    if !auto_enabled(store)? {
        return Ok(());
    }
    let wanted: bool = store
        .conn()
        .query_row("SELECT extraction_status = 'ok' AND NOT translate_manual FROM articles WHERE id = ?1", [article_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !wanted {
        return Ok(());
    }
    let target = article_target(store, article_id)?;
    if target.language != display_language(store)? && !auto_own_language(store)? {
        return Ok(());
    }
    enqueue(store, article_id, &target)
}

/// Turns automatic translation of one article off (`on`) or back on. Off also takes back its translate
/// jobs, a running one included (`jobs::run_job` stops it). Turning it back on queues nothing: that waits
/// for the next thing that starts a translation.
pub fn set_manual(store: &Store, article_id: i64, on: bool) -> Result<(), String> {
    let c = store.conn();
    c.execute("UPDATE articles SET translate_manual = ?2 WHERE id = ?1", params![article_id, on]).map_err(|e| e.to_string())?;
    if on {
        c.execute("DELETE FROM processing_jobs WHERE type = ?1 AND article_id = ?2", params![JOB_TYPE, article_id]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The current settings' target for non-Japanese sources (`Target::for_source` adapts it).
pub fn target(store: &Store) -> Result<Target, String> {
    Ok(Target { language: TARGET_LANGUAGE, keep_terms: keep_terms(store)?, instructions: instructions(store)? })
}

/// The current settings' target for one article: English if the article is Japanese.
pub fn article_target(store: &Store, article_id: i64) -> Result<Target, String> {
    Ok(target(store)?.for_source(store.article_is_japanese(article_id).map_err(|e| e.to_string())?))
}

/// The job keeps the target it was queued with, so changing settings meanwhile does not mix modes.
pub fn enqueue(store: &Store, article_id: i64, target: &Target) -> Result<(), String> {
    let key = target.key();
    let params = serde_json::json!({ "target_language": key, "instructions": target.instructions }).to_string();
    store.enqueue_job(JOB_TYPE, article_id, &params, &format!("{JOB_TYPE}:{article_id}:{key}")).map_err(|e| e.to_string())
}

/// The translations already saved for `snippets`, by `source_hash`. `article`, for a page that shows
/// its article cut up differently from its blocks (a PDF's paragraph broken across columns, `pdf::regions`),
/// also serves a snippet from the units of the block that holds it: they were never stored under its hash.
pub fn saved_units(store: &Store, article: Option<i64>, snippets: &[String], key: &str) -> Result<HashMap<String, Vec<Unit>>, String> {
    let hashes: Vec<String> = snippets.iter().map(|s| segments::source_hash(s)).collect();
    let mut found = store.cached_segments(&hashes, key).map_err(|e| e.to_string())?;
    let Some(article) = article else {
        return Ok(found);
    };
    // A PDF's blocks are plain text. Their units, saved under a snippet's hash too since it ignores
    // tags, would flatten the snippet's scripts into its letters: those go to the model once more.
    for (snippet, hash) in snippets.iter().zip(&hashes) {
        if segments::scripted(snippet) && found.get(hash).is_some_and(|units| !units.iter().any(|u| segments::scripted(&u.source))) {
            found.remove(hash);
        }
    }
    if hashes.iter().all(|h| found.contains_key(h)) {
        return Ok(found);
    }
    let blocks = store.translated_blocks(article, key).map_err(|e| e.to_string())?;
    for (snippet, hash) in snippets.iter().zip(hashes) {
        if segments::scripted(snippet) {
            continue;
        }
        if let Entry::Vacant(slot) = found.entry(hash) {
            let piece = segments::plain_text(snippet);
            if let Some(units) = blocks.iter().filter(|(text, _)| text.contains(&piece)).find_map(|(_, units)| units_of_piece(units, &piece)) {
                slot.insert(units);
            }
        }
    }
    Ok(found)
}

/// The run of `units` that is exactly `piece`, or none when the piece starts or ends inside a unit: half
/// a sentence's translation cannot be told from the rest. Whitespace is ignored, as some models leave
/// the space between two sentences out of their sources.
fn units_of_piece(units: &[Unit], piece: &str) -> Option<Vec<Unit>> {
    let squeezed = |s: &str| s.split_whitespace().collect::<String>();
    let piece = squeezed(piece);
    (0..units.len()).find_map(|start| {
        let mut text = String::new();
        for (end, unit) in units.iter().enumerate().skip(start) {
            text.push_str(&squeezed(&segments::plain_text(&unit.source)));
            if text == piece {
                return Some(units[start..=end].to_vec());
            }
            if !piece.starts_with(&text) {
                return None;
            }
        }
        None
    })
}

/// Translates the article anew: drops its cached translations for `target` (also those of
/// paragraphs other articles share, which then get the new translation) and queues the job,
/// which now finds every block untranslated. Returns how many translations were dropped.
pub fn retranslate(store: &Store, article_id: i64, target: &Target) -> Result<usize, String> {
    let key = target.key();
    let blocks = store.drop_translations(article_id, &key, PROSE_KINDS).map_err(|e| e.to_string())?;
    let pieces = store.drop_segments(&pdf_piece_hashes(store, article_id), &key).map_err(|e| e.to_string())?;
    enqueue(store, article_id, target)?;
    Ok(blocks + pieces)
}

/// What the Page view saves a PDF's regions under, unknown to `drop_translations`: left in place, they
/// would keep showing the old translation there. Whatever keeps them from being read must not stop the
/// retranslation, which only leaves those few rows.
fn pdf_piece_hashes(store: &Store, article_id: i64) -> Vec<String> {
    let regions = match store.latest_snapshot(article_id) {
        Ok(Some(s)) if s.content_type.as_deref() == Some(pdf::CONTENT_TYPE) => pdf::regions(&s.body),
        Ok(_) => return Vec::new(),
        Err(e) => Err(e.to_string()),
    };
    match regions {
        Ok(regions) => regions.iter().map(|r| segments::source_hash(&snippet_from_inlines(&r.translated_text(), &[]))).collect(),
        Err(e) => {
            log::warn!("reading the regions of article {article_id} to retranslate it: {e}");
            Vec::new()
        }
    }
}

/// An article with a translate job queued or running, for the article list's label. Finished
/// translations have none.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct Progress {
    pub article_id: i64,
    pub running: bool,
    /// Prose blocks translated, and those plus the ones still to translate (as the Reader counts them).
    pub done: usize,
    pub total: usize,
}

/// Every article being translated or waiting to be.
pub fn in_progress(store: &Store) -> Result<Vec<Progress>, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let mut out = Vec::new();
    for job in store.active_jobs(JOB_TYPE).map_err(e)? {
        let Some(article_id) = job.article_id else {
            continue;
        };
        let key = job
            .params
            .as_deref()
            .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok())
            .and_then(|p| p["target_language"].as_str().map(str::to_string))
            .map_or_else(|| article_target(store, article_id).map(|t| t.key()), Ok)?;
        let target = Target::from_key(&key, "");
        let done = store.translated_count(article_id, &key, PROSE_KINDS).map_err(e)?;
        let left = store.untranslated_texts(article_id, &key, PROSE_KINDS).map_err(e)?.iter().filter(|t| !target.is_written_in(t)).count();
        out.push(Progress { article_id, running: job.status == "running", done, total: done + left });
    }
    Ok(out)
}

fn batches(blocks: Vec<PendingBlock>) -> Vec<Vec<PendingBlock>> {
    let mut out: Vec<Vec<PendingBlock>> = Vec::new();
    let mut chars = 0;
    for b in blocks {
        let len = b.text.chars().count();
        match out.last_mut() {
            Some(batch) if batch.len() < BATCH_ITEMS && chars + len <= BATCH_CHARS => {
                chars += len;
                batch.push(b);
            }
            _ => {
                chars = len;
                out.push(vec![b]);
            }
        }
    }
    out
}

/// Bounds the translation calls in flight across every article to 並列実行数: a batch enters before
/// it is sent and leaves when it returns. The limit is read at each entry, so a changed setting
/// applies from the next batch.
#[derive(Default)]
pub struct Gate {
    in_flight: std::sync::Mutex<usize>,
    left: tokio::sync::Notify,
}

pub struct Pass<'a>(&'a Gate);

impl Gate {
    pub async fn enter(&self, limit: usize) -> Pass<'_> {
        loop {
            // Registered before the check, so a batch leaving in between is not missed.
            let left = self.left.notified();
            tokio::pin!(left);
            left.as_mut().enable();
            {
                let mut n = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
                if *n < limit.max(1) {
                    *n += 1;
                    return Pass(self);
                }
            }
            left.await;
        }
    }

    pub fn in_flight(&self) -> usize {
        *self.in_flight.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        *self.0.in_flight.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.left.notify_waiters();
    }
}

/// \`gate\` shares 並列実行数 with the other articles being translated; \`None\` (the reserved slot for the
/// article on screen, the CLI) sends up to that many of this article's batches regardless.
pub async fn run<P: LlmProvider>(
    store: &Store,
    provider: &P,
    article_id: i64,
    target: &Target,
    gate: Option<&Gate>,
    on_progress: &(dyn Fn() + Send + Sync),
) -> Result<(), String> {
    let key = target.key();
    let mut pending = store.untranslated_blocks(article_id, &key, PROSE_KINDS).map_err(|e| e.to_string())?;
    // Same paragraph twice translates once; a paragraph already in the target language needs none.
    let mut seen = std::collections::HashSet::new();
    pending.retain(|b| seen.insert(b.text_hash.clone()) && !target.is_written_in(&b.text));
    let mut missing = 0;
    let parallel = parallel(store)?;
    // A batch that failed whole says the provider may be down: none starts until another answers, and
    // the job backs off at the end. One that answers says it was that batch's text, so the rest of the
    // article goes on. Calls already made are saved either way: they are paid for.
    let stopped = std::sync::atomic::AtomicBool::new(false);
    let mut failed = None;
    let stopped_ref = &stopped;
    // `buffered` keeps the article's order: the top of the article is saved (and shown) first.
    let mut done = stream::iter(batches(pending))
        .map(|batch| async move {
            let queued = std::time::Instant::now();
            let _pass = match gate {
                Some(g) => Some(g.enter(parallel).await),
                None => None,
            };
            if stopped_ref.load(std::sync::atomic::Ordering::Relaxed) {
                let results = vec![None; batch.len()];
                return (batch, segments::Translated { results, error: None });
            }
            let (waited, sent) = (queued.elapsed(), std::time::Instant::now());
            let snippets: Vec<String> = batch.iter().map(|b| snippet_from_inlines(&b.text, &b.inlines)).collect();
            let t = segments::translate_snippets(provider, &snippets, target).await;
            // Per batch, for tuning 並列実行数 and the batch size from real timings.
            log::info!(
                "translate article {article_id}: {} blocks, {} chars in {:.1?} (waited {:.1?} for a slot){}",
                batch.len(),
                snippets.iter().map(|s| s.chars().count()).sum::<usize>(),
                sent.elapsed(),
                waited,
                if t.error.is_some() {
                    ", with errors"
                } else {
                    ""
                },
            );
            (batch, t)
        })
        .buffered(parallel);
    while let Some((batch, t)) = done.next().await {
        let rows: Vec<SegmentRow> = batch
            .iter()
            .zip(&t.results)
            .filter_map(|(b, r)| r.as_ref().map(|(units, o)| (b.text_hash.as_str(), &units[..], o.provider.as_str(), o.model.as_deref())))
            .collect();
        missing += batch.len() - rows.len();
        match (rows.is_empty(), t.error) {
            (false, _) => stopped.store(false, std::sync::atomic::Ordering::Relaxed),
            (true, Some(e)) => {
                stopped.store(true, std::sync::atomic::Ordering::Relaxed);
                failed.get_or_insert(e.to_string());
            }
            (true, None) => {}
        }
        store.insert_segments(&key, PROMPT_VERSION, &rows).map_err(|e| e.to_string())?;
        on_progress();
    }
    if let Some(e) = failed {
        return Err(e);
    }
    if missing > 0 {
        return Err(msg!("translate.missingBlocks", missing = missing));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::Fetched;
    use crate::ingest::store_fetched;
    use crate::llm::{Completion, LlmError};
    use crate::segments::tests::Fake;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// `Fake`, slow enough that calls overlap, counting how many are in flight at once.
    struct Slow {
        fake: Fake,
        now: AtomicUsize,
        most: AtomicUsize,
    }

    impl LlmProvider for Slow {
        fn name(&self) -> &str {
            "slow"
        }
        async fn complete_json(&self, system: &str, input: &str, schema: &Value) -> Result<Completion, LlmError> {
            let n = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(n, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            self.now.fetch_sub(1, Ordering::SeqCst);
            self.fake.complete_json(system, input, schema).await
        }
    }

    #[test]
    fn page_skip_sites_default_to_search_engines_and_match_subdomains() {
        let s = Store::open_in_memory().unwrap();
        let sites = page_skip_sites(&s).unwrap();
        for url in ["https://www.google.com/search?q=x", "https://www.google.co.jp/", "https://html.duckduckgo.com/html?q=x", "https://DuckDuckGo.com./"] {
            assert!(page_skipped(&sites, url), "{url}");
        }
        for url in ["https://docs.google.com/document/d/1", "https://notbing.com/", "https://example.com/?u=bing.com"] {
            assert!(!page_skipped(&sites, url), "{url}");
        }

        let stored = set_page_skip_sites(&s, " https://Docs.Example.com/api/* \n\nexample.org/blog*\n*.test\n*.test\n").unwrap();
        assert_eq!(stored, ["https://docs.example.com/api/*", "example.org/blog*", "*.test"]);
        assert_eq!(page_skip_sites(&s).unwrap(), stored);
        assert!(page_skipped(&stored, "https://docs.example.com/api/v1#x"));
        assert!(!page_skipped(&stored, "http://docs.example.com/api/v1"), "the scheme counts when written");
        assert!(!page_skipped(&stored, "https://docs.example.com/guide"));
        assert!(page_skipped(&stored, "http://example.org/blog/post") && !page_skipped(&stored, "https://www.example.org/blog"));
        assert!(page_skipped(&stored, "https://app.test:8080/"), "the port is not part of the host");
        assert!(!glob("*a*a*a*a*a*a*b", &"a".repeat(2000)) && glob("a**b*", "axxbyy"));

        let x = set_page_skip_sites(&s, "x.com/*\n!x.com/*/status/*\nx.com/spam/*\nx.com/*\n").unwrap();
        assert_eq!(x, ["!x.com/*/status/*", "x.com/spam/*", "x.com/*"], "a repeated line moves to its last place");
        let x = set_page_skip_sites(&s, "x.com/*\n!x.com/*/status/*\nx.com/spam/*").unwrap();
        assert!(page_skipped(&x, "https://x.com/home"));
        assert!(!page_skipped(&x, "https://x.com/Maru32768/status/1"), "a later ! line translates");
        assert!(page_skipped(&x, "https://x.com/spam/status/1"), "and a still later line skips again");
        assert!(!page_skipped(&["!example.com".to_owned()], "https://example.com/"), "! alone skips nothing");

        assert!(set_page_skip_sites(&s, "").unwrap().is_empty());
        assert!(page_skip_sites(&s).unwrap().is_empty(), "cleared stays cleared");
        set_page_skip_sites(&s, &DEFAULT_PAGE_SKIP_SITES.join("\n")).unwrap();
        assert_eq!(s.setting(PAGE_SKIP_SETTING).unwrap(), None, "the defaults are not stored");
    }

    #[tokio::test]
    async fn an_articles_batches_are_translated_as_many_at_a_time_as_set() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/long", "https://a.dev/long", "a.dev").unwrap();
        let paras: String = (0..60).map(|i| format!("<p>Paragraph {i} explains how snapshot isolation handles write skew in practice.</p>")).collect();
        let html = format!("<html><body><article>{paras}</article></body></html>");
        store_fetched(&s, id, &Fetched { final_url: "https://a.dev/long".into(), status: 200, content_type: None, html }).unwrap();
        let slow = Slow { fake: Fake::new(), now: AtomicUsize::new(0), most: AtomicUsize::new(0) };
        let saved = AtomicUsize::new(0);
        assert!(set_parallel(&s, 0).is_err() && set_parallel(&s, MAX_PARALLEL + 1).is_err());
        set_parallel(&s, 2).unwrap();

        run(&s, &slow, id, &Target::default(), None, &|| {
            saved.fetch_add(1, Ordering::SeqCst);
        })
        .await
        .unwrap();
        assert_eq!(saved.load(Ordering::SeqCst), 5, "60 paragraphs in batches of 12");
        assert_eq!(slow.most.load(Ordering::SeqCst), 2, "the setting caps the calls in flight");
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert!(v.blocks.iter().all(|b| b.translation.is_some()), "every batch saved");
    }

    #[tokio::test]
    async fn progress_lists_queued_and_running_articles_until_done_and_the_view_has_sentences() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/p", "https://a.dev/p", "a.dev").unwrap();
        let html = "<html><body><article><p>One sentence here. Two sentences here.</p><p>スナップショット分離の説明です。</p><p>A third paragraph about write skew.</p></article></body></html>";
        store_fetched(&s, id, &Fetched { final_url: "https://a.dev/p".into(), status: 200, content_type: None, html: html.into() }).unwrap();
        let target = Target::default();
        enqueue(&s, id, &target).unwrap();
        let p = in_progress(&s).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].article_id, p[0].running, p[0].done, p[0].total), (id, false, 0, 2), "the Japanese paragraph is not counted");

        let job = s.claim_article_job(&[JOB_TYPE], id).unwrap().unwrap();
        run(&s, &Fake::new(), id, &target, None, &|| {}).await.unwrap();
        let p = in_progress(&s).unwrap();
        assert_eq!((p[0].running, p[0].done, p[0].total), (true, 2, 2));
        s.finish_job(job.id, None).unwrap();
        assert!(in_progress(&s).unwrap().is_empty(), "a finished translation has no label");

        let v = s.get_article(id, &target.key()).unwrap().unwrap();
        let units: Vec<(&str, &str)> = v.blocks[0].units.iter().map(|u| (u.source.as_str(), u.translation.as_str())).collect();
        assert_eq!(
            units,
            [("One sentence here.", "ONE SENTENCE HERE."), ("Two sentences here.", "TWO SENTENCES HERE.")],
            "plain text, for the Reader to mix by sentence"
        );
    }

    #[tokio::test]
    async fn saved_units_serve_the_pieces_of_a_translated_block_but_only_whole_sentences() {
        let s = Store::open_in_memory().unwrap();
        let (id, _) = s.upsert_pending("https://a.dev/p", "https://a.dev/p", "a.dev").unwrap();
        let html = "<html><body><article><p>One sentence here. Two sentences here. Three sentences here.</p></article></body></html>";
        store_fetched(&s, id, &Fetched { final_url: "https://a.dev/p".into(), status: 200, content_type: None, html: html.into() }).unwrap();
        let target = Target::default();
        run(&s, &Fake::new(), id, &target, None, &|| {}).await.unwrap();
        let key = target.key();

        let sources = |snippet: &str, article: Option<i64>, key: &str| {
            let found = saved_units(&s, article, &[snippet.to_string()], key).unwrap();
            found.get(&segments::source_hash(snippet)).map(|u| u.iter().map(|u| u.source.trim().to_string()).collect::<Vec<_>>())
        };
        let whole = "One sentence here. Two sentences here. Three sentences here.";
        assert_eq!(sources(whole, None, &key).unwrap().len(), 3, "the block itself needs no article");
        assert_eq!(sources("Two sentences here. Three sentences here.", Some(id), &key).unwrap(), ["Two sentences here.", "Three sentences here."]);
        assert_eq!(sources("One sentence here.", Some(id), &key).unwrap(), ["One sentence here."], "a unit's trailing space is no difference");
        assert_eq!(sources("sentence here. Two", Some(id), &key), None, "a piece that cuts through a sentence has no translation of its own");
        assert_eq!(sources("Two sentences here.", None, &key), None, "pieces are looked for in the page's article only");
        assert_eq!(sources("Two sentences here.", Some(id), "en"), None, "nor under another target");
        assert_eq!(sources("Two sen<sub>tences</sub> here.", Some(id), &key), None, "plain units would lose a script");
        assert_eq!(
            sources("One sen<sup>tence</sup> here. Two sentences here. Three sentences here.", Some(id), &key),
            None,
            "even under the snippet's own hash"
        );
        let scripted = "One sen<sup>tence</sup> here. Two sentences here. Three sentences here.";
        let units = [Unit { source: scripted.to_string(), translation: "x".to_string() }];
        s.insert_segments(&key, PROMPT_VERSION, &[(segments::source_hash(scripted).as_str(), &units[..], "fake", None)]).unwrap();
        assert_eq!(sources(scripted, Some(id), &key).unwrap().len(), 1, "a translation made with the scripts is kept");
    }

    #[tokio::test]
    async fn the_gate_caps_the_calls_in_flight_across_articles() {
        let s = Store::open_in_memory().unwrap();
        let mut ids = vec![];
        for n in 0..2 {
            let url = format!("https://a.dev/{n}");
            let (id, _) = s.upsert_pending(&url, &url, "a.dev").unwrap();
            let paras: String = (0..36).map(|i| format!("<p>Paragraph {i} explains how snapshot isolation handles write skew in practice.</p>")).collect();
            let html = format!("<html><body><article>{paras}</article></body></html>");
            store_fetched(&s, id, &Fetched { final_url: url.clone(), status: 200, content_type: None, html }).unwrap();
            ids.push(id);
        }
        set_parallel(&s, 2).unwrap();
        let slow = Slow { fake: Fake::new(), now: AtomicUsize::new(0), most: AtomicUsize::new(0) };
        let gate = Gate::default();
        let target = Target::default();
        let (a, b) = tokio::join!(run(&s, &slow, ids[0], &target, Some(&gate), &|| {}), run(&s, &slow, ids[1], &target, Some(&gate), &|| {}));
        a.unwrap();
        b.unwrap();
        assert_eq!(slow.most.load(Ordering::SeqCst), 2, "two articles of three batches each share the limit of 2");
        assert_eq!(gate.in_flight(), 0, "every batch left");
    }
}
