//! The operations the CLI and the MCP server share. `Op` is parsed from command-line arguments
//! (clap) and from MCP tool calls (serde, `{"name": ..., "arguments": {...}}`) alike, and every
//! operation answers with JSON plus a plain-text rendering of the same result.

use clap::Subcommand;
use lattice_core::chain::LlmChain;
use lattice_core::chat::{self, Scope};
use lattice_core::embed::LocalE5;
use lattice_core::ir::BlockKind;
use lattice_core::jobs::{self, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleSort, Store, StoredBlock};
use lattice_core::url_norm::normalize;
use lattice_core::{classify, feeds, groups, ingest, job_status, relevance, search, summarize, translate};
use serde::Deserialize;
use serde_json::{Value, json};

const SEARCH_LIMIT: usize = 20;
const LIST_LIMIT: usize = 50;
/// Chat answers with mode "none" carry the app's coded message; this is its English text.
const NO_SOURCES: &str = "Nothing in the saved articles in this scope relates to the question. Try a wider scope, or ask it another way.";

fn search_limit() -> usize {
    SEARCH_LIMIT
}

fn list_limit() -> usize {
    LIST_LIMIT
}

#[derive(Debug, Subcommand, Deserialize)]
#[serde(tag = "name", content = "arguments", rename_all = "snake_case")]
pub enum Op {
    /// Hybrid search (full text and meaning) over the blocks of saved articles
    Search {
        query: String,
        /// all, unread, favorites, tag:NAME, genre:NAME, genre:none, feed:ID, feed:none, folder:ID, collection:ID, important[:MIN] or article:ID[,ID...]
        #[arg(long)]
        #[serde(default)]
        scope: Option<String>,
        #[arg(long, default_value_t = SEARCH_LIMIT)]
        #[serde(default = "search_limit")]
        limit: usize,
    },
    /// One article: metadata, summary and text
    Get {
        id: i64,
        /// The blocks with their ids instead of the joined text
        #[arg(long)]
        #[serde(default)]
        blocks: bool,
        /// Include the stored translation
        #[arg(long)]
        #[serde(default)]
        translation: bool,
    },
    /// Saved articles, newest first
    List {
        /// all, unread, favorites, tag:NAME, genre:NAME, genre:none, feed:ID, feed:none, folder:ID, collection:ID, important[:MIN] or article:ID[,ID...]
        #[arg(long)]
        #[serde(default)]
        scope: Option<String>,
        #[arg(long, default_value_t = LIST_LIMIT)]
        #[serde(default = "list_limit")]
        limit: usize,
    },
    /// An article's stored summary
    Summary { id: i64 },
    /// Tags with their article counts
    Tags {},
    /// Genres with their article counts
    Genres {},
    /// Subscribed feeds
    Feeds {},
    /// Collections with their ids and article counts (for --scope collection:ID)
    Collections {},
    /// Queued, running and failed background jobs
    Jobs {},
    /// Ask a question answered from saved articles, with citations (uses the app's LLM chain)
    Ask {
        question: String,
        /// all, unread, favorites, tag:NAME, genre:NAME, genre:none, feed:ID, feed:none, folder:ID, collection:ID, important[:MIN] or article:ID[,ID...]
        #[arg(long)]
        #[serde(default)]
        scope: Option<String>,
    },
    /// Save a URL: queues its fetch for the app (needs --allow-write)
    Save {
        url: String,
        /// Fetch and index it here now instead of waiting for the app
        #[arg(long)]
        #[serde(default)]
        run: bool,
    },
    /// Add a tag to an article (needs --allow-write)
    Tag { id: i64, name: String },
    /// Mark an article as read (needs --allow-write)
    Read { id: i64 },
    /// Mark an article as a favorite (needs --allow-write)
    Favorite { id: i64 },
}

impl Op {
    pub fn is_write(&self) -> bool {
        matches!(self, Op::Save { .. } | Op::Tag { .. } | Op::Read { .. } | Op::Favorite { .. })
    }
}

pub struct Ctx {
    pub store: Store,
    pub providers: Providers<LlmChain, LocalE5>,
    pub allow_write: bool,
}

/// One result in both output formats.
pub struct Out {
    pub json: Value,
    pub text: String,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// `important` without a minimum uses the app's threshold (Settings › Importance).
fn parse_scope(store: &Store, scope: Option<&str>) -> Result<Scope, String> {
    let filter = match scope.map(|s| s.split_once(':').unwrap_or((s, ""))) {
        None | Some(("all", "")) => ArticleFilter::All,
        Some(("unread", "")) => ArticleFilter::Unread,
        Some(("favorites", "")) => ArticleFilter::Favorites,
        Some(("tag", name)) if !name.is_empty() => ArticleFilter::Tag { name: name.into() },
        Some(("genre", "none")) => ArticleFilter::Genre { name: None },
        Some(("genre", name)) if !name.is_empty() => ArticleFilter::Genre { name: Some(name.into()) },
        Some(("feed", "none")) => ArticleFilter::Feed { id: None },
        Some(("feed", id)) if id.parse::<i64>().is_ok() => ArticleFilter::Feed { id: id.parse().ok() },
        // `group` is the older name, kept for existing scripts.
        Some(("collection" | "group", id)) if id.parse::<i64>().is_ok() => ArticleFilter::Group { id: id.parse().map_err(err)? },
        Some(("folder", id)) if id.parse::<i64>().is_ok() => ArticleFilter::Folder { id: id.parse().map_err(err)? },
        Some(("important", "")) => ArticleFilter::Important { min: relevance::threshold(store)? },
        Some(("important", min)) if matches!(min.parse::<i64>(), Ok(1..=5)) => ArticleFilter::Important { min: min.parse().map_err(err)? },
        Some(("article", ids)) => {
            if let Ok(mut ids) = ids.split(',').map(str::parse).collect::<Result<Vec<i64>, _>>() {
                return Ok(if ids.len() == 1 {
                    Scope::Article { id: ids.remove(0) }
                } else {
                    Scope::Articles { ids }
                });
            }
            return Err(format!("unknown scope {:?}: article takes ids separated by commas", scope.unwrap_or_default()));
        }
        _ => {
            return Err(format!(
                "unknown scope {:?}: use all, unread, favorites, tag:NAME, genre:NAME, genre:none, feed:ID, feed:none, folder:ID, collection:ID, important[:MIN] or article:ID[,ID...]",
                scope.unwrap_or_default()
            ));
        }
    };
    Ok(Scope::Filter { filter })
}

fn article(store: &Store, id: i64) -> Result<ArticleRow, String> {
    store.article_row(id).map_err(err)?.ok_or_else(|| format!("no article {id}"))
}

fn row_line(a: &ArticleRow) -> String {
    let title = a.title.as_deref().unwrap_or(&a.original_url);
    let mark = if a.read_status == "read" {
        " "
    } else {
        "*"
    };
    format!("{mark} {:>6}  {title}  <{}>", a.id, a.original_url)
}

/// Blocks as Markdown-like text: what an agent or a terminal reads best.
fn joined(blocks: &[StoredBlock], text: fn(&StoredBlock) -> &str) -> String {
    let parts: Vec<String> = blocks
        .iter()
        .map(|b| {
            let t = text(b);
            match b.block.kind {
                BlockKind::Heading => format!("## {t}"),
                BlockKind::Code => format!("```\n{t}\n```"),
                BlockKind::ListItem => format!("- {t}"),
                BlockKind::Blockquote => format!("> {t}"),
                BlockKind::Image => format!("[image: {t}]"),
                _ => t.to_string(),
            }
        })
        .collect();
    parts.join("\n\n")
}

fn source(b: &StoredBlock) -> &str {
    &b.block.text
}

/// The translation where there is one (code and already-target-language blocks have none).
fn translated(b: &StoredBlock) -> &str {
    b.translation.as_deref().unwrap_or(&b.block.text)
}

fn lines<T>(items: &[T], f: impl Fn(&T) -> String) -> String {
    items.iter().map(f).collect::<Vec<_>>().join("\n")
}

pub async fn run(ctx: &Ctx, op: Op) -> Result<Out, String> {
    if op.is_write() && !ctx.allow_write {
        return Err("this command changes the library: pass --allow-write or set LATTICE_ALLOW_WRITE=1".into());
    }
    let store = &ctx.store;
    match op {
        Op::Search { query, scope, limit } => {
            let ids = store.scope_articles(&parse_scope(store, scope.as_deref())?).map_err(err)?;
            let r = search::search(store, &ctx.providers.embedder, &query, ids.as_deref(), &translate::target(store)?, limit.max(1)).await?;
            let mode = if r.semantic_error.is_some() {
                "full_text"
            } else {
                "hybrid"
            };
            let mut text = r.semantic_error.as_ref().map(|e| format!("(full text only: {e})\n\n")).unwrap_or_default();
            text += &lines(&r.hits, |h| {
                let d = &h.detail;
                let heading = d.heading.as_deref().map(|h| format!(" › {h}")).unwrap_or_default();
                format!("[article {} block {}] {}{heading}\n  {}", d.article_id, d.block_id, d.article_title, d.text)
            });
            Ok(Out { json: json!({ "mode": mode, "semantic_error": r.semantic_error, "hits": r.hits }), text })
        }
        Op::Get { id, blocks, translation } => {
            article(store, id)?;
            let target = translate::article_target(store, id)?;
            let mut v = store.get_article(id, &target.key()).map_err(err)?.ok_or_else(|| format!("no article {id}"))?;
            summarize::mark_stale(store, &mut v)?;
            let a = &v.article;
            let mut text = format!("# {}\n<{}>\n", a.title.as_deref().unwrap_or(&a.original_url), a.original_url);
            if let Some(s) = &v.summary {
                text += &format!("\n{}\n", s.text);
            }
            let mut json = json!({ "article": a, "summary": v.summary });
            if blocks {
                json["blocks"] = v
                    .blocks
                    .iter()
                    .map(|b| {
                        let mut o = json!({ "id": b.id, "kind": b.block.kind.as_str(), "text": b.block.text });
                        if translation {
                            o["translation"] = json!(b.translation);
                        }
                        o
                    })
                    .collect();
            } else {
                json["text"] = json!(joined(&v.blocks, source));
                if translation {
                    json["translation_language"] = json!(v.target_language);
                    json["translation"] = json!(joined(&v.blocks, translated));
                }
            }
            let pick = if translation {
                translated
            } else {
                source
            };
            text += &if blocks {
                format!("\n{}\n", lines(&v.blocks, |b| format!("[block {}] {}: {}", b.id, b.block.kind.as_str(), pick(b))))
            } else {
                format!("\n{}\n", joined(&v.blocks, pick))
            };
            Ok(Out { json, text })
        }
        Op::List { scope, limit } => {
            let rows = match parse_scope(store, scope.as_deref())? {
                Scope::Article { id } => vec![article(store, id)?],
                Scope::Articles { ids } => ids.into_iter().map(|id| article(store, id)).collect::<Result<_, _>>()?,
                Scope::Filter { filter } => store.list_articles_sorted(&filter, ArticleSort::SavedDesc).map_err(err)?,
            };
            let total = rows.len();
            let rows = &rows[..total.min(limit)];
            let text = format!("{}\n({} of {total}; * unread)", lines(rows, row_line), rows.len());
            Ok(Out { json: json!({ "total": total, "articles": rows }), text })
        }
        Op::Summary { id } => {
            let mut v = store.get_article(id, "ja").map_err(err)?.ok_or_else(|| format!("no article {id}"))?;
            summarize::mark_stale(store, &mut v)?;
            let text = v.summary.as_ref().map_or("(no summary yet)".to_string(), |s| s.text.clone());
            Ok(Out { json: json!({ "article_id": id, "title": v.article.title, "url": v.article.original_url, "summary": v.summary }), text })
        }
        Op::Tags {} => {
            let tags = store.list_tags().map_err(err)?;
            Ok(Out { text: lines(&tags, |t| format!("{}\t{}", t.name, t.count)), json: json!(tags) })
        }
        Op::Genres {} => {
            let genres = classify::list_genres(store)?;
            Ok(Out { text: lines(&genres, |t| format!("{}\t{}", t.name, t.count)), json: json!(genres) })
        }
        Op::Feeds {} => {
            let feeds = feeds::list(store)?;
            let text = lines(&feeds, |f| {
                let folder = f.folder.as_ref().map(|n| format!("  [{n}]")).unwrap_or_default();
                format!("{:>4}  {}  <{}>  {} articles{folder}", f.id, f.custom_title.as_ref().or(f.title.as_ref()).unwrap_or(&f.url), f.url, f.article_count)
            });
            Ok(Out { json: json!(feeds), text })
        }
        Op::Collections {} => {
            let groups = groups::list(store)?;
            Ok(Out { text: lines(&groups, |g| format!("{:>4}  {}  {} articles", g.id, g.name, g.count)), json: json!(groups) })
        }
        Op::Jobs {} => {
            let o = job_status::overview(store)?;
            let mut text = lines(&o.counts, |c| format!("{}\t{}\t{}", c.job_type, c.state, c.count));
            if text.is_empty() {
                text = "(no queued or failed jobs)".into();
            }
            text += &lines(&o.issues, |i| format!("\n{} #{} ({}): {}", i.job_type, i.id, i.status, i.last_error.as_deref().unwrap_or("")));
            Ok(Out { json: json!(o), text })
        }
        Op::Ask { question, scope } => {
            let mut m = chat::ask(store, &ctx.providers.llm, &ctx.providers.embedder, None, &question, parse_scope(store, scope.as_deref())?).await?;
            if m.mode == "none" {
                m.answer = NO_SOURCES.into();
            }
            let cites = lines(&m.citations, |c| format!("[{}] {} <{}>", c.n, c.title, c.url));
            Ok(Out { text: format!("{}\n\n{cites}", m.answer).trim_end().to_string(), json: json!(m) })
        }
        Op::Save { url, run } => {
            let url = url.trim().to_string();
            let norm = normalize(&url).map_err(|e| format!("not a URL to save: {e}"))?;
            let queued = ingest::enqueue_urls(store, std::slice::from_ref(&url))?.queued == 1;
            let id = store.find_article_by_url(norm.as_str()).map_err(err)?.ok_or("the article was not saved")?;
            let ran = if run {
                // Embedding runs here only if the app has already downloaded the model.
                let types: Vec<&str> = NET_JOBS
                    .iter()
                    .chain(if ctx.providers.embedder.is_downloaded() {
                        LOCAL_JOBS
                    } else {
                        &[]
                    })
                    .copied()
                    .collect();
                jobs::run_article(store, &ctx.providers, &types, id, &|_| {}).await?
            } else {
                0
            };
            let a = article(store, id)?;
            let state = match (queued, run) {
                (false, _) => "already saved",
                (true, false) => "queued: the app fetches it within 30 seconds while it runs (or use --run)",
                (true, true) => "fetched here",
            };
            let text = format!("{}\n{state} ({})", row_line(&a), a.fetch_status);
            Ok(Out { json: json!({ "article_id": id, "queued": queued, "jobs_run": ran, "article": a }), text })
        }
        Op::Tag { id, name } => {
            article(store, id)?;
            store.add_tag(id, name.trim()).map_err(err)?;
            let a = article(store, id)?;
            Ok(Out { text: format!("{}\ntags: {}", row_line(&a), a.tags.join(", ")), json: json!({ "article_id": id, "tags": a.tags }) })
        }
        Op::Read { id } => {
            article(store, id)?;
            store.set_read_status(id, true).map_err(err)?;
            let a = article(store, id)?;
            Ok(Out { text: row_line(&a), json: json!({ "article_id": id, "read_status": a.read_status }) })
        }
        Op::Favorite { id } => {
            article(store, id)?;
            store.set_favorite(id, true).map_err(err)?;
            let a = article(store, id)?;
            Ok(Out { text: format!("{}\nfavorite", row_line(&a)), json: json!({ "article_id": id, "favorite": a.favorite }) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty in-memory library with no LLM or embedding model behind it.
    fn ctx() -> Ctx {
        let store = Store::open_in_memory().unwrap();
        let llm = LlmChain::new(lattice_core::chain::load(&store).unwrap());
        let embedder = LocalE5::offline(std::env::temp_dir().join("lattice-cli-test-models"));
        Ctx { store, providers: Providers { llm, embedder, http: lattice_core::fetch::client() }, allow_write: true }
    }

    #[test]
    fn scopes_parse_into_the_apps_filters() {
        let s = Store::open_in_memory().unwrap();
        let f = |scope| match parse_scope(&s, Some(scope)).unwrap() {
            Scope::Filter { filter } => filter,
            other => panic!("{other:?}"),
        };
        assert_eq!(parse_scope(&s, None).unwrap(), Scope::Filter { filter: ArticleFilter::All });
        assert_eq!(f("unread"), ArticleFilter::Unread);
        assert_eq!(f("tag:db:mvcc"), ArticleFilter::Tag { name: "db:mvcc".into() }, "only the first colon splits");
        assert_eq!(f("genre:データベース"), ArticleFilter::Genre { name: Some("データベース".into()) });
        assert_eq!(f("genre:none"), ArticleFilter::Genre { name: None });
        assert_eq!(f("feed:3"), ArticleFilter::Feed { id: Some(3) });
        assert_eq!(f("feed:none"), ArticleFilter::Feed { id: None });
        assert_eq!(f("collection:4"), ArticleFilter::Group { id: 4 });
        assert_eq!(f("group:4"), ArticleFilter::Group { id: 4 }, "the older name still works");
        assert_eq!(f("folder:5"), ArticleFilter::Folder { id: 5 });
        assert_eq!(f("important"), ArticleFilter::Important { min: 4 });
        relevance::set_threshold(&s, 3).unwrap();
        assert_eq!(f("important"), ArticleFilter::Important { min: 3 }, "the app's threshold");
        assert_eq!(f("important:5"), ArticleFilter::Important { min: 5 });
        assert_eq!(parse_scope(&s, Some("article:7")).unwrap(), Scope::Article { id: 7 });
        assert_eq!(parse_scope(&s, Some("article:7,3")).unwrap(), Scope::Articles { ids: vec![7, 3] });
        for bad in [
            "tag:",
            "feed:x",
            "folder:",
            "folder:x",
            "group:",
            "group:x",
            "collection:x",
            "important:9",
            "article:",
            "article:7,",
            "article:7,x",
            "starred",
            "unread:1",
        ] {
            assert!(parse_scope(&s, Some(bad)).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn lists_collections_and_prints_blocks_with_ids() {
        let ctx = ctx();
        let s = &ctx.store;
        let (id, _) = s.upsert_pending("https://example.com/a", "https://example.com/a", "example.com").unwrap();
        let html = "<html><head><title>A</title></head><body><article><h2>Why</h2><p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. This sentence pads the paragraph so readability keeps it.</p></article></body></html>";
        ingest::store_fetched(
            s,
            id,
            &lattice_core::fetch::Fetched { final_url: "https://example.com/a".into(), status: 200, content_type: None, html: html.into() },
        )
        .unwrap();
        let g = groups::create(s, "Reading").unwrap();
        groups::add(s, g, &[id]).unwrap();

        let out = run(&ctx, Op::Collections {}).await.unwrap();
        assert_eq!(out.text, format!("{g:>4}  Reading  1 articles"));
        assert_eq!(out.json[0]["id"], g);
        let listed = run(&ctx, Op::List { scope: Some(format!("collection:{g}")), limit: 10 }).await.unwrap();
        assert_eq!(listed.json["total"], 1);

        let out = run(&ctx, Op::Get { id, blocks: true, translation: false }).await.unwrap();
        let first = out.json["blocks"][0]["id"].as_i64().unwrap();
        assert!(out.text.contains(&format!("[block {first}] heading: Why")), "{}", out.text);
        assert!(!run(&ctx, Op::Get { id, blocks: false, translation: false }).await.unwrap().text.contains("[block "));
    }

    #[test]
    fn mcp_calls_and_arguments_parse_into_the_same_ops() {
        let op: Op = serde_json::from_value(json!({ "name": "search", "arguments": { "query": "wal" } })).unwrap();
        assert!(matches!(op, Op::Search { ref query, scope: None, limit: SEARCH_LIMIT } if query == "wal"));
        let op: Op = serde_json::from_value(json!({ "name": "tags", "arguments": {} })).unwrap();
        assert!(matches!(op, Op::Tags {}) && !op.is_write());
        let op: Op = serde_json::from_value(json!({ "name": "save", "arguments": { "url": "https://example.com" } })).unwrap();
        assert!(op.is_write());
        assert!(serde_json::from_value::<Op>(json!({ "name": "get", "arguments": {} })).is_err(), "id is required");
        assert!(serde_json::from_value::<Op>(json!({ "name": "delete", "arguments": { "id": 1 } })).is_err());
    }
}
