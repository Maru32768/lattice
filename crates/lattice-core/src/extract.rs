//! HTML -> Article IR. Readability (dom_smoothie) removes boilerplate, then we
//! segment its cleaned HTML into blocks. Raw HTML never reaches the UI.

use dom_query::{Document, NodeRef, Selection};
use dom_smoothie::{Config, Readability};
use url::Url;

use crate::ir::{ArticleIr, ArticleMeta, Block, BlockAttrs, BlockKind, Inline};

/// Bump when segmentation output changes: the articles an older version read are re-extracted from their
/// stored pages (`ingest::REEXTRACT_JOB`). 3: images inside paragraphs and links. 4: a `<sup>` of digits in superscript.
pub const EXTRACTION_VERSION: i64 = 4;

/// Asides inside the article body: boxed sidebars and footnotes that belong to the text.
const BODY_ASIDES: &str = "article aside, main aside, [role=main] aside, [itemprop=articleBody] aside";

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("readability failed: {0}")]
    Readability(String),
    #[error("no readable content")]
    Empty,
}

pub fn extract(html: &str, url: &str) -> Result<ArticleIr, ExtractError> {
    let base = Url::parse(url).map_err(|e| ExtractError::Readability(e.to_string()))?;
    let cfg = Config { keep_classes: true, ..Default::default() };
    let mut r = Readability::new(html, Some(url), Some(cfg)).map_err(|e| ExtractError::Readability(e.to_string()))?;
    cut_deep(&r.doc);
    // Read before parse(): parse() mutates the document.
    let canonical = r.doc.select(r#"link[rel="canonical"]"#).attr("href").and_then(|h| http_url(&base, &h));
    // Readability drops every <aside>, and anything classed like "sidebar", as boilerplate; inside
    // the article body they are content, so they become plain <div>s first. Code keeps its
    // classes (they carry the language).
    let asides = r.doc.select(BODY_ASIDES);
    for node in asides.select(":not(pre):not(code)").nodes() {
        node.remove_attrs(&["class", "id"]);
    }
    for aside in asides.nodes() {
        aside.rename("div");
        aside.remove_attrs(&["class", "id", "role"]);
    }
    let a = r.parse().map_err(|e| ExtractError::Readability(e.to_string()))?;

    let content = Document::from(a.content.as_ref());
    let mut w = Walker { base, blocks: Vec::new(), para: Vec::new() };
    w.walk(&content.root());
    w.flush();
    if w.blocks.is_empty() {
        return Err(ExtractError::Empty);
    }
    let non_empty = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(ArticleIr {
        meta: ArticleMeta {
            title: non_empty(Some(a.title)),
            author: non_empty(a.byline),
            site_name: non_empty(a.site_name),
            published_at: non_empty(a.published_time),
            language: non_empty(a.lang),
            canonical_url: canonical,
        },
        blocks: w.blocks,
    })
}

/// Only http(s) links survive; `javascript:` etc. are untrusted-input hazards.
fn http_url(base: &Url, href: &str) -> Option<String> {
    let u = base.join(href.trim()).ok()?;
    matches!(u.scheme(), "http" | "https").then(|| u.to_string())
}

const INLINE: &[&str] = &[
    "a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup",
    "time", "u", "var", "br", "wbr",
];
const SKIP: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "button", "form", "input", "select", "textarea", "iframe", "object", "embed", "nav", "footer", "aside",
    "head",
];

/// Nesting beyond this is cut off before Readability: it and the walker recurse per level, so a
/// 20 MB page of unclosed tags would overflow the stack (and Readability goes quadratic first).
const MAX_DEPTH: usize = 256;

fn cut_deep(doc: &Document) {
    let mut stack = vec![(doc.root(), 0)];
    while let Some((node, depth)) = stack.pop() {
        for child in node.children() {
            if depth < MAX_DEPTH {
                stack.push((child, depth + 1));
            } else {
                child.remove_from_parent();
            }
        }
    }
}

struct Walker {
    base: Url,
    blocks: Vec<Block>,
    /// Loose inline content that appears directly inside a container (no <p>).
    para: Vec<Inline>,
}

impl Walker {
    fn walk(&mut self, node: &NodeRef) {
        for child in node.children() {
            if child.is_text() {
                push_text(&mut self.para, &child.text());
                continue;
            }
            let Some(name) = child.node_name() else {
                continue;
            };
            let name = name.as_ref();
            if INLINE.contains(&name) {
                self.inline_into_para(&child);
                continue;
            }
            if SKIP.contains(&name) {
                continue;
            }
            self.flush();
            match name {
                "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    let level = name[1..].parse().ok();
                    self.prose(BlockKind::Heading, &child, BlockAttrs { level, ..Default::default() });
                }
                "p" => self.prose(BlockKind::Paragraph, &child, BlockAttrs::default()),
                "blockquote" => self.prose(BlockKind::Blockquote, &child, BlockAttrs::default()),
                "figcaption" => self.prose(BlockKind::Caption, &child, BlockAttrs::default()),
                "pre" => self.code(&child),
                "ul" | "ol" => self.list(&child, name == "ol", 0),
                "table" => self.table(&child),
                "img" => self.image(&child),
                "hr" => {}
                _ => self.walk(&child), // div, section, figure, article, details, ...
            }
        }
    }

    fn inline_into_para(&mut self, node: &NodeRef) {
        let mut para = std::mem::take(&mut self.para);
        collect_inline(&self.base, node, &mut para);
        self.para = para;
        if !Selection::from(*node).select("img").nodes().is_empty() {
            self.flush();
            self.inner_images(node);
        }
    }

    fn flush(&mut self) {
        let inlines = std::mem::take(&mut self.para);
        self.push_prose(BlockKind::Paragraph, inlines, BlockAttrs::default());
    }

    fn prose(&mut self, kind: BlockKind, node: &NodeRef, attrs: BlockAttrs) {
        let mut inlines = Vec::new();
        collect_children(&self.base, node, &mut inlines);
        self.push_prose(kind, inlines, attrs);
        self.inner_images(node);
    }

    /// Images inside prose (`<p><img></p>`, `<a><img></a>`): the inline collectors keep text only, so these
    /// follow the block as image blocks. Nested lists are skipped: `list` emits them, images included.
    fn inner_images(&mut self, node: &NodeRef) {
        for child in node.children() {
            let Some(name) = child.node_name() else {
                continue;
            };
            match name.as_ref() {
                "img" => self.image(&child),
                "ul" | "ol" => {}
                n if SKIP.contains(&n) => {}
                _ => self.inner_images(&child),
            }
        }
    }

    fn push_prose(&mut self, kind: BlockKind, mut inlines: Vec<Inline>, attrs: BlockAttrs) {
        trim_inlines(&mut inlines);
        let text: String = inlines.iter().map(inline_text).collect();
        if !text.is_empty() {
            self.blocks.push(Block { kind, text, inlines, attrs });
        }
    }

    fn code(&mut self, pre: &NodeRef) {
        let text = pre.text().trim_end().trim_start_matches('\n').to_string();
        if text.is_empty() {
            return;
        }
        // `language-rust` / `lang-rust` on <pre> or its <code>.
        let classes = Selection::from(*pre).select("code").attr("class").or_else(|| pre.attr("class")).unwrap_or_default();
        let lang = classes.split_whitespace().find_map(|c| c.strip_prefix("language-").or_else(|| c.strip_prefix("lang-"))).map(str::to_string);
        self.blocks.push(Block { kind: BlockKind::Code, text, inlines: Vec::new(), attrs: BlockAttrs { lang, ..Default::default() } });
    }

    fn list(&mut self, list: &NodeRef, ordered: bool, depth: u8) {
        for li in list.element_children() {
            if !li.has_name("li") {
                continue;
            }
            let attrs = BlockAttrs { ordered: Some(ordered), depth: Some(depth), ..Default::default() };
            // shortcut: block content inside <li> (pre, blockquote) is flattened to inline text; split it out if real articles need it.
            self.prose(BlockKind::ListItem, &li, attrs);
            for sub in li.element_children() {
                if sub.has_name("ul") || sub.has_name("ol") {
                    self.list(&sub, sub.has_name("ol"), depth.saturating_add(1));
                }
            }
        }
    }

    fn table(&mut self, table: &NodeRef) {
        let rows: Vec<Vec<String>> = Selection::from(*table)
            .select("tr")
            .nodes()
            .iter()
            .map(|tr| Selection::from(*tr).select("th, td").nodes().iter().map(|c| collapse(&text_of(c)).trim().to_string()).collect())
            .filter(|r: &Vec<String>| !r.is_empty())
            .collect();
        if rows.is_empty() {
            return;
        }
        let text = rows.iter().map(|r| r.join("\t")).collect::<Vec<_>>().join("\n");
        self.blocks.push(Block { kind: BlockKind::Table, text, inlines: Vec::new(), attrs: BlockAttrs { rows: Some(rows), ..Default::default() } });
    }

    fn image(&mut self, img: &NodeRef) {
        let Some(src) = img.attr("src").and_then(|s| http_url(&self.base, &s)) else {
            return;
        };
        let alt = collapse(&img.attr("alt").unwrap_or_default()).trim().to_string();
        self.blocks.push(Block { kind: BlockKind::Image, text: alt, inlines: Vec::new(), attrs: BlockAttrs { src: Some(src), ..Default::default() } });
    }
}

fn collect_children(base: &Url, node: &NodeRef, out: &mut Vec<Inline>) {
    for child in node.children() {
        if child.is_text() {
            push_text(out, &child.text());
        } else if child.is_element() {
            collect_inline(base, &child, out);
        }
    }
}

fn collect_inline(base: &Url, node: &NodeRef, out: &mut Vec<Inline>) {
    let name = node.node_name().unwrap_or_default();
    match name.as_ref() {
        "code" | "kbd" | "samp" => {
            let v = collapse(&node.text()).trim().to_string();
            if !v.is_empty() {
                out.push(Inline::Code { v });
            }
        }
        "a" => {
            let v = collapse(&text_of(node)).trim().to_string();
            match node.attr("href").and_then(|h| http_url(base, &h)) {
                Some(href) if !v.is_empty() => out.push(Inline::Link { v, href }),
                _ => push_text(out, &v),
            }
        }
        "br" => push_text(out, " "),
        "sup" => superscript(base, node, out),
        "ul" | "ol" | "img" => {} // nested lists and images are emitted as their own blocks
        n if SKIP.contains(&n) => {}
        _ => collect_children(base, node, out),
    }
}

/// A `<sup>` of digits in superscript digits, as the page shows it: joined as they are, a footnote's number or an exponent
/// becomes one number with the digits before it (`2019.<sup>1</sup>` would read 2019.1, `10<sup>6</sup>` 106). Which of
/// the two it is takes no guess: `2019.¹`, `10⁶`. Anything else in it (`1<sup>st</sup>`, Wikipedia's `[1]`) stays as written.
fn superscript(base: &Url, node: &NodeRef, out: &mut Vec<Inline>) {
    let mut inner = Vec::new();
    collect_children(base, node, &mut inner);
    let raise = inner.iter().flat_map(|i| inline_text(i).chars()).all(raisable);
    let lift = |v: String| {
        if raise {
            raised(&v)
        } else {
            v
        }
    };
    for i in inner {
        match i {
            Inline::Text { v } => push_text(out, &lift(v)),
            Inline::Link { v, href } => out.push(Inline::Link { v: lift(v), href }),
            code @ Inline::Code { .. } => out.push(code),
        }
    }
}

/// `text()` with the `<sup>`s of digits raised as in prose: a link's text (Pandoc's footnotes are `<a><sup>1</sup></a>`)
/// and a table cell's.
fn text_of(node: &NodeRef) -> String {
    let mut out = String::new();
    for child in node.children() {
        if child.is_text() {
            out.push_str(&child.text());
        } else if child.has_name("sup") {
            let t = text_of(&child);
            out.push_str(&if t.chars().all(raisable) {
                raised(&t)
            } else {
                t
            });
        } else if child.is_element() {
            out.push_str(&text_of(&child));
        }
    }
    out
}

const PLAIN: &str = "0123456789+-\u{2212}=()";
pub(crate) const RAISED: &str = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾";

/// Digits and signs, and what separates footnote numbers (`1, 2`, `1–3`).
fn raisable(c: char) -> bool {
    PLAIN.contains(c) || c.is_whitespace() || matches!(c, ',' | '\u{2013}')
}

fn raised(s: &str) -> String {
    s.chars().map(|c| PLAIN.chars().zip(RAISED.chars()).find(|&(p, _)| p == c).map_or(c, |(_, r)| r)).collect()
}

pub(crate) fn collapse(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !ws {
                out.push(' ');
            }
            ws = true;
        } else {
            out.push(c);
            ws = false;
        }
    }
    out
}

pub(crate) fn push_text(out: &mut Vec<Inline>, s: &str) {
    let s = collapse(s);
    if s.is_empty() {
        return;
    }
    if let Some(Inline::Text { v }) = out.last_mut() {
        if v.ends_with(' ') && s.starts_with(' ') {
            v.push_str(&s[1..]);
        } else {
            v.push_str(&s);
        }
    } else {
        out.push(Inline::Text { v: s });
    }
}

pub(crate) fn trim_inlines(inlines: &mut Vec<Inline>) {
    if let Some(Inline::Text { v }) = inlines.first_mut() {
        *v = v.trim_start().to_string();
    }
    if let Some(Inline::Text { v }) = inlines.last_mut() {
        *v = v.trim_end().to_string();
    }
    inlines.retain(|i| !inline_text(i).is_empty());
}

pub(crate) fn inline_text(i: &Inline) -> &str {
    match i {
        Inline::Text { v } | Inline::Code { v } | Inline::Link { v, .. } => v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!doctype html><html lang="en"><head>
<title>Understanding WAL in PostgreSQL</title>
<link rel="canonical" href="/posts/wal?utm_source=x">
<meta name="author" content="Jane Doe">
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
<h1>Understanding WAL in PostgreSQL</h1>
<p>The write-ahead log (<code>WAL</code>) guarantees durability. See the
   <a href="https://www.postgresql.org/docs/current/wal-intro.html">official docs</a> for details.
   This paragraph is intentionally long enough for readability scoring to consider it real content.</p>
<h2>How it works</h2>
<p>Every change is first appended to the log, then applied to data pages later by the checkpointer.
   Long enough text to keep the readability heuristics happy, with a few commas, like this, and this.</p>
<ul><li>Durability<ul><li>fsync on commit</li></ul></li><li>Replication via <code>pg_basebackup</code></li></ul>
<pre><code class="language-sql">SELECT pg_current_wal_lsn();
</code></pre>
<blockquote><p>WAL is the source of truth.</p></blockquote>
<p><a href="javascript:alert(1)">evil</a> link should become text.</p>
</article>
<footer>Copyright 2026, all rights reserved, unrelated footer text.</footer>
</body></html>"#;

    /// Reduced from a Sphinx book page: a boxed sidebar inside the article body is content.
    const SIDEBAR: &str = r#"<!doctype html><html lang="en"><head><title>2.1 Technology</title></head><body>
<nav class="toc"><a href="/">Contents</a> <a href="/next.html">Next</a></nav>
<div role="main" class="document" itemscope="itemscope" itemtype="http://schema.org/Article"><div itemprop="articleBody">
<section id="technology"><h1>2.1 Technology</h1>
<p>The link layer is where nodes share a physical medium. This paragraph is long enough, with commas, clauses, and detail, to count as real content for readability.</p>
<p>This section introduces the problems addressed by the link layer, and uses Ethernet as its representative example, with plenty of words to score well.</p>
<aside class="sidebar">
<p class="sidebar-title">Ethernet Standards</p>
<p>When we say Ethernet we are really talking about a family of standards, tracing back to the first specification written by DEC, Intel, and Xerox.</p>
</aside>
<p>Encoding comes next, and it is just as important, because bits must be turned into signals that the receiver can decode reliably.</p>
<aside class="footnote brackets" id="id2" role="doc-footnote"><p>A footnote that belongs to the text.</p></aside>
</section></div></div>
<aside class="related"><p><a href="/other.html">Related posts</a> from elsewhere on the site.</p></aside>
<footer>Copyright notice and other unrelated footer text.</footer>
</body></html>"#;

    #[test]
    fn deeply_nested_pages_are_cut_off_instead_of_overflowing_the_stack() {
        let prose = "<p>A paragraph long enough for readability to keep, with commas, clauses, and detail about write-ahead logging.</p>".repeat(3);
        // 5000 overflowed a 2 MB test-thread stack before the cut; deeper takes html5ever quadratically longer to parse.
        let n = 5000;
        let html = format!("<html><body><article>{prose}{}<p>deep</p>{prose}</article></body></html>", "<div>".repeat(n));
        let ir = extract(&html, "https://example.com/deep").unwrap();
        assert!(ir.blocks.iter().any(|b| b.text.starts_with("A paragraph")));
        assert!(!ir.blocks.iter().any(|b| b.text == "deep"), "past the cap: cut off");
        let html = format!("<html><body><article>{prose}<p>{}deep</p></article></body></html>", "<span>".repeat(n));
        extract(&html, "https://example.com/deep-inline").unwrap();
    }

    #[test]
    fn keeps_images_inside_paragraphs_and_links() {
        let prose = "<p>A paragraph long enough for readability to keep, with commas, clauses, and detail about write-ahead logging.</p>".repeat(3);
        let html = format!(
            "<html><body><article>{prose}<p><img src=\"/blog/images/railways.jpg\" alt=\"\" /></p>{prose}<div><a href=\"/big.png\"><img src=\"small.png\" alt=\"Diagram\"></a> Figure 1</div>{prose}<ul><li>Item<ul><li><img src=\"/nested.png\"></li></ul></li></ul>{prose}</article></body></html>"
        );
        let ir = extract(&html, "https://brooker.co.za/blog/2026/03/25/ic-junior.html").unwrap();
        let images: Vec<_> =
            ir.blocks.iter().filter(|b| b.kind == BlockKind::Image).map(|b| (b.attrs.src.as_deref().unwrap_or_default(), b.text.as_str())).collect();
        assert_eq!(
            images,
            [
                ("https://brooker.co.za/blog/images/railways.jpg", ""),
                ("https://brooker.co.za/blog/2026/03/25/small.png", "Diagram"),
                ("https://brooker.co.za/nested.png", "")
            ]
        );
        assert!(ir.blocks.iter().any(|b| b.text == "Figure 1"), "text beside the linked image stays");
    }

    #[test]
    fn superscript_digits_stay_apart_from_the_digits_before_them() {
        let prose = "<p>A paragraph long enough for readability to keep, with commas, clauses, and detail about write-ahead logging.</p>".repeat(3);
        let html = format!(
            r##"<html><body><article>{prose}
<p>It started in 2019.<sup><a href="#fn1">1</a></sup> It now has 1,129<sup>2</sup> users<sup>3, 4</sup>, 2 of them<a href="#fn5"><sup>5</sup></a>.</p>
<p>About 10<sup>6</sup> requests, 2<sup>&minus;10</sup> of them slow, at 9.8 m/s<sup>2</sup>, from Na<sup>+</sup>.</p>
<p>On the 1<sup>st</sup> try, as Wikipedia says.<sup class="reference"><a href="#cite_note-3">[3]</a></sup> 約2千<sup>1</sup>人が参加した。</p>
<table><tr><th>Year</th><th>Users</th></tr><tr><td>2019</td><td>1,129<sup><a href="#t1">2</a></sup></td></tr></table>
{prose}</article></body></html>"##
        );
        let ir = extract(&html, "https://example.com/post").unwrap();
        let block = |prefix: &str| ir.blocks.iter().find(|b| b.text.starts_with(prefix)).unwrap_or_else(|| panic!("{prefix}: {:?}", ir.blocks));

        let footnotes = block("It started");
        assert_eq!(footnotes.text, "It started in 2019.¹ It now has 1,129² users³, ⁴, 2 of them⁵.");
        assert!(footnotes.inlines.contains(&Inline::Link { v: "¹".into(), href: "https://example.com/post#fn1".into() }), "{:?}", footnotes.inlines);
        assert!(footnotes.inlines.contains(&Inline::Link { v: "⁵".into(), href: "https://example.com/post#fn5".into() }), "Pandoc's footnote");
        assert_eq!(block("About").text, "About 10⁶ requests, 2⁻¹⁰ of them slow, at 9.8 m/s², from Na⁺.");
        assert_eq!(block("On the").text, "On the 1st try, as Wikipedia says.[3] 約2千¹人が参加した。", "letters and brackets stay as written");
        assert_eq!(block("Year").text, "Year\tUsers\n2019\t1,129²");

        let article = crate::numbers::Article::new(ir.blocks.iter().map(|b| b.text.as_str()));
        let flagged = crate::numbers::unverified("2019年に始まり、利用者は1,129人、約2千人が参加した", &article);
        assert!(flagged.is_empty(), "a summary that copies the numbers the footnotes follow: {flagged:?}");
    }

    #[test]
    fn keeps_asides_inside_the_article_body() {
        let ir = extract(SIDEBAR, "https://book.example/technology.html").unwrap();
        let texts: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
        let at = |prefix: &str| texts.iter().position(|t| t.starts_with(prefix)).unwrap_or_else(|| panic!("{prefix}: {texts:?}"));
        assert!(at("This section introduces") < at("Ethernet Standards"), "kept in place");
        assert!(at("When we say Ethernet") < at("Encoding comes next"));
        at("A footnote that belongs");
        assert!(!texts.iter().any(|t| t.contains("Related posts") || t.contains("Contents")), "asides outside the body stay out: {texts:?}");
    }

    #[test]
    fn segments_article_into_blocks() {
        let ir = extract(PAGE, "https://example.com/posts/wal").unwrap();
        assert_eq!(ir.meta.canonical_url.as_deref(), Some("https://example.com/posts/wal?utm_source=x"));
        assert_eq!(ir.meta.language.as_deref(), Some("en"));

        let kinds: Vec<_> = ir.blocks.iter().map(|b| b.kind.as_str()).collect();
        assert!(!ir.blocks.iter().any(|b| b.text.contains("Home") || b.text.contains("Copyright")), "{kinds:?}");

        let p = ir.blocks.iter().find(|b| b.text.starts_with("The write-ahead log")).unwrap();
        assert!(p.inlines.contains(&Inline::Code { v: "WAL".into() }));
        assert!(p.inlines.iter().any(|i| matches!(i, Inline::Link { href, .. } if href.starts_with("https://www.postgresql.org/"))));
        assert!(p.text.contains("(WAL) guarantees"), "{}", p.text);

        let h2 = ir.blocks.iter().find(|b| b.text == "How it works").unwrap();
        assert_eq!((h2.kind.as_str(), h2.attrs.level), ("heading", Some(2)));

        let items: Vec<_> = ir.blocks.iter().filter(|b| b.kind == BlockKind::ListItem).map(|b| (b.text.as_str(), b.attrs.depth)).collect();
        assert_eq!(items, [("Durability", Some(0)), ("fsync on commit", Some(1)), ("Replication via pg_basebackup", Some(0))]);

        let code = ir.blocks.iter().find(|b| b.kind == BlockKind::Code).unwrap();
        assert_eq!((code.text.as_str(), code.attrs.lang.as_deref()), ("SELECT pg_current_wal_lsn();", Some("sql")));

        assert!(ir.blocks.iter().any(|b| b.kind == BlockKind::Blockquote && b.text == "WAL is the source of truth."));
        let evil = ir.blocks.iter().find(|b| b.text.contains("evil")).unwrap();
        assert!(evil.inlines.iter().all(|i| matches!(i, Inline::Text { .. })));
    }
}
