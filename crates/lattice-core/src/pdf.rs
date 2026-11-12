//! PDF (typically a research paper) -> Article IR. The original bytes are the snapshot, so
//! re-extraction needs no network. A PDF fetched from a URL is an ordinary article of that URL;
//! a file the user picked has none: its identity is `local:pdf/<sha256 of the bytes>`.
//!
//! pdf-extract reports each glyph with its position and size, and the layout is rebuilt here:
//! lines, two-column reading order, running headers and page numbers, title, headings,
//! paragraphs (with hyphenated line breaks joined), captions and the reference list.

use std::collections::{HashMap, HashSet};

use pdf_extract::content::Content;
use pdf_extract::{Document, MediaBox, Object, ObjectId, OutputDev, OutputError, Transform};
use serde::Serialize;

use crate::extract::collapse;
use crate::ir::{ArticleIr, ArticleMeta, Block, BlockAttrs, BlockKind, Inline};
use crate::markdown::joins_without_space;
use crate::msg;
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

/// Extracts the stored bytes again; the title the app found (not the user's name) is the fallback, as on import.
pub fn reextract(store: &Store, id: i64, bytes: &[u8]) -> Result<i64, String> {
    let title = store.article_row(id).map_err(err)?.and_then(|a| a.auto_title.or(a.title));
    store.save_snapshot(id, None, to_ir(bytes, title.as_deref()), None).map_err(err)
}

fn snapshot<'a>(url: &'a str, bytes: &'a [u8]) -> NewSnapshot<'a> {
    NewSnapshot { final_url: url, status: 200, content_type: Some(CONTENT_TYPE), body: bytes }
}

/// Title: the first page's largest text, else the document's own (when it reads like one),
/// else `fallback`, else the first line.
pub fn to_ir(bytes: &[u8], fallback: Option<&str>) -> Result<ArticleIr, String> {
    let doc = read(bytes)?;
    let (lines, body, front) = lay_out(&doc);
    let blocks = to_blocks(&lines, body);
    if blocks.is_empty() {
        return Err(msg!("pdf.noText"));
    }
    let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let first_line = || blocks.first().map(|b| b.text.chars().take(80).collect::<String>());
    let title = front.title.or(doc.title.filter(|t| reads_like_title(t))).or_else(|| fallback.and_then(non_empty)).or_else(first_line);
    let author = front.author.or(doc.author.filter(|a| a.contains(' ')));
    Ok(ArticleIr { meta: ArticleMeta { title, author, published_at: doc.created, ..Default::default() }, blocks })
}

/// Where a run of body text sits on its page, in points from the page's top left, for the Page
/// view to draw its translation over the original.
#[derive(Debug, Serialize)]
pub struct Region {
    pub page: usize,
    /// Which block it is a piece of: the same on all of a block's pieces, whatever columns and pages they are on.
    pub block: usize,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub size: f64,
    pub text: String,
    /// `text` cut where a superscript or a subscript starts and ends.
    pub runs: Vec<TextRun>,
    /// A heading's level, for the contents of a PDF that has no bookmarks.
    pub level: Option<u8>,
    /// How far a translation may run past the box, in points: a region at the edge of the page's text
    /// has the margin beyond it. A sentence moved here from another page needs more than the box holds.
    pub room_up: f64,
    pub room_down: f64,
    /// The top left of the page's MediaBox in the PDF's own coordinates, which `x0`.. are measured from.
    /// The viewer's page is the CropBox, possibly turned, so it places a box by these.
    pub left: f64,
    pub top: f64,
}

impl Region {
    /// The text as the overlay sends it: a formula goes as a placeholder, which its hash leaves out.
    pub fn translated_text(&self) -> String {
        self.runs.iter().filter(|r| !r.math).map(|r| r.text.as_str()).collect()
    }
}

#[derive(Debug, Serialize)]
pub struct TextRun {
    pub text: String,
    /// The element that sets it: `sub` or `sup`.
    pub script: Option<&'static str>,
    /// Part of a formula (`formula_glyphs`): shown as it stands, never sent to be translated.
    pub math: bool,
    /// Set in italics, inside a formula: elsewhere translation would not keep it.
    pub italic: bool,
}

// Mark a line's scripts in the text that `piece_texts` cuts up. Noncharacters: no text holds them.
const SUP: char = '\u{fdd0}';
const SUB: char = '\u{fdd1}';
const SCRIPT_END: char = '\u{fdd2}';
const MATH: char = '\u{fdd3}';
const MATH_END: char = '\u{fdd4}';
const ITALIC: char = '\u{fdd5}';
const ITALIC_END: char = '\u{fdd6}';

/// A cut can fall inside a script: what follows it in the next piece then reads as plain text.
fn text_runs(marked: &str) -> Vec<TextRun> {
    let mut runs: Vec<TextRun> = Vec::new();
    let (mut script, mut math, mut italic) = (None, false, false);
    for c in marked.chars() {
        match c {
            SUP => script = Some("sup"),
            SUB => script = Some("sub"),
            SCRIPT_END => script = None,
            MATH => math = true,
            MATH_END => math = false,
            ITALIC => italic = true,
            ITALIC_END => italic = false,
            c => match runs.last_mut() {
                Some(run) if run.script == script && run.math == math && run.italic == italic => run.text.push(c),
                _ => runs.push(TextRun { text: c.to_string(), script, math, italic }),
            },
        }
    }
    runs
}

/// The blocks of `to_ir` with their places. A block that runs on across a column, a page or a figure
/// becomes one region per piece, each translated on its own (`piece_texts`). Panics are caught as in `read`, which
/// covers only the parse: one in the layout would otherwise fail the Page view, a retranslation, or the count of
/// unused translations that first gives each PDF its old ones (`Store::own_pdf_regions`).
pub fn regions(bytes: &[u8]) -> Result<Vec<Region>, String> {
    std::panic::catch_unwind(|| laid_out_regions(bytes)).unwrap_or_else(|_| Err(msg!("pdf.parseFailed")))
}

fn laid_out_regions(bytes: &[u8]) -> Result<Vec<Region>, String> {
    let doc = read(bytes)?;
    let (lines, body, _) = lay_out(&doc);
    let vocab = vocabulary(&lines);
    let run_on = |a: &&Line, b: &&Line| a.page == b.page && a.side == b.side && b.y > a.y && b.y - a.y < 2.5 * a.size.max(b.size);
    let mut out = Vec::new();
    for (block, d) in drafts(&lines, body).iter().enumerate().filter(|(_, d)| !laid_out_text(d)) {
        let level = if let Kind::Heading(l) = d.kind {
            Some(l)
        } else {
            None
        };
        let pieces: Vec<&[&Line]> = d.lines.chunk_by(run_on).collect();
        out.extend(pieces.iter().zip(piece_texts(&pieces, &vocab)).filter_map(|(piece, text)| region(piece, text, level, block)));
    }
    let top = lines.iter().map(|l| l.y - l.size).fold(f64::MAX, f64::min);
    let bottom = lines.iter().map(|l| l.y + 0.3 * l.size).fold(f64::MIN, f64::max);
    for r in &mut out {
        if let Some(page) = doc.pages.get(r.page) {
            give_room(r, page, top, bottom);
            (r.left, r.top) = (page.left, page.top);
        }
    }
    Ok(out)
}

/// Keeps out of the outer part of the page, where the viewer has its buttons.
const PAGE_EDGE: f64 = 0.05;

/// A region as far up or down as the document's text goes has only the margin beyond it, and what is
/// printed there (a running header) stops it. One that ends short of that has a figure or the like
/// beyond it, which is not in the glyphs: figures are skipped.
fn give_room(r: &mut Region, page: &Page, top: f64, bottom: f64) {
    let across = |g: &&Glyph| g.x < r.x1 && g.end > r.x0;
    if r.y0 <= top + r.size {
        let above = page.glyphs.iter().filter(across).filter(|g| g.y < r.y0).map(|g| g.y + 0.3 * g.size);
        r.room_up = (r.y0 - above.fold(PAGE_EDGE * page.height, f64::max)).max(0.);
    }
    if r.y1 >= bottom - r.size {
        let below = page.glyphs.iter().filter(across).filter(|g| g.y > r.y1).map(|g| g.y - g.size);
        r.room_down = (below.fold((1. - PAGE_EDGE) * page.height, f64::min) - r.y1).max(0.);
    }
}

/// Figure labels, table cells, axis ticks, code: the page draws them apart and a translation set over
/// them would wreck the drawing. They are what is left as a paragraph with no full line and no
/// punctuation to end it, or a line with cells across it. The Reader keeps them, as text to search.
fn laid_out_text(d: &Draft) -> bool {
    let Some(last) = d.lines.last() else {
        return false;
    };
    let short = !last.text.ends_with(['.', '!', '?', ':', ';', ',', '。', '！', '？', '、']) && d.lines.iter().all(|l| l.x1 - l.x0 < 0.85 * (l.right - l.left));
    d.kind == Kind::Paragraph && (short || d.lines.iter().any(|l| l.tabular()))
}

/// The text of each piece of a block. Cut at the line break, "To-" / "day these changes" would be
/// translated as two fragments, so a sentence goes whole to the piece that holds most of it; the
/// other piece's box still covers its end of it. A sentence that would leave a piece empty, whose box
/// would then keep showing the original, is cut between words instead.
fn piece_texts(pieces: &[&[&Line]], vocab: &HashSet<String>) -> Vec<String> {
    let mut whole = String::new();
    let mut breaks = Vec::new();
    for piece in pieces {
        for l in *piece {
            join(&mut whole, &l.marked, vocab);
        }
        breaks.push(whole.len());
    }
    breaks.pop();
    let ends = sentence_ends(&whole);
    let mut texts = Vec::with_capacity(pieces.len());
    let mut start = 0;
    for at in breaks {
        let before = ends.iter().rev().find(|&&e| e <= at).copied().unwrap_or(0);
        let after = ends.iter().find(|&&e| e > at).copied().unwrap_or(whole.len());
        let mut cut = if at - before > after - at {
            after
        } else {
            before
        };
        if cut <= start || cut >= whole.len() {
            cut = word_break(&whole, at).max(start);
        }
        texts.push(whole[start..cut].to_string());
        start = cut;
    }
    texts.push(whole[start..].to_string());
    texts
}

/// Where each sentence but the last ends: the offset of the next one's first letter.
fn sentence_ends(text: &str) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if matches!(c, '。' | '！' | '？') {
            if let Some(&(i, _)) = chars.peek() {
                ends.push(i);
            }
            continue;
        }
        if !matches!(c, '.' | '!' | '?') {
            continue;
        }
        while chars.next_if(|(_, c)| matches!(c, '"' | '\'' | ')' | ']' | '”' | '’')).is_some() {}
        if chars.next_if(|(_, c)| c.is_whitespace()).is_none() {
            continue;
        }
        // Not "e.g. a" or "Fig. 3".
        if let Some(&(i, next)) = chars.peek()
            && next.is_uppercase()
        {
            ends.push(i);
        }
    }
    ends
}

/// The start of the word that `at` falls in. `at` itself may be inside a character: a line's hyphen
/// was taken out of the text after it was measured.
fn word_break(text: &str, at: usize) -> usize {
    text.as_bytes()[..(at + 1).min(text.len())]
        .iter()
        .rposition(|&b| b == b' ')
        .map_or_else(|| (at..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len()), |space| space + 1)
}

fn region(piece: &[&Line], text: String, level: Option<u8>, block: usize) -> Option<Region> {
    let (first, last) = (piece.first()?, piece.last()?);
    let runs = text_runs(collapse(&text).trim());
    Some(Region {
        page: first.page,
        block,
        x0: piece.iter().map(|l| l.x0).fold(f64::MAX, f64::min),
        y0: first.y - first.size,
        x1: piece.iter().map(|l| l.x1).fold(f64::MIN, f64::max),
        y1: last.y + 0.3 * last.size,
        size: first.size,
        text: runs.iter().map(|r| r.text.as_str()).collect(),
        runs,
        level,
        room_up: 0.,
        room_down: 0.,
        left: 0.,
        top: 0.,
    })
}

/// The document's lines in reading order, without running headers, the size of its body text, and
/// the front matter taken off the first page.
fn lay_out(doc: &Parsed) -> (Vec<Line>, f64, Front) {
    let mut lines = Vec::new();
    for (i, page) in doc.pages.iter().enumerate() {
        lines.push(page_lines(i, page));
    }
    drop_running_lines(&mut lines, &doc.pages);
    let mut lines: Vec<Line> = lines.into_iter().zip(&doc.pages).flat_map(|(l, p)| order(l, p.width)).collect();
    let body = body_size(&lines);
    let half = doc.pages.first().map_or(0., |p| p.height / 2.);
    let front = take_front_matter(&mut lines, body, half);
    (lines, body, front)
}

struct Glyph {
    x: f64,
    /// Baseline, from the top of the page.
    y: f64,
    end: f64,
    size: f64,
    text: String,
    face: Face,
}

/// What a glyph's font says about it.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
enum Face {
    #[default]
    Body,
    /// Prose set in italics, or a name set like a formula (`TT.now()`).
    Italic,
    /// A math font's letters.
    MathLetter,
    /// A math font's symbols.
    MathSymbol,
}

impl Face {
    /// From a font's `BaseFont`, with or without its subset prefix (`GMFWUF+CMMI10`).
    fn of(base: &str) -> Face {
        let name = base.rsplit('+').next().unwrap_or(base).to_ascii_uppercase();
        let is = |families: &[&str]| families.iter().any(|f| name.starts_with(f));
        if is(&["CMMI", "MATHITALIC", "STIXMATH"]) {
            Face::MathLetter
        } else if is(&["CMSY", "CMBSY", "CMEX", "MSAM", "MSBM", "SYMBOL", "STMARY", "RSFS", "WASY", "EUFM"]) {
            Face::MathSymbol
        } else if is(&["CMTI", "CMSL"]) || name.contains("ITAL") || name.contains("OBLIQUE") {
            Face::Italic
        } else {
            Face::Body
        }
    }

    fn is_math(self) -> bool {
        matches!(self, Face::MathLetter | Face::MathSymbol)
    }

    fn is_italic(self) -> bool {
        matches!(self, Face::MathLetter | Face::Italic)
    }
}

/// The face of each string the page shows, in the order pdf-extract shows them. It reports glyphs without
/// their fonts, but calls `begin_word` once per string, so these line up with what it reports.
fn string_faces(doc: &Document, page: ObjectId) -> Vec<Face> {
    let Ok(content) = doc.get_page_content(page).and_then(|bytes| Content::decode(&bytes)) else {
        return Vec::new();
    };
    let fonts = doc.get_page_fonts(page).unwrap_or_default();
    let face_named = |name: &[u8]| {
        let base = fonts.get(name).and_then(|f| f.get(b"BaseFont").ok()).and_then(|b| b.as_name().ok());
        base.map_or(Face::Body, |b| Face::of(&String::from_utf8_lossy(b)))
    };
    let (mut face, mut saved, mut out) = (Face::Body, Vec::new(), Vec::new());
    for op in &content.operations {
        match op.operator.as_str() {
            "q" => saved.push(face),
            "Q" => face = saved.pop().unwrap_or(face),
            "Tf" => {
                if let Some(name) = op.operands.first().and_then(|o| o.as_name().ok()) {
                    face = face_named(name);
                }
            }
            "Tj" => out.push(face),
            "TJ" => {
                if let Some(Ok(items)) = op.operands.first().map(Object::as_array) {
                    out.extend(items.iter().filter(|o| matches!(o, Object::String(..))).map(|_| face));
                }
            }
            _ => {}
        }
    }
    out
}

#[derive(Default)]
struct Page {
    width: f64,
    height: f64,
    /// The top left of the MediaBox in the PDF's own coordinates.
    left: f64,
    top: f64,
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
    .unwrap_or_else(|_| Err(msg!("pdf.parseFailed")))
}

/// `skip_forms`: figures are form XObjects, whose labels are noise, and pdf-extract places text
/// inside a form without the transform that positions it on the page.
fn glyphs(bytes: &[u8], skip_forms: bool) -> Result<(Document, Vec<Page>), String> {
    let fail = |e: &dyn std::fmt::Debug| msg!("pdf.unreadable", error = format!("{e:?}"));
    let mut doc = Document::load_mem(bytes).map_err(|e| fail(&e))?;
    if doc.is_encrypted() {
        doc.decrypt("").map_err(|e| fail(&e))?;
    }
    // pdf-extract draws an image as if it were a form, parsing its pixels as operators, and
    // panics on some of them; an image holds no text.
    for o in doc.objects.values_mut() {
        if let Object::Stream(s) = o
            && s.dict.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Image" || (skip_forms && n == b"Form"))
        {
            s.set_plain_content(Vec::new());
        }
    }
    let faces = doc.get_pages().values().map(|&page| string_faces(&doc, page)).collect();
    let mut out = Glyphs { faces, ..Default::default() };
    pdf_extract::output_doc(&doc, &mut out).map_err(|e| fail(&e))?;
    Ok((doc, out.pages))
}

#[derive(Default)]
struct Glyphs {
    pages: Vec<Page>,
    origin: (f64, f64),
    /// `string_faces` of each page, and how many of the current page's strings have begun.
    faces: Vec<Vec<Face>>,
    shown: usize,
}

impl OutputDev for Glyphs {
    fn begin_page(&mut self, _: u32, b: &MediaBox, _: Option<(f64, f64, f64, f64)>) -> Result<(), OutputError> {
        self.origin = (b.llx, b.lly);
        self.shown = 0;
        self.pages.push(Page { width: b.urx - b.llx, height: b.ury - b.lly, left: b.llx, top: b.ury, glyphs: Vec::new() });
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        // Strings inside forms, which `string_faces` does not follow: the faces would be off by those.
        let index = self.pages.len().wrapping_sub(1);
        if self.faces.get(index).is_none_or(|f| f.len() != self.shown)
            && let Some(page) = self.pages.last_mut()
        {
            page.glyphs.iter_mut().for_each(|g| g.face = Face::Body);
        }
        Ok(())
    }

    fn output_character(&mut self, trm: &Transform, width: f64, _: f64, font_size: f64, text: &str) -> Result<(), OutputError> {
        // Rotated or mirrored text is a margin stamp (arXiv's) or a figure label, not prose.
        let upright = trm.m11 > 0. && trm.m22 > 0. && trm.m12.abs() < 1e-3 * trm.m11 && trm.m21.abs() < 1e-3 * trm.m22;
        let size = font_size.abs() * (trm.m11 * trm.m22).sqrt();
        let index = self.pages.len().wrapping_sub(1);
        let Some(page) = self.pages.last_mut().filter(|_| upright && size > 0.5) else {
            return Ok(());
        };
        let x = trm.m31 - self.origin.0;
        let face = self.faces.get(index).and_then(|f| f.get(self.shown.wrapping_sub(1))).copied().unwrap_or_default();
        page.glyphs.push(Glyph { x, y: page.height - (trm.m32 - self.origin.1), end: x + width * size, size, text: text.to_string(), face });
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        self.shown += 1;
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
    /// `text` with its scripts marked.
    marked: String,
    side: Side,
    /// Left and right edges of the column the line is in.
    left: f64,
    right: f64,
    /// Spaces too wide to be between words of prose: a justified line stretched those to 1.5 times
    /// the font size in the papers measured, a table's cells start at 2.1.
    wide_gaps: usize,
}

impl Line {
    /// A table row, or an equation and its label. One wide gap in a line that runs to the column's
    /// edge is a heading set in the paragraph's first line.
    fn tabular(&self) -> bool {
        self.wide_gaps > 1 || self.wide_gaps == 1 && self.x1 < self.right - 0.5 * self.size
    }
}

/// Glyphs in content order -> lines: a new line where the baseline moves, the pen jumps back
/// left, or it jumps the gutter in the middle of the page (columns written row by row). A script
/// is measured from the letter it belongs to: `e` with both a superscript and a subscript moves
/// further up and down than a line break would, and returns left to set the second under the first.
fn page_lines(page: usize, p: &Page) -> Vec<Line> {
    let mid = p.width / 2.;
    let mut groups: Vec<Vec<&Glyph>> = Vec::new();
    for g in &p.glyphs {
        let new_line = match groups.last().and_then(|l| Some((l.last()?, *l.iter().rev().find(|x| !is_script(x, l))?))) {
            None => true,
            Some((prev, letter)) => {
                let size = prev.size.max(g.size);
                let back = g.x < prev.x - size && (g.x < letter.x || g.size >= SCRIPT * letter.size);
                (g.y - letter.y).abs() > 0.6 * letter.size.max(g.size) || back || (prev.end < mid && g.x > mid && g.x - prev.end > 1.5 * size)
            }
        };
        match groups.last_mut() {
            Some(l) if !new_line => l.push(g),
            _ => groups.push(vec![g]),
        }
    }
    groups.iter().filter_map(|g| line(page, g)).collect()
}

/// A glyph this much smaller than the line's largest is a superscript or a subscript.
const SCRIPT: f64 = 0.85;

fn is_script(g: &Glyph, line: &[&Glyph]) -> bool {
    g.size < SCRIPT * line.iter().map(|x| x.size).fold(0., f64::max)
}

fn line(page: usize, glyphs: &[&Glyph]) -> Option<Line> {
    let ink: Vec<&&Glyph> = glyphs.iter().filter(|g| !g.text.trim().is_empty()).collect();
    // The size most of the line is set in: superscripts and inline symbols don't count.
    let mut sizes: HashMap<i64, usize> = HashMap::new();
    for g in &ink {
        *sizes.entry((g.size * 10.).round() as i64).or_default() += 1;
    }
    let main = sizes.iter().max_by_key(|(k, n)| (**n, **k)).map(|(k, _)| *k)?;
    let base = ink.iter().find(|g| (g.size * 10.).round() as i64 == main)?;
    let script_of = |g: &Glyph| match () {
        _ if g.size >= SCRIPT * base.size => None,
        _ if g.y < base.y - 0.1 * base.size => Some(SUP),
        _ if g.y > base.y + 0.1 * base.size => Some(SUB),
        _ => None,
    };
    let formula = formula_glyphs(glyphs);
    let mut text = String::new();
    let mut marked = String::new();
    let mut open = None;
    let (mut in_math, mut in_italic) = (false, false);
    let mut prev: Option<&Glyph> = None;
    let mut space = false;
    let mut gaps = Vec::new();
    let mut reach = f64::MIN;
    for (&g, &math) in glyphs.iter().zip(&formula) {
        if g.text.trim().is_empty() {
            space = true;
            continue;
        }
        let script = script_of(g);
        let italic = math && g.face.is_italic();
        if open.is_some() && open != script {
            marked.push(SCRIPT_END);
        }
        if in_italic && !italic {
            marked.push(ITALIC_END);
        }
        if in_math && !math {
            marked.push(MATH_END);
        }
        if let Some(p) = prev {
            gaps.push(g.x - reach);
            if space || g.x > p.end + 0.15 * p.size.min(g.size) {
                text.push(' ');
                marked.push(' ');
            }
        }
        if math && !in_math {
            marked.push(MATH);
        }
        if italic && !in_italic {
            marked.push(ITALIC);
        }
        if let Some(mark) = script.filter(|_| open != script) {
            marked.push(mark);
        }
        open = script;
        (in_math, in_italic) = (math, italic);
        reach = reach.max(g.end);
        space = false;
        push_clean(&mut text, &g.text);
        push_clean(&mut marked, &g.text);
        prev = Some(g);
    }
    if open.is_some() {
        marked.push(SCRIPT_END);
    }
    if in_italic {
        marked.push(ITALIC_END);
    }
    if in_math {
        marked.push(MATH_END);
    }
    let text = collapse(&text).trim().to_string();
    if text.is_empty() {
        return None;
    }
    let marked = collapse(&marked).trim().to_string();
    let x0 = ink.iter().map(|g| g.x).fold(f64::MAX, f64::min);
    let x1 = ink.iter().map(|g| g.end).fold(f64::MIN, f64::max);
    let wide_gaps = gaps.iter().filter(|&&gap| gap > 1.8 * main as f64 / 10.).count();
    Some(Line { page, x0, x1, y: base.y, size: main as f64 / 10., text, marked, side: Side::Full, left: x0, right: x1, wide_gaps })
}

/// Which of a line's glyphs make up a formula, which the page view then shows as printed: `t_abs(e)` or
/// `tt.earliest ≤ x` read badly set in Japanese type, and only the fonts tell them from prose. A word is
/// one by its math font, or in italics when it has a script, a call or a member (`TT.now()`) or is a
/// single letter. Prose in italics (*time master*) stays prose. An operator joins what it stands between,
/// and that brings in a short italic name or a number on its other side.
fn formula_glyphs(glyphs: &[&Glyph]) -> Vec<bool> {
    let mut words: Vec<std::ops::Range<usize>> = Vec::new();
    let mut prev: Option<&Glyph> = None;
    let mut space = false;
    for (i, &g) in glyphs.iter().enumerate() {
        if g.text.trim().is_empty() {
            space = true;
            continue;
        }
        match words.last_mut() {
            Some(w) if !space && prev.is_some_and(|p| g.x <= p.end + 0.15 * p.size.min(g.size)) => w.end = i + 1,
            _ => words.push(i..i + 1),
        }
        prev = Some(g);
        space = false;
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        Formula,
        ShortName,
        Number,
        Operator,
        Prose,
    }
    let kind = |w: &std::ops::Range<usize>| {
        let word = &glyphs[w.clone()];
        let text: String = word.iter().map(|g| g.text.as_str()).collect();
        let text = text.trim();
        let letters = text.chars().filter(|c| c.is_alphanumeric()).count();
        let alphabetic = text.chars().filter(|c| c.is_alphabetic()).count();
        let italic = word.iter().filter(|g| g.text.chars().any(char::is_alphanumeric)).all(|g| g.face.is_italic());
        let member = text.char_indices().any(|(i, c)| c == '.' && text[i + 1..].chars().next().is_some_and(char::is_alphabetic));
        if word.iter().any(|g| g.face.is_math())
            || (alphabetic > 0 && italic && (member || text.contains('(') || letters == 1 || word.iter().any(|g| is_script(g, glyphs))))
        {
            Kind::Formula
        } else if alphabetic > 0 && italic && letters <= 3 {
            Kind::ShortName
        } else if text.chars().all(|c| c.is_ascii_digit() || c == '.') {
            Kind::Number
        } else if letters == 0 && text.chars().all(|c| "=<>≤≥≠≈+-−*/×·∈→".contains(c)) {
            Kind::Operator
        } else {
            Kind::Prose
        }
    };
    let kinds: Vec<Kind> = words.iter().map(kind).collect();
    let is_formula = |i: Option<usize>, more: &[Kind]| i.and_then(|i| kinds.get(i)).is_some_and(|k| *k == Kind::Formula || more.contains(k));
    let mut joined: Vec<bool> = kinds.iter().map(|k| *k == Kind::Formula).collect();
    for i in 0..kinds.len() {
        if kinds[i] == Kind::Operator && is_formula(i.checked_sub(1), &[Kind::ShortName]) && is_formula(Some(i + 1), &[Kind::ShortName, Kind::Number]) {
            joined[i] = true;
        }
    }
    for i in 0..kinds.len() {
        let by_operator = |n: Option<usize>| n.is_some_and(|n| kinds.get(n) == Some(&Kind::Operator) && joined[n]);
        if matches!(kinds[i], Kind::ShortName | Kind::Number) && (by_operator(i.checked_sub(1)) || by_operator(Some(i + 1))) {
            joined[i] = true;
        }
    }
    let mut out = vec![false; glyphs.len()];
    let mut i = 0;
    while i < words.len() {
        if !joined[i] {
            i += 1;
            continue;
        }
        let first = i;
        while joined.get(i + 1) == Some(&true) {
            i += 1;
        }
        let (start, end) = trimmed(glyphs, words[first].start, words[i].end);
        out[start..end].iter_mut().for_each(|m| *m = true);
        i += 1;
    }
    out
}

/// A formula without the sentence's punctuation around it: the comma after `TT.now(),` and the
/// parenthesis of "(see `t`)". Those stay with the prose, where a period still ends the sentence.
fn trimmed(glyphs: &[&Glyph], mut start: usize, mut end: usize) -> (usize, usize) {
    let count = |s: usize, e: usize, c: &str| glyphs[s..e].iter().filter(|g| g.text == c).count();
    while end > start {
        let last = glyphs[end - 1].text.as_str();
        let unopened = last == ")" && count(start, end, ")") > count(start, end, "(");
        if matches!(last, "," | "." | ";" | ":") || last.trim().is_empty() || unopened {
            end -= 1;
        } else {
            break;
        }
    }
    if start < end && glyphs[start].text == "(" && count(start, end, "(") > count(start, end, ")") {
        start += 1;
    }
    (start, end)
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
    let Some(max) = lines.iter().filter(|l| top(l)).map(|l| l.size).reduce(f64::max).filter(|&m| m >= body * 1.3) else {
        return Front::default();
    };
    let Some(start) = lines.iter().position(|l| top(l) && l.size >= max - 0.5) else {
        return Front::default();
    };
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
    drafts(lines, body).into_iter().filter_map(|d| block(d, &vocab)).collect()
}

fn drafts(lines: &[Line], body: f64) -> Vec<Draft<'_>> {
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
                // A table's widest row would carry the short ones past `laid_out_text`.
                Kind::Paragraph if prev.tabular() || l.tabular() => false,
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
            drafts.push(Draft {
                kind: start.unwrap_or(if refs.is_some() {
                    Kind::Reference
                } else {
                    Kind::Paragraph
                }),
                lines: vec![l],
            });
        }
    }
    drop_figure_labels(&mut drafts);
    drafts
}

/// A line that carries on a sentence (lowercase, not indented) after a caption or a footnote,
/// and the stray labels around a figure: the paragraph it continues, if one before them is
/// unfinished.
fn interrupted(drafts: &[Draft], l: &Line, body: f64) -> Option<usize> {
    if !l.text.starts_with(char::is_lowercase) || l.x0 > l.left + 0.8 * l.size || l.tabular() {
        return None;
    }
    let float = |d: &Draft| d.kind == Kind::Caption || d.kind == Kind::Paragraph && d.lines.iter().all(|x| x.size < body * 0.95);
    let skipped: Vec<&Draft> = drafts.iter().rev().take_while(|d| float(d) || fragment(d)).collect();
    let i = drafts.len().checked_sub(skipped.len() + 1)?;
    let last = drafts[i].lines.last()?;
    let unfinished = drafts[i].kind == Kind::Paragraph && (last.size - body).abs() < 0.5 && !last.text.ends_with(['.', '!', '?', ':']);
    (unfinished && skipped.iter().any(|d| float(d))).then_some(i)
}

/// A short line on its own with no full stop, or one with cells: a figure's label, or an equation.
fn fragment(d: &Draft) -> bool {
    let l = d.lines[0];
    d.kind == Kind::Paragraph && d.lines.len() == 1 && (l.tabular() || l.x1 - l.x0 < 0.6 * (l.right - l.left) && !l.text.ends_with(['.', '!', '?', ':']))
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
    // "A Paxos leader" also opens a sentence: an appendix's bare letter counts only when set larger.
    let appendix = l.size >= body * 1.15 && first.len() == 1 && first.chars().all(|c| c.is_ascii_uppercase());
    if let Some(depth) = section_number(first).or(appendix.then_some(1)) {
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
    let name = if section_number(first).is_some() {
        rest
    } else {
        heading
    };
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
    if indented * 5 >= section.len() && indented > 0 {
        RefStyle::Hanging
    } else {
        RefStyle::Spaced
    }
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
    let Some(rest) = ["Figure", "Fig.", "Table", "Algorithm"].iter().find_map(|p| t.strip_prefix(p)) else {
        return false;
    };
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
    let Object::String(bytes, _) = dict.get(key).ok()? else {
        return None;
    };
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
    use pdf_extract::content::Operation;
    use pdf_extract::{Dictionary, Stream, StringFormat};

    /// One text run: x and baseline y from the top of a US Letter page, font size, text.
    pub(crate) type Run<'a> = (f64, f64, f64, &'a str);

    fn name(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }

    /// A PDF set in Helvetica, or Times-Italic for a run starting with this, the runs of each page
    /// written in the order given.
    const ITALIC_RUN: &str = "/i ";

    pub(crate) fn pdf(pages: &[Vec<Run>], title: Option<&str>) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type1"));
        font.set("BaseFont", name("Helvetica"));
        let font_id = doc.add_object(font);
        let mut italic = Dictionary::new();
        italic.set("Type", name("Font"));
        italic.set("Subtype", name("Type1"));
        italic.set("BaseFont", name("Times-Italic"));
        let italic_id = doc.add_object(italic);
        let mut kids = Vec::new();
        for runs in pages {
            let mut ops = Vec::new();
            for &(x, y, size, text) in runs {
                ops.push(Operation::new("BT", vec![]));
                let (font, text) = text.strip_prefix(ITALIC_RUN).map_or(("F1", text), |t| ("F2", t));
                ops.push(Operation::new("Tf", vec![name(font), Object::Real(size as f32)]));
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
            fonts.set("F2", Object::Reference(italic_id));
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
    fn regions_say_where_their_mediabox_lies() {
        let bytes = paper();
        let mut moved = Document::load_mem(&bytes).unwrap();
        for id in moved.get_pages().into_values().collect::<Vec<_>>() {
            moved.get_dictionary_mut(id).unwrap().set("MediaBox", Object::Array([10, 20, 622, 812].map(Object::Integer).to_vec()));
        }
        let mut out = Vec::new();
        moved.save_to(&mut out).unwrap();
        let (base, shifted) = (regions(&bytes).unwrap(), regions(&out).unwrap());
        assert_eq!((base[0].left, base[0].top), (0., 792.));
        assert_eq!((shifted[0].left, shifted[0].top), (10., 812.));
        // The glyphs did not move on the page, so each box comes to the same place in the PDF's coordinates.
        assert!((shifted[0].left + shifted[0].x0 - (base[0].left + base[0].x0)).abs() < 1e-6);
        assert!((shifted[0].top - shifted[0].y0 - (base[0].top - base[0].y0)).abs() < 1e-6);
    }

    #[test]
    fn regions_place_the_blocks_and_split_those_broken_across_columns_and_figures() {
        let r = regions(&paper()).unwrap();
        let at = |t: &str| r.iter().find(|x| x.text.starts_with(t)).unwrap_or_else(|| panic!("no region for {t}"));
        let abs = at("We study");
        assert_eq!(abs.page, 0);
        assert_eq!(abs.level, None);
        assert_eq!(at("1 Introduction").level, Some(2));
        assert_eq!(at("2.1 Running headers").level, Some(3));
        assert!(abs.text.ends_with("representation of columns."), "lines joined as in the block: {}", abs.text);
        assert_eq!((abs.x0, abs.y0, abs.y1), (L, 155., 216.), "from the top of the first line to below the last");
        assert!(abs.x1 > L && abs.x1 < R);
        assert_eq!(at("Most papers").x0, L, "the paragraph's left column");
        assert_eq!(at("reading order").x0, R, "and its right column");
        assert!(at("A paragraph that runs").y1 < at("figure before").y0, "the figure between the pieces stays uncovered");
        assert_eq!(at("figure before").page, 2);
    }

    /// Glyphs as a line would have them, one per character, with `|` starting and ending a stretch in `face`.
    fn glyphs_of(text: &str, face: Face) -> Vec<Glyph> {
        let mut x = 72.;
        let mut inside = false;
        let mut out = Vec::new();
        for c in text.chars() {
            if c == '|' {
                inside = !inside;
                continue;
            }
            let face = if inside {
                face
            } else {
                Face::Body
            };
            out.push(Glyph { x, y: 100., end: x + 5., size: 10., text: c.to_string(), face });
            x += 5.;
        }
        out
    }

    /// `text` with the glyphs of its formulas in brackets.
    fn formulas(text: &str, face: Face) -> String {
        let glyphs = glyphs_of(text, face);
        let refs: Vec<&Glyph> = glyphs.iter().collect();
        let mut out = String::new();
        let mut open = false;
        for (g, math) in refs.iter().zip(formula_glyphs(&refs)) {
            if math != open && (open || !g.text.trim().is_empty()) {
                out.push(if math {
                    '['
                } else {
                    ']'
                });
                open = math;
            }
            out.push_str(&g.text);
        }
        if open {
            out.push(']');
        }
        out
    }

    #[test]
    fn a_formula_is_told_from_prose_by_its_font_and_its_shape() {
        let italic = |t| formulas(t, Face::Italic);
        assert_eq!(italic("for |tt| = |TT.now()|, where"), "for [tt = TT.now()], where", "an operator brings in the short name beside it");
        assert_eq!(italic("the |time master| and |timeslave daemon| run"), "the time master and timeslave daemon run", "prose in italics");
        assert_eq!(italic("|In| Proc. |of| the"), "In Proc. of the", "short italic words on their own");
        assert_eq!(italic("an event |e| happens"), "an event [e] happens");
        assert_eq!(italic("(see |tt.latest|) and"), "(see [tt.latest]) and");
        assert_eq!(italic("a = b and 3 - 2"), "a = b and 3 - 2", "no italics, no formula");
        assert_eq!(italic("|2.2| Crush and |7|"), "2.2 Crush and 7", "a section's number in italics");

        let math = |t| formulas(t, Face::MathLetter);
        assert_eq!(math("then |s| > 5."), "then [s > 5].", "a number beyond an operator, not the sentence's period");
        assert_eq!(math("if (|x|) and"), "if [(x)] and", "its parentheses");
        assert_eq!(formulas("|≤| and", Face::MathSymbol), "[≤] and");
    }

    #[test]
    fn faces_follow_the_font_names_with_or_without_a_subset_prefix() {
        for (font, face) in [
            ("GMFWUF+CMMI10", Face::MathLetter),
            ("ACCOFV+CMSY10", Face::MathSymbol),
            ("Symbol", Face::MathSymbol),
            ("QJOIDE+NimbusRomNo9L-ReguItal", Face::Italic),
            ("Times-Italic", Face::Italic),
            ("Helvetica-Oblique", Face::Italic),
            ("COIEQL+NimbusRomNo9L-Regu", Face::Body),
            ("EGYAWT+CMR10", Face::Body),
        ] {
            assert_eq!(Face::of(font), face, "{font}");
        }
    }

    #[test]
    fn a_formula_goes_as_printed_and_the_rest_to_be_translated() {
        let line: Vec<Run> = vec![
            (72., 100., 10., "Denote the absolute time of an event"),
            (240., 100., 10., "/i e"),
            (250., 100., 10., "by the clock of the machine that saw it happen."),
        ];
        let r = regions(&pdf(&[line], None)).unwrap();
        let math: Vec<(&str, bool)> = r[0].runs.iter().filter(|run| run.math).map(|run| (run.text.as_str(), run.italic)).collect();
        assert_eq!(math, [("e", true)]);
        assert_eq!(r[0].runs.iter().map(|run| run.text.as_str()).collect::<String>(), r[0].text, "the runs add up to the text");
        assert_eq!(r[0].translated_text(), "Denote the absolute time of an event  by the clock of the machine that saw it happen.");
        assert!(
            to_ir(&pdf(&[vec![(72., 100., 10., "An event"), (120., 100., 10., "/i e"), (130., 100., 10., "happens.")]], None), None)
                .unwrap()
                .blocks
                .iter()
                .any(|b| b.text.contains("An event e happens.")),
            "the Reader keeps it as text"
        );
    }

    #[test]
    fn only_regions_at_the_edge_of_the_text_have_the_margin_as_room() {
        let lines = |y: f64| {
            [
                (72., y, 10., "A paragraph at this place on the page runs across the whole of the column and ends."),
                (72., y + 12., 10., "It has a second line too."),
            ]
        };
        let page = |header: bool| {
            let mut runs: Vec<Run> = Vec::new();
            if header {
                runs.push((72., 50., 10., "Running Header Of The Paper"));
            }
            for y in [100., 400., 700.] {
                runs.extend(lines(y));
            }
            runs
        };
        let r = regions(&pdf(&[page(false)], None)).unwrap();
        let at = |r: &[Region], i: usize| (r[i].room_up.round(), r[i].room_down.round());
        assert_eq!(at(&r, 0).1, 0.);
        assert_eq!(at(&r, 0).0, (r[0].y0 - 0.05 * 792.).round(), "to the page's outer edge");
        assert_eq!(at(&r, 1), (0., 0.), "the middle of the page has other text around it");
        assert_eq!(at(&r, 2).0, 0.);
        assert_eq!(at(&r, 2).1, (0.95 * 792. - r[2].y1).round());

        let r = regions(&pdf(&[page(true), page(true), page(true)], None)).unwrap();
        assert!(r.iter().all(|x| !x.text.contains("Running")), "dropped as a header, though still printed");
        assert_eq!(at(&r, 0).0, (r[0].y0 - 53.).round(), "it stops at the header");
    }

    #[test]
    fn the_pieces_of_a_block_share_it_across_columns_and_pages() {
        let r = regions(&paper()).unwrap();
        let block = |t: &str| r.iter().find(|x| x.text.starts_with(t)).unwrap_or_else(|| panic!("no region for {t}")).block;
        assert_eq!(block("Most papers"), block("reading order"), "across columns");
        assert_ne!(block("We study"), block("Most papers"), "another block");

        let first: Vec<Run> = vec![
            (L, 100., 10., "The leader sends every write to all of the replicas and then waits"),
            (L, 112., 10., "until a majority of them has answered with the same stored value and"),
        ];
        let second: Vec<Run> =
            vec![(L, 100., 10., "only then does it tell the client that the write has been committed"), (L, 112., 10., "to the log for good.")];
        let r = regions(&pdf(&[first, second], None)).unwrap();
        let places: Vec<(usize, usize)> = r.iter().map(|x| (x.page, x.block)).collect();
        assert_eq!(places, [(0, r[0].block), (1, r[0].block)], "across pages");
    }

    #[test]
    fn a_sentence_broken_across_columns_goes_whole_to_the_piece_with_most_of_it() {
        let column = |x: f64, lines: [&'static str; 3]| lines.into_iter().enumerate().map(move |(i, t)| (x, 100. + 12. * i as f64, 10., t));
        let page: Vec<Run> = column(L, ["Unlike storage has proven much more hard", "and most of them all need the new", "hardware to change. To-"])
            .chain(column(
                R,
                ["day these changes mainly come in the form", "of newer memory designs and there are many", "more of them coming along every year now."],
            ))
            .collect();
        let r = regions(&pdf(&[page], None)).unwrap();
        let texts: Vec<&str> = r.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Unlike storage has proven much more hard and most of them all need the new hardware to change.",
                "Today these changes mainly come in the form of newer memory designs and there are many more of them coming along every year now."
            ]
        );
        assert_eq!((r[0].x0, r[1].x0), (L, R), "each box stays over its own column");
        assert_eq!(r[0].y1, 124. + 3., "and the first still covers the word's start");
    }

    #[test]
    fn regions_leave_out_what_a_figure_or_table_draws_but_keep_it_for_the_reader() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "Over the years personal computers and many other servers came to use a chipset of two parts, the one we show."),
            (140., 130., 10., "CPU1 CPU2"),
            (105., 160., 10., "Southbridge PCI-E SATA"),
            (L, 200., 10., "Figure 2.1: Structure with two bridges"),
            (L, 230., 10., "This short line ends with a stop."),
            (L, 260., 10., "133MHz 266MHz 4,256MB/s PC2-4200"),
        ];
        let bytes = pdf(&[page], None);
        let texts: Vec<String> = regions(&bytes).unwrap().into_iter().map(|r| r.text).collect();
        assert!(texts.iter().any(|t| t.starts_with("Over the years")), "{texts:?}");
        assert!(texts.iter().any(|t| t.starts_with("Figure 2.1")), "{texts:?}");
        assert!(texts.iter().any(|t| t.starts_with("This short line")), "{texts:?}");
        assert!(!texts.iter().any(|t| t.contains("CPU1") || t.contains("Southbridge") || t.contains("133MHz")), "{texts:?}");
        assert!(to_ir(&bytes, None).unwrap().blocks.iter().any(|b| b.text.contains("133MHz")), "the Reader keeps the table text");
    }

    /// Two columns of prose, so the page reads as a two-column one.
    fn columns() -> Vec<Run<'static>> {
        (0..12)
            .flat_map(|i| {
                let y = 300. + 12. * i as f64;
                [(L, y, 10., "Some prose that runs along the whole of its column,"), (R, y, 10., "and more prose running along the whole of its one,")]
            })
            .collect()
    }

    #[test]
    fn regions_leave_out_a_table_whose_rows_span_the_band() {
        let mut page: Vec<Run> = vec![
            (120., 100., 9., "Read-Only Transaction"),
            (300., 100., 9., "lock-free"),
            (400., 100., 9., "leader for timestamp; any for"),
            (400., 111., 9., "read, subject to 4.1.3"),
            (120., 122., 9., "Snapshot Read, client-provided timestamp"),
            (345., 122., 9., "lock-free"),
            (400., 122., 9., "any, subject to 4.1.3"),
            (120., 133., 9., "Snapshot Read, client-provided bound"),
            (345., 133., 9., "lock-free"),
            (400., 133., 9., "any, subject to 4.1.3"),
            (179., 160., 9., "Table 2: Types of reads and writes, and how they compare."),
        ];
        page.extend(columns());
        let bytes = pdf(&[page], None);
        let texts: Vec<String> = regions(&bytes).unwrap().into_iter().map(|r| r.text).collect();
        assert!(texts.iter().any(|t| t.starts_with("Table 2")), "{texts:?}");
        assert!(texts.iter().any(|t| t.starts_with("Some prose")), "{texts:?}");
        assert!(!texts.iter().any(|t| t.contains("lock-free") || t.contains("subject to") || t.contains("Snapshot")), "{texts:?}");
        assert!(to_ir(&bytes, None).unwrap().blocks.iter().any(|b| b.text.contains("Snapshot Read")), "the Reader keeps the table text");
    }

    #[test]
    fn a_heading_set_in_a_paragraphs_first_line_is_not_a_table_row() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "Single Threaded Access"),
            (L + 130., 100., 10., "The simplest case is a walk"),
            (L, 112., 10., "over all of the entries in the list, which are"),
            (L, 124., 10., "laid out in a row one after another in memory."),
        ];
        let r = regions(&pdf(&[page], None)).unwrap();
        assert_eq!(r.len(), 1, "{:?}", r.iter().map(|x| &x.text).collect::<Vec<_>>());
        assert!(r[0].text.starts_with("Single Threaded Access The simplest") && r[0].text.ends_with("in memory."), "{}", r[0].text);
    }

    #[test]
    fn stacked_scripts_stay_on_their_line() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "Each replica grants a lease at lease e"),
            (L + 164., 96.4, 7., "grant"),
            (L + 164., 103., 7., "i,r"),
            (L + 182., 100., 10., ", after it"),
            (L, 112., 10., "receives a lease request from the leader of it."),
        ];
        let bytes = pdf(&[page], None);
        let r = regions(&bytes).unwrap();
        assert_eq!(r.len(), 1, "{:?}", r.iter().map(|x| &x.text).collect::<Vec<_>>());
        assert!(r[0].text.starts_with("Each replica") && r[0].text.contains(", after it receives"), "{}", r[0].text);
        assert_eq!((r[0].y0, r[0].y1), (90., 115.));
        let scripts: Vec<_> = r[0].runs.iter().filter_map(|run| run.script.map(|s| (s, run.text.as_str()))).collect();
        assert_eq!(scripts, [("sup", "grant"), ("sub", "i,r")]);
        assert_eq!(r[0].runs.iter().map(|run| run.text.as_str()).collect::<String>(), r[0].text, "the runs add up to the text");
        let ir = to_ir(&bytes, None).unwrap();
        assert!(ir.blocks[0].text.contains("granti,r"), "the Reader's text stays plain: {}", ir.blocks[0].text);
    }

    #[test]
    fn an_appendix_heading_filling_its_column_ends_the_references() {
        let page: Vec<Run> = vec![
            (L, 100., 8., "[1] A. Author. A study of reading in columns. 2020."),
            (L, 130., 12., "A Paxos Leader-Lease Management"),
            (L, 150., 10., "The simplest means to ensure the disjointness is a"),
            (L, 162., 10., "write of the lease interval each time it is extended,"),
            (L, 174., 10., "and a later leader reads it and waits until it ends."),
            (L, 198., 10., "A Paxos leader keeps a lower bound on the lease."),
        ];
        let mut all = vec![(L, 80., 12., "References")];
        all.extend(page);
        let ir = to_ir(&pdf(&[all], None), None).unwrap();
        let heading = ir.blocks.iter().find(|b| b.text.starts_with("A Paxos Leader")).expect("the heading");
        assert_eq!((heading.kind.as_str(), heading.text.as_str(), heading.attrs.level), ("heading", "A Paxos Leader-Lease Management", Some(2)));
        let simple = ir.blocks.iter().find(|b| b.text.starts_with("The simplest")).expect("the paragraph");
        assert_eq!(simple.kind.as_str(), "paragraph");
        assert!(ir.blocks.iter().any(|b| b.kind.as_str() == "paragraph" && b.text.starts_with("A Paxos leader")), "a sentence at body size is no heading");
    }

    #[test]
    fn sentence_ends_skip_abbreviations() {
        let text = "See Fig. 3 for it. Then e.g. this \"one.\" Next one. 日本語の文。次の文";
        let ends: Vec<&str> = sentence_ends(text).into_iter().map(|e| &text[e..]).collect();
        assert_eq!(ends, ["Then e.g. this \"one.\" Next one. 日本語の文。次の文", "Next one. 日本語の文。次の文", "次の文"]);
        assert_eq!(word_break("one two", 5), 4);
        assert_eq!(word_break("日本語", 1), 3, "no space, and never inside a character");
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
    fn image_data_is_not_read_as_content() {
        // pdf-extract reads an image XObject's data as a content stream, and an image in
        // Designing Data-Intensive Applications decodes to a `CS` with no operand, where it panicked.
        let body = vec![(L, 120., 10., "A paragraph next to a figure drawn as an image.")];
        let mut doc = Document::load_mem(&pdf(&[body], None)).unwrap();
        let mut dict = Dictionary::new();
        dict.set("Type", name("XObject"));
        dict.set("Subtype", name("Image"));
        dict.set("Width", Object::Integer(1));
        dict.set("Height", Object::Integer(1));
        dict.set("ColorSpace", name("DeviceGray"));
        dict.set("BitsPerComponent", Object::Integer(8));
        let image = doc.add_object(Stream::new(dict, b"CS".to_vec()));
        let page = *doc.get_pages().values().next().unwrap();
        let mut xobjects = Dictionary::new();
        xobjects.set("Im0", Object::Reference(image));
        let page_dict = doc.get_object_mut(page).and_then(Object::as_dict_mut).unwrap();
        let content = page_dict.get(b"Contents").and_then(Object::as_reference).unwrap();
        page_dict.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
        let mut ops = stream.content.clone();
        ops.extend_from_slice(b"\nq /Im0 Do Q\n");
        stream.set_plain_content(ops);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "A paragraph next to a figure drawn as an image.")]);
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
