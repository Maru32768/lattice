//! PDF (typically a research paper) -> Article IR. The original bytes are the snapshot, so
//! re-extraction needs no network. A PDF fetched from a URL is an ordinary article of that URL;
//! a file the user picked has none: its identity is `local:pdf/<sha256 of the bytes>`.
//!
//! pdf-extract reports each glyph with its position and size, and the layout is rebuilt here:
//! lines, two-column reading order, running headers and page numbers, title, headings,
//! paragraphs (with hyphenated line breaks joined), captions and the reference list.

use std::collections::{HashMap, HashSet};

use pdf_extract::{Document, MediaBox, Object, OutputDev, OutputError, Transform};

use crate::extract::collapse;
use crate::ir::{ArticleIr, ArticleMeta, Block, BlockAttrs, BlockKind, Inline};
use crate::markdown::joins_without_space;
use crate::store::{NewSnapshot, Store, sha256_hex};

/// `original_url` and `normalized_url` of every PDF imported from a file.
pub const URL_PREFIX: &str = "local:pdf/";
pub const CONTENT_TYPE: &str = "application/pdf";
/// Larger than any paper; also the download cap for a PDF URL.
pub const MAX_BYTES: usize = 50 * 1024 * 1024;

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// By the declared type, or by the magic bytes when a server says nothing useful.
pub fn is_pdf(content_type: Option<&str>, body: &[u8]) -> bool {
    content_type.is_some_and(|ct| ct.trim().to_ascii_lowercase().starts_with(CONTENT_TYPE)) || body.starts_with(b"%PDF-")
}

/// Imports a PDF the user picked and returns its article id; the same file again returns the
/// existing one. `name` (the file name without extension) is the title when the PDF has none.
pub fn import(store: &Store, bytes: &[u8], name: Option<&str>) -> Result<i64, String> {
    let ir = to_ir(bytes, name)?;
    let url = format!("{URL_PREFIX}{}", sha256_hex(bytes));
    let (id, needs_work) = store.upsert_pending(&url, &url, "").map_err(err)?;
    if needs_work {
        store.save_snapshot(id, Some(&snapshot(&url, bytes)), Ok(ir), None).map_err(err)?;
    }
    Ok(id)
}

/// A PDF fetched from a URL: like a page, a failed extraction is recorded on the article.
pub fn store_fetched(store: &Store, id: i64, final_url: &str, bytes: &[u8]) -> Result<i64, String> {
    store.save_snapshot(id, Some(&snapshot(final_url, bytes)), to_ir(bytes, None), None).map_err(err)
}

/// Extracts the stored bytes again; the current title is the fallback, as on import.
pub fn reextract(store: &Store, id: i64, bytes: &[u8]) -> Result<i64, String> {
    let title = store.article_row(id).map_err(err)?.and_then(|a| a.title);
    store.save_snapshot(id, None, to_ir(bytes, title.as_deref()), None).map_err(err)
}

fn snapshot<'a>(url: &'a str, bytes: &'a [u8]) -> NewSnapshot<'a> {
    NewSnapshot { final_url: url, status: 200, content_type: Some(CONTENT_TYPE), body: bytes }
}

/// Title: the first page's largest text, else the document's own (when it reads like one),
/// else `fallback`, else the first line.
pub fn to_ir(bytes: &[u8], fallback: Option<&str>) -> Result<ArticleIr, String> {
    let doc = read(bytes)?;
    let mut lines = Vec::new();
    for (i, page) in doc.pages.iter().enumerate() {
        lines.push(page_lines(i, page));
    }
    drop_running_lines(&mut lines, &doc.pages);
    let mut lines: Vec<Line> = lines.into_iter().zip(&doc.pages).flat_map(|(l, p)| order(l, p.width)).collect();
    let body = body_size(&lines);
    let half = doc.pages.first().map_or(0., |p| p.height / 2.);
    let front = take_front_matter(&mut lines, body, half);
    let blocks = to_blocks(&lines, body);
    if blocks.is_empty() {
        return Err("PDF から本文を取り出せませんでした（文字のない画像だけの PDF には対応していません）".into());
    }
    let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let first_line = || blocks.first().map(|b| b.text.chars().take(80).collect::<String>());
    let title = front.title.or(doc.title.filter(|t| reads_like_title(t))).or_else(|| fallback.and_then(non_empty)).or_else(first_line);
    let author = front.author.or(doc.author.filter(|a| a.contains(' ')));
    Ok(ArticleIr { meta: ArticleMeta { title, author, published_at: doc.created, ..Default::default() }, blocks })
}

struct Glyph {
    x: f64,
    /// Baseline, from the top of the page.
    y: f64,
    end: f64,
    size: f64,
    text: String,
}

#[derive(Default)]
struct Page {
    width: f64,
    height: f64,
    glyphs: Vec<Glyph>,
}

struct Parsed {
    pages: Vec<Page>,
    title: Option<String>,
    author: Option<String>,
    created: Option<String>,
}

/// pdf-extract panics on some malformed files; with `panic = "unwind"` in the release profile
/// that becomes an error here instead of ending the app.
fn read(bytes: &[u8]) -> Result<Parsed, String> {
    std::panic::catch_unwind(|| {
        let (doc, mut pages) = glyphs(bytes, true)?;
        // A page drawn entirely inside forms (an included PDF) is read with them after all.
        if pages.iter().any(|p| p.glyphs.is_empty()) {
            let (_, all) = glyphs(bytes, false)?;
            for (p, a) in pages.iter_mut().zip(all) {
                if p.glyphs.is_empty() {
                    *p = a;
                }
            }
        }
        let created = info(&doc, b"CreationDate").and_then(|d| pdf_date(&d));
        Ok(Parsed { pages, title: info(&doc, b"Title"), author: info(&doc, b"Author"), created })
    })
    .unwrap_or_else(|_| Err("PDF の解析に失敗しました".into()))
}

/// `skip_forms`: figures are form XObjects, whose labels are noise, and pdf-extract places text
/// inside a form without the transform that positions it on the page.
fn glyphs(bytes: &[u8], skip_forms: bool) -> Result<(Document, Vec<Page>), String> {
    let fail = |e: &dyn std::fmt::Debug| format!("PDF を読み込めません: {e:?}");
    let mut doc = Document::load_mem(bytes).map_err(|e| fail(&e))?;
    if doc.is_encrypted() {
        doc.decrypt("").map_err(|e| fail(&e))?;
    }
    if skip_forms {
        for o in doc.objects.values_mut() {
            if let Object::Stream(s) = o
                && s.dict.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Form")
            {
                s.set_plain_content(Vec::new());
            }
        }
    }
    let mut out = Glyphs::default();
    pdf_extract::output_doc(&doc, &mut out).map_err(|e| fail(&e))?;
    Ok((doc, out.pages))
}

#[derive(Default)]
struct Glyphs {
    pages: Vec<Page>,
    origin: (f64, f64),
}

impl OutputDev for Glyphs {
    fn begin_page(&mut self, _: u32, b: &MediaBox, _: Option<(f64, f64, f64, f64)>) -> Result<(), OutputError> {
        self.origin = (b.llx, b.lly);
        self.pages.push(Page { width: b.urx - b.llx, height: b.ury - b.lly, glyphs: Vec::new() });
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn output_character(&mut self, trm: &Transform, width: f64, _: f64, font_size: f64, text: &str) -> Result<(), OutputError> {
        // Rotated or mirrored text is a margin stamp (arXiv's) or a figure label, not prose.
        let upright = trm.m11 > 0. && trm.m22 > 0. && trm.m12.abs() < 1e-3 * trm.m11 && trm.m21.abs() < 1e-3 * trm.m22;
        let size = font_size.abs() * (trm.m11 * trm.m22).sqrt();
        let Some(page) = self.pages.last_mut().filter(|_| upright && size > 0.5) else { return Ok(()) };
        let x = trm.m31 - self.origin.0;
        page.glyphs.push(Glyph { x, y: page.height - (trm.m32 - self.origin.1), end: x + width * size, size, text: text.to_string() });
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Side {
    Left,
    Right,
    Full,
}

#[derive(Clone, Debug)]
struct Line {
    page: usize,
    x0: f64,
    x1: f64,
    y: f64,
    size: f64,
    text: String,
    side: Side,
    /// Left and right edges of the column the line is in.
    left: f64,
    right: f64,
}

/// Glyphs in content order -> lines: a new line where the baseline moves, the pen jumps back
/// left, or it jumps the gutter in the middle of the page (columns written row by row).
fn page_lines(page: usize, p: &Page) -> Vec<Line> {
    let mid = p.width / 2.;
    let mut groups: Vec<Vec<&Glyph>> = Vec::new();
    for g in &p.glyphs {
        let new_line = match groups.last().and_then(|l| l.last()) {
            None => true,
            Some(prev) => {
                let size = prev.size.max(g.size);
                (g.y - prev.y).abs() > 0.6 * size || g.x < prev.x - size || (prev.end < mid && g.x > mid && g.x - prev.end > 1.5 * size)
            }
        };
        match groups.last_mut() {
            Some(l) if !new_line => l.push(g),
            _ => groups.push(vec![g]),
        }
    }
    groups.iter().filter_map(|g| line(page, g)).collect()
}

fn line(page: usize, glyphs: &[&Glyph]) -> Option<Line> {
    let mut text = String::new();
    let mut prev: Option<&Glyph> = None;
    let mut space = false;
    for &g in glyphs {
        if g.text.trim().is_empty() {
            space = true;
            continue;
        }
        if let Some(p) = prev
            && (space || g.x > p.end + 0.15 * p.size.min(g.size))
        {
            text.push(' ');
        }
        space = false;
        push_clean(&mut text, &g.text);
        prev = Some(g);
    }
    let text = collapse(&text).trim().to_string();
    if text.is_empty() {
        return None;
    }
    let ink: Vec<&&Glyph> = glyphs.iter().filter(|g| !g.text.trim().is_empty()).collect();
    // The size most of the line is set in: superscripts and inline symbols don't count.
    let mut sizes: HashMap<i64, usize> = HashMap::new();
    for g in &ink {
        *sizes.entry((g.size * 10.).round() as i64).or_default() += 1;
    }
    let main = sizes.iter().max_by_key(|(k, n)| (**n, **k)).map(|(k, _)| *k)?;
    let base = ink.iter().find(|g| (g.size * 10.).round() as i64 == main)?;
    let x0 = ink.iter().map(|g| g.x).fold(f64::MAX, f64::min);
    let x1 = ink.iter().map(|g| g.end).fold(f64::MIN, f64::max);
    Some(Line { page, x0, x1, y: base.y, size: main as f64 / 10., text, side: Side::Full, left: x0, right: x1 })
}

/// Ligatures as letters; soft hyphens and control characters as nothing.
fn push_clean(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            'ﬀ' => out.push_str("ff"),
            'ﬁ' => out.push_str("fi"),
            'ﬂ' => out.push_str("fl"),
            'ﬃ' => out.push_str("ffi"),
            'ﬄ' => out.push_str("ffl"),
            'ﬅ' | 'ﬆ' => out.push_str("st"),
            '\u{ad}' => out.push('-'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
}

/// Drops page numbers and the running headers and footers: lines in the top or bottom margin
/// that repeat (digits aside) on at least a third of the pages.
fn drop_running_lines(lines: &mut [Vec<Line>], pages: &[Page]) {
    let key = |l: &Line| {
        let h = pages[l.page].height;
        (l.y < h * 0.08 || l.y > h * 0.92).then(|| {
            let mut k = String::new();
            for c in l.text.to_lowercase().chars() {
                match c {
                    '0'..='9' if k.ends_with('#') => {}
                    '0'..='9' => k.push('#'),
                    c => k.push(c),
                }
            }
            k
        })
    };
    let mut seen: HashMap<String, HashSet<usize>> = HashMap::new();
    for l in lines.iter().flatten() {
        if let Some(k) = key(l) {
            seen.entry(k).or_default().insert(l.page);
        }
    }
    let n = pages.len();
    let running = |k: &str| {
        let pages = seen.get(k).map_or(0, HashSet::len);
        let number = k.chars().all(|c| c == '#' || !c.is_alphanumeric()) || (k.len() <= 6 && k.chars().all(|c| matches!(c, 'i' | 'v' | 'x')));
        number || pages >= 2 && pages * 3 >= n
    };
    for page in lines.iter_mut() {
        page.retain(|l| key(l).is_none_or(|k| !running(&k)));
    }
}

/// Reading order of one page. Two columns when each half holds a fifth of the text: lines across
/// the middle (title, wide figures) split the page into bands, read left column then right.
/// Otherwise the content order stands.
fn order(mut lines: Vec<Line>, width: f64) -> Vec<Line> {
    let (mid, tol) = (width / 2., width * 0.01);
    let side = |l: &Line| match () {
        _ if l.x1 <= mid + tol => Side::Left,
        _ if l.x0 >= mid - tol => Side::Right,
        _ => Side::Full,
    };
    let chars = |s: Side| lines.iter().filter(|l| side(l) == s).map(|l| l.text.chars().count()).sum::<usize>();
    let total = chars(Side::Left) + chars(Side::Right) + chars(Side::Full);
    let two = chars(Side::Left) * 5 >= total && chars(Side::Right) * 5 >= total;
    if two {
        for l in &mut lines {
            l.side = side(l);
        }
    }
    for s in [Side::Left, Side::Right, Side::Full] {
        let of_side = || lines.iter().filter(|l| l.side == s);
        let long = || of_side().filter(|l| l.text.chars().count() >= 20);
        let (lo, hi) = match long().next() {
            Some(_) => (long().map(|l| l.x0).fold(f64::MAX, f64::min), long().map(|l| l.x1).fold(f64::MIN, f64::max)),
            None => (of_side().map(|l| l.x0).fold(f64::MAX, f64::min), of_side().map(|l| l.x1).fold(f64::MIN, f64::max)),
        };
        for l in lines.iter_mut().filter(|l| l.side == s) {
            (l.left, l.right) = (lo, hi);
        }
    }
    if !two {
        return lines;
    }
    lines.sort_by(|a, b| a.y.total_cmp(&b.y));
    let mut out = Vec::with_capacity(lines.len());
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for l in lines {
        match l.side {
            Side::Left => left.push(l),
            Side::Right => right.push(l),
            Side::Full => {
                out.append(&mut left);
                out.append(&mut right);
                out.push(l);
            }
        }
    }
    out.append(&mut left);
    out.append(&mut right);
    out
}

/// The size most of the text is set in.
fn body_size(lines: &[Line]) -> f64 {
    let mut sizes: HashMap<i64, usize> = HashMap::new();
    for l in lines {
        *sizes.entry((l.size * 10.).round() as i64).or_default() += l.text.chars().count();
    }
    sizes.into_iter().max_by_key(|&(k, n)| (n, k)).map_or(10., |(k, _)| k as f64 / 10.)
}

#[derive(Default)]
struct Front {
    title: Option<String>,
    author: Option<String>,
}

/// The title is the largest text in the top half of the first page, when it stands out. The
/// lines between it and the first section heading on that page (authors, affiliations,
/// addresses) are dropped from the body; the first of them is taken as the author line.
fn take_front_matter(lines: &mut Vec<Line>, body: f64, half: f64) -> Front {
    let top = |l: &Line| l.page == 0 && l.y < half;
    let Some(max) = lines.iter().filter(|l| top(l)).map(|l| l.size).reduce(f64::max).filter(|&m| m >= body * 1.3) else { return Front::default() };
    let Some(start) = lines.iter().position(|l| top(l) && l.size >= max - 0.5) else { return Front::default() };
    let end = start + lines[start..].iter().take_while(|l| l.page == 0 && l.size >= max - 0.5).count();
    let mut title = String::new();
    for l in &lines[start..end] {
        join(&mut title, &l.text, &HashSet::new());
    }
    let heading = lines[end..].iter().take_while(|l| l.page == 0).position(|l| section_level(l, body).is_some()).unwrap_or(0);
    let author =
        lines[end..end + heading].first().map(|l| l.text.trim_end_matches(['∗', '*', '†', '‡']).to_string()).filter(|a| a.len() <= 150 && !a.contains('@'));
    lines.drain(start..end + heading);
    Front { title: Some(title), author }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Paragraph,
    Heading(u8),
    Caption,
    Item,
    Reference,
}

struct Draft<'a> {
    kind: Kind,
    lines: Vec<&'a Line>,
}

fn to_blocks(lines: &[Line], body: f64) -> Vec<Block> {
    let vocab = vocabulary(lines);
    let pitch = pitch(lines, body);
    let mut drafts: Vec<Draft> = Vec::new();
    let mut refs: Option<RefStyle> = None;
    for (i, l) in lines.iter().enumerate() {
        if let Some(level) = heading_level(l, body) {
            refs = is_references(&l.text).then(|| ref_style(&lines[i + 1..], body));
            drafts.push(Draft { kind: Kind::Heading(level), lines: vec![l] });
            continue;
        }
        let cur = drafts.last().map(|d| (d.kind, *d.lines.last().expect("a draft has a line"), d.lines[0]));
        let flows = cur.is_some_and(|(_, prev, _)| flows(prev, l, pitch));
        let start = match (refs, cur) {
            (Some(style), _) => match style {
                RefStyle::Numbered => ref_number(&l.text),
                RefStyle::Hanging => l.x0 <= l.left + 0.5 * l.size,
                RefStyle::Spaced => cur.is_none_or(|(_, prev, _)| prev.page == l.page && prev.side == l.side && !flows),
            }
            .then_some(Kind::Reference),
            _ if is_caption(&l.text) => Some(Kind::Caption),
            _ if is_bullet(&l.text) => Some(Kind::Item),
            _ => None,
        };
        let continues = start.is_none()
            && cur.is_some_and(|(kind, prev, first)| match kind {
                // Entries start by number, edge or space; one ending in a full stop does not run
                // on into the next column, which may be an appendix whose heading went unseen.
                Kind::Reference => flows || !prev.text.ends_with('.'),
                // A title too long for one line.
                Kind::Heading(_) => flows && (prev.size - l.size).abs() < 0.3 && (l.size >= body * 1.1 || prev.x1 >= prev.right - 3. * prev.size),
                Kind::Caption => flows && (prev.size - l.size).abs() < 0.3,
                Kind::Item => flows && l.x0 > first.x0 + 0.3 * l.size,
                Kind::Paragraph if (prev.size - l.size).abs() > 0.15 * prev.size.max(l.size) => false,
                Kind::Paragraph if flows => {
                    let indented = l.x0 > prev.x0 + 0.8 * l.size;
                    let ended = prev.x1 < prev.right - 2. * prev.size && prev.text.ends_with(['.', '!', '?', ':']);
                    !indented && !ended
                }
                // Across a column or page: only a paragraph that ran to the column's edge, into
                // a line that is not indented.
                Kind::Paragraph => {
                    let across = prev.page != l.page || prev.side != l.side || l.y < prev.y;
                    across && (prev.x1 >= prev.right - 2. * prev.size || prev.text.ends_with('-')) && l.x0 <= l.left + 0.8 * l.size
                }
            });
        if continues {
            drafts.last_mut().expect("continues a draft").lines.push(l);
        } else if let Some(i) = start.is_none().then(|| interrupted(&drafts, l, body)).flatten() {
            // The figure goes before the paragraph it interrupted, as a float would.
            let mut d = drafts.remove(i);
            d.lines.push(l);
            drafts.push(d);
        } else {
            drafts.push(Draft { kind: start.unwrap_or(if refs.is_some() { Kind::Reference } else { Kind::Paragraph }), lines: vec![l] });
        }
    }
    drop_figure_labels(&mut drafts);
    drafts.into_iter().filter_map(|d| block(d, &vocab)).collect()
}

/// A line that carries on a sentence (lowercase, not indented) after a caption or a footnote,
/// and the stray labels around a figure: the paragraph it continues, if one before them is
/// unfinished.
fn interrupted(drafts: &[Draft], l: &Line, body: f64) -> Option<usize> {
    if !l.text.starts_with(char::is_lowercase) || l.x0 > l.left + 0.8 * l.size {
        return None;
    }
    let float = |d: &Draft| d.kind == Kind::Caption || d.kind == Kind::Paragraph && d.lines.iter().all(|x| x.size < body * 0.95);
    let skipped: Vec<&Draft> = drafts.iter().rev().take_while(|d| float(d) || fragment(d)).collect();
    let i = drafts.len().checked_sub(skipped.len() + 1)?;
    let last = drafts[i].lines.last()?;
    let unfinished = drafts[i].kind == Kind::Paragraph && (last.size - body).abs() < 0.5 && !last.text.ends_with(['.', '!', '?', ':']);
    (unfinished && skipped.iter().any(|d| float(d))).then_some(i)
}

/// A short line on its own with no full stop: a figure's label, or an equation.
fn fragment(d: &Draft) -> bool {
    let l = d.lines[0];
    d.kind == Kind::Paragraph && d.lines.len() == 1 && l.x1 - l.x0 < 0.6 * (l.right - l.left) && !l.text.ends_with(['.', '!', '?', ':'])
}

/// Drops the fragments next to a figure caption: labels drawn as page text, not inside the figure.
fn drop_figure_labels(drafts: &mut Vec<Draft>) {
    let mut junk = vec![false; drafts.len()];
    for (c, d) in drafts.iter().enumerate().filter(|(_, d)| d.kind == Kind::Caption && d.lines[0].text.starts_with("Fig")) {
        let page = d.lines[0].page;
        let near = |j: &usize| fragment(&drafts[*j]) && drafts[*j].lines[0].page == page;
        for j in (0..c).rev().take_while(near).chain((c + 1..drafts.len()).take_while(near)) {
            junk[j] = true;
        }
    }
    let mut keep = junk.into_iter().map(|j| !j);
    drafts.retain(|_| keep.next().unwrap_or(true));
}

/// The next line of the same column, no further down than the line spacing allows.
fn flows(prev: &Line, l: &Line, pitch: f64) -> bool {
    let dy = l.y - prev.y;
    let column = prev.side == l.side || prev.side == Side::Full || l.side == Side::Full;
    prev.page == l.page && column && dy > 0. && dy <= prev.size.max(l.size) * (pitch + 0.25)
}

/// Line spacing as a multiple of the font size, from consecutive lines of body text.
fn pitch(lines: &[Line], body: f64) -> f64 {
    let mut r: Vec<f64> = lines
        .windows(2)
        .filter(|w| w[0].page == w[1].page && w[0].side == w[1].side && (w[0].size - body).abs() < 0.5 && (w[1].size - body).abs() < 0.5)
        .map(|w| (w[1].y - w[0].y) / body)
        .filter(|r| (0.9..2.5).contains(r))
        .collect();
    r.sort_by(f64::total_cmp);
    r.get(r.len() / 2).copied().unwrap_or(1.2)
}

fn block(d: Draft, vocab: &HashSet<String>) -> Option<Block> {
    let mut text = String::new();
    for l in &d.lines {
        join(&mut text, &l.text, vocab);
    }
    let text = collapse(&text).trim().to_string();
    if text.is_empty() {
        return None;
    }
    let (kind, attrs) = match d.kind {
        Kind::Paragraph => (BlockKind::Paragraph, BlockAttrs::default()),
        Kind::Heading(level) => (BlockKind::Heading, BlockAttrs { level: Some(level), ..Default::default() }),
        Kind::Caption => (BlockKind::Caption, BlockAttrs::default()),
        Kind::Item | Kind::Reference => (BlockKind::ListItem, BlockAttrs { ordered: Some(false), depth: Some(0), ..Default::default() }),
    };
    Some(Block { kind, inlines: vec![Inline::Text { v: text.clone() }], text, attrs })
}

/// Words as written inside lines, to tell "pre-trained" broken at its own hyphen from "repre-sentation".
fn vocabulary(lines: &[Line]) -> HashSet<String> {
    let mut words = HashSet::new();
    for l in lines {
        let mut tokens: Vec<&str> = l.text.split_whitespace().collect();
        tokens.pop(); // may be the first half of a broken word
        words.extend(tokens.into_iter().map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()));
    }
    words
}

/// Appends a line to a block's text. A word hyphenated across the break is joined unless the
/// hyphen is the word's own: the first half already has one ("left-to-"), or the document writes
/// the word with it.
fn join(acc: &mut String, next: &str, vocab: &HashSet<String>) {
    let next_lower = next.chars().next().is_some_and(char::is_lowercase);
    if let Some(stem) = acc.strip_suffix('-')
        && stem.chars().last().is_some_and(char::is_alphabetic)
        && next_lower
    {
        let tail = stem.rsplit(char::is_whitespace).next().unwrap_or(stem).trim_start_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        let head: String = next.chars().take_while(|c| c.is_alphabetic()).collect::<String>().to_lowercase();
        let own = tail.contains('-') || vocab.contains(&format!("{tail}-{head}")) && !vocab.contains(&format!("{tail}{head}"));
        if !own {
            acc.pop();
        }
    } else if !acc.is_empty() && !glued(acc, next) {
        acc.push(' ');
    }
    acc.push_str(next);
}

/// No space across the break after "Al-", "1638–" or "tasks—", or between Japanese lines.
fn glued(acc: &str, next: &str) -> bool {
    let mut end = acc.chars().rev();
    let (last, before) = (end.next(), end.next());
    let hyphen = last == Some('-') && before.is_some_and(char::is_alphanumeric);
    hyphen || matches!(last, Some('–' | '—')) || last.is_some_and(joins_without_space) && next.chars().next().is_some_and(joins_without_space)
}

const NAMED_SECTIONS: &[&str] = &[
    "abstract",
    "references",
    "bibliography",
    "acknowledgments",
    "acknowledgements",
    "acknowledgment",
    "acknowledgement",
    "appendix",
    "introduction",
    "conclusion",
    "conclusions",
    "related work",
];

/// A short line that is a section title, or one set clearly larger than the body that fits on
/// its line.
fn heading_level(l: &Line, body: f64) -> Option<u8> {
    let t = l.text.as_str();
    let words = t.split_whitespace().count();
    let big = l.size >= body * 1.15 && words <= 10 && l.x1 < l.right - 3. * l.size && t.chars().filter(|c| c.is_alphabetic()).count() >= 3;
    section_level(l, body).or((big && !t.ends_with([',', '.']) && t.chars().next().is_some_and(|c| !c.is_lowercase())).then_some(2))
}

/// A numbered section title ("3.1 Pre-training" -> 3) or a well-known unnumbered one ("References").
fn section_level(l: &Line, body: f64) -> Option<u8> {
    let t = l.text.as_str();
    let words = t.split_whitespace().count();
    if t.chars().count() > 90 || words > 12 || l.size < body * 0.95 {
        return None;
    }
    let (first, rest) = t.split_once(' ').unwrap_or((t, ""));
    if let Some(depth) = section_number(first) {
        let rest = rest.trim();
        let letters = rest.chars().filter(|c| c.is_alphabetic()).count();
        let digits = rest.chars().filter(char::is_ascii_digit).count();
        if rest.chars().next().is_some_and(char::is_uppercase) && letters >= 3 && digits <= 2 && !rest.ends_with([',', ';']) && words <= 10 {
            return Some((depth + 1).min(4) as u8);
        }
    }
    let name = t.trim_end_matches(['.', ':']).to_lowercase();
    NAMED_SECTIONS.contains(&name.as_str()).then_some(2)
}

/// "2", "2.", "3.1", "A.2" and "IV." number a section; returns the depth.
fn section_number(tok: &str) -> Option<usize> {
    let roman = |s: &str| !s.is_empty() && s.len() <= 4 && s.chars().all(|c| matches!(c, 'I' | 'V' | 'X'));
    if let Some(r) = tok.strip_suffix('.')
        && roman(r)
    {
        return Some(1);
    }
    let parts: Vec<&str> = tok.strip_suffix('.').unwrap_or(tok).split('.').collect();
    let num = |s: &str| (1..=2).contains(&s.len()) && s.chars().all(|c| c.is_ascii_digit());
    let first_ok = num(parts[0]) && parts[0] != "0" || parts.len() > 1 && parts[0].len() == 1 && parts[0].chars().all(|c| c.is_ascii_uppercase());
    (first_ok && parts[1..].iter().all(|p| num(p))).then_some(parts.len())
}

fn is_references(heading: &str) -> bool {
    let (first, rest) = heading.split_once(' ').unwrap_or(("", heading));
    let name = if section_number(first).is_some() { rest } else { heading };
    matches!(name.trim_end_matches(['.', ':']).to_lowercase().as_str(), "references" | "bibliography" | "literature cited" | "works cited")
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum RefStyle {
    /// "[12] …" or "12. …"
    Numbered,
    /// Each entry starts at the column edge, its other lines indented.
    Hanging,
    /// Entries separated by space only.
    Spaced,
}

fn ref_style(after: &[Line], body: f64) -> RefStyle {
    let section: Vec<&Line> = after.iter().take_while(|l| heading_level(l, body).is_none()).collect();
    if section.first().is_some_and(|l| ref_number(&l.text)) {
        return RefStyle::Numbered;
    }
    let indented = section.iter().filter(|l| l.x0 > l.left + 0.8 * l.size).count();
    if indented * 5 >= section.len() && indented > 0 { RefStyle::Hanging } else { RefStyle::Spaced }
}

fn ref_number(t: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.len() <= 3 && s.chars().all(|c| c.is_ascii_digit());
    match t.strip_prefix('[') {
        Some(rest) => rest.split_once(']').is_some_and(|(n, _)| digits(n)),
        None => t.split_once(". ").is_some_and(|(n, _)| digits(n)),
    }
}

/// "Figure 3:", "Fig. 2.", "Table 1:" open a caption.
fn is_caption(t: &str) -> bool {
    let Some(rest) = ["Figure", "Fig.", "Table", "Algorithm"].iter().find_map(|p| t.strip_prefix(p)) else { return false };
    let rest = rest.trim_start();
    let n = rest.chars().take_while(|c| c.is_ascii_digit() || matches!(c, 'I' | 'V' | 'X')).count();
    n > 0 && rest[n..].starts_with(['.', ':'])
}

fn is_bullet(t: &str) -> bool {
    t.starts_with(['•', '◦', '▪', '●', '■', '‣']) && t.chars().nth(1).is_some_and(char::is_whitespace)
}

/// A metadata title worth showing: not a file name or a word processor's placeholder.
fn reads_like_title(t: &str) -> bool {
    let lower = t.to_lowercase();
    t.contains(' ') && !t.contains('_') && !lower.starts_with("microsoft word") && ![".pdf", ".dvi", ".doc", ".docx", ".tex"].iter().any(|e| lower.ends_with(e))
}

/// A text string of the document information dictionary.
fn info(doc: &Document, key: &[u8]) -> Option<String> {
    let dict = match doc.trailer.get(b"Info").ok()? {
        Object::Reference(id) => doc.get_dictionary(*id).ok()?,
        Object::Dictionary(d) => d,
        _ => return None,
    };
    let Object::String(bytes, _) = dict.get(key).ok()? else { return None };
    let text = match bytes.strip_prefix(&[0xfe, 0xff]) {
        Some(be) => String::from_utf16_lossy(&be.as_chunks::<2>().0.iter().map(|&c| u16::from_be_bytes(c)).collect::<Vec<_>>()),
        // PDFDocEncoding matches Latin-1 for everything a title uses.
        None => bytes.iter().map(|&b| b as char).collect(),
    };
    Some(collapse(&text).trim().to_string()).filter(|s| !s.is_empty())
}

/// "D:20190524002235Z" -> "2019-05-24".
fn pdf_date(d: &str) -> Option<String> {
    let d = d.strip_prefix("D:").unwrap_or(d);
    let digits = d.get(..8).filter(|s| s.chars().all(|c| c.is_ascii_digit()))?;
    let (y, m, day) = (&digits[..4], &digits[4..6], &digits[6..]);
    let ok = |s: &str, max: u32| s.parse::<u32>().is_ok_and(|v| (1..=max).contains(&v));
    (ok(m, 12) && ok(day, 31)).then(|| format!("{y}-{m}-{day}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use pdf_extract::content::{Content, Operation};
    use pdf_extract::{Dictionary, Stream, StringFormat};

    /// One text run: x and baseline y from the top of a US Letter page, font size, text.
    pub(crate) type Run<'a> = (f64, f64, f64, &'a str);

    fn name(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }

    /// A PDF set in Helvetica, the runs of each page written in the order given.
    pub(crate) fn pdf(pages: &[Vec<Run>], title: Option<&str>) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type1"));
        font.set("BaseFont", name("Helvetica"));
        let font_id = doc.add_object(font);
        let mut kids = Vec::new();
        for runs in pages {
            let mut ops = Vec::new();
            for &(x, y, size, text) in runs {
                ops.push(Operation::new("BT", vec![]));
                ops.push(Operation::new("Tf", vec![name("F1"), Object::Real(size as f32)]));
                if text.starts_with("arXiv:") {
                    ops.push(Operation::new("Tm", [0., 1., -1., 0., x, 792. - y].map(|v| Object::Real(v as f32)).to_vec()));
                } else {
                    ops.push(Operation::new("Td", vec![Object::Real(x as f32), Object::Real((792. - y) as f32)]));
                }
                ops.push(Operation::new("Tj", vec![Object::String(text.as_bytes().to_vec(), StringFormat::Literal)]));
                ops.push(Operation::new("ET", vec![]));
            }
            let content = doc.add_object(Stream::new(Dictionary::new(), Content { operations: ops }.encode().unwrap()));
            let mut fonts = Dictionary::new();
            fonts.set("F1", Object::Reference(font_id));
            let mut resources = Dictionary::new();
            resources.set("Font", Object::Dictionary(fonts));
            let mut page = Dictionary::new();
            page.set("Type", name("Page"));
            page.set("Parent", Object::Reference(pages_id));
            page.set("MediaBox", Object::Array([0, 0, 612, 792].map(Object::Integer).to_vec()));
            page.set("Contents", Object::Reference(content));
            page.set("Resources", Object::Dictionary(resources));
            kids.push(Object::Reference(doc.add_object(page)));
        }
        let mut tree = Dictionary::new();
        tree.set("Type", name("Pages"));
        tree.set("Count", Object::Integer(kids.len() as i64));
        tree.set("Kids", Object::Array(kids));
        doc.objects.insert(pages_id, Object::Dictionary(tree));
        let mut catalog = Dictionary::new();
        catalog.set("Type", name("Catalog"));
        catalog.set("Pages", Object::Reference(pages_id));
        let root = doc.add_object(catalog);
        doc.trailer.set("Root", Object::Reference(root));
        if let Some(t) = title {
            let mut info = Dictionary::new();
            info.set("Title", Object::String(t.as_bytes().to_vec(), StringFormat::Literal));
            info.set("CreationDate", Object::String(b"D:20190524002235Z".to_vec(), StringFormat::Literal));
            let id = doc.add_object(info);
            doc.trailer.set("Info", Object::Reference(id));
        }
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    const L: f64 = 72.;
    const R: f64 = 320.;
    const HEADER: Run = (72., 40., 9., "Journal of Imaginary Results");

    /// A two-column first page whose columns are written row by row (left, right, left, …), so
    /// the content order is not the reading order; then single-column pages, the last with a
    /// figure in the middle of a paragraph.
    pub(crate) fn paper() -> Vec<u8> {
        let left: &[Run] = &[
            (L, 150., 12., "Abstract"),
            (L, 165., 10., "We study how the order of text in a page"),
            (L, 177., 10., "differs from the way people read it, with a"),
            (L, 189., 10., "pre-trained reader and a simple pre-"),
            (L, 201., 10., "trained baseline for the repre-"),
            (L, 213., 10., "sentation of columns."),
            (L, 237., 12., "1 Introduction"),
            (L, 252., 10., "Most papers are set in two columns, and"),
            (L, 264., 10., "content streams do not always follow the usual"),
        ];
        let right: &[Run] = &[
            (R, 150., 10., "reading order, so a reader has to rebuild"),
            (R, 162., 10., "it from positions in a careful left-to-"),
            (R, 174., 10., "right pass."),
            (R, 198., 10., "2.1 Running headers"),
            (R, 213., 10., "Figure 1: Columns are read top to bottom."),
            (R, 237., 12., "References"),
            (R, 252., 10., "[1] A. Author. A study of reading in"),
            (R, 264., 10., "columns. 2020."),
            (R, 276., 10., "[2] B. Author. Another study. 2021."),
        ];
        let mut page1 = vec![
            HEADER,
            (40., 500., 10., "arXiv:2401.00001v1 [cs.CL] 1 Jan 2024"),
            (150., 80., 18., "Reading Order in Two Column Papers"),
            (230., 110., 11., "Ada Lovelace and Alan Turing"),
            (250., 124., 9., "Analytical Engines Ltd."),
        ];
        for (l, r) in left.iter().zip(right) {
            page1.extend([*l, *r]);
        }
        page1.push((300., 760., 10., "1"));
        let page2 = vec![
            HEADER,
            (L, 100., 12., "A Proofs"),
            (L, 120., 10., "A single column page keeps its content order,"),
            (L, 132., 10., "line by line."),
            (300., 760., 10., "2"),
        ];
        let page3 = vec![
            HEADER,
            (L, 100., 10., "A paragraph that runs to the end of its line and is cut by a"),
            (200., 130., 10., "Encoder"),
            (L, 150., 10., "Figure 2: A figure in the middle of a paragraph."),
            (L, 175., 10., "figure before it ends here."),
            (300., 760., 10., "3"),
        ];
        pdf(&[page1, page2, page3], Some("making_paper_v2"))
    }

    fn kinds(ir: &ArticleIr) -> Vec<(&str, &str)> {
        ir.blocks.iter().map(|b| (b.kind.as_str(), b.text.as_str())).collect()
    }

    #[test]
    fn rebuilds_a_two_column_paper() {
        let ir = to_ir(&paper(), Some("file-name")).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("Reading Order in Two Column Papers"));
        assert_eq!(ir.meta.author.as_deref(), Some("Ada Lovelace and Alan Turing"));
        assert_eq!(ir.meta.published_at.as_deref(), Some("2019-05-24"));
        assert_eq!(
            kinds(&ir),
            [
                ("heading", "Abstract"),
                (
                    "paragraph",
                    "We study how the order of text in a page differs from the way people read it, with a pre-trained reader and a simple pre-trained baseline for the representation of columns."
                ),
                ("heading", "1 Introduction"),
                (
                    "paragraph",
                    "Most papers are set in two columns, and content streams do not always follow the usual reading order, so a reader has to rebuild it from positions in a careful left-to-right pass."
                ),
                ("heading", "2.1 Running headers"),
                ("caption", "Figure 1: Columns are read top to bottom."),
                ("heading", "References"),
                ("list_item", "[1] A. Author. A study of reading in columns. 2020."),
                ("list_item", "[2] B. Author. Another study. 2021."),
                ("heading", "A Proofs"),
                ("paragraph", "A single column page keeps its content order, line by line."),
                ("caption", "Figure 2: A figure in the middle of a paragraph."),
                ("paragraph", "A paragraph that runs to the end of its line and is cut by a figure before it ends here."),
            ],
            "no running header, page numbers, arXiv stamp, affiliations or figure label"
        );
        let levels: Vec<_> = ir.blocks.iter().filter_map(|b| b.attrs.level).collect();
        assert_eq!(levels, [2, 2, 3, 2, 2]);
    }

    #[test]
    fn title_falls_back_to_metadata_then_name() {
        let body = vec![(L, 120., 10., "Plain text with no larger title line on the page.")];
        let ir = to_ir(&pdf(std::slice::from_ref(&body), Some("A Paper Title From Metadata")), Some("file")).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("A Paper Title From Metadata"));
        let ir = to_ir(&pdf(std::slice::from_ref(&body), Some("Microsoft Word - draft.docx")), Some("file")).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("file"));
        assert!(to_ir(&pdf(&[vec![]], None), None).is_err(), "no text, no article");
        assert!(to_ir(b"%PDF-1.5 not really", None).is_err(), "a broken file is an error, not a crash");
    }

    #[test]
    fn helpers() {
        assert!(is_pdf(Some("application/pdf; qs=0.001"), b""));
        assert!(is_pdf(Some("application/octet-stream"), b"%PDF-1.7\n"));
        assert!(!is_pdf(Some("text/html"), b"<html>"));
        assert_eq!(section_number("3.1"), Some(2));
        assert_eq!(section_number("A.2"), Some(2));
        assert_eq!(section_number("IV."), Some(1));
        assert_eq!(section_number("2018"), None);
        assert!(ref_number("[12] X") && ref_number("3. Y") && !ref_number("2018. Z"));
        assert!(is_caption("Fig. 2. A") && is_caption("Table IV: B") && !is_caption("Table 1 shows"));
        assert_eq!(pdf_date("D:2019"), None);
    }

    #[test]
    fn imports_once_per_file_and_reextracts_in_place() {
        let s = Store::open_in_memory().unwrap();
        let bytes = paper();
        let id = import(&s, &bytes, Some("paper")).unwrap();
        assert_eq!(import(&s, &bytes, None).unwrap(), id, "same bytes, same article");
        let a = s.article_row(id).unwrap().unwrap();
        assert!(a.original_url.starts_with(URL_PREFIX) && a.domain.is_empty());
        assert_eq!((a.title.as_deref(), a.extraction_status.as_str()), (Some("Reading Order in Two Column Papers"), "ok"));
        let snap = s.latest_snapshot(id).unwrap().unwrap();
        assert_eq!((snap.content_type.as_deref(), snap.body == bytes), (Some(CONTENT_TYPE), true), "the original is kept");
        let ids: Vec<i64> = s.get_article(id, "ja").unwrap().unwrap().blocks.iter().map(|b| b.id).collect();
        assert_eq!(crate::ingest::reextract(&s, id).unwrap(), id);
        let again: Vec<i64> = s.get_article(id, "ja").unwrap().unwrap().blocks.iter().map(|b| b.id).collect();
        assert_eq!(again, ids, "re-extraction reads the stored PDF");
        assert!(import(&s, b"not a pdf", None).is_err());
    }
}
