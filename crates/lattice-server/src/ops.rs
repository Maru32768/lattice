//! The operations the CLI and the MCP server share. `Op` is parsed from command-line arguments
//! (clap) and from MCP tool calls (serde, `{"name": ..., "arguments": {...}}`) alike, and every
//! operation answers with JSON plus a plain-text rendering of the same result.

use std::sync::Arc;

use clap::Subcommand;
use lattice_core::chain::LlmChain;
use lattice_core::chat::{self, Scope};
use lattice_core::embed::LocalE5;
use lattice_core::ir::BlockKind;
use lattice_core::jobs::{self, LOCAL_JOBS, NET_JOBS, Providers};
use lattice_core::mcp::Role;
use lattice_core::mobile::Effects;
use lattice_core::msg;
use lattice_core::store::{ArticleFilter, ArticleRow, ArticleSort, Store, StoredBlock};
use lattice_core::url_norm::normalize;
use lattice_core::{classify, feed_folders, feeds, groups, ingest, job_status, relevance, search, summarize, translate};
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
#[serde(tag = "name", content = "arguments", rename_all = "snake_case", deny_unknown_fields)]
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
    /// Remove a tag from an article (needs --allow-write)
    Untag { id: i64, name: String },
    /// Mark an article as unread (needs --allow-write)
    Unread { id: i64 },
    /// Take an article out of the favorites (needs --allow-write)
    Unfavorite { id: i64 },
    /// Give an article your own title; an empty one goes back to the title Lattice found (needs --allow-write)
    RenameArticle { id: i64, title: String },
    /// Put an article in a genre, which auto-classification does not overwrite; an empty name takes it out (needs --allow-write)
    SetGenre { id: i64, name: String },
    /// Add a genre that classification may choose (needs --allow-write)
    AddGenre { name: String },
    /// Rename a genre; merge-genre merges it into one that exists (needs --allow-write)
    RenameGenre { from: String, to: String },
    /// Delete a genre that no article is in (needs --allow-write)
    DeleteGenre { name: String },
    /// Create a collection (needs --allow-write)
    CreateCollection { name: String },
    /// Rename a collection (needs --allow-write)
    RenameCollection { id: i64, name: String },
    /// Add an article to a collection (needs --allow-write)
    Collect { collection: i64, article: i64 },
    /// Take an article out of a collection (needs --allow-write)
    Uncollect { collection: i64, article: i64 },
    /// Subscribe to an RSS or Atom feed, fetching it once to check it (needs --allow-write)
    AddFeed {
        url: String,
        /// Put it in the folder with this name, created if missing
        #[arg(long)]
        #[serde(default)]
        folder: Option<String>,
    },
    /// Give a feed your own name; without one it goes back to the feed's own title (needs --allow-write)
    RenameFeed {
        id: i64,
        #[serde(default)]
        name: Option<String>,
    },
    /// Move a feed into the folder with this name, created if missing; without one, out of any folder (needs --allow-write)
    MoveFeed {
        id: i64,
        #[serde(default)]
        folder: Option<String>,
    },
    /// Rename a feed folder (needs --allow-write)
    RenameFolder { id: i64, name: String },
    /// Delete an article with its summary, translation, note and quiz (needs --allow-delete)
    DeleteArticle { id: i64 },
    /// Delete a collection; its articles stay (needs --allow-delete)
    DeleteCollection { id: i64 },
    /// Unsubscribe from a feed; its articles stay (needs --allow-delete)
    RemoveFeed { id: i64 },
    /// Delete a feed folder; its feeds stay, in no folder (needs --allow-delete)
    DeleteFolder { id: i64 },
    /// Merge a genre into another: its articles move there and it is deleted (needs --allow-delete)
    MergeGenre { from: String, into: String },
}

impl Op {
    /// The least role that may run this operation.
    pub fn role(&self) -> Role {
        match self {
            Op::Search { .. }
            | Op::Get { .. }
            | Op::List { .. }
            | Op::Summary { .. }
            | Op::Tags {}
            | Op::Genres {}
            | Op::Feeds {}
            | Op::Collections {}
            | Op::Jobs {}
            | Op::Ask { .. } => Role::Read,
            Op::Save { .. }
            | Op::Tag { .. }
            | Op::Read { .. }
            | Op::Favorite { .. }
            | Op::Untag { .. }
            | Op::Unread { .. }
            | Op::Unfavorite { .. }
            | Op::RenameArticle { .. }
            | Op::SetGenre { .. }
            | Op::AddGenre { .. }
            | Op::RenameGenre { .. }
            | Op::DeleteGenre { .. }
            | Op::CreateCollection { .. }
            | Op::RenameCollection { .. }
            | Op::Collect { .. }
            | Op::Uncollect { .. }
            | Op::AddFeed { .. }
            | Op::RenameFeed { .. }
            | Op::MoveFeed { .. }
            | Op::RenameFolder { .. } => Role::Edit,
            Op::DeleteArticle { .. } | Op::DeleteCollection { .. } | Op::RemoveFeed { .. } | Op::DeleteFolder { .. } | Op::MergeGenre { .. } => Role::Delete,
        }
    }

    /// What a running app has to show or start after this operation ran. Exhaustive like `role`: a new operation does
    /// not compile until it says.
    pub fn effects(&self) -> Effects {
        let article = |id: i64| Effects { article: Some(id), ..Effects::default() };
        // `article-changed` with no article of that id still reloads every list.
        let lists = Effects { article: Some(0), ..Effects::default() };
        let feeds = Effects { feeds: true, ..lists };
        match self {
            Op::Search { .. }
            | Op::Get { .. }
            | Op::List { .. }
            | Op::Summary { .. }
            | Op::Tags {}
            | Op::Genres {}
            | Op::Feeds {}
            | Op::Collections {}
            | Op::Jobs {}
            | Op::Ask { .. } => Effects::default(),
            Op::Tag { id, .. }
            | Op::Untag { id, .. }
            | Op::Read { id }
            | Op::Unread { id }
            | Op::Favorite { id }
            | Op::Unfavorite { id }
            | Op::RenameArticle { id, .. }
            | Op::SetGenre { id, .. }
            | Op::DeleteArticle { id }
            | Op::Collect { article: id, .. }
            | Op::Uncollect { article: id, .. } => article(*id),
            Op::AddGenre { .. }
            | Op::RenameGenre { .. }
            | Op::DeleteGenre { .. }
            | Op::MergeGenre { .. }
            | Op::CreateCollection { .. }
            | Op::RenameCollection { .. }
            | Op::DeleteCollection { .. } => lists,
            Op::Save { .. } => Effects { fetch: true, ..lists },
            Op::AddFeed { .. } => Effects { fetch: true, ..feeds },
            Op::RenameFeed { .. } | Op::MoveFeed { .. } | Op::RenameFolder { .. } | Op::RemoveFeed { .. } | Op::DeleteFolder { .. } => feeds,
        }
    }
}

pub struct Ctx {
    pub store: Arc<Store>,
    pub providers: Arc<Providers<LlmChain, LocalE5>>,
    pub role: Role,
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

fn tags_out(store: &Store, id: i64) -> Result<Out, String> {
    let a = article(store, id)?;
    Ok(Out { text: format!("{}\ntags: {}", row_line(&a), a.tags.join(", ")), json: json!({ "article_id": id, "tags": a.tags }) })
}

fn read_out(store: &Store, id: i64, read: bool) -> Result<Out, String> {
    store.set_read_status(id, read).map_err(err)?;
    let a = article(store, id)?;
    Ok(Out { text: row_line(&a), json: json!({ "article_id": id, "read_status": a.read_status }) })
}

fn favorite_out(store: &Store, id: i64, favorite: bool) -> Result<Out, String> {
    store.set_favorite(id, favorite).map_err(err)?;
    let a = article(store, id)?;
    let mark = if a.favorite {
        "favorite"
    } else {
        "not a favorite"
    };
    Ok(Out { text: format!("{}\n{mark}", row_line(&a)), json: json!({ "article_id": id, "favorite": a.favorite }) })
}

fn genres_out(store: &Store) -> Result<Out, String> {
    let genres = classify::list_genres(store)?;
    Ok(Out { text: lines(&genres, |t| format!("{}\t{}", t.name, t.count)), json: json!(genres) })
}

fn collections_out(store: &Store) -> Result<Out, String> {
    let groups = groups::list(store)?;
    Ok(Out { text: lines(&groups, |g| format!("{:>4}  {}  {} articles", g.id, g.name, g.count)), json: json!(groups) })
}

fn collection(store: &Store, id: i64) -> Result<groups::GroupRow, String> {
    groups::list(store)?.into_iter().find(|g| g.id == id).ok_or_else(|| msg!("groups.notFound"))
}

fn feed_line(f: &feeds::FeedRow) -> String {
    let folder = f.folder.as_ref().map(|n| format!("  [{n}]")).unwrap_or_default();
    format!("{:>4}  {}  <{}>  {} articles{folder}", f.id, f.custom_title.as_ref().or(f.title.as_ref()).unwrap_or(&f.url), f.url, f.article_count)
}

fn feed(store: &Store, id: i64) -> Result<feeds::FeedRow, String> {
    feeds::list(store)?.into_iter().find(|f| f.id == id).ok_or_else(|| msg!("feeds.gone"))
}

fn feed_out(store: &Store, id: i64) -> Result<Out, String> {
    let f = feed(store, id)?;
    Ok(Out { text: feed_line(&f), json: json!(f) })
}

fn folders_out(store: &Store) -> Result<Out, String> {
    let folders = feed_folders::list(store)?;
    Ok(Out { text: lines(&folders, |f| format!("{:>4}  {}  {} feeds", f.id, f.name, f.feeds)), json: json!(folders) })
}

fn folder(store: &Store, id: i64) -> Result<feed_folders::FolderRow, String> {
    feed_folders::list(store)?.into_iter().find(|f| f.id == id).ok_or_else(|| msg!("feedFolders.notFound"))
}

pub async fn run(ctx: &Ctx, op: Op) -> Result<Out, String> {
    if op.role() > ctx.role {
        return Err(match op.role() {
            Role::Delete => "this command deletes from the library: pass --allow-delete",
            Role::Read | Role::Edit => "this command changes the library: pass --allow-write or set LATTICE_ALLOW_WRITE=1",
        }
        .into());
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
        Op::Genres {} => genres_out(store),
        Op::Feeds {} => {
            let feeds = feeds::list(store)?;
            Ok(Out { text: lines(&feeds, feed_line), json: json!(feeds) })
        }
        Op::Collections {} => collections_out(store),
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
            let mut m = chat::ask(store, &ctx.providers.llm, None, &ctx.providers.embedder, None, &question, parse_scope(store, scope.as_deref())?).await?;
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
                jobs::with_keep_alive(store, jobs::run_article(store, &ctx.providers, &types, id, &|_| {})).await?
            } else {
                0
            };
            let a = article(store, id)?;
            // --run finds nothing to run when the running app's runner claimed the job first.
            let state = match (queued, ran > 0) {
                (false, _) => "already saved",
                (true, true) => "fetched here",
                (true, false) if run => "queued: the running app took it first",
                (true, false) => "queued: the app fetches it within 30 seconds while it runs (or use --run)",
            };
            let text = format!("{}\n{state} ({})", row_line(&a), a.fetch_status);
            Ok(Out { json: json!({ "article_id": id, "queued": queued, "jobs_run": ran, "article": a }), text })
        }
        Op::Tag { id, name } => {
            article(store, id)?;
            store.add_tag(id, name.trim()).map_err(err)?;
            tags_out(store, id)
        }
        Op::Untag { id, name } => {
            store.remove_tag(id, &name).map_err(err)?;
            tags_out(store, id)
        }
        Op::Read { id } => read_out(store, id, true),
        Op::Unread { id } => read_out(store, id, false),
        Op::Favorite { id } => favorite_out(store, id, true),
        Op::Unfavorite { id } => favorite_out(store, id, false),
        Op::RenameArticle { id, title } => {
            store.set_title(id, &title).map_err(err)?;
            let a = article(store, id)?;
            Ok(Out { text: row_line(&a), json: json!({ "article_id": id, "title": a.title, "auto_title": a.auto_title }) })
        }
        Op::SetGenre { id, name } => {
            article(store, id)?;
            classify::set_genre(store, id, &name)?;
            let a = article(store, id)?;
            Ok(Out {
                text: format!("{}\ngenre: {}", row_line(&a), a.genre.as_deref().unwrap_or("(none)")),
                json: json!({ "article_id": id, "genre": a.genre }),
            })
        }
        Op::AddGenre { name } => {
            classify::add_genre(store, &name)?;
            genres_out(store)
        }
        Op::RenameGenre { from, to } => {
            classify::rename_genre(store, &from, &to, false)?;
            genres_out(store)
        }
        Op::DeleteGenre { name } => {
            classify::delete_genre(store, &name)?;
            genres_out(store)
        }
        Op::CreateCollection { name } => {
            let id = groups::create(store, &name)?;
            let g = collection(store, id)?;
            Ok(Out { text: format!("{:>4}  {}", g.id, g.name), json: json!(g) })
        }
        Op::RenameCollection { id, name } => {
            groups::rename(store, id, &name)?;
            collections_out(store)
        }
        Op::Collect { collection: id, article: a } => {
            article(store, a)?;
            groups::add(store, id, &[a])?;
            collections_out(store)
        }
        Op::Uncollect { collection: id, article: a } => {
            collection(store, id)?;
            article(store, a)?;
            groups::remove(store, id, &[a])?;
            collections_out(store)
        }
        Op::AddFeed { url, folder } => {
            // Checked first: refused after subscribing, the call would fail with the feed added.
            folder.as_deref().map(feed_folders::clean).transpose()?;
            let id = feeds::subscribe(store, &ctx.providers.http, &url, None).await?;
            if let Some(name) = folder {
                feed_folders::move_feeds(store, &[id], Some(feed_folders::find_or_create(store, &name)?))?;
            }
            feed_out(store, id)
        }
        Op::RenameFeed { id, name } => {
            feeds::rename(store, id, name.as_deref())?;
            feed_out(store, id)
        }
        Op::MoveFeed { id, folder } => {
            feed(store, id)?;
            let to = folder.map(|name| feed_folders::find_or_create(store, &name)).transpose()?;
            feed_folders::move_feeds(store, &[id], to)?;
            feed_out(store, id)
        }
        Op::RenameFolder { id, name } => {
            feed_folders::rename(store, id, &name)?;
            folders_out(store)
        }
        Op::DeleteArticle { id } => {
            let a = article(store, id)?;
            store.delete_article(id).map_err(err)?;
            Ok(Out { text: format!("deleted {}", row_line(&a)), json: json!({ "article_id": id, "deleted": true }) })
        }
        Op::DeleteCollection { id } => {
            collection(store, id)?;
            groups::delete(store, id)?;
            collections_out(store)
        }
        Op::RemoveFeed { id } => {
            let f = feed(store, id)?;
            feeds::remove(store, id)?;
            Ok(Out { text: format!("removed {}", feed_line(&f)), json: json!({ "feed_id": id, "removed": true }) })
        }
        Op::DeleteFolder { id } => {
            folder(store, id)?;
            feed_folders::delete(store, id)?;
            folders_out(store)
        }
        Op::MergeGenre { from, into } => {
            classify::merge_genre(store, &from, &into)?;
            genres_out(store)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// An empty in-memory library with no LLM or embedding model behind it.
    pub(crate) fn ctx() -> Ctx {
        let store = Store::open_in_memory().unwrap();
        let llm = LlmChain::new(lattice_core::chain::load(&store).unwrap());
        let embedder = LocalE5::offline(std::env::temp_dir().join("lattice-cli-test-models"));
        Ctx { store: Arc::new(store), providers: Arc::new(Providers { llm, embedder, http: lattice_core::fetch::client() }), role: Role::Edit }
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

    /// An article Lattice fetched, titled `title`.
    fn saved(s: &Store, url: &str, title: &str) -> i64 {
        let (id, _) = s.upsert_pending(url, url, "example.com").unwrap();
        let html = format!(
            "<html><head><title>{title}</title></head><body><article><p>Snapshot isolation permits write skew, which serializable snapshot isolation prevents at commit time. This sentence pads the paragraph so readability keeps it.</p></article></body></html>"
        );
        ingest::store_fetched(s, id, &lattice_core::fetch::Fetched { final_url: url.into(), status: 200, content_type: None, html }).unwrap();
        id
    }

    fn reads(id: i64) -> Vec<Op> {
        vec![
            Op::Search { query: "wal".into(), scope: None, limit: 1 },
            Op::Get { id, blocks: false, translation: false },
            Op::List { scope: None, limit: 10 },
            Op::Summary { id },
            Op::Tags {},
            Op::Genres {},
            Op::Feeds {},
            Op::Collections {},
            Op::Jobs {},
            Op::Ask { question: "What is MVCC?".into(), scope: Some("tag:nothing".into()) },
        ]
    }

    /// Every edit-role change, aimed at article `id` and at collection, feed and folder 1.
    fn edits(id: i64) -> Vec<Op> {
        vec![
            Op::Save { url: "https://example.com/b".into(), run: false },
            Op::Tag { id, name: "later".into() },
            Op::Untag { id, name: "later".into() },
            Op::Read { id },
            Op::Unread { id },
            Op::Favorite { id },
            Op::Unfavorite { id },
            Op::RenameArticle { id, title: "Mine".into() },
            Op::SetGenre { id, name: "Databases".into() },
            Op::AddGenre { name: "Networking".into() },
            Op::RenameGenre { from: "Databases".into(), to: "Storage".into() },
            Op::DeleteGenre { name: "Databases".into() },
            Op::CreateCollection { name: "Reading".into() },
            Op::RenameCollection { id: 1, name: "Later".into() },
            Op::Collect { collection: 1, article: id },
            Op::Uncollect { collection: 1, article: id },
            Op::AddFeed { url: "http://127.0.0.1:9/feed.xml".into(), folder: None },
            Op::RenameFeed { id: 1, name: Some("Mine".into()) },
            Op::MoveFeed { id: 1, folder: Some("Tech".into()) },
            Op::RenameFolder { id: 1, name: "News".into() },
        ]
    }

    fn deletions(id: i64) -> Vec<Op> {
        vec![
            Op::DeleteArticle { id },
            Op::DeleteCollection { id: 1 },
            Op::RemoveFeed { id: 1 },
            Op::DeleteFolder { id: 1 },
            Op::MergeGenre { from: "Databases".into(), into: "Storage".into() },
        ]
    }

    /// What the refused calls must leave as it was.
    fn library(s: &Store) -> Value {
        let articles: Vec<Value> = s
            .list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc)
            .unwrap()
            .iter()
            .map(|a| json!([a.id, a.title, a.read_status, a.favorite, a.tags, a.genre]))
            .collect();
        json!({
            "articles": articles,
            "genres": classify::list_genres(s).unwrap(),
            "collections": groups::list(s).unwrap(),
            "feeds": feeds::list(s).unwrap(),
            "folders": feed_folders::list(s).unwrap(),
        })
    }

    #[test]
    fn every_op_is_a_read_an_edit_or_a_deletion_and_is_tried_below() {
        let ops = Op::augment_subcommands(clap::Command::new("lattice-cli")).get_subcommands().count();
        assert_eq!(reads(1).len() + edits(1).len() + deletions(1).len(), ops);
        assert!(reads(1).iter().all(|op| op.role() == Role::Read));
        assert!(edits(1).iter().all(|op| op.role() == Role::Edit));
        assert!(deletions(1).iter().all(|op| op.role() == Role::Delete));
    }

    #[tokio::test]
    async fn the_read_role_runs_every_read_and_refuses_every_change() {
        let ctx = Ctx { role: Role::Read, ..ctx() };
        let id = saved(&ctx.store, "https://example.com/a", "A");
        let before = library(&ctx.store);
        for op in edits(id).into_iter().chain(deletions(id)) {
            let name = format!("{op:?}");
            assert!(run(&ctx, op).await.is_err_and(|e| e.contains("pass --allow-")), "{name}");
        }
        assert_eq!(library(&ctx.store), before, "nothing changed");
        for op in reads(id) {
            let name = format!("{op:?}");
            run(&ctx, op).await.unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[tokio::test]
    async fn the_edit_role_refuses_every_deletion() {
        let ctx = ctx();
        let s = &ctx.store;
        let id = saved(s, "https://example.com/a", "A");
        classify::set_genre(s, id, "Databases").unwrap();
        classify::add_genre(s, "Storage").unwrap();
        groups::create(s, "Reading").unwrap();
        feeds::add(s, "https://example.com/feed.xml", Some(feed_folders::create(s, "Tech").unwrap())).unwrap();
        let before = library(s);
        for op in deletions(id) {
            let name = format!("{op:?}");
            assert!(run(&ctx, op).await.is_err_and(|e| e.contains("--allow-delete")), "{name}");
        }
        assert_eq!(library(s), before, "nothing deleted");
    }

    #[tokio::test]
    async fn an_article_change_can_be_undone() {
        let ctx = ctx();
        let id = saved(&ctx.store, "https://example.com/a", "Found title");
        let before = library(&ctx.store);
        run(&ctx, Op::Tag { id, name: "later".into() }).await.unwrap();
        run(&ctx, Op::Read { id }).await.unwrap();
        run(&ctx, Op::Favorite { id }).await.unwrap();
        run(&ctx, Op::RenameArticle { id, title: "Mine".into() }).await.unwrap();
        run(&ctx, Op::SetGenre { id, name: "Databases".into() }).await.unwrap();
        let changed = article(&ctx.store, id).unwrap();
        assert_eq!(
            (changed.tags.clone(), changed.read_status.as_str(), changed.favorite, changed.title.as_deref(), changed.genre.as_deref(), changed.genre_manual),
            (vec!["later".to_string()], "read", true, Some("Mine"), Some("Databases"), true)
        );
        run(&ctx, Op::Untag { id, name: "later".into() }).await.unwrap();
        run(&ctx, Op::Unread { id }).await.unwrap();
        run(&ctx, Op::Unfavorite { id }).await.unwrap();
        run(&ctx, Op::RenameArticle { id, title: String::new() }).await.unwrap();
        run(&ctx, Op::SetGenre { id, name: String::new() }).await.unwrap();
        run(&ctx, Op::DeleteGenre { name: "Databases".into() }).await.unwrap();
        assert!(run(&ctx, Op::SetGenre { id: id + 1, name: "Ghost".into() }).await.is_err(), "no such article, and no genre made for it");
        assert_eq!(library(&ctx.store), before, "back as it was");
        assert!(run(&ctx, Op::Unread { id: id + 1 }).await.is_err(), "no such article");
    }

    #[tokio::test]
    async fn genres_are_added_renamed_and_deleted_but_merged_only_on_purpose() {
        let ctx = Ctx { role: Role::Delete, ..ctx() };
        let s = &ctx.store;
        let id = saved(s, "https://example.com/a", "A");
        let count = |name: &str| classify::list_genres(s).unwrap().into_iter().find(|g| g.name == name).map(|g| g.count);
        run(&ctx, Op::AddGenre { name: "Networking".into() }).await.unwrap();
        run(&ctx, Op::SetGenre { id, name: "Databases".into() }).await.unwrap();
        run(&ctx, Op::RenameGenre { from: "Networking".into(), to: "Net".into() }).await.unwrap();
        assert_eq!((count("Networking"), count("Net")), (None, Some(0)));
        assert!(run(&ctx, Op::RenameGenre { from: "Databases".into(), to: "net".into() }).await.is_err(), "rename does not merge");
        assert!(run(&ctx, Op::DeleteGenre { name: "Databases".into() }).await.is_err(), "an article is in it");
        assert!(run(&ctx, Op::MergeGenre { from: "Databases".into(), into: "Storage".into() }).await.is_err(), "no genre to merge into");
        assert!(run(&ctx, Op::MergeGenre { from: "Nope".into(), into: "Net".into() }).await.is_err(), "no genre to merge away");
        assert_eq!((count("Databases"), count("Net"), count("Storage")), (Some(1), Some(0), None), "nothing moved");
        run(&ctx, Op::AddGenre { name: "Storage Engines".into() }).await.unwrap();
        run(&ctx, Op::MergeGenre { from: "Databases".into(), into: " storage   engines ".into() }).await.unwrap();
        assert_eq!((count("Databases"), count("Storage Engines")), (None, Some(1)), "the name is read as rename_genre reads it");
        run(&ctx, Op::MergeGenre { from: "Storage Engines".into(), into: "net".into() }).await.unwrap();
        assert_eq!((count("Storage Engines"), count("Net")), (None, Some(1)));
        run(&ctx, Op::MergeGenre { from: "Net".into(), into: "net".into() }).await.unwrap();
        assert_eq!(count("Net"), Some(1), "merged into itself, it stays");
        assert_eq!(article(s, id).unwrap().genre.as_deref(), Some("Net"));
        run(&ctx, Op::SetGenre { id, name: String::new() }).await.unwrap();
        run(&ctx, Op::DeleteGenre { name: "Net".into() }).await.unwrap();
        assert_eq!(count("Net"), None);
    }

    #[tokio::test]
    async fn collections_are_managed_by_id() {
        let ctx = Ctx { role: Role::Delete, ..ctx() };
        let s = &ctx.store;
        // Saved first so that the article and collection ids differ: a swap of the two would not show otherwise.
        saved(s, "https://example.com/first", "First");
        let id = saved(s, "https://example.com/a", "A");
        let g = run(&ctx, Op::CreateCollection { name: "Reading".into() }).await.unwrap().json["id"].as_i64().unwrap();
        run(&ctx, Op::RenameCollection { id: g, name: "Later".into() }).await.unwrap();
        run(&ctx, Op::Collect { collection: g, article: id }).await.unwrap();
        let rows = groups::list(s).unwrap();
        assert_eq!((rows[0].name.as_str(), rows[0].count), ("Later", 1));
        assert!(run(&ctx, Op::Collect { collection: g, article: id + 1 }).await.is_err(), "no such article");
        assert!(run(&ctx, Op::Collect { collection: g + 1, article: id }).await.is_err(), "no such collection");
        assert!(run(&ctx, Op::Uncollect { collection: g + 1, article: id }).await.is_err(), "no such collection");
        assert!(run(&ctx, Op::Uncollect { collection: g, article: id + 1 }).await.is_err(), "no such article");
        run(&ctx, Op::Uncollect { collection: g, article: id }).await.unwrap();
        assert_eq!(groups::list(s).unwrap()[0].count, 0);
        run(&ctx, Op::Collect { collection: g, article: id }).await.unwrap();
        run(&ctx, Op::DeleteCollection { id: g }).await.unwrap();
        assert!(groups::list(s).unwrap().is_empty());
        assert_eq!(s.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).unwrap().len(), 2, "every article stays, the collected one too");
        assert!(run(&ctx, Op::DeleteCollection { id: g }).await.is_err(), "already gone");
    }

    #[tokio::test]
    async fn a_feed_goes_into_a_folder_by_name_and_a_refused_name_adds_nothing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://localhost:{}/feed.xml", listener.local_addr().unwrap().port());
        let feed = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title><link>https://example.com/</link></channel></rss>"#;
        let app = axum::Router::new().route("/feed.xml", axum::routing::get(move || async move { ([("content-type", "application/rss+xml")], feed) }));
        tokio::spawn(async move { axum::serve(listener, app).await });
        let mut ctx = ctx();
        let local = lattice_core::network::NetworkSettings { allow: vec!["localhost".into()], ..Default::default() };
        Arc::get_mut(&mut ctx.providers).unwrap().http = lattice_core::fetch::HttpClient::configured(&local).unwrap();
        let s = &ctx.store;
        // Made first so that the feed and folder ids differ: a swap of the two would not show otherwise.
        feed_folders::create(s, "Other").unwrap();
        assert!(run(&ctx, Op::AddFeed { url: url.clone(), folder: Some(" ".into()) }).await.is_err(), "no folder has an empty name");
        assert!(feeds::list(s).unwrap().is_empty(), "the refused call subscribed to nothing");
        run(&ctx, Op::AddFeed { url, folder: Some("Tech".into()) }).await.unwrap();
        let row = feeds::list(s).unwrap().remove(0);
        assert_eq!((row.title.as_deref(), row.folder.as_deref()), (Some("Local"), Some("Tech")));
    }

    #[tokio::test]
    async fn feeds_and_folders_are_managed_by_id() {
        let ctx = Ctx { role: Role::Delete, ..ctx() };
        let s = &ctx.store;
        assert!(run(&ctx, Op::AddFeed { url: "http://127.0.0.1:9/feed.xml".into(), folder: Some("Tech".into()) }).await.is_err());
        assert!(feeds::list(s).unwrap().is_empty() && feed_folders::list(s).unwrap().is_empty(), "a feed that does not load is not kept");
        // Made first so that the feed and folder ids differ: a swap of the two would not show otherwise.
        feed_folders::create(s, "Other").unwrap();
        let (f, _) = feeds::add(s, "https://example.com/feed.xml", None).unwrap();
        let shown = || {
            let row = feeds::list(s).unwrap().remove(0);
            (row.custom_title, row.folder)
        };
        run(&ctx, Op::RenameFeed { id: f, name: Some("Mine".into()) }).await.unwrap();
        run(&ctx, Op::MoveFeed { id: f, folder: Some("Tech".into()) }).await.unwrap();
        assert_eq!(shown(), (Some("Mine".into()), Some("Tech".into())), "the folder was made");
        let folder = feed_folders::list(s).unwrap().into_iter().find(|d| d.name == "Tech").unwrap().id;
        run(&ctx, Op::RenameFolder { id: folder, name: "News".into() }).await.unwrap();
        run(&ctx, Op::RenameFeed { id: f, name: None }).await.unwrap();
        assert_eq!(shown(), (None, Some("News".into())));
        run(&ctx, Op::MoveFeed { id: f, folder: None }).await.unwrap();
        assert_eq!(shown(), (None, None));
        assert!(run(&ctx, Op::MoveFeed { id: f + 1, folder: Some("Ghost".into()) }).await.is_err(), "no such feed, and no folder made for it");
        run(&ctx, Op::MoveFeed { id: f, folder: Some("news".into()) }).await.unwrap();
        assert_eq!(feed_folders::list(s).unwrap().len(), 2, "an existing folder, found without regard to case");
        run(&ctx, Op::DeleteFolder { id: folder }).await.unwrap();
        assert_eq!(shown(), (None, None), "the feed stays, in no folder");
        run(&ctx, Op::RemoveFeed { id: f }).await.unwrap();
        assert!(feeds::list(s).unwrap().is_empty());
        assert!(run(&ctx, Op::RemoveFeed { id: f }).await.is_err(), "already gone");
        assert!(run(&ctx, Op::DeleteFolder { id: folder }).await.is_err(), "already gone");
    }

    #[tokio::test]
    async fn deleting_an_article_removes_it() {
        let ctx = Ctx { role: Role::Delete, ..ctx() };
        let id = saved(&ctx.store, "https://example.com/a", "A");
        let other = saved(&ctx.store, "https://example.com/b", "B");
        run(&ctx, Op::DeleteArticle { id }).await.unwrap();
        let left: Vec<i64> = ctx.store.list_articles_sorted(&ArticleFilter::All, ArticleSort::SavedDesc).unwrap().iter().map(|a| a.id).collect();
        assert_eq!(left, [other]);
        assert!(run(&ctx, Op::DeleteArticle { id }).await.is_err(), "already gone");
    }

    #[test]
    fn only_a_change_has_anything_to_show_the_app() {
        for op in reads(7) {
            assert_eq!(op.effects(), Effects::default(), "{op:?}");
        }
        // The article itself, every list (an id no article has), and whether fetchers or the feed screen must hear.
        let (one, lists, feeds) = ((7, false, false), (0, false, false), (0, false, true));
        let expected = [
            (0, true, false),
            one,
            one,
            one,
            one,
            one,
            one,
            one,
            one,
            lists,
            lists,
            lists,
            lists,
            lists,
            one,
            one,
            (0, true, true),
            feeds,
            feeds,
            feeds,
            one,
            lists,
            feeds,
            feeds,
            lists,
        ];
        let ops: Vec<Op> = edits(7).into_iter().chain(deletions(7)).collect();
        assert_eq!(ops.len(), expected.len());
        for (op, (article, fetch, feeds)) in ops.iter().zip(expected) {
            assert_eq!(op.effects(), Effects { article: Some(article), fetch, feeds, ..Effects::default() }, "{op:?}");
        }
    }

    #[test]
    fn mcp_calls_and_arguments_parse_into_the_same_ops() {
        let op: Op = serde_json::from_value(json!({ "name": "search", "arguments": { "query": "wal" } })).unwrap();
        assert!(matches!(op, Op::Search { ref query, scope: None, limit: SEARCH_LIMIT } if query == "wal"));
        let op: Op = serde_json::from_value(json!({ "name": "tags", "arguments": {} })).unwrap();
        assert!(matches!(op, Op::Tags {}) && op.role() == Role::Read);
        let op: Op = serde_json::from_value(json!({ "name": "save", "arguments": { "url": "https://example.com" } })).unwrap();
        assert_eq!(op.role(), Role::Edit);
        assert!(serde_json::from_value::<Op>(json!({ "name": "get", "arguments": {} })).is_err(), "id is required");
        assert!(serde_json::from_value::<Op>(json!({ "name": "delete", "arguments": { "id": 1 } })).is_err());
    }
}
