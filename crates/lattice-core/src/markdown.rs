//! Markdown (a file the user picked, or pasted text) -> Article IR. Imported Markdown has no
//! URL: its identity is `local:md/<sha256 of the text>`, so importing the same text again finds
//! the same article. Raw HTML inside it is dropped like any untrusted markup.

use std::path::Path;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use url::Url;

use crate::extract::{collapse, inline_text, push_text, trim_inlines};
use crate::fetch::Fetched;
use crate::images;
use crate::ir::{ArticleIr, ArticleMeta, Block, BlockAttrs, BlockKind, Inline};
use crate::msg;
use crate::store::{Store, sha256_hex};

/// `original_url` and `normalized_url` of every imported Markdown article.
pub const URL_PREFIX: &str = "local:md/";
/// The snapshot holds the Markdown source, for re-extraction.
pub const CONTENT_TYPE: &str = "text/markdown";
/// A larger "Markdown" file is almost certainly something else.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn is_local(url: &str) -> bool {
    url.starts_with(URL_PREFIX)
}

/// Imports Markdown as an article and returns its id; the same text again returns the existing
/// one. `name` (the file name without extension) is the title when there is no H1. `dir`, the
/// folder of a file the user picked, is where relative image paths are read from.
pub fn import(store: &Store, md: &str, name: Option<&str>, dir: Option<&Path>) -> Result<i64, String> {
    let md = md.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let md = md.trim();
    let ir = to_ir(md, name)?;
    let url = format!("{URL_PREFIX}{}", sha256_hex(md));
    let (id, needs_work) = store.upsert_pending(&url, &url, "").map_err(err)?;
    if !needs_work {
        return Ok(id);
    }
    let source = Fetched { final_url: url, status: 200, content_type: Some(CONTENT_TYPE.into()), html: md.to_string() };
    store.save_fetched(id, Some(&source), Ok(ir.clone()), None).map_err(err)?;
    if let Some(dir) = dir {
        store_local_images(store, id, dir, &ir)?;
    }
    images::enqueue(store, id)?;
    Ok(id)
}

/// Converts the stored source again (no file access: local images were stored on import).
pub fn reextract(store: &Store, id: i64, md: &str) -> Result<i64, String> {
    let title = store.article_row(id).map_err(err)?.and_then(|a| a.title);
    store.save_fetched(id, None, to_ir(md, title.as_deref()), None).map_err(err)?;
    images::enqueue(store, id)?;
    Ok(id)
}

/// Title: the first H1 (dropped from the body when it opens the document), else `fallback`,
/// else the first line of text.
pub fn to_ir(md: &str, fallback: Option<&str>) -> Result<ArticleIr, String> {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut c = Conv::default();
    for event in Parser::new_ext(md, opts) {
        c.event(event);
    }
    c.flush();
    if c.blocks.is_empty() {
        return Err(msg!("markdown.empty"));
    }
    let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let first_line = || c.blocks.iter().find(|b| !b.text.is_empty()).map(|b| b.text.chars().take(80).collect::<String>());
    let title = c.title.clone().or_else(|| fallback.and_then(non_empty)).or_else(first_line);
    Ok(ArticleIr { meta: ArticleMeta { title, ..Default::default() }, blocks: c.blocks })
}

#[derive(Default)]
struct Conv {
    blocks: Vec<Block>,
    inlines: Vec<Inline>,
    /// Open lists, innermost last: whether each is ordered.
    lists: Vec<bool>,
    quotes: usize,
    heading: Option<u8>,
    /// (lang, text) of the open code block.
    code: Option<(Option<String>, String)>,
    table: Option<Vec<Vec<String>>>,
    cell: Option<String>,
    /// (href, text) of the open link.
    link: Option<(String, String)>,
    /// (src, alt) of the open image.
    image: Option<(String, String)>,
    /// Inside raw HTML or front matter, whose text is dropped.
    skip: usize,
    title: Option<String>,
}

impl Conv {
    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => self.text(&t),
            Event::Code(t) => match (&mut self.image, &mut self.link, &mut self.cell) {
                (Some((_, s)), _, _) | (None, Some((_, s)), _) | (None, None, Some(s)) => s.push_str(&t),
                _ => {
                    let v = collapse(&t).trim().to_string();
                    if !v.is_empty() {
                        self.inlines.push(Inline::Code { v });
                    }
                }
            },
            // A soft break inside Japanese text is not a word gap.
            Event::SoftBreak if self.last_char().is_some_and(joins_without_space) => {}
            Event::SoftBreak | Event::HardBreak => self.text(" "),
            // Only the tags of inline HTML are dropped by default; the text inside script/style is code, not prose.
            Event::InlineHtml(h) => match script_tag(&h) {
                Some(true) => self.skip += 1,
                Some(false) => self.skip = self.skip.saturating_sub(1),
                None => {}
            },
            Event::TaskListMarker(done) => self.text(if done { "☑ " } else { "☐ " }),
            Event::Rule => self.flush(),
            // Raw HTML (and math or footnote syntax, not enabled) never reaches the IR.
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::HtmlBlock | Tag::MetadataBlock(_) => self.skip += 1,
            Tag::Heading { level, .. } => {
                self.flush();
                self.heading = Some(level as u8);
            }
            Tag::BlockQuote(_) => {
                self.flush();
                self.quotes += 1;
            }
            Tag::List(start) => {
                self.flush();
                self.lists.push(start.is_some());
            }
            Tag::Item | Tag::FootnoteDefinition(_) => self.flush(),
            Tag::CodeBlock(kind) => {
                self.flush();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(str::to_string),
                    CodeBlockKind::Indented => None,
                };
                self.code = Some((lang, String::new()));
            }
            Tag::Table(_) => {
                self.flush();
                self.table = Some(Vec::new());
            }
            Tag::TableHead | Tag::TableRow => {
                if let Some(t) = &mut self.table {
                    t.push(Vec::new());
                }
            }
            Tag::TableCell => self.cell = Some(String::new()),
            Tag::Link { dest_url, .. } => self.link = Some((dest_url.to_string(), String::new())),
            Tag::Image { dest_url, .. } => self.image = Some((dest_url.to_string(), String::new())),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::HtmlBlock | TagEnd::MetadataBlock(_) => self.skip = self.skip.saturating_sub(1),
            TagEnd::Heading(level) => {
                let mut inlines = std::mem::take(&mut self.inlines);
                trim_inlines(&mut inlines);
                let text: String = inlines.iter().map(inline_text).collect();
                self.heading = None;
                if level as u8 == 1 && self.title.is_none() && !text.is_empty() {
                    self.title = Some(text);
                    if self.blocks.is_empty() {
                        return; // the document's title, shown above the body
                    }
                }
                self.push(BlockKind::Heading, inlines, BlockAttrs { level: Some(level as u8), ..Default::default() });
            }
            TagEnd::Paragraph | TagEnd::Item | TagEnd::FootnoteDefinition => self.flush(),
            TagEnd::BlockQuote(_) => {
                self.flush();
                self.quotes = self.quotes.saturating_sub(1);
            }
            TagEnd::List(_) => {
                self.flush();
                self.lists.pop();
            }
            TagEnd::CodeBlock => {
                if let Some((lang, text)) = self.code.take() {
                    let text = text.trim_end().trim_start_matches('\n').to_string();
                    if !text.is_empty() {
                        self.blocks.push(Block { kind: BlockKind::Code, text, inlines: Vec::new(), attrs: BlockAttrs { lang, ..Default::default() } });
                    }
                }
            }
            TagEnd::TableCell => {
                if let (Some(cell), Some(row)) = (self.cell.take(), self.table.as_mut().and_then(|t| t.last_mut())) {
                    row.push(collapse(&cell).trim().to_string());
                }
            }
            TagEnd::Table => {
                let rows: Vec<Vec<String>> = self.table.take().unwrap_or_default().into_iter().filter(|r| !r.is_empty()).collect();
                if !rows.is_empty() {
                    let text = rows.iter().map(|r| r.join("\t")).collect::<Vec<_>>().join("\n");
                    self.blocks.push(Block { kind: BlockKind::Table, text, inlines: Vec::new(), attrs: BlockAttrs { rows: Some(rows), ..Default::default() } });
                }
            }
            TagEnd::Link => {
                let Some((href, text)) = self.link.take() else { return };
                let v = collapse(&text).trim().to_string();
                match &mut self.cell {
                    Some(cell) => cell.push_str(&text),
                    None if is_http(&href) && !v.is_empty() => self.inlines.push(Inline::Link { v, href }),
                    None => push_text(&mut self.inlines, &text),
                }
            }
            TagEnd::Image => {
                let Some((src, alt)) = self.image.take() else { return };
                let alt = collapse(&alt).trim().to_string();
                if self.cell.is_some() || self.heading.is_some() {
                    self.text(&alt);
                    return;
                }
                let src = image_src(&src);
                if src.is_none() && alt.is_empty() {
                    return;
                }
                self.flush();
                self.blocks.push(Block { kind: BlockKind::Image, text: alt, inlines: Vec::new(), attrs: BlockAttrs { src, ..Default::default() } });
            }
            _ => {}
        }
    }

    fn last_char(&self) -> Option<char> {
        match (&self.image, &self.code, &self.link, &self.cell) {
            (Some((_, t)), ..) | (None, Some((_, t)), ..) | (None, None, Some((_, t)), _) | (None, None, None, Some(t)) => t.chars().last(),
            _ => self.inlines.last().and_then(|i| inline_text(i).chars().last()),
        }
    }

    fn text(&mut self, s: &str) {
        if self.skip > 0 {
            return;
        }
        match (&mut self.image, &mut self.code, &mut self.link, &mut self.cell) {
            (Some((_, t)), ..) | (None, Some((_, t)), ..) | (None, None, Some((_, t)), _) | (None, None, None, Some(t)) => t.push_str(s),
            _ => push_text(&mut self.inlines, s),
        }
    }

    /// Ends the open run of text as a block of the kind its container gives it.
    fn flush(&mut self) {
        let inlines = std::mem::take(&mut self.inlines);
        let (kind, attrs) = match self.lists.last() {
            Some(&ordered) => {
                let depth = u8::try_from(self.lists.len() - 1).unwrap_or(u8::MAX);
                (BlockKind::ListItem, BlockAttrs { ordered: Some(ordered), depth: Some(depth), ..Default::default() })
            }
            None if self.quotes > 0 => (BlockKind::Blockquote, BlockAttrs::default()),
            None => (BlockKind::Paragraph, BlockAttrs::default()),
        };
        self.push(kind, inlines, attrs);
    }

    fn push(&mut self, kind: BlockKind, mut inlines: Vec<Inline>, attrs: BlockAttrs) {
        trim_inlines(&mut inlines);
        let text: String = inlines.iter().map(inline_text).collect();
        if !text.is_empty() {
            self.blocks.push(Block { kind, text, inlines, attrs });
        }
    }
}

fn is_http(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("https://") || u.starts_with("http://")
}

/// Remote images are downloaded like any article's; a relative path is kept to be read from the
/// picked file's folder. Anything else (`data:`, `file:`, absolute paths) keeps only its alt text.
fn image_src(src: &str) -> Option<String> {
    let src = src.trim();
    let relative = matches!(Url::parse(src), Err(url::ParseError::RelativeUrlWithoutBase)) && !src.starts_with(['/', '\\']);
    (is_http(src) || relative && !src.is_empty() && src.len() <= 2048).then(|| src.to_string())
}

/// Stores the images whose relative path resolves inside `dir` (never outside it) and that are
/// raster images within the size limits. The rest keep their alt text.
fn store_local_images(store: &Store, id: i64, dir: &Path, ir: &ArticleIr) -> Result<(), String> {
    let settings = images::settings(store)?;
    let Ok(base) = Url::from_directory_path(dir) else { return Ok(()) };
    if !settings.save {
        return Ok(());
    }
    let cap = u64::from(settings.max_mb) * 1024 * 1024;
    let mut used = 0;
    for src in ir.blocks.iter().filter_map(|b| b.attrs.src.as_deref()).filter(|s| !is_http(s)) {
        let Some(path) = base.join(src).ok().and_then(|u| u.to_file_path().ok()).filter(|p| p.starts_with(dir)) else { continue };
        if std::fs::metadata(&path).map_or(true, |m| !m.is_file() || m.len() > cap) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Some(mime) = images::sniff(&bytes) else { continue };
        if used + bytes.len() > images::ARTICLE_CAP {
            break;
        }
        used += bytes.len();
        images::save(store, id, src, mime, &bytes)?;
    }
    Ok(())
}

/// Japanese text and its full-width punctuation run on across a line break.
pub(crate) fn joins_without_space(c: char) -> bool {
    crate::segments::is_cjk(c) || matches!(c, '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FFEF}')
}

/// `<script …>` / `<style …>` → Some(true), their closing tags → Some(false), anything else → None.
fn script_tag(html: &str) -> Option<bool> {
    let t = html.trim().to_ascii_lowercase();
    let (close, rest) = match t.strip_prefix("</") {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('<')?),
    };
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    let self_closing = !close && t.ends_with("/>");
    (matches!(name.as_str(), "script" | "style") && !self_closing).then_some(!close)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "---\ntitle: front matter is not text\n---\n\n# Notes on WAL\n\n\
The write-ahead log (`WAL`) guarantees *durability*. See [the docs](https://www.postgresql.org/docs/) \
and [a sibling](./other.md).\nSecond line <b>bold</b>.\n\n\
<div onclick=\"x()\">raw html block</div>\n\n\
## How it works\n\n\
1. First\n   - nested one\n   - [x] done task\n2. Second\n\n\
> Quoted line.\n\n\
```sql extra\nSELECT 1;\n```\n\n\
| a | b |\n|---|---|\n| `x` | [y](https://y.dev) |\n\n\
![Remote](https://cdn.example.com/a.png)\n\n![Local *one*](img/a%20b.png)\n\n![](data:image/png;base64,AAAA)\n\n![Inline](data:image/png;base64,AAAA)\n\n\
# Second H1\n";

    fn kinds(ir: &ArticleIr) -> Vec<(&str, &str)> {
        ir.blocks.iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect()
    }

    #[test]
    fn converts_markdown_to_blocks() {
        let ir = to_ir(DOC, Some("file-name")).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("Notes on WAL"));
        assert_eq!(
            kinds(&ir),
            [
                ("paragraph", "The write-ahead log (WAL) guarantees durability. See the docs and a sibling. Second line bold."),
                ("heading", "How it works"),
                ("list_item", "First"),
                ("list_item", "nested one"),
                ("list_item", "☑ done task"),
                ("list_item", "Second"),
                ("blockquote", "Quoted line."),
                ("code", "SELECT 1;"),
                ("table", "a\tb\nx\ty"),
                ("image", "Remote"),
                ("image", "Local one"),
                ("image", "Inline"),
                ("heading", "Second H1"),
            ]
        );
        let p = &ir.blocks[0];
        assert!(p.inlines.contains(&Inline::Code { v: "WAL".into() }));
        assert!(p.inlines.contains(&Inline::Link { v: "the docs".into(), href: "https://www.postgresql.org/docs/".into() }));
        assert!(!p.inlines.iter().any(|i| matches!(i, Inline::Link { href, .. } if href.contains("other.md"))), "relative links become text");
        let attrs: Vec<_> = ir.blocks.iter().map(|b| (b.attrs.depth, b.attrs.ordered)).filter(|a| a.0.is_some()).collect();
        assert_eq!(attrs, [(Some(0), Some(true)), (Some(1), Some(false)), (Some(1), Some(false)), (Some(0), Some(true))]);
        assert_eq!(ir.blocks[7].attrs.lang.as_deref(), Some("sql"));
        assert_eq!(ir.blocks[8].attrs.rows, Some(vec![vec!["a".into(), "b".into()], vec!["x".into(), "y".into()]]));
        let srcs: Vec<_> = ir.blocks.iter().filter(|b| b.kind == BlockKind::Image).map(|b| b.attrs.src.as_deref()).collect();
        assert_eq!(srcs, [Some("https://cdn.example.com/a.png"), Some("img/a%20b.png"), None], "data: keeps only its alt");
        assert_eq!(ir.blocks[12].attrs.level, Some(1), "a later H1 stays in the body");
    }

    #[test]
    fn joins_japanese_lines_and_drops_inline_script_text() {
        let ir = to_ir(
            "日本語の文が
改行で続く。
English line
next.

Hello <script>alert(1)</script>world <STYLE>p{}</style>end
",
            None,
        )
        .unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "日本語の文が改行で続く。English line next."), ("paragraph", "Hello world end")]);
    }

    #[test]
    fn title_falls_back_to_name_then_first_line() {
        let body = "Just a paragraph that opens the note.\n\nMore.";
        assert_eq!(to_ir(body, Some(" my-note ")).unwrap().meta.title.as_deref(), Some("my-note"));
        assert_eq!(to_ir(body, None).unwrap().meta.title.as_deref(), Some("Just a paragraph that opens the note."));
        assert!(to_ir("<p>only html</p>\n", None).is_err());
    }

    #[test]
    fn imports_once_per_text_and_reextracts_in_place() {
        let s = Store::open_in_memory().unwrap();
        let body = "Intro paragraph.\n\n## Part\n\nBody text.\n";
        let id = import(&s, body, Some("note"), None).unwrap();
        assert_eq!(import(&s, &format!("\u{feff}{}\n\n", body.replace('\n', "\r\n")), None, None).unwrap(), id, "same text, same article");
        let a = s.article_row(id).unwrap().unwrap();
        assert!(is_local(&a.original_url) && a.domain.is_empty());
        assert_eq!((a.title.as_deref(), a.extraction_status.as_str(), a.thin), (Some("note"), "ok", false), "a short note is not a thin page");
        let ids: Vec<i64> = s.get_article(id, "ja").unwrap().unwrap().blocks.iter().map(|b| b.id).collect();
        assert_eq!(crate::ingest::reextract(&s, id).unwrap(), id);
        let v = s.get_article(id, "ja").unwrap().unwrap();
        assert_eq!(v.blocks.iter().map(|b| b.id).collect::<Vec<_>>(), ids, "re-extraction converts the stored Markdown");
        assert_eq!(v.article.title.as_deref(), Some("note"), "the file name title survives re-extraction");
    }

    #[test]
    fn reads_relative_images_only_inside_the_picked_folder() {
        const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        let root = std::env::temp_dir().join(format!("lattice-md-{}", std::process::id()));
        let dir = root.join("notes");
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("img").join("a b.png"), PNG).unwrap();
        std::fs::write(dir.join("fake.png"), b"<svg>not raster</svg>").unwrap();
        std::fs::write(root.join("outside.png"), PNG).unwrap();
        let s = Store::open_in_memory().unwrap();
        let md = "Text.\n\n![in](img/a%20b.png)\n\n![out](../outside.png)\n\n![svg](fake.png)\n\n![gone](missing.png)\n";
        let id = import(&s, md, None, Some(&dir)).unwrap();
        let blocks = s.get_article(id, "ja").unwrap().unwrap().blocks;
        let stored: Vec<bool> = blocks.iter().filter(|b| b.block.kind == BlockKind::Image).map(|b| images::data_url(&s, b.id).unwrap().is_some()).collect();
        assert_eq!(stored, [true, false, false, false]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
