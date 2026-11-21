//! PDF (typically a research paper) -> Article IR. The original bytes are the snapshot, so
//! re-extraction needs no network. A PDF fetched from a URL is an ordinary article of that URL;
//! a file the user picked has none: its identity is `local:pdf/<sha256 of the bytes>`.
//!
//! pdf-extract reports each glyph with its position and size, and the layout is rebuilt here:
//! lines, two-column reading order, running headers and page numbers, title, headings,
//! paragraphs (with hyphenated line breaks joined), captions and the reference list.

use std::borrow::Cow;
use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::rc::Rc;
use std::sync::LazyLock;

use pdf_extract::content::{Content, Operation};
use pdf_extract::{Dictionary, Document, MediaBox, Object, ObjectId, OutputDev, OutputError, Stream, Transform};
use serde::{Deserialize, Serialize};

use crate::extract::collapse;
use crate::images;
use crate::ir::{ArticleIr, ArticleMeta, Block, BlockAttrs, BlockKind, Inline};
use crate::markdown::joins_without_space;
use crate::msg;
use crate::pdf_image::Format;
use crate::pdf_japan1;
use crate::pdf_worker::{self, Request, Session};
use crate::store::{NewSnapshot, Store, hex, sha256_hex};

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
        images::enqueue(store, id)?;
    }
    Ok(id)
}

/// A PDF fetched from a URL: like a page, a failed extraction is recorded on the article. A worker that did not start
/// fails the job as well, which fetches the PDF again on its next try.
pub fn store_fetched(store: &Store, id: i64, final_url: &str, bytes: &[u8]) -> Result<i64, String> {
    let read = to_ir(bytes, None);
    let unstarted = worker_failed(&read);
    let id = store.save_snapshot(id, Some(&snapshot(final_url, bytes)), read, None).map_err(err)?;
    images::enqueue(store, id)?;
    unstarted.map_or(Ok(id), Err)
}

/// Extracts the stored bytes again; the title the app found (not the user's name) is the fallback, as on import. A
/// worker that did not start leaves the article as it is.
pub fn reextract(store: &Store, id: i64, bytes: &[u8]) -> Result<i64, String> {
    let title = store.article_row(id).map_err(err)?.and_then(|a| a.auto_title.or(a.title));
    let read = to_ir(bytes, title.as_deref());
    if let Some(e) = worker_failed(&read) {
        return Err(e);
    }
    let id = store.save_snapshot(id, None, read, None).map_err(err)?;
    images::enqueue(store, id)?;
    Ok(id)
}

/// The error of a worker that did not start, which says nothing about the PDF.
fn worker_failed(read: &Result<ArticleIr, String>) -> Option<String> {
    read.as_ref().err().filter(|e| **e == msg!("pdf.workerFailed")).cloned()
}

fn snapshot<'a>(url: &'a str, bytes: &'a [u8]) -> NewSnapshot<'a> {
    NewSnapshot { final_url: url, status: 200, content_type: Some(CONTENT_TYPE), body: bytes }
}

/// Title: the first page's largest text, else the document's own (when it reads like one),
/// else `fallback`, else the first line.
pub fn to_ir(bytes: &[u8], fallback: Option<&str>) -> Result<ArticleIr, String> {
    pdf_worker::ask(Request::Ir { fallback: fallback.map(str::to_owned) }, bytes, || ir(bytes, fallback))
}

fn ir(bytes: &[u8], fallback: Option<&str>) -> Result<ArticleIr, String> {
    let doc = read(bytes)?;
    let (lines, body, front) = lay_out(&doc);
    let blocks = to_blocks(&lines, body, &figures(&doc), &figure_prefix(bytes));
    let Some(first) = blocks.iter().find(|b| b.kind != BlockKind::Image) else {
        return Err(msg!("pdf.noText"));
    };
    let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let first_line = || Some(first.text.chars().take(80).collect::<String>());
    let title = front.title.or(doc.title.filter(|t| reads_like_title(t))).or_else(|| fallback.and_then(non_empty)).or_else(first_line);
    let author = front.author.or(doc.author.filter(|a| a.contains(' ')));
    Ok(ArticleIr { meta: ArticleMeta { title, author, published_at: doc.created, ..Default::default() }, blocks })
}

/// Where a run of body text sits on its page, in points from the page's top left, for the Page
/// view to draw its translation over the original.
#[derive(Debug, Serialize, Deserialize)]
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
    /// How far a single line may run to its sides, in points: to the edges of its column, or to what else is
    /// printed on the line. The viewer widens it before it goes up or down, where a frame may be drawn.
    pub room_left: f64,
    pub room_right: f64,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct TextRun {
    pub text: String,
    /// The element that sets it.
    pub script: Option<Script>,
    /// Part of a formula (`formula_glyphs`): shown as it stands, never sent to be translated.
    pub math: bool,
    /// Set in italics, inside a formula: elsewhere translation would not keep it.
    pub italic: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Script {
    Sub,
    Sup,
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
            SUP => script = Some(Script::Sup),
            SUB => script = Some(Script::Sub),
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
    pdf_worker::ask(Request::Regions, bytes, || std::panic::catch_unwind(|| laid_out_regions(bytes)).unwrap_or_else(|_| Err(msg!("pdf.parseFailed"))))
}

fn laid_out_regions(bytes: &[u8]) -> Result<Vec<Region>, String> {
    let doc = read(bytes)?;
    let (lines, body, _) = lay_out(&doc);
    let vocab = vocabulary(&lines);
    let run_on = |a: &&Line, b: &&Line| a.page == b.page && a.side == b.side && b.y > a.y && b.y - a.y < 2.5 * a.size.max(b.size);
    let mut out = Vec::new();
    // shortcut: a turned page has no regions, as a box over a column would need turning back and a translation set
    // down it; give them one when vertical text turns up for the Page view to translate.
    let on_upright_page = |piece: &[&Line]| doc.pages.get(piece[0].page).is_some_and(|p| !p.vertical);
    for (block, d) in drafts(&lines, body).iter().enumerate().filter(|(_, d)| !laid_out_text(d)) {
        let level = if let Kind::Heading(l) = d.kind {
            Some(l)
        } else {
            None
        };
        let pieces: Vec<&[&Line]> = d.lines.chunk_by(run_on).collect();
        let texts = pieces.iter().zip(piece_texts(&pieces, &vocab)).filter(|(piece, _)| on_upright_page(piece));
        out.extend(texts.filter_map(|(piece, text)| region(piece, text, level, block)));
    }
    // A turned page's lines lie across its height, not down it.
    let upright: Vec<&Line> = lines.iter().filter(|l| doc.pages.get(l.page).is_some_and(|p| !p.vertical)).collect();
    let top = upright.iter().map(|l| l.y - l.size).fold(f64::MAX, f64::min);
    let bottom = upright.iter().map(|l| l.y + 0.3 * l.size).fold(f64::MIN, f64::max);
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
    // Only a single line has room at its sides (`region`), so the box's bottom gives its baseline.
    if r.room_left > 0. || r.room_right > 0. {
        let base = r.y1 - 0.3 * r.size;
        let beside = |g: &&Glyph| (g.y - base).abs() < 0.6 * r.size && !g.text.trim().is_empty();
        r.room_left = page.glyphs.iter().filter(beside).filter(|g| g.end <= r.x0).map(|g| r.x0 - g.end).fold(r.room_left, f64::min);
        r.room_right = page.glyphs.iter().filter(beside).filter(|g| g.x >= r.x1).map(|g| g.x - r.x1).fold(r.room_right, f64::min);
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
/// would then keep showing the original, goes whole to the other piece if that holds a third of it: cut through,
/// neither piece would be whole sentences, which are all the block's saved translation can show
/// (`translate::saved_units`). Otherwise it is cut between words.
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
    for (i, &at) in breaks.iter().enumerate() {
        let before = ends.iter().rev().find(|&&e| e <= at).copied().unwrap_or(0);
        let after = ends.iter().find(|&&e| e > at).copied().unwrap_or(whole.len());
        let (most, rest) = if at - before > after - at {
            (after, before)
        } else {
            (before, after)
        };
        // The side with less of the sentence takes it only if it has a third: the viewer's smallest type gives a letter
        // about a quarter of the area (`FIT_STEPS`), so its box then still shows the sentence.
        let rest = (3 * (at - before).min(after - at) >= after - before).then_some(rest);
        // Short of the next piece's end, or the piece after this one is left empty.
        // shortcut: each break is decided alone, so in a block of three or more pieces a move can leave the next break
        // no whole-sentence cut; look one break ahead if such blocks turn up in real PDFs.
        let next = breaks.get(i + 1).copied().unwrap_or(whole.len());
        let cut = [Some(most), rest].into_iter().flatten().find(|&c| c > start && c < next).unwrap_or_else(|| word_break(&whole, at).max(start));
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
    let (room_left, room_right) = match piece {
        [l] => ((l.x0 - l.left).max(0.), (l.right - l.x1).max(0.)),
        _ => (0., 0.),
    };
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
        room_left,
        room_right,
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
    /// Set in vertical writing, where `x` is the middle of the column and `y` the top of the glyph's em box.
    vertical: bool,
    /// Turned a quarter clockwise to run down the page, and placed as in vertical writing: Latin set down a column on a
    /// page that is `turn`ed. On any other page it is a label, and dropped.
    turned: bool,
}

/// How far a Japanese font's em box rises above its baseline, in ems.
const ASCENT: f64 = 0.88;

/// What `walk` learns of a string from its font.
#[derive(Clone, Copy, Default)]
struct Style {
    face: Face,
    vertical: bool,
    /// In vertical writing, how far below where a glyph is placed its em box starts, in ems. The glyph's place is its
    /// vertical origin, which the font's `DW2` puts so far above the baseline: 0.88 em unless it says otherwise.
    top: f64,
    /// Shown where the string before it on the page left the pen: a string of a TJ after its first, or one that nothing
    /// placed since the last.
    goes_on: bool,
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

/// An image drawn on a page: what the clip leaves of the unit square through the CTM, in points from the page's top left
/// like a `Glyph`.
struct Drawn {
    id: ObjectId,
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

/// The styles and the images `walk` finds on a page.
type Walked = (Vec<Style>, Vec<Drawn>);

/// What a page's content shows beside what pdf-extract reports, which is glyphs without their fonts and no images: the
/// style of each string, in the order pdf-extract shows them, and the images, in the PDF's own coordinates. pdf-extract
/// calls `begin_word` once per string, so the styles line up with what it reports. Images inside forms, and inline
/// images, are not followed. A clip counts by the box around its path.
// shortcut: the Reader shows a clipped image whole (cropping a JPEG or predicted rows means decoding them); crop the
// pixels when a figure's hidden part turns out to matter.
fn walk(doc: &Document, page: ObjectId, resources: Option<&Dictionary>) -> Walked {
    let Ok(content) = doc.get_page_content(page).and_then(|bytes| Content::decode(&bytes)) else {
        return (Vec::new(), Vec::new());
    };
    let fonts = resources.and_then(|r| r.get_deref(b"Font", doc).and_then(Object::as_dict).ok());
    let style_named = |name: &[u8]| {
        let font = fonts.and_then(|f| f.get_deref(name, doc).and_then(Object::as_dict).ok());
        let base = font.and_then(|f| f.get(b"BaseFont").ok()).and_then(|b| b.as_name().ok());
        let vertical = font.filter(|f| writes_down(doc, f));
        let vy = vertical.and_then(|f| cid_font(doc, f)?.get_deref(b"DW2", doc).and_then(Object::as_array).ok()?.first()?.as_float().ok());
        let top = vy.map_or(0., |v| f64::from(v) / 1000. - ASCENT);
        let vertical = vertical.is_some();
        Style { face: base.map_or(Face::Body, |b| Face::of(&String::from_utf8_lossy(b))), vertical, top, goes_on: false }
    };
    let images = page_images(doc, resources);
    let (mut style, mut ctm, mut saved, mut styles, mut drawn) = (Style::default(), Transform::identity(), Vec::new(), Vec::new(), Vec::new());
    let (mut clip, mut path, mut clipping, mut mode, mut invisible) = (None, NOTHING, false, 0, false);
    // Whether the pen is where the last string left it.
    let mut goes_on = false;
    let numbers = |op: &Operation| op.operands.iter().filter_map(|o| o.as_float().ok()).map(f64::from).collect::<Vec<_>>();
    for op in &content.operations {
        if matches!(op.operator.as_str(), "BT" | "Td" | "TD" | "Tm" | "T*" | "cm" | "q" | "Q") {
            goes_on = false;
        }
        match op.operator.as_str() {
            "q" => saved.push((style, ctm, clip, mode)),
            "Q" => (style, ctm, clip, mode) = saved.pop().unwrap_or((style, ctm, clip, mode)),
            "cm" => {
                if let [a, b, c, d, e, f] = numbers(op)[..] {
                    ctm = ctm.pre_transform(&Transform::row_major(a, b, c, d, e, f));
                }
            }
            "re" => {
                if let [x, y, w, h] = numbers(op)[..] {
                    path = union(path, bounds(&ctm, &[(x, y), (x + w, y), (x, y + h), (x + w, y + h)]));
                }
            }
            "m" | "l" | "c" | "v" | "y" => path = union(path, bounds(&ctm, &numbers(op).as_chunks::<2>().0.iter().map(|&[x, y]| (x, y)).collect::<Vec<_>>())),
            "W" | "W*" => clipping = true,
            // The path ends here, and a clip it was marked for starts. pdf.js clips nothing for an empty path.
            "n" | "f" | "F" | "f*" | "S" | "s" | "B" | "B*" | "b" | "b*" => {
                if clipping && path != NOTHING {
                    clip = Some(clip.map_or(path, |c| intersect(c, path)));
                }
                (path, clipping) = (NOTHING, false);
            }
            "Do" => {
                // The Reader shows the pixels as stored, so an image the page mirrors, turns over or turns 45 degrees
                // or more would show the wrong way round there: it stays in the Page view.
                let upright = ctm.m11 > ctm.m12.abs() && ctm.m22 > ctm.m21.abs();
                if upright && let Some(&id) = op.operands.first().and_then(|o| o.as_name().ok()).and_then(|n| images.get(n)) {
                    let unit = bounds(&ctm, &[(0., 0.), (1., 0.), (0., 1.), (1., 1.)]);
                    let [x0, y0, x1, y1] = clip.map_or(unit, |c| intersect(unit, c));
                    if x0 < x1 && y0 < y1 {
                        drawn.push(Drawn { id, x0, y0, x1, y1 });
                    }
                }
            }
            "Tf" => {
                if let Some(name) = op.operands.first().and_then(|o| o.as_name().ok()) {
                    style = style_named(name);
                }
            }
            "Tr" => mode = op.operands.first().and_then(|o| o.as_i64().ok()).unwrap_or(0),
            "Tj" => {
                styles.push(Style { goes_on, ..style });
                goes_on = true;
                invisible |= mode == 3;
            }
            "TJ" => {
                if let Some(Ok(items)) = op.operands.first().map(Object::as_array) {
                    for _ in items.iter().filter(|o| matches!(o, Object::String(..))) {
                        styles.push(Style { goes_on, ..style });
                        goes_on = true;
                    }
                }
                invisible |= mode == 3;
            }
            _ => {}
        }
    }
    // Text drawn invisibly is what OCR lays over a scanned page: its images are the page, not figures in it. Text a
    // form draws is not read, so OCR text put inside a form does not count.
    if invisible {
        drawn.clear();
    }
    (styles, drawn)
}

/// A box as x0, y0, x1 and y1, in the PDF's own coordinates.
type Bounds = [f64; 4];

/// The box around no points, which every union widens and every intersection keeps empty.
const NOTHING: Bounds = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];

fn bounds(t: &Transform, points: &[(f64, f64)]) -> Bounds {
    let at = |&(x, y): &(f64, f64)| (x * t.m11 + y * t.m21 + t.m31, x * t.m12 + y * t.m22 + t.m32);
    points.iter().map(at).fold(NOTHING, |b, (x, y)| [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)])
}

fn union(a: Bounds, b: Bounds) -> Bounds {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

fn intersect(a: Bounds, b: Bounds) -> Bounds {
    [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])]
}

/// The image XObjects in a `Format` the Reader shows, by the names a page with these resources draws them with.
fn page_images(doc: &Document, resources: Option<&Dictionary>) -> HashMap<Vec<u8>, ObjectId> {
    let Some(xobjects) = resources.and_then(|r| r.get_deref(b"XObject", doc).and_then(Object::as_dict).ok()) else {
        return HashMap::new();
    };
    let shown = |id: ObjectId| doc.get_object(id).and_then(Object::as_stream).is_ok_and(|s| is_image(s) && Format::of(doc, &s.dict).is_some());
    xobjects.iter().filter_map(|(name, o)| o.as_reference().ok().filter(|&id| shown(id)).map(|id| (name.clone(), id))).collect()
}

/// More levels than a page tree has: writers balance it, so even a million pages two to a node are 20 deep. Few enough
/// that pdf-extract's recursion up them stays well inside the stack.
const PAGE_TREE_DEPTH: usize = 256;

/// A page's own `key`, or else the nearest the page tree gives it, written in place or referred to: the entry pdf-extract
/// takes for a page's Resources and MediaBox. Like pdf-extract, the walk passes over an entry `found` refuses; it also
/// passes over a reference to nothing, where pdf-extract panics. (lopdf's `get_page_resources` skips resources written
/// into the page tree.) Fails past `PAGE_TREE_DEPTH` levels, which only a loop or a chain made that long reaches.
/// pdf-extract climbs by recursion with no bound: round a loop a release build spins forever and a debug build overflows
/// the stack, past any `catch_unwind`, and a long enough chain overflows a debug build too.
fn inherited<'a, T>(doc: &'a Document, page: ObjectId, key: &[u8], found: impl Fn(&'a Object) -> Result<T, pdf_extract::Error>) -> Result<Option<T>, String> {
    let mut id = page;
    for _ in 0..PAGE_TREE_DEPTH {
        let Ok(node) = doc.get_dictionary(id) else {
            return Ok(None);
        };
        if let Ok(t) = node.get_deref(key, doc).and_then(&found) {
            return Ok(Some(t));
        }
        let Ok(parent) = node.get(b"Parent").and_then(Object::as_reference) else {
            return Ok(None);
        };
        id = parent;
    }
    Err(msg!("pdf.parseFailed"))
}

/// Deeper than forms nest in a PDF: a page included from another PDF, a figure in it, a group in that. pdf-extract draws
/// each by recursion, at about 8 KB of stack a level in a debug build.
const FORM_DEPTH: usize = 32;

/// How much pdf-extract may read of the forms it draws again, in bytes, each draw counting 64 more for what any draw
/// costs it. A plot draws its markers thousands of times, and a page its header; forms that each draw the next twice
/// would take twice as long with every level. A release build reads this much in about 10 seconds.
const REDRAWN: usize = 64 << 20;

/// Refuses a document whose forms pdf-extract would draw more than `FORM_DEPTH` deep, or again past `REDRAWN`.
/// pdf-extract follows `Do` by recursion with no bound, so a form that draws itself, directly or through others,
/// overflows the stack in every build, past any `catch_unwind`. Follows what pdf-extract draws: the content of each page,
/// and in it the streams that `Do` names in the XObjects of a stream's own Resources, else of those it was drawn with.
/// A name they give no stream for makes pdf-extract panic, and is refused here. A stream the blanking in `glyphs`
/// emptied draws nothing. A stream that draws another many times is followed once, counting the times.
fn drawable(doc: &Document) -> Result<(), String> {
    // Each stream drawn so far: its length and what it draws.
    let mut streams: HashMap<ObjectId, (usize, Draws)> = HashMap::new();
    let mut redrawn = 0usize;
    for &page in doc.get_pages().values() {
        let resources = inherited(doc, page, b"Resources", Object::as_dict)?;
        let content = doc.get_page_content(page).unwrap_or_default();
        // What a content draws, the Resources it draws them from, how deep it is, and how many times it is drawn.
        let mut todo = vec![(draws(doc, &content, resources)?, resources, 0, 1usize)];
        while let Some((draws_here, resources, depth, times)) = todo.pop() {
            for (name, count) in draws_here.iter() {
                let (id, stream) = xobject(doc, resources, name).ok_or_else(|| msg!("pdf.parseFailed"))?;
                if stream.content.is_empty() {
                    continue;
                }
                if depth == FORM_DEPTH {
                    return Err(msg!("pdf.parseFailed"));
                }
                let own = stream.dict.get_deref(b"Resources", doc).and_then(Object::as_dict).ok().or(resources);
                let times = times.saturating_mul(*count);
                let (len, inner, again) = match streams.entry(id) {
                    Entry::Occupied(seen) => (seen.get().0, seen.get().1.clone(), times),
                    Entry::Vacant(first) => {
                        let content = plain(stream);
                        let (len, inner) = &*first.insert((content.len(), draws(doc, &content, own)?));
                        (*len, inner.clone(), times - 1)
                    }
                };
                redrawn = again.saturating_mul(len + 64).saturating_add(redrawn);
                if redrawn > REDRAWN {
                    return Err(msg!("pdf.parseFailed"));
                }
                todo.push((inner, own, depth + 1, times));
            }
        }
    }
    Ok(())
}

/// The names a content draws with `Do`, each with how many times: none if pdf-extract cannot decode it either.
type Draws = Rc<[(Vec<u8>, usize)]>;

/// What `content` draws, refused at a name that `resources` give no stream for. So only names the document has are kept.
fn draws(doc: &Document, content: &[u8], resources: Option<&Dictionary>) -> Result<Draws, String> {
    let ops = Content::decode(content).map(|c| c.operations).unwrap_or_default();
    let mut counts: HashMap<&[u8], usize> = HashMap::new();
    for op in ops.iter().filter(|op| op.operator == "Do") {
        let name = op.operands.first().and_then(|o| o.as_name().ok());
        let name = name.filter(|&n| counts.contains_key(n) || xobject(doc, resources, n).is_some()).ok_or_else(|| msg!("pdf.parseFailed"))?;
        *counts.entry(name).or_default() += 1;
    }
    Ok(counts.into_iter().map(|(name, count)| (name.to_vec(), count)).collect())
}

/// The stream `name` draws, found where pdf-extract finds it: in the XObjects of `resources`.
fn xobject<'a>(doc: &'a Document, resources: Option<&'a Dictionary>, name: &[u8]) -> Option<(ObjectId, &'a Stream)> {
    let xobjects = resources?.get_deref(b"XObject", doc).and_then(Object::as_dict).ok()?;
    match xobjects.get(name).and_then(|o| doc.dereference(o)).ok()? {
        (Some(id), Object::Stream(stream)) => Some((id, stream)),
        _ => None,
    }
}

fn is_image(s: &Stream) -> bool {
    s.dict.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Image")
}

fn is_form(s: &Stream) -> bool {
    s.dict.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Form")
}

fn blank(doc: &mut Document, which: fn(&Stream) -> bool) {
    for s in doc.objects.values_mut().filter_map(|o| o.as_stream_mut().ok()).filter(|s| which(s)) {
        s.set_plain_content(Vec::new());
    }
}

fn plain(s: &Stream) -> Vec<u8> {
    s.decompressed_content().unwrap_or_else(|_| s.content.clone())
}

#[derive(Default)]
struct Page {
    width: f64,
    height: f64,
    /// The top left of the MediaBox in the PDF's own coordinates.
    left: f64,
    top: f64,
    glyphs: Vec<Glyph>,
    /// The images in a `Format` the Reader shows.
    drawn: Vec<Drawn>,
    /// Set mostly in vertical writing, and turned by `turn`.
    vertical: bool,
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
        // A page drawn entirely inside forms (an included PDF) is read with them after all, unless they cannot be drawn.
        if pages.iter().any(|p| p.glyphs.is_empty())
            && let Ok((_, all)) = glyphs(bytes, false)
        {
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
    let (doc, walked) = prepared(bytes, skip_forms, true)?;
    let (styles, drawn): (Vec<_>, Vec<_>) = walked.into_iter().unzip();
    let mut out = Glyphs { styles, ..Default::default() };
    match catch_unwind(AssertUnwindSafe(|| pdf_extract::output_doc(&doc, &mut out))) {
        Ok(read) => read.map_err(|e| unreadable(&e))?,
        // pdf-extract passes over a quote, but may panic at the Tj it is spelt out to: one shown with no font set, for one.
        // A page it panics at is read again as written, which loses what its quotes show rather than the PDF.
        Err(_) => {
            // The last page begun is the one it panicked in.
            let read = out.pages.len().saturating_sub(1);
            out.pages.truncate(read);
            let mut written = None;
            for &number in doc.get_pages().keys().skip(read) {
                let index = out.pages.len();
                let spelt = catch_unwind(AssertUnwindSafe(|| pdf_extract::output_doc_page(&doc, &mut out, number)));
                let read = spelt.or_else(|_| {
                    out.pages.truncate(index);
                    let (written, walked) = match &mut written {
                        Some(written) => written,
                        none => none.insert(prepared(bytes, skip_forms, false)?),
                    };
                    if let (Some(spelt), Some((written, _))) = (out.styles.get_mut(index), walked.get_mut(index)) {
                        *spelt = std::mem::take(written);
                    }
                    let read = catch_unwind(AssertUnwindSafe(|| pdf_extract::output_doc_page(written, &mut out, number)));
                    Ok::<_, String>(read.unwrap_or_else(|panic| resume_unwind(panic)))
                })?;
                read.map_err(|e| unreadable(&e))?;
            }
        }
    }
    for (page, drawn) in out.pages.iter_mut().zip(drawn) {
        page.drawn = drawn.into_iter().map(|d| Drawn { x0: d.x0 - page.left, y0: page.top - d.y1, x1: d.x1 - page.left, y1: page.top - d.y0, ..d }).collect();
        let set = page.glyphs.iter().filter(|g| !g.turned && !g.text.trim().is_empty());
        let (down, all) = set.fold((0, 0), |(down, all), g| (down + usize::from(g.vertical), all + 1));
        if down * 2 > all {
            turn(page);
        } else {
            page.glyphs.retain(|g| !g.turned);
        }
    }
    Ok((doc, out.pages))
}

/// The document as pdf-extract is given it, with what `walk` finds on each of its pages. `quotes`: with `'` and `"`
/// spelt out.
fn prepared(bytes: &[u8], skip_forms: bool, quotes: bool) -> Result<(Document, Vec<Walked>), String> {
    let mut doc = load(bytes)?;
    // Before `spell_out_quotes` and `give_japan1_text`, which would otherwise decode forms that pdf-extract is not given.
    if skip_forms {
        blank(&mut doc, is_form);
    }
    mend_to_unicode(&mut doc);
    if quotes {
        spell_out_quotes(&mut doc);
    }
    give_japan1_text(&mut doc);
    let mut walked = Vec::new();
    for &page in doc.get_pages().values() {
        // Only to refuse a tree too deep to trust pdf-extract with: it reads the MediaBox itself.
        inherited(&doc, page, b"MediaBox", Object::as_array)?;
        // Before the blanking below takes the images' filters, which `Format::of` reads.
        walked.push(walk(&doc, page, inherited(&doc, page, b"Resources", Object::as_dict)?));
    }
    // pdf-extract draws an image as if it were a form, parsing its pixels as operators, and
    // panics on some of them; an image holds no text.
    blank(&mut doc, is_image);
    drawable(&doc)?;
    Ok((doc, walked))
}

/// A page set mostly in vertical writing, turned a quarter so that its columns, right to left, read as lines down the
/// page, each from its left: what the layout reads. Text set across on it, a number set sideways in a column (縦中横)
/// or a page number, goes in as one glyph at the middle of its run.
fn turn(page: &mut Page) {
    let width = page.width;
    let sideways = |run: Glyph| Glyph { x: run.y - ASCENT * run.size, end: run.y + (1. - ASCENT) * run.size, y: width - (run.x + run.end) / 2., ..run };
    let mut turned = Vec::with_capacity(page.glyphs.len());
    let mut run: Option<Glyph> = None;
    for g in std::mem::take(&mut page.glyphs) {
        if let Some(r) = &mut run
            && !g.vertical
            && !g.turned
            && (g.y - r.y).abs() < 0.3 * r.size
            && (g.x - r.end).abs() < 0.5 * r.size
        {
            if g.x > r.end + 0.15 * r.size.min(g.size) && !r.text.ends_with(' ') && !between_japanese(&r.text, &g.text) {
                r.text.push(' ');
            }
            r.text.push_str(&g.text);
            r.end = g.end;
            continue;
        }
        turned.extend(run.take().map(sideways));
        if g.vertical || g.turned {
            turned.push(Glyph { x: g.y, end: g.y + (g.end - g.x), y: width - g.x, ..g });
        } else {
            run = Some(g);
        }
    }
    turned.extend(run.map(sideways));
    page.glyphs = turned;
    page.drawn = std::mem::take(&mut page.drawn).into_iter().map(|d| Drawn { x0: d.y0, y0: width - d.x1, x1: d.y1, y1: width - d.x0, ..d }).collect();
    (page.width, page.height, page.vertical) = (page.height, page.width, true);
}

/// PDF::API2 writes a character past U+FFFF in a ToUnicode CMap as its code point (`<26951>`) where UTF-16 is due.
/// pdf-extract's CMap parser stops at a hex string of odd length and then panics, which loses the whole PDF.
fn mend_to_unicode(doc: &mut Document) {
    static CODE_POINT: LazyLock<regex::bytes::Regex> = LazyLock::new(|| regex::bytes::Regex::new("<([0-9A-Fa-f]{5})>").expect("static regex"));
    let utf16 = |c: &regex::bytes::Captures| {
        let ch = std::str::from_utf8(&c[1]).ok().and_then(|h| u32::from_str_radix(h, 16).ok()).and_then(char::from_u32);
        ch.map_or_else(|| c[0].to_vec(), |ch| format!("<{}>", ch.encode_utf16(&mut [0; 2]).iter().map(|u| format!("{u:04X}")).collect::<String>()).into_bytes())
    };
    let cmaps: HashSet<ObjectId> = doc.objects.values().filter_map(|o| o.as_dict().ok()?.get(b"ToUnicode").ok()?.as_reference().ok()).collect();
    for id in cmaps {
        let Some(Object::Stream(s)) = doc.objects.get_mut(&id) else {
            continue;
        };
        let content = plain(s);
        if let Cow::Owned(mended) = CODE_POINT.replace_all(&content, utf16) {
            s.set_plain_content(mended);
        }
    }
}

/// pdf-extract shows nothing for `'` and `"`, which some books set every line with: it reads the `T*` and `Tj` they stand
/// for. Before `walk`, so that the faces it counts line up with what pdf-extract shows. A page's streams may part anywhere,
/// even between a string and its quote, so a page is spelt out as a whole, into one stream.
fn spell_out_quotes(doc: &mut Document) {
    for page in doc.get_pages().into_values() {
        if let Some(spelt) = doc.get_page_content(page).ok().and_then(|c| spelt_out(&c)) {
            let id = doc.add_object(Stream::new(Dictionary::new(), spelt));
            if let Ok(page) = doc.get_dictionary_mut(page) {
                page.set("Contents", Object::Reference(id));
            }
        }
    }
    for s in doc.objects.values_mut().filter_map(|o| o.as_stream_mut().ok()).filter(|s| is_form(s)) {
        if let Some(spelt) = spelt_out(&plain(s)) {
            s.set_plain_content(spelt);
        }
    }
}

/// `content` with its quotes spelt out, if it has any. Inline images are left out: lopdf cannot write one back, and
/// neither pdf-extract nor `walk` reads them.
fn spelt_out(content: &[u8]) -> Option<Vec<u8>> {
    if !content.iter().any(|&b| b == b'\'' || b == b'"') {
        return None;
    }
    let content = Content::decode(content).ok()?;
    if !content.operations.iter().any(|op| op.operator == "'" || op.operator == "\"") {
        return None;
    }
    let op = |name: &str, operand: Option<&Object>| Operation::new(name, operand.into_iter().cloned().collect());
    let operations = content.operations.into_iter().flat_map(|o| match (o.operator.as_str(), &o.operands[..]) {
        ("'", [text @ Object::String(..)]) => vec![op("T*", None), op("Tj", Some(text))],
        ("\"", [aw @ (Object::Integer(_) | Object::Real(_)), ac @ (Object::Integer(_) | Object::Real(_)), text @ Object::String(..)]) => {
            vec![op("Tw", Some(aw)), op("Tc", Some(ac)), op("T*", None), op("Tj", Some(text))]
        }
        ("BI", _) => vec![],
        _ => vec![o],
    });
    Content { operations: operations.collect::<Vec<_>>() }.encode().ok()
}

/// A Japanese font that shows the CIDs of Adobe-Japan1 as they are, with no ToUnicode, gives pdf-extract no text. It gets a
/// ToUnicode of the CIDs it shows, not of the whole collection: pdf-extract parses a font's ToUnicode again on each page.
/// A form without Resources of its own is not looked in.
fn give_japan1_text(doc: &mut Document) {
    let fonts: HashSet<ObjectId> = doc.objects.iter().filter(|(_, o)| o.as_dict().is_ok_and(|f| shows_japan1(doc, f))).map(|(&id, _)| id).collect();
    if fonts.is_empty() {
        return;
    }
    let pages =
        doc.get_pages().into_values().map(|p| (doc.get_page_content(p).unwrap_or_default(), inherited(doc, p, b"Resources", Object::as_dict).ok().flatten()));
    let forms = doc.objects.values().filter_map(|o| o.as_stream().ok()).filter(|s| is_form(s));
    let forms = forms.map(|s| (plain(s), s.dict.get_deref(b"Resources", doc).and_then(Object::as_dict).ok()));
    let mut shown: HashMap<ObjectId, BTreeSet<u32>> = HashMap::new();
    for (content, resources) in pages.chain(forms) {
        let names = resources.and_then(|r| r.get_deref(b"Font", doc).and_then(Object::as_dict).ok());
        let (mut font, mut saved) = (None, Vec::new());
        for op in Content::decode(&content).map(|c| c.operations).unwrap_or_default() {
            match (op.operator.as_str(), op.operands.first()) {
                ("q", _) => saved.push(font),
                ("Q", _) => font = saved.pop().unwrap_or(font),
                ("Tf", Some(name)) => {
                    let named = name.as_name().ok().and_then(|n| names?.get(n).ok()?.as_reference().ok());
                    font = named.filter(|id| fonts.contains(id));
                }
                ("Tj" | "TJ", Some(shown_text)) if let Some(id) = font => {
                    let strings = shown_text.as_array().map_or(std::slice::from_ref(shown_text), Vec::as_slice);
                    let cids =
                        strings.iter().filter_map(|o| o.as_str().ok()).flat_map(|s| s.as_chunks::<2>().0.iter().map(|&c| u32::from(u16::from_be_bytes(c))));
                    shown.entry(id).or_default().extend(cids);
                }
                _ => {}
            }
        }
    }
    for (font, cids) in shown {
        let entries: Vec<String> = cids.into_iter().filter_map(|cid| Some(format!("<{cid:04X}> <{}>", hex(pdf_japan1::utf16(cid)?)))).collect();
        let cmap = format!(
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n{} beginbfchar\n{}\nendbfchar\nendcmap end end\n",
            entries.len(),
            entries.join("\n")
        );
        let cmap = doc.add_object(Stream::new(Dictionary::new(), cmap.into_bytes()));
        if let Ok(f) = doc.get_dictionary_mut(font) {
            f.set("ToUnicode", Object::Reference(cmap));
        }
    }
}

/// A font set in vertical writing: by a CMap named for it (`Identity-V`, `UniJIS-UCS2-V`), or one with `/WMode 1`.
fn writes_down(doc: &Document, font: &Dictionary) -> bool {
    match font.get_deref(b"Encoding", doc) {
        Ok(Object::Name(name)) => name.ends_with(b"-V"),
        Ok(Object::Stream(cmap)) => cmap.dict.get(b"WMode").and_then(Object::as_i64).is_ok_and(|m| m == 1),
        _ => false,
    }
}

/// The CIDFont a Type0 font draws with.
fn cid_font<'a>(doc: &'a Document, font: &'a Dictionary) -> Option<&'a Dictionary> {
    let first = font.get_deref(b"DescendantFonts", doc).and_then(Object::as_array).ok()?.first()?;
    doc.dereference(first).ok()?.1.as_dict().ok()
}

/// A Type0 font without a ToUnicode whose codes are the CIDs of Adobe-Japan1.
fn shows_japan1(doc: &Document, font: &Dictionary) -> bool {
    let name = |key: &[u8]| font.get(key).and_then(Object::as_name).ok();
    let info = cid_font(doc, font).and_then(|f| f.get_deref(b"CIDSystemInfo", doc).and_then(Object::as_dict).ok());
    let says = |key: &[u8], value: &[u8]| info.is_some_and(|i| i.get_deref(key, doc).and_then(Object::as_str).is_ok_and(|s| s == value));
    matches!(name(b"Subtype"), Some(b"Type0"))
        && matches!(name(b"Encoding"), Some(b"Identity-H" | b"Identity-V"))
        && !font.has(b"ToUnicode")
        && says(b"Registry", b"Adobe")
        && says(b"Ordering", b"Japan1")
}

fn load(bytes: &[u8]) -> Result<Document, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| unreadable(&e))?;
    if doc.is_encrypted() {
        doc.decrypt("").map_err(|e| unreadable(&e))?;
    }
    Ok(doc)
}

fn unreadable(e: &dyn std::fmt::Debug) -> String {
    msg!("pdf.unreadable", error = format!("{e:?}"))
}

#[derive(Default)]
struct Glyphs {
    pages: Vec<Page>,
    origin: (f64, f64),
    /// The styles `walk` found on each page, and how many of the current page's strings have begun.
    styles: Vec<Vec<Style>>,
    shown: usize,
    /// Where the column of vertical writing began, as pdf-extract placed its first glyph: of the strings since one that
    /// did not go on from the string before it.
    column: Option<(f64, f64)>,
    /// Where each text has been drawn on the current page.
    drawn: HashMap<String, Spots>,
}

/// Glyphs closer than this on both axes are drawn in the same place.
const SAME_SPOT: f64 = 0.05;

/// The places a text was drawn, by the `SAME_SPOT` square each lies in.
type Spots = HashMap<(i64, i64), (f64, f64)>;

impl Glyphs {
    /// The style of the string being shown.
    fn style(&self) -> Style {
        let page = self.styles.get(self.pages.len().wrapping_sub(1));
        page.and_then(|f| f.get(self.shown.wrapping_sub(1))).copied().unwrap_or_default()
    }
}

impl OutputDev for Glyphs {
    fn begin_page(&mut self, _: u32, b: &MediaBox, _: Option<(f64, f64, f64, f64)>) -> Result<(), OutputError> {
        self.origin = (b.llx, b.lly);
        self.shown = 0;
        self.drawn.clear();
        self.pages.push(Page { width: b.urx - b.llx, height: b.ury - b.lly, left: b.llx, top: b.ury, ..Default::default() });
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        // Strings inside forms, which `walk` does not follow: the styles would be off by those.
        let index = self.pages.len().wrapping_sub(1);
        if self.styles.get(index).is_none_or(|f| f.len() != self.shown)
            && let Some(page) = self.pages.last_mut()
        {
            page.glyphs.iter_mut().for_each(|g| (g.face, g.vertical) = (Face::Body, false));
        }
        Ok(())
    }

    fn output_character(&mut self, trm: &Transform, width: f64, _: f64, font_size: f64, text: &str) -> Result<(), OutputError> {
        // Rotated or mirrored text is a margin stamp (arXiv's) or a figure label, not prose, unless it runs down a column
        // of a page in vertical writing; which pages are is known once they are done.
        let upright = trm.m11 > 0. && trm.m22 > 0. && trm.m12.abs() < 1e-3 * trm.m11 && trm.m21.abs() < 1e-3 * trm.m22;
        let turned = trm.m12 < 0. && trm.m21 > 0. && trm.m11.abs() < 1e-3 * trm.m21 && trm.m22.abs() < 1e-3 * trm.m21;
        let scale = if turned {
            -trm.m12 * trm.m21
        } else {
            trm.m11 * trm.m22
        };
        let size = font_size.abs() * scale.sqrt();
        let style = self.style();
        let Some(page) = self.pages.last_mut().filter(|_| (upright || turned) && size > 0.5) else {
            return Ok(());
        };
        // pdf-extract moves along every string as if it ran across the page; vertical writing runs down from where it
        // starts. Its advances are the glyphs' widths, which in a Japanese font match their heights.
        let (mut x, mut y) = (trm.m31 - self.origin.0, trm.m32);
        if style.vertical {
            let (sx, sy) = *self.column.get_or_insert((x, y));
            (x, y) = (sx, sy - (x - sx));
        }
        // A glyph drawn again where it already is adds no ink: a book draws an item's bullet once for each of the
        // item's lines, and the pen's return to it would start a line. The repeats lie within 0.01pt of each other.
        // Looked up by square, not by scanning: a page can draw one glyph a million times.
        let places = self.drawn.entry(text.to_string()).or_default();
        let square = |v: f64| (v / SAME_SPOT).floor() as i64;
        let (sx, sy) = (square(x), square(y));
        let near = |&(px, py): &(f64, f64)| (px - x).abs() < SAME_SPOT && (py - y).abs() < SAME_SPOT;
        if (-1..=1).any(|i| (-1..=1).any(|j| places.get(&(sx.saturating_add(i), sy.saturating_add(j))).is_some_and(near))) {
            return Ok(());
        }
        places.entry((sx, sy)).or_insert((x, y));
        let Style { face, vertical, top, .. } = style;
        let y = page.height - (y - self.origin.1) + top * size;
        // A turned glyph's baseline runs down the column's left, and its em box rises to the right.
        let x = if turned {
            x + (ASCENT - 0.5) * size
        } else {
            x
        };
        page.glyphs.push(Glyph { x, y, end: x + width * size, size, text: text.to_string(), face, vertical, turned });
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        self.shown += 1;
        if !self.style().goes_on {
            self.column = None;
        }
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

/// Whether two texts meet between Japanese characters.
fn between_japanese(before: &str, after: &str) -> bool {
    before.chars().last().is_some_and(joins_without_space) && after.chars().next().is_some_and(joins_without_space)
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
            let gap = g.x - reach;
            gaps.push(gap);
            // Japanese has no spaces between words: a gap between its characters is a heading's spacing, or a line set
            // out to its full width. Only a gap as wide as between a table's cells parts them.
            let wide = gap > 1.8 * base.size;
            if space || g.x > p.end + 0.15 * p.size.min(g.size) && (!between_japanese(&p.text, &g.text) || wide) {
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
/// that repeat (digits aside) on at least a third of the pages. A footer that names the current
/// section repeats on few, but its number goes up with the page: those are the lines whose number
/// is as far from the page's index on at least a third of the pages.
fn drop_running_lines(lines: &mut [Vec<Line>], pages: &[Page]) {
    // A turned page has the top and the bottom of the page at its sides.
    let margin = |l: &Line| {
        let p = &pages[l.page];
        l.y < p.height * 0.08 || l.y > p.height * 0.92 || p.vertical && (l.x1 < p.width * 0.08 || l.x0 > p.width * 0.92)
    };
    let key = |l: &Line| {
        margin(l).then(|| {
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
    // The number a margin line starts or ends with, less the page's index. A heading starts with its
    // number too ("2 Related Work"), so at the start it counts only when no word follows it.
    let folio = |l: &Line| {
        if !margin(l) {
            return None;
        }
        let mut tokens = l.text.split_whitespace();
        let (first, second) = (tokens.next()?, tokens.next()?);
        let number = |t: &str| t.parse::<i64>().ok().filter(|_| t.bytes().all(|b| b.is_ascii_digit()));
        let start = number(first).filter(|_| !second.starts_with(char::is_alphabetic));
        let n = start.or_else(|| number(tokens.next_back().unwrap_or(second)))?;
        Some(n - l.page as i64)
    };
    let mut seen: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut numbered: HashMap<i64, HashSet<usize>> = HashMap::new();
    for l in lines.iter().flatten() {
        if let Some(k) = key(l) {
            seen.entry(k).or_default().insert(l.page);
        }
        if let Some(offset) = folio(l) {
            numbered.entry(offset).or_default().insert(l.page);
        }
    }
    let n = pages.len();
    let often = |on: Option<&HashSet<usize>>| on.is_some_and(|p| p.len() >= 2 && p.len() * 3 >= n);
    let running = |k: &str| {
        let number = k.chars().all(|c| c == '#' || !c.is_alphanumeric()) || (k.len() <= 6 && k.chars().all(|c| matches!(c, 'i' | 'v' | 'x')));
        number || often(seen.get(k))
    };
    for page in lines.iter_mut() {
        page.retain(|l| key(l).is_none_or(|k| !running(&k)) && folio(l).is_none_or(|offset| !often(numbered.get(&offset))));
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

/// The drafts' blocks with the figures' among them, each before the draft `place` puts it at, in drawing order. Their
/// `src` starts with `prefix`.
fn to_blocks(lines: &[Line], body: f64, figures: &[(usize, &Drawn)], prefix: &str) -> Vec<Block> {
    let vocab = vocabulary(lines);
    let drafts = drafts(lines, body);
    let mut out: Vec<(usize, Block)> = figures
        .iter()
        .map(|&(page, f)| {
            let at = place(&drafts, page, f);
            let label = drafts.get(at).filter(|d| d.kind == Kind::Caption).and_then(|d| caption_label(&d.lines[0].text));
            let src = format!("{prefix}{}.{}", f.id.0, f.id.1);
            let attrs = BlockAttrs { src: Some(src), ..Default::default() };
            (at, Block { kind: BlockKind::Image, text: label.unwrap_or_default().to_string(), inlines: Vec::new(), attrs })
        })
        .collect();
    // After the figures: the stable sort keeps each figure before the draft it goes before.
    out.extend(drafts.into_iter().enumerate().filter_map(|(i, d)| Some((i, block(d, &vocab)?))));
    out.sort_by_key(|(at, _)| *at);
    out.into_iter().map(|(_, b)| b).collect()
}

/// `pdf-figure:<the start of the PDF's sha256>/<object>.<generation>`: re-extracting the same file keeps every `src` and
/// with it the stored image, and a changed file renames them all, so the image job drops the old ones.
const FIGURE_SRC: &str = "pdf-figure:";

pub(crate) fn is_figure(src: &str) -> bool {
    src.starts_with(FIGURE_SRC)
}

/// What the `src` of every figure in `pdf` starts with.
fn figure_prefix(pdf: &[u8]) -> String {
    format!("{FIGURE_SRC}{}/", &sha256_hex(pdf)[..16])
}

/// An article's stored PDF, read once for a run of the image job, which asks it for each figure.
pub(crate) struct Figures {
    source: Source,
    /// `figure_prefix` of the PDF.
    prefix: String,
}

enum Source {
    Here(Option<Box<Document>>),
    /// A worker that has been sent the PDF; it reads it once, and then each figure asked for.
    Worker(std::sync::Mutex<Session>),
}

impl Figures {
    pub(crate) fn parse(pdf: &[u8]) -> Result<Figures, String> {
        Figures::read_by(pdf_worker::this(), pdf)
    }

    /// Read by `worker`, or here. Fails only when the worker does not start or ends before it has the PDF, which says
    /// nothing about the PDF: the figures are then for a later try, not unsupported.
    pub(crate) fn read_by(worker: Option<&pdf_worker::Worker>, pdf: &[u8]) -> Result<Figures, String> {
        let source = match worker {
            Some(worker) => Source::Worker(std::sync::Mutex::new(worker.start(&Request::Figures, pdf)?)),
            None => Source::Here(std::panic::catch_unwind(|| load(pdf).ok()).ok().flatten().map(Box::new)),
        };
        Ok(Figures { source, prefix: figure_prefix(pdf) })
    }

    /// The figure's PNG or JPEG. `None` when `src` names another PDF (the article's changed since its blocks were read), or
    /// the data does not hold the image its dictionary describes. An error when the worker has ended (by a limit, a crash or
    /// the time), which says nothing about this figure or the ones after it.
    pub(crate) fn image(&self, src: &str) -> Result<Option<(&'static str, Vec<u8>)>, String> {
        let Some(id) = src.strip_prefix(self.prefix.as_str()).and_then(object_id) else {
            return Ok(None);
        };
        let doc = match &self.source {
            Source::Here(None) => return Ok(None),
            Source::Here(Some(doc)) => doc,
            Source::Worker(session) => {
                let mut session = session.lock().map_err(|_| msg!("pdf.parseFailed"))?;
                session.send(src.as_bytes())?;
                let bytes = session.frame()?;
                return Ok(crate::images::sniff(&bytes).map(|mime| (mime, bytes)));
            }
        };
        Ok(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let image = doc.get_object(id).ok()?.as_stream().ok()?;
            Format::of(doc, &image.dict)?.encode(&image.content)
        }))
        .ok()
        .flatten())
    }
}

/// `12.0` as an object id.
fn object_id(text: &str) -> Option<ObjectId> {
    let (number, generation) = text.split_once('.')?;
    Some((number.parse().ok()?, generation.parse().ok()?))
}

/// A raster figure the Reader shows: drawn at least a fifth of the page wide (not a margin icon), over less than 80% of
/// the page (not a scan or a background), and on fewer than three pages (not a logo). In page and drawing order, once
/// per page.
fn figures(doc: &Parsed) -> Vec<(usize, &Drawn)> {
    let all = || doc.pages.iter().enumerate().flat_map(|(i, p)| p.drawn.iter().map(move |d| (i, p, d)));
    let mut pages: HashMap<ObjectId, HashSet<usize>> = HashMap::new();
    for (i, _, d) in all() {
        pages.entry(d.id).or_default().insert(i);
    }
    let mut seen = HashSet::new();
    all()
        .filter(|(_, p, d)| d.x1 - d.x0 >= p.width / 5. && (d.x1 - d.x0) * (d.y1 - d.y0) < 0.8 * p.width * p.height)
        .filter(|(i, _, d)| pages.get(&d.id).is_some_and(|on| on.len() < 3) && seen.insert((*i, d.id)))
        .map(|(i, _, d)| (i, d))
        .collect()
}

/// The draft a figure goes before: the first that starts under it on its page and across from it (its caption, and in a
/// right-hand column that column's next draft), else the first of a later page, else none.
fn place(drafts: &[Draft], page: usize, f: &Drawn) -> usize {
    let under = |d: &Draft| {
        let l = d.lines[0];
        l.page == page && l.y >= f.y1 && l.x0 < f.x1 && l.x1 > f.x0
    };
    drafts.iter().position(under).or_else(|| drafts.iter().position(|d| d.lines[0].page > page)).unwrap_or(drafts.len())
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
        // "… as illustrated in" / "Figure 2-6. Even if …": a sentence broken before a reference, not a caption.
        let wrapped = flows && cur.is_some_and(|(_, prev, _)| prev.x1 >= prev.right - 2. * prev.size && prev.text.ends_with(char::is_alphanumeric));
        let start = match (refs, cur) {
            (Some(style), _) => match style {
                RefStyle::Numbered => ref_number(&l.text),
                RefStyle::Hanging => l.x0 <= l.left + 0.5 * l.size,
                RefStyle::Spaced => cur.is_none_or(|(_, prev, _)| prev.page == l.page && prev.side == l.side && !flows),
            }
            .then_some(Kind::Reference),
            _ if caption_label(&l.text).is_some() && !wrapped => Some(Kind::Caption),
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
    let big = l.size >= body * 1.1 && words <= 10 && l.x1 < l.right - 3. * l.size && t.chars().filter(|c| c.is_alphabetic()).count() >= 3;
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

/// "Figure 3:", "Fig. 2.", "Table IV:", "Figure 2.1:" and a book's "Figure 6-13." open a caption, labelled by what comes
/// before the stop: "Figure 6-13".
fn caption_label(t: &str) -> Option<&str> {
    let rest = ["Figure", "Fig.", "Table", "Algorithm"].iter().find_map(|p| t.strip_prefix(p))?.trim_start();
    let mut n = rest.chars().take_while(|c| c.is_ascii_digit() || matches!(c, 'I' | 'V' | 'X')).count();
    if n == 0 {
        return None;
    }
    while let [b'-' | b'.', d, ..] = rest.as_bytes()[n..]
        && d.is_ascii_digit()
    {
        n += 1 + rest[n + 1..].chars().take_while(char::is_ascii_digit).count();
    }
    rest[n..].starts_with(['.', ':']).then(|| &t[..t.len() - rest.len() + n])
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
    use pdf_extract::{Dictionary, Stream, StringFormat};

    /// One text run: x and baseline y from the top of a US Letter page, font size, text.
    pub(crate) type Run<'a> = (f64, f64, f64, &'a str);

    pub(crate) fn name(s: &str) -> Object {
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
                // Helvetica's own encoding has the bullet at 0xB7.
                let bytes = text.replace('•', "\u{b7}").chars().map(|c| c as u8).collect();
                ops.push(Operation::new("Tj", vec![Object::String(bytes, StringFormat::Literal)]));
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

    const SPREAD: [Run; 2] = [
        (L, 100., 10., "the leader sends every write to all of the replicas and then waits"),
        (L, 112., 10., "until a majority of them has answered with the same stored value and"),
    ];

    #[test]
    fn a_footer_naming_the_section_is_dropped_by_the_page_number_it_ends_with() {
        let footers = ["Leaders and Followers | 197", "Replication Lag | 198", "Multi-Leader Replication | 199", "Summary | 200"];
        let pages: Vec<Vec<Run>> = footers.iter().map(|f| vec![SPREAD[0], SPREAD[1], (330., 760., 9., *f)]).collect();
        let ir = to_ir(&pdf(&pages, None), None).unwrap();
        let whole = [SPREAD[0].3, SPREAD[1].3].join(" ");
        assert_eq!(kinds(&ir), [("paragraph", [whole.as_str(); 4].join(" ").as_str())], "the paragraph runs on across each page break");
    }

    #[test]
    fn a_footer_naming_the_section_on_every_second_page_is_dropped_by_the_page_number_it_starts_with() {
        // A chapter opens on a page with no footer, so fewer than half of its pages carry the section's name.
        let footers = [None, Some("198 | Leaders and Followers"), Some("199"), Some("200 | Multi-Leader Replication"), Some("201")];
        let pages: Vec<Vec<Run>> = footers.into_iter().map(|f| SPREAD.into_iter().chain(f.map(|f| (L, 760., 9., f))).collect()).collect();
        let ir = to_ir(&pdf(&pages, None), None).unwrap();
        let whole = [SPREAD[0].3, SPREAD[1].3].join(" ");
        assert_eq!(kinds(&ir), [("paragraph", [whole.as_str(); 5].join(" ").as_str())], "two pages of five carry it, more than a third");
    }

    #[test]
    fn a_line_set_a_tenth_larger_than_the_body_is_a_heading() {
        let page: Vec<Run> = vec![
            (L, 100., 10.5, "A long line of body text that runs across the whole of the column and on to its end,"),
            (L, 112.6, 10.5, "with a second line that is nearly as long as the first one and then comes to a stop."),
            (L, 138., 11.6, "Logical (row-based) log replication"),
            (L, 155., 10.5, "Another way is to use different log formats for replication and for the storage engine,"),
            (L, 167.6, 10.5, "which allows the log to be decoupled from the internals of the storage engine."),
        ];
        let bytes = pdf(&[page], None);
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "heading", "paragraph"]);
        assert_eq!(ir.blocks[1].text, "Logical (row-based) log replication");
        assert!(regions(&bytes).unwrap().iter().any(|r| r.text.starts_with("Logical") && r.level == Some(2)), "the Page view translates it");
    }

    #[test]
    fn a_line_set_a_little_larger_than_the_body_is_not_a_heading() {
        let page: Vec<Run> = vec![
            (L, 100., 10.5, "A long line of body text that runs across the whole of the column and on to its end,"),
            (L, 112.6, 10.5, "with a second line that is nearly as long as the first one and then comes to a stop."),
            (L, 138., 11.4, "Logical (row-based) log replication"),
            (L, 155., 10.5, "Another way is to use different log formats for replication and for the storage engine,"),
            (L, 167.6, 10.5, "which allows the log to be decoupled from the internals of the storage engine."),
        ];
        let ir = to_ir(&pdf(&[page], None), None).unwrap();
        assert!(kinds(&ir).iter().all(|k| k.0 != "heading"), "{:?}", kinds(&ir));
    }

    #[test]
    fn section_headings_at_the_top_of_pages_are_not_page_numbers() {
        // Numbered in step with the pages, on three of four: only the word after each number tells them from "198 | Chapter 6".
        let pages: Vec<Vec<Run>> = [None, Some("2 Related Work"), Some("3 Method"), Some("4 Results")]
            .into_iter()
            .map(|h| h.map(|h| (L, 50., 12., h)).into_iter().chain(SPREAD).collect())
            .collect();
        let ir = to_ir(&pdf(&pages, None), None).unwrap();
        let headings: Vec<&str> = ir.blocks.iter().filter(|b| b.kind == BlockKind::Heading).map(|b| b.text.as_str()).collect();
        assert_eq!(headings, ["2 Related Work", "3 Method", "4 Results"]);
    }

    #[test]
    fn a_body_line_ending_with_a_number_in_step_with_the_pages_is_kept() {
        let ends = [Some("as the timings of the first run in Table 1"), Some("and those of the second run in Table 2"), None, None];
        let pages: Vec<Vec<Run>> = ends.into_iter().map(|e| SPREAD.into_iter().chain(e.map(|e| (L, 124., 10., e))).collect()).collect();
        let ir = to_ir(&pdf(&pages, None), None).unwrap();
        let text = ir.blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join(" ");
        assert!(text.contains("run in Table 1") && text.contains("run in Table 2"), "only a margin line is a page number: {text}");
    }

    #[test]
    fn a_margin_line_whose_number_follows_the_page_on_fewer_than_a_third_of_them_is_kept() {
        let notes = [Some("1 The timings of the first run are in Table 1"), Some("2 Those of the second run are in Table 2")];
        let pages: Vec<Vec<Run>> = (0..7).map(|i| SPREAD.into_iter().chain(notes.get(i).copied().flatten().map(|n| (L, 760., 8., n))).collect()).collect();
        let ir = to_ir(&pdf(&pages, None), None).unwrap();
        let text = ir.blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join(" ");
        assert!(text.contains("are in Table 1") && text.contains("are in Table 2"), "two pages of seven are not a third: {text}");
    }

    #[test]
    fn a_list_marker_drawn_again_for_each_line_of_its_item_is_read_once() {
        // The book places the repeats a few thousandths of a point apart: here across the edges of the squares they are looked up by.
        let page: Vec<Run> = vec![
            (L, 100., 10., "There are several reasons to copy the same data to many machines, including:"),
            (79.995, 120.005, 10., "•"),
            (90., 120., 10., "To keep the data close to the people who use it (and so reduce the"),
            (80.005, 120., 10., "•"),
            (90., 132., 10., "latency)"),
            (80., 150., 10., "•"),
            (90., 150., 10., "To serve more reads."),
            (79.995, 150.005, 10., "•"),
            (L, 170., 10., "In this chapter each machine holds a copy of all of the data, and that is assumed below."),
        ];
        let bytes = pdf(&[page], None);
        assert_eq!(
            kinds(&to_ir(&bytes, None).unwrap()),
            [
                ("paragraph", "There are several reasons to copy the same data to many machines, including:"),
                ("list_item", "• To keep the data close to the people who use it (and so reduce the latency)"),
                ("list_item", "• To serve more reads."),
                ("paragraph", "In this chapter each machine holds a copy of all of the data, and that is assumed below."),
            ]
        );
        let r = regions(&bytes).unwrap();
        let texts: Vec<&str> = r.iter().map(|x| x.text.as_str()).collect();
        let item = r.iter().find(|x| x.text.ends_with("reduce the latency)"));
        let item = item.unwrap_or_else(|| panic!("the item's second line is translated with it: {texts:?}"));
        assert_eq!((item.room_left, item.room_right), (0., 0.), "an item of two lines gets no room beside it");
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
            out.push(Glyph { x, y: 100., end: x + 5., size: 10., text: c.to_string(), face, vertical: false, turned: false });
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
    fn a_single_line_has_the_rest_of_its_line_as_room() {
        let page: Vec<Run> = vec![
            (200., 80., 12., "Regions and Zones "),
            (L, 100., 10., "A paragraph under the heading runs across the whole of the column and ends."),
            (L, 112., 10., "It has a second line too."),
            (400., 150., 10., "(1)"),
            (L, 150., 10., "A line with a label beside it."),
            (110., 180., 10., "Another line, with a label before it."),
            (L, 180., 10., "(2)"),
        ];
        let r = regions(&pdf(&[page], None)).unwrap();
        let at = |t: &str| r.iter().find(|x| x.text.starts_with(t)).unwrap_or_else(|| panic!("no region for {t}"));
        let (heading, paragraph, labelled) = (at("Regions"), at("A paragraph"), at("A line"));
        let after = at("Another line");
        assert_eq!((after.x0 - after.room_left).round(), (L + 12.2).round(), "back to what is printed before it: \"(2)\" is 12.2pt of Helvetica");
        assert_eq!(
            (heading.x0 - heading.room_left, heading.x1 + heading.room_right),
            (paragraph.x0, paragraph.x1),
            "out to the column's edges, past the space it ends with"
        );
        assert_eq!((paragraph.room_left, paragraph.room_right), (0., 0.), "lines above and below would be covered");
        assert_eq!((labelled.room_left, labelled.x1 + labelled.room_right), (0., 400.), "up to what is printed beside it");
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
    fn a_sentence_that_would_leave_a_piece_empty_goes_whole_to_the_other() {
        // DDIA's p199: the paragraph's last sentence holds all that runs on to the next page. Cut between words, neither
        // piece is whole sentences, so neither can show the block's saved translation.
        let first: Vec<Run> = vec![
            (L, 100., 10., "Single-leader replication is very widely used. Many consensus algorithms"),
            (L, 112., 10., "such as Raft are also based on a single leader and every one of them will"),
        ];
        let second: Vec<Run> =
            vec![(L, 100., 10., "automatically elect a new leader when the old one fails, as we will see"), (L, 112., 10., "in a later chapter.")];
        let texts = |bytes: &[u8]| regions(bytes).unwrap().into_iter().map(|r| r.text).collect::<Vec<_>>();
        assert_eq!(
            texts(&pdf(&[first, second], None)),
            [
                "Single-leader replication is very widely used.",
                "Many consensus algorithms such as Raft are also based on a single leader and every one of them will automatically elect a new leader when the old one fails, as we will see in a later chapter."
            ]
        );
        // One sentence leaves no other piece to give it to.
        let first: Vec<Run> = vec![(L, 100., 10., "The leader sends every write to all of the replicas and then waits")];
        let second: Vec<Run> =
            vec![(L, 100., 10., "until a majority of them has answered with the same stored value and"), (L, 112., 10., "only then replies.")];
        assert_eq!(
            texts(&pdf(&[first, second], None)),
            [
                "The leader sends every write to all of the replicas and then waits",
                "until a majority of them has answered with the same stored value and only then replies."
            ]
        );
    }

    #[test]
    fn a_sentence_across_a_page_goes_to_the_side_with_most_of_it() {
        let texts = |pages: &[Vec<Run>]| regions(&pdf(pages, None)).unwrap().into_iter().map(|r| r.text).collect::<Vec<_>>();
        let mostly_before: Vec<Vec<Run>> = vec![
            vec![(L, 100., 10., "Here is one whole first sentence. The second one starts here and it goes on")],
            vec![(L, 100., 10., "to an end. A third sentence is on the next page, and so is all of it.")],
        ];
        assert_eq!(
            texts(&mostly_before),
            [
                "Here is one whole first sentence. The second one starts here and it goes on to an end.",
                "A third sentence is on the next page, and so is all of it."
            ]
        );
        let mostly_after: Vec<Vec<Run>> = vec![
            vec![(L, 100., 10., "Here is one whole first sentence of the paragraph on its first page. The")],
            vec![(L, 100., 10., "second one is all on the next page, but for a word. A third one ends it.")],
        ];
        assert_eq!(
            texts(&mostly_after),
            [
                "Here is one whole first sentence of the paragraph on its first page.",
                "The second one is all on the next page, but for a word. A third one ends it."
            ]
        );
    }

    #[test]
    fn a_sentence_too_long_for_the_short_side_is_cut_between_words() {
        // Moved whole, the sentence would fill a box of one word more than its smallest type can show.
        let first: Vec<Run> = vec![
            (L, 100., 10., "A short one. Then a long sentence that runs across this whole line and"),
            (L, 112., 10., "the whole of the next one too, before it stops on the following page"),
        ];
        let second: Vec<Run> = vec![(L, 100., 10., "at last.")];
        let r = regions(&pdf(&[first, second], None)).unwrap();
        assert_eq!(r.iter().map(|x| x.text.as_str()).collect::<Vec<_>>()[1], "at last.");
    }

    #[test]
    fn a_sentence_across_three_pages_leaves_no_piece_empty() {
        let pages: Vec<Vec<Run>> = vec![
            vec![(L, 100., 10., "This one sentence starts at the bottom of the first page and then runs")],
            vec![(L, 100., 10., "across the whole of the second page, which holds nothing but this part")],
            vec![(L, 100., 10., "of it, and ends on the third. Another sentence follows it there."), (L, 112., 10., "And a last one.")],
        ];
        let r = regions(&pdf(&pages, None)).unwrap();
        let texts: Vec<&str> = r.iter().map(|x| x.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "This one sentence starts at the bottom of the first page and then runs",
                "across the whole of the second page, which holds nothing but this part of it, and ends on the third.",
                "Another sentence follows it there. And a last one."
            ]
        );
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
        assert_eq!(scripts, [(Script::Sup, "grant"), (Script::Sub, "i,r")]);
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
    fn reextracting_a_renamed_pdf_keeps_the_file_name_as_the_found_title() {
        let s = Store::open_in_memory().unwrap();
        let body = vec![(L, 120., 10., "Plain text with no larger title line on the page.")];
        let id = import(&s, &pdf(std::slice::from_ref(&body), None), Some("file")).unwrap();
        assert_eq!(s.article_row(id).unwrap().unwrap().title.as_deref(), Some("file"));
        s.set_title(id, "Part 2").unwrap();
        crate::ingest::reextract(&s, id).unwrap();
        let a = s.article_row(id).unwrap().unwrap();
        assert_eq!((a.title.as_deref(), a.auto_title.as_deref()), (Some("Part 2"), Some("file")));
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
        let bytes = draw(&pdf(&[body], None), image(1, 1, "DeviceGray", b"CS".to_vec()), &[(0, L, 200., 1., 1.)]);
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "A paragraph next to a figure drawn as an image.")]);
    }

    /// An image XObject of `w` by `h` pixels, 8 bits a channel, with `data` as stored.
    fn image(w: u32, h: u32, space: &str, data: Vec<u8>) -> Stream {
        let mut dict = Dictionary::new();
        dict.set("Type", name("XObject"));
        dict.set("Subtype", name("Image"));
        dict.set("Width", Object::Integer(w.into()));
        dict.set("Height", Object::Integer(h.into()));
        dict.set("ColorSpace", name(space));
        dict.set("BitsPerComponent", Object::Integer(8));
        Stream::new(dict, data)
    }

    /// FlateDecode DeviceRGB: `w` by `h` pixels of one colour.
    fn rgb(w: u32, h: u32, colour: [u8; 3]) -> Stream {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut z, &colour.repeat((w * h) as usize)).unwrap();
        let mut s = image(w, h, "DeviceRGB", z.finish().unwrap());
        s.dict.set("Filter", name("FlateDecode"));
        s
    }

    /// `bytes` with `image` drawn at each (page, x and y of its top left, width, height): one object drawn on several pages
    /// is what a logo is.
    fn draw(bytes: &[u8], image: Stream, at: &[(usize, f64, f64, f64, f64)]) -> Vec<u8> {
        let mut doc = Document::load_mem(bytes).unwrap();
        let id = doc.add_object(image);
        let name = format!("Im{}", id.0);
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        for &(page, x, y, w, h) in at {
            let page = doc.get_object_mut(pages[page]).and_then(Object::as_dict_mut).unwrap();
            let content = page.get(b"Contents").and_then(Object::as_reference).unwrap();
            let resources = page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap();
            if !resources.has(b"XObject") {
                resources.set("XObject", Dictionary::new());
            }
            resources.get_mut(b"XObject").and_then(Object::as_dict_mut).unwrap().set(name.as_str(), Object::Reference(id));
            let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
            let mut ops = stream.content.clone();
            ops.extend_from_slice(format!("\nq {w} 0 0 {h} {x} {} cm /{name} Do Q\n", 792. - y - h).as_bytes());
            stream.set_plain_content(ops);
        }
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn quorum_text() -> Vec<Run<'static>> {
        vec![
            (L, 100., 10., "With n replicas, every write must be confirmed by w nodes and every read by r nodes."),
            (L, 315., 9., "Figure 6-13. If w + r > n, reads see the latest write."),
            (L, 340., 10., "The parameters are usually configurable, and a common choice is an odd n."),
            (L, 520., 10., "A paragraph under a second figure, which has no caption."),
        ]
    }

    /// `quorum_text` with a figure from y 200 to 300 over its caption, and an uncaptioned one from y 400 to 500 over the
    /// last paragraph.
    pub(crate) fn quorum() -> Vec<u8> {
        let bytes = draw(&pdf(&[quorum_text()], None), rgb(30, 10, [200, 0, 0]), &[(0, L, 200., 300., 100.)]);
        draw(&bytes, rgb(30, 10, [0, 0, 200]), &[(0, L, 400., 300., 100.)])
    }

    #[test]
    fn a_figure_goes_before_the_caption_under_it() {
        let bytes = quorum();
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(
            kinds(&ir),
            [
                ("paragraph", "With n replicas, every write must be confirmed by w nodes and every read by r nodes."),
                ("image", "Figure 6-13"),
                ("caption", "Figure 6-13. If w + r > n, reads see the latest write."),
                ("paragraph", "The parameters are usually configurable, and a common choice is an odd n."),
                ("image", ""),
                ("paragraph", "A paragraph under a second figure, which has no caption."),
            ]
        );
        let src = ir.blocks[1].attrs.src.as_deref().unwrap_or_default();
        assert!(src.starts_with(&format!("pdf-figure:{}/", &sha256_hex(&bytes)[..16])), "named by the PDF it is in: {src}");
        assert_ne!(ir.blocks[4].attrs.src.as_deref(), Some(src));
    }

    #[test]
    fn figures_over_one_caption_keep_their_drawing_order() {
        let left = draw(&pdf(&[quorum_text()], None), rgb(30, 10, [1, 0, 0]), &[(0, L, 200., 140., 100.)]);
        let ir = to_ir(&draw(&left, rgb(30, 10, [2, 0, 0]), &[(0, L + 160., 200., 140., 100.)]), None).unwrap();
        let object = |b: &Block| b.attrs.src.as_deref()?.rsplit_once('/')?.1.split_once('.')?.0.parse::<u32>().ok();
        let objects: Vec<u32> = ir.blocks.iter().filter_map(object).collect();
        assert!(objects.len() == 2 && objects[0] < objects[1], "the left one, drawn first, comes first: {objects:?}");
        assert_eq!(kinds(&ir)[1..4].iter().map(|k| k.0).collect::<Vec<_>>(), ["image", "image", "caption"], "both before the one caption");
    }

    #[test]
    fn figures_do_not_change_regions() {
        let (with, without) = (quorum(), pdf(&[quorum_text()], None));
        assert!(to_ir(&with, None).unwrap().blocks.iter().any(|b| b.kind == BlockKind::Image), "the figures are there");
        let json = |bytes: &[u8]| serde_json::to_string(&regions(bytes).unwrap()).unwrap();
        assert_eq!(json(&with), json(&without));
    }

    #[test]
    fn a_right_column_figure_stays_in_its_column() {
        let page: Vec<Run> = vec![
            (L, 300., 10., "Prose of the left column runs on,"),
            (L, 312., 10., "and comes to its end here."),
            (L, 420., 10., "Another paragraph of the left one,"),
            (L, 432., 10., "lower than the bottom of the figure."),
            (R, 415., 9., "Figure 2: Reads in the right column."),
            (R, 440., 10., "Prose of the right column goes on,"),
            (R, 452., 10., "under the figure and its caption."),
        ];
        let ir = to_ir(&draw(&pdf(&[page], None), rgb(30, 10, [0, 0, 0]), &[(0, R, 300., 220., 100.)]), None).unwrap();
        assert_eq!(
            kinds(&ir),
            [
                ("paragraph", "Prose of the left column runs on, and comes to its end here."),
                ("paragraph", "Another paragraph of the left one, lower than the bottom of the figure."),
                ("image", "Figure 2"),
                ("caption", "Figure 2: Reads in the right column."),
                ("paragraph", "Prose of the right column goes on, under the figure and its caption."),
            ]
        );
    }

    #[test]
    fn only_figures_are_kept() {
        let text = |t| vec![(L, 100., 10., t)];
        let pages = [text("The first page has a note icon and a logo."), text("The second page is scanned."), text("The third page has a figure.")];
        let mut bytes = pdf(&pages, None);
        let mut masked = rgb(4, 4, [0, 0, 0]);
        masked.dict.set("SMask", Object::Reference((1, 0)));
        // Its filter is read before the reading of text blanks every image's data and filters.
        let mut lzw = image(4, 4, "DeviceRGB", vec![0; 8]);
        lzw.dict.set("Filter", name("LZWDecode"));
        for (image, at) in [
            (rgb(4, 4, [0, 0, 0]), vec![(0, L, 120., 38., 50.)]),
            (rgb(4, 4, [0, 0, 0]), (0..3).map(|p| (p, L, 600., 300., 40.)).collect()),
            (rgb(4, 4, [0, 0, 0]), vec![(1, 0., 0., 612., 792.)]),
            // A scan drawn upside down: not upright, and over the whole page.
            (rgb(4, 4, [1, 1, 1]), vec![(1, 0., 792., 612., -792.)]),
            (rgb(4, 4, [9, 9, 9]), vec![(2, L, 200., 300., 100.), (2, L, 200., 300., 100.)]),
            (masked, vec![(2, L, 350., 300., 100.)]),
            (image(4, 4, "DeviceCMYK", vec![0; 64]), vec![(2, L, 500., 300., 100.)]),
            (lzw, vec![(2, L, 650., 300., 100.)]),
        ] {
            bytes = draw(&bytes, image, &at);
        }
        let ir = to_ir(&bytes, None).unwrap();
        let kinds: Vec<&str> = ir.blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "image").count(), 1, "neither masked, CMYK nor LZW, and drawn twice still one: {kinds:?}");
        assert_eq!(kinds.last(), Some(&"image"), "the third page's figure, under all of the text: {kinds:?}");
    }

    #[test]
    fn a_figure_is_read_from_the_pdf_its_src_names() {
        let bytes = quorum();
        let src = to_ir(&bytes, None).unwrap().blocks[1].attrs.src.clone().unwrap_or_default();
        let (mime, png) = Figures::parse(&bytes).unwrap().image(&src).unwrap().unwrap();
        assert_eq!((mime, &png[12..24]), ("image/png", &b"IHDR\0\0\0\x1e\0\0\0\x0a"[..]), "30x10 as drawn into the PDF");
        assert_eq!(Figures::parse(&[&bytes[..], b"\n"].concat()).unwrap().image(&src), Ok(None), "the same objects in another file");
        assert_eq!(Figures::parse(b"%PDF-1.5 not really").unwrap().image(&src), Ok(None));
        assert_eq!(Figures::parse(&bytes).unwrap().image("pdf-figure:12.0"), Ok(None));
    }

    /// The article's image blocks: id and `src`.
    fn figure_blocks(s: &Store, id: i64) -> Vec<(i64, String)> {
        let blocks = s.get_article(id, "ja").unwrap().unwrap().blocks;
        blocks.into_iter().filter(|b| b.block.kind == BlockKind::Image).map(|b| (b.id, b.block.attrs.src.unwrap_or_default())).collect()
    }

    /// The article's `article_images` rows: `src`, and whether it holds an image.
    fn mappings(s: &Store, id: i64) -> Vec<(String, bool)> {
        let c = s.conn();
        let mut st = c.prepare("SELECT src, hash IS NOT NULL FROM article_images WHERE article_id = ?1 ORDER BY src").unwrap();
        st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    fn stored(srcs: &[(i64, String)]) -> Vec<(String, bool)> {
        let mut out: Vec<(String, bool)> = srcs.iter().map(|(_, src)| (src.clone(), true)).collect();
        out.sort();
        out
    }

    async fn store_images(s: &Store, id: i64) {
        images::run(s, &crate::fetch::client(), id).await.unwrap();
    }

    #[tokio::test]
    async fn figures_are_stored_once_and_follow_the_pdf() {
        let s = Store::open_in_memory().unwrap();
        let id = import(&s, &quorum(), None).unwrap();
        store_images(&s, id).await;
        let blocks = figure_blocks(&s, id);
        assert_eq!(mappings(&s, id), stored(&blocks));
        for (block, _) in &blocks {
            let (mime, png) = images::stored(&s, *block).unwrap().unwrap();
            assert_eq!((mime.as_str(), images::sniff(&png)), ("image/png", Some("image/png")), "what the Reader shows");
        }
        for _ in 0..2 {
            crate::ingest::reextract(&s, id).unwrap();
            store_images(&s, id).await;
        }
        assert_eq!((figure_blocks(&s, id), mappings(&s, id)), (blocks.clone(), stored(&blocks)), "re-extracting changes nothing");

        let changed = draw(&pdf(&[quorum_text()], None), rgb(30, 10, [0, 200, 0]), &[(0, L, 200., 300., 100.)]);
        store_fetched(&s, id, "https://example.com/quorum.pdf", &changed).unwrap();
        store_images(&s, id).await;
        let now = figure_blocks(&s, id);
        assert_eq!(now.len(), 1);
        assert!(!blocks.iter().any(|(_, src)| *src == now[0].1), "the changed file names its figure anew");
        assert_eq!(mappings(&s, id), stored(&now), "and the old figures' images are dropped");
    }

    #[tokio::test]
    async fn figures_are_stored_once_saving_is_switched_on() {
        let s = Store::open_in_memory().unwrap();
        images::set_settings(&s, images::ImageSettings { save: false, max_mb: 5 }).unwrap();
        let id = import(&s, &quorum(), None).unwrap();
        store_images(&s, id).await;
        s.finish_job(s.claim_next_job(&[images::JOB_TYPE]).unwrap().unwrap().id, None).unwrap();
        assert_eq!((figure_blocks(&s, id).len(), mappings(&s, id)), (2, vec![]), "the blocks, and nothing stored");
        images::set_settings(&s, images::ImageSettings { save: true, max_mb: 5 }).unwrap();
        assert_eq!(images::enqueue_missing(&s).unwrap(), 1);
        store_images(&s, id).await;
        assert_eq!(mappings(&s, id), stored(&figure_blocks(&s, id)));
    }

    #[tokio::test]
    async fn a_figure_that_does_not_decode_fails_alone() {
        let s = Store::open_in_memory().unwrap();
        let mut broken = rgb(30, 10, [0, 0, 0]);
        broken.set_content(b"not deflated".to_vec());
        let id = import(&s, &draw(&quorum(), broken, &[(0, L, 600., 300., 100.)]), None).unwrap();
        store_images(&s, id).await;
        let blocks = figure_blocks(&s, id);
        let failed: Vec<(String, String)> = {
            let c = s.conn();
            let mut st = c.prepare("SELECT src, error FROM article_images WHERE article_id = ?1 AND hash IS NULL").unwrap();
            st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, blocks[2].1, "the broken one, last on the page");
        assert!(failed[0].1.contains("images.unsupported"), "{}", failed[0].1);
        assert_eq!(mappings(&s, id).iter().filter(|m| m.1).count(), 2, "the others are stored");
    }

    #[test]
    fn a_caption_numbered_within_its_chapter_is_a_caption() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "Quorum reads and writes keep the replicas in step as long as the sum is large,"),
            (L, 112., 10., "and a read then sees at least one node with the latest value, as is illustrated in"),
            (L, 124., 10., "Figure 6-12. A write that reaches only a few of the nodes is not lost either."),
            (L, 154., 9., "Figure 6-13. If w + r > n, reads see the latest write."),
            (L, 184., 10., "Figure 3 shows that a majority is not the only choice of quorum."),
        ];
        let ir = to_ir(&pdf(&[page], None), None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "caption", "paragraph"], "a sentence wrapped before a reference");
    }

    #[test]
    fn a_figure_on_a_later_page_stays_on_its_page() {
        let first: Vec<Run> = vec![(L, 100., 10., "The first page opens with this paragraph."), (L, 500., 10., "And it ends with this one, low on the page.")];
        let second: Vec<Run> = vec![(L, 315., 9., "Figure 2. Drawn at the top of the second page."), (L, 340., 10., "Text under the figure and its caption.")];
        let ir = to_ir(&draw(&pdf(&[first, second], None), rgb(30, 10, [0, 0, 0]), &[(1, L, 200., 300., 100.)]), None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "paragraph", "image", "caption", "paragraph"]);
    }

    /// `bytes` with an image named `Im0` on its first page, `before` written ahead of the page's own content and `after`
    /// behind it.
    fn with_ops(bytes: &[u8], before: &str, after: &str) -> Vec<u8> {
        let mut doc = Document::load_mem(bytes).unwrap();
        let id = doc.add_object(rgb(30, 10, [0, 0, 0]));
        let p = *doc.get_pages().values().next().unwrap();
        let page = doc.get_object_mut(p).and_then(Object::as_dict_mut).unwrap();
        let content = page.get(b"Contents").and_then(Object::as_reference).unwrap();
        let mut xobjects = Dictionary::new();
        xobjects.set("Im0", Object::Reference(id));
        page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
        let ops = [before.as_bytes(), b"\n", &stream.content[..], b"\n", after.as_bytes(), b"\n"].concat();
        stream.set_plain_content(ops);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn image_count(ir: &ArticleIr) -> usize {
        ir.blocks.iter().filter(|b| b.kind == BlockKind::Image).count()
    }

    #[test]
    fn a_figure_cut_down_by_a_clip_is_placed_by_what_shows() {
        // 400pt tall from the top of the page, clipped to the 100pt over the caption.
        let ops = "q 72 492 300 100 re W n 300 0 0 400 72 392 cm /Im0 Do Q";
        let ir = to_ir(&with_ops(&pdf(&[quorum_text()], None), "", ops), None).unwrap();
        assert_eq!(kinds(&ir)[1], ("image", "Figure 6-13"), "{:?}", kinds(&ir));
        // Across from the image and above it, so what drops it is the clip and not the width rule.
        let outside = "q 72 700 300 50 re W n 300 0 0 100 72 492 cm /Im0 Do Q";
        assert_eq!(image_count(&to_ir(&with_ops(&pdf(&[quorum_text()], None), "", outside), None).unwrap()), 0, "clipped away");
        // pdf.js, which draws the Page view, clips nothing for a clip without a path.
        let pathless = "q W n 300 0 0 100 72 492 cm /Im0 Do Q";
        assert_eq!(image_count(&to_ir(&with_ops(&pdf(&[quorum_text()], None), "", pathless), None).unwrap()), 1, "a clip without a path");
    }

    #[test]
    fn a_scan_under_invisible_text_is_not_a_figure() {
        // A page scanned within its margins, its text recognised and drawn over it invisibly, as OCR writes it.
        let scan = "q 500 0 0 700 56 46 cm /Im0 Do Q";
        let visible = to_ir(&with_ops(&pdf(&[quorum_text()], None), scan, ""), None).unwrap();
        assert_eq!(image_count(&visible), 1, "the same image under visible text is a figure, at 72% of the page");
        let ocr = to_ir(&with_ops(&pdf(&[quorum_text()], None), &format!("{scan} 3 Tr"), ""), None).unwrap();
        assert_eq!(image_count(&ocr), 0, "{:?}", kinds(&ocr));
        assert_eq!(ocr.blocks.len(), visible.blocks.len() - 1, "the text still reads");
        let text = |ops: &str| format!("BT /F1 9 Tf 72 30 Td {ops} ET");
        for (before, after, how) in [
            (scan.to_owned(), text("3 Tr [(Recognised) -250 (words)] TJ"), "written as an array"),
            (format!("{scan} 3 Tr"), text("0 Tr (Stamped on later) Tj"), "with visible text after it"),
            ("3 Tr".to_owned(), scan.to_owned(), "drawn before the scan"),
        ] {
            let ir = to_ir(&with_ops(&pdf(&[quorum_text()], None), &before, &after), None).unwrap();
            assert_eq!(image_count(&ir), 0, "{how}: {:?}", kinds(&ir));
        }
    }

    #[test]
    fn a_figure_is_kept_only_when_drawn_its_own_way_up() {
        let figures = |cm: &str| image_count(&to_ir(&with_ops(&pdf(&[quorum_text()], None), "", &format!("q {cm} cm /Im0 Do Q")), None).unwrap());
        // The Reader shows the pixels as stored, straightening a slight tilt.
        assert_eq!(figures("300 0 0 100 72 500"), 1, "upright");
        assert_eq!(figures("260 150 -50 87 72 500"), 1, "tilted by 30 degrees");
        assert_eq!(figures("300 0 0 -100 72 600"), 0, "upside down");
        assert_eq!(figures("-300 0 0 100 372 500"), 0, "mirrored");
        assert_eq!(figures("0 300 -300 0 372 400"), 0, "on its side");
        assert_eq!(figures("150 260 -87 50 72 500"), 0, "tilted by 60 degrees");
    }

    #[test]
    fn a_figure_under_an_outer_transform_is_placed_where_it_shows() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "A paragraph above the figure, which ends here."),
            (L, 420., 10., "A paragraph above where the figure shows."),
            (L, 605., 9., "Figure 1. The figure, drawn at half its size."),
        ];
        let mut doc = Document::load_mem(&pdf(&[page], None)).unwrap();
        let id = doc.add_object(rgb(30, 10, [0, 0, 0]));
        let p = *doc.get_pages().values().next().unwrap();
        let page = doc.get_object_mut(p).and_then(Object::as_dict_mut).unwrap();
        let content = page.get(b"Contents").and_then(Object::as_reference).unwrap();
        let mut xobjects = Dictionary::new();
        xobjects.set("Im0", Object::Reference(id));
        page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
        let mut ops = stream.content.clone();
        // Shows at x 72 to 372 and y 492 to 592 from the top; composed the other way round, at 144 to 444 and 292 to 392.
        ops.extend_from_slice(b"\nq 0.5 0 0 0.5 0 0 cm q 600 0 0 200 144 400 cm /Im0 Do Q Q\n");
        stream.set_plain_content(ops);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "paragraph", "image", "caption"]);
    }

    #[test]
    fn re_extracting_and_fetching_queue_the_figures() {
        let s = Store::open_in_memory().unwrap();
        let id = import(&s, &quorum(), None).unwrap();
        let take = |s: &Store| s.claim_next_job(&[images::JOB_TYPE]).unwrap().map(|j| s.finish_job(j.id, None).unwrap()).is_some();
        assert!(take(&s));
        crate::ingest::reextract(&s, id).unwrap();
        assert!(take(&s), "re-extracting queues the images job");
        store_fetched(&s, id, "https://example.com/quorum.pdf", &quorum()).unwrap();
        assert!(take(&s), "saving a fetched PDF queues it");
    }

    #[test]
    fn a_caption_under_a_figure_label_is_a_caption() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "A paragraph before the figure runs on to the edge of the column and then ends"),
            (L, 112., 10., "with a full stop in its second line."),
            (L + 100., 300., 9., "Throughput"),
            (L, 312., 9., "Figure 3: Reads per second as nodes are added."),
        ];
        let ir = to_ir(&pdf(&[page], None), None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "caption"], "{:?}", kinds(&ir));
    }

    #[test]
    fn a_caption_right_under_a_full_line_ending_a_sentence_is_a_caption() {
        let page: Vec<Run> = vec![
            (L, 100., 10., "A paragraph whose last line runs to the edge of the column, ending a sentence."),
            (L, 112., 10., "Table 1: Reads per second as nodes are added."),
        ];
        let ir = to_ir(&pdf(&[page], None), None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["paragraph", "caption"], "{:?}", kinds(&ir));
    }

    #[test]
    fn figures_next_to_each_threshold() {
        let text = |t| vec![(L, 100., 10., t)];
        let pages = [text("Narrow images."), text("Large images."), text("An image on two pages."), text("The second page of it.")];
        let mut bytes = pdf(&pages, None);
        for (image, at) in [
            (rgb(4, 4, [1, 1, 1]), vec![(0, L, 200., 130., 100.)]),
            (rgb(4, 4, [2, 2, 2]), vec![(0, L, 400., 120., 100.)]),
            (rgb(4, 4, [3, 3, 3]), vec![(1, 0., 150., 612., 600.)]),
            (rgb(4, 4, [4, 4, 4]), vec![(1, 0., 50., 612., 700.)]),
            (rgb(4, 4, [5, 5, 5]), vec![(2, L, 200., 300., 100.), (3, L, 200., 300., 100.)]),
        ] {
            bytes = draw(&bytes, image, &at);
        }
        let ir = to_ir(&bytes, None).unwrap();
        // 130 of 612 wide is kept and 120 is not; 76% of the page is kept and 88% is not; two pages are kept, once on each.
        assert_eq!(ir.blocks.iter().filter(|b| b.kind == BlockKind::Image).count(), 4, "{:?}", kinds(&ir));
    }

    #[tokio::test]
    async fn a_figure_over_the_size_limit_is_not_stored() {
        let s = Store::open_in_memory().unwrap();
        images::set_settings(&s, images::ImageSettings { save: true, max_mb: 1 }).unwrap();
        let (w, h) = (700u32, 500u32);
        let mut x = 1u32;
        let noise: Vec<u8> = (0..w * h * 3)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (x >> 24) as u8
            })
            .collect();
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut z, &noise).unwrap();
        let mut big = image(w, h, "DeviceRGB", z.finish().unwrap());
        big.dict.set("Filter", name("FlateDecode"));
        let id = import(&s, &draw(&pdf(&[quorum_text()], None), big, &[(0, L, 200., 300., 100.)]), None).unwrap();
        store_images(&s, id).await;
        let error: String = s.conn().query_row("SELECT error FROM article_images WHERE article_id = ?1", [id], |r| r.get(0)).unwrap();
        assert!(error.contains("images.tooLarge"), "{error}");
    }

    #[test]
    fn a_pdf_of_figures_without_text_has_no_text() {
        let bytes = draw(&pdf(&[vec![]], None), rgb(30, 10, [0, 0, 0]), &[(0, L, 200., 300., 100.)]);
        assert_eq!(to_ir(&bytes, None).unwrap_err(), msg!("pdf.noText"));
    }

    #[test]
    fn a_figure_is_placed_on_a_page_whose_mediabox_is_off_the_origin() {
        let mut doc = Document::load_mem(&quorum()).unwrap();
        for id in doc.get_pages().into_values().collect::<Vec<_>>() {
            let page = doc.get_dictionary_mut(id).unwrap();
            page.set("MediaBox", Object::Array([400, 300, 1012, 1092].map(Object::Integer).to_vec()));
            let content = page.get(b"Contents").and_then(Object::as_reference).unwrap();
            let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
            // Everything moves with the box, so the page looks the same; a figure measured from 0 would sit 400pt right of its
            // caption, and one measured from the box's height 300pt above the paragraph over it.
            let ops = [&b"1 0 0 1 400 300 cm\n"[..], &stream.content].concat();
            stream.set_plain_content(ops);
        }
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    #[test]
    fn a_figure_named_in_resources_the_page_inherits_is_kept() {
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let dict = doc.get_object_mut(page).and_then(Object::as_dict_mut).unwrap();
        let resources = dict.remove(b"Resources").unwrap();
        let parent = dict.get(b"Parent").and_then(Object::as_reference).unwrap();
        // Referred to from the page tree, or written into it.
        let shared = Object::Reference(doc.add_object(resources.clone()));
        for inherited in [shared, resources] {
            doc.get_object_mut(parent).and_then(Object::as_dict_mut).unwrap().set("Resources", inherited);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
        }
    }

    #[test]
    fn a_clip_counts_however_its_path_is_written() {
        // Each leaves the 100pt over the caption of an image drawn 400pt tall, as in the test above.
        let image = "300 0 0 400 72 392 cm /Im0 Do";
        for (clip, how) in [
            (format!("0 0 612 792 re W n 72 492 300 100 re W n {image}"), "inside the page's clip"),
            (format!("72 492 300 100 re W n 0 0 612 792 re W n {image}"), "with a wider clip inside it"),
            (format!("72 492 300 100 re W* n {image}"), "even-odd"),
            (format!("72 492 m 372 492 l 372 592 l 72 592 l h W n {image}"), "drawn with lines"),
            ("0.5 0 0 0.5 0 0 cm 144 984 600 200 re W n 600 0 0 800 144 784 cm /Im0 Do".to_owned(), "under a transform"),
        ] {
            let ir = to_ir(&with_ops(&pdf(&[quorum_text()], None), "", &format!("q {clip} Q")), None).unwrap();
            assert_eq!(kinds(&ir)[1], ("image", "Figure 6-13"), "{how}: {:?}", kinds(&ir));
        }
    }

    #[test]
    fn a_clip_lasts_until_its_q_ends_and_narrows_nothing_else() {
        // A background filled before the clip, the figure it cuts down, a rule filled after its Q, and a second figure
        // above the rule that no clip touches.
        let clipped = "q 72 492 300 100 re W n 300 0 0 400 72 392 cm /Im0 Do Q 72 280 300 1 re f";
        let bytes = with_ops(&pdf(&[quorum_text()], None), "0 0 612 792 re f", clipped);
        let ir = to_ir(&draw(&bytes, rgb(30, 10, [0, 0, 200]), &[(0, L, 400., 300., 100.)]), None).unwrap();
        assert_eq!(kinds(&ir), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    #[test]
    fn a_figure_named_in_xobjects_referred_to_is_kept() {
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let resources = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap();
        let xobjects = resources.remove(b"XObject").unwrap();
        let id = doc.add_object(xobjects);
        doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Reference(id));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    #[test]
    fn a_figure_named_in_resources_two_levels_up_is_kept() {
        // The page, a Pages node between, and the root that holds the resources.
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let dict = doc.get_dictionary_mut(page).unwrap();
        let resources = dict.remove(b"Resources").unwrap();
        let root = dict.get(b"Parent").and_then(Object::as_reference).unwrap();
        let mut between = Dictionary::new();
        between.set("Type", name("Pages"));
        between.set("Parent", Object::Reference(root));
        between.set("Kids", Object::Array(vec![Object::Reference(page)]));
        between.set("Count", Object::Integer(1));
        let between = doc.add_object(between);
        doc.get_dictionary_mut(page).unwrap().set("Parent", Object::Reference(between));
        let tree = doc.get_dictionary_mut(root).unwrap();
        tree.set("Kids", Object::Array(vec![Object::Reference(between)]));
        tree.set("Resources", resources);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    /// Whether this is a child running only the test `name`, which goes on with the test. The test run itself starts that
    /// child, checks that the test passed there, and returns. A stack overflow ends the process past any `catch_unwind`, so
    /// a test that would overflow if it failed runs apart, and fails instead of ending the whole run.
    fn in_child(name: &str) -> bool {
        const CHILD: &str = "LATTICE_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            return true;
        }
        let out = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", name]).env(CHILD, "1").output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("1 passed"), "{:?}\n{stdout}", out.status);
        false
    }

    #[test]
    fn a_page_tree_too_deep_for_pdf_extract_to_climb_is_refused() {
        // pdf-extract would climb until the stack overflowed.
        if !in_child("pdf::tests::a_page_tree_too_deep_for_pdf_extract_to_climb_is_refused") {
            return;
        }
        // In place of its own entry the page has none, one of the wrong kind (pdf-extract passes it over and looks further
        // up), or one that refers to nothing (pdf-extract stops there only by panicking). Above it the parent is its own
        // Parent, or the page is.
        for (key, entry, back_to_page) in [
            ("Resources", None, false),
            ("MediaBox", None, false),
            ("MediaBox", None, true),
            ("Resources", Some(Object::Integer(0)), false),
            ("MediaBox", Some(Object::Integer(0)), false),
            ("Resources", Some(Object::Reference((999, 0))), false),
        ] {
            let mut doc = Document::load_mem(&quorum()).unwrap();
            let page = *doc.get_pages().values().next().unwrap();
            let dict = doc.get_dictionary_mut(page).unwrap();
            dict.remove(key.as_bytes()).unwrap();
            if let Some(entry) = &entry {
                dict.set(key, entry.clone());
            }
            let parent = dict.get(b"Parent").and_then(Object::as_reference).unwrap();
            let up = if back_to_page {
                page
            } else {
                parent
            };
            doc.get_dictionary_mut(parent).unwrap().set("Parent", Object::Reference(up));
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            assert_eq!(to_ir(&bytes, None).unwrap_err(), msg!("pdf.parseFailed"), "{key} {entry:?}, back to the page: {back_to_page}");
        }
        // No loop, but the MediaBox lies so far up that the recursion would overflow.
        assert_eq!(to_ir(&chained(100_000), None).unwrap_err(), msg!("pdf.parseFailed"), "a chain");
    }

    /// The page hung from a chain of `links` nodes outside the page tree, with its MediaBox moved to one more on top.
    fn chained(links: usize) -> Vec<u8> {
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let mut top = Dictionary::new();
        top.set("MediaBox", doc.get_dictionary_mut(page).unwrap().remove(b"MediaBox").unwrap());
        let mut up = doc.add_object(top);
        for _ in 0..links {
            let mut node = Dictionary::new();
            node.set("Parent", Object::Reference(up));
            up = doc.add_object(node);
        }
        doc.get_dictionary_mut(page).unwrap().set("Parent", Object::Reference(up));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_mediabox_on_the_last_node_the_walk_reaches_is_read() {
        // The page, 254 links and the top: 256 nodes, as many as the walk reaches. A number of its own, so that a lower
        // PAGE_TREE_DEPTH fails here instead of shrinking the tree along with it.
        assert_eq!(kinds(&to_ir(&chained(254), None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    #[test]
    fn entries_found_below_a_loop_in_the_page_tree_are_read() {
        // pdf-extract climbs no further than where it finds them, so a loop above is no reason to refuse the PDF. The page
        // has its own MediaBox, and takes its Resources from its parent, whose Parent is itself.
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let dict = doc.get_dictionary_mut(page).unwrap();
        let resources = dict.remove(b"Resources").unwrap();
        let parent = dict.get(b"Parent").and_then(Object::as_reference).unwrap();
        let tree = doc.get_dictionary_mut(parent).unwrap();
        tree.set("Resources", resources);
        tree.set("Parent", Object::Reference(parent));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), kinds(&to_ir(&quorum(), None).unwrap()));
    }

    #[test]
    fn a_character_past_u_ffff_written_as_its_code_point_in_a_cmap_is_read() {
        let mut doc = Document::load_mem(&pdf(&[vec![(72., 100., 10., "A cat sat on the mat.")]], None)).unwrap();
        let cmap = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <00> <ff> endcodespacerange\n\
            2 beginbfchar\n<41> <26951>\n<63> <0063>\nendbfchar\nendcmap end end\n";
        let cmap = doc.add_object(Stream::new(Dictionary::new(), cmap.to_vec()));
        let helvetica = |o: &Object| o.as_dict().is_ok_and(|d| d.get(b"BaseFont").and_then(Object::as_name).is_ok_and(|n| n == b"Helvetica"));
        let font = doc.objects.values_mut().find(|o| helvetica(o)).and_then(|o| o.as_dict_mut().ok()).unwrap();
        font.set("ToUnicode", Object::Reference(cmap));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(to_ir(&bytes, None).unwrap().blocks[0].text, "\u{26951} cat sat on the mat.");
    }

    #[test]
    fn lines_set_with_quote_operators_are_read() {
        // The page's content in as many streams as `parts`.
        let read = |parts: &[&[u8]]| {
            let mut doc = Document::load_mem(&pdf(&[vec![]], None)).unwrap();
            let page = *doc.get_pages().values().next().unwrap();
            let streams: Vec<Object> = parts.iter().map(|p| Object::Reference(doc.add_object(Stream::new(Dictionary::new(), p.to_vec())))).collect();
            doc.get_dictionary_mut(page).unwrap().set("Contents", streams);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            to_ir(&bytes, None).unwrap().blocks[0].text.clone()
        };
        let lines: &[u8] = b"BT /F1 10 Tf 12 TL 72 692 Td (The cat sat) Tj (on the mat) ' 0 0 (by the door.) \" ET";
        assert_eq!(read(&[lines]), "The cat sat on the mat by the door.");
        // Quotes with no string to show, or no spacing, which pdf-extract passes over: as a Tj, Tw or Tc they would panic,
        // and the page would be read again with none of its quotes.
        for bad in ["5 '", "/N 0 (by the door.) \"", "0 /N (by the door.) \"", "0 0 5 \""] {
            let content = format!("BT /F1 10 Tf 12 TL 72 692 Td (The cat sat) Tj (on the mat.) ' {bad} ET");
            assert_eq!(read(&[content.as_bytes()]), "The cat sat on the mat.", "{bad}");
        }
        // Spacing given as real numbers.
        assert_eq!(read(&[b"BT /F1 10 Tf 12 TL 72 692 Td (The cat sat) Tj 0.1 0.0 (on the mat.) \" ET"]), "The cat sat on the mat.");
        // An inline image, which lopdf cannot write back.
        assert_eq!(read(&[&[lines, b" q 10 0 0 10 300 300 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q"].concat()]), "The cat sat on the mat by the door.");
        // Streams split between a quote and its string.
        assert_eq!(read(&[b"BT /F1 10 Tf 12 TL 72 692 Td (The cat sat) Tj (on the mat.)", b"' ET"]), "The cat sat on the mat.");
    }

    /// `bytes` with the content of each page given, by its index, in place of its own.
    fn with_contents(bytes: &[u8], contents: &[(usize, &str)]) -> Vec<u8> {
        let mut doc = Document::load_mem(bytes).unwrap();
        let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        for &(page, ops) in contents {
            let content = doc.add_object(Stream::new(Dictionary::new(), ops.as_bytes().to_vec()));
            doc.get_dictionary_mut(pages[page]).unwrap().set("Contents", Object::Reference(content));
        }
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_quote_shown_before_any_font_is_set_does_not_lose_the_pdf() {
        // pdf-extract panics at a Tj with no font, and passes over a quote: spelt out, the quote would lose the PDF.
        let sentence = "The cat sat on the mat by the door, as it does every day.";
        let content = format!("BT 12 TL 72 692 Td (by the door.) ' ET BT /F1 10 Tf 72 600 Td ({sentence}) Tj ET");
        let bytes = with_contents(&pdf(&[vec![]], None), &[(0, &content)]);
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()), [sentence]);
    }

    #[test]
    fn the_pages_around_one_read_again_as_written_keep_their_quotes() {
        // The middle page panics once spelt out, between its two lines: its quote is in the no font a Q took back.
        let quoted = |line: &str, quote: &str| format!("BT /F1 10 Tf 12 TL 72 700 Td ({line}) Tj ({quote}) ' ET");
        let middle = "q BT /F1 10 Tf 72 700 Td (It saw a dog.) Tj ET Q BT 12 TL 72 600 Td (by the door.) ' ET BT /F1 10 Tf 72 500 Td (It ran.) Tj ET";
        let (first, last) = (quoted("The cat sat", "on the mat."), quoted("Then it slept", "by the fire."));
        let bytes = with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &first), (1, middle), (2, &last)]);
        assert_eq!(glyphs(&bytes, true).unwrap().1.len(), 3);
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()).join(" "), "The cat sat on the mat. It saw a dog. It ran. Then it slept by the fire.");
    }

    #[test]
    fn a_page_pdf_extract_cannot_read_as_written_still_fails_the_pdf() {
        // A Tj with no font set, which pdf-extract panics at whether or not quotes are spelt out.
        let bytes = with_contents(&pdf(&[vec![(72., 100., 10., "The cat sat on the mat.")], vec![]], None), &[(1, "BT 72 692 Td (by the door.) Tj ET")]);
        assert_eq!(to_ir(&bytes, None).unwrap_err(), msg!("pdf.parseFailed"));
    }

    #[test]
    fn a_quote_in_a_form_that_sets_no_font_does_not_lose_the_other_pages() {
        // The second page is drawn by a form, which shows its text with a quote in the font the page set. pdf-extract
        // starts a form with no font, so the page has no text; the first page keeps its own.
        let sentence = "The cat sat on the mat by the door, as it does every day.";
        let mut doc = Document::load_mem(&pdf(&[vec![(72., 100., 10., sentence)], vec![]], None)).unwrap();
        let mut form = Dictionary::new();
        form.set("Type", name("XObject"));
        form.set("Subtype", name("Form"));
        form.set("BBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
        let form = doc.add_object(Stream::new(form, b"BT 12 TL 72 692 Td (Then it slept.) ' ET".to_vec()));
        let page = *doc.get_pages().values().next_back().unwrap();
        let content = doc.add_object(Stream::new(Dictionary::new(), b"BT /F1 10 Tf ET /X1 Do".to_vec()));
        let page = doc.get_dictionary_mut(page).unwrap();
        page.set("Contents", Object::Reference(content));
        let mut xobjects = Dictionary::new();
        xobjects.set("X1", Object::Reference(form));
        page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()), [sentence]);
    }

    /// `pages`, then `ops` drawn on the last in F3: a Japanese font that shows the CIDs of Adobe-Japan1 by `encoding`
    /// and has no ToUnicode, as typeset Japanese books embed one.
    fn japanese(pages: &[Vec<Run>], encoding: &str, ops: &str) -> Vec<u8> {
        let mut doc = Document::load_mem(&pdf(pages, None)).unwrap();
        let mut info = Dictionary::new();
        info.set("Registry", Object::string_literal("Adobe"));
        info.set("Ordering", Object::string_literal("Japan1"));
        info.set("Supplement", Object::Integer(6));
        let mut descriptor = Dictionary::new();
        descriptor.set("Type", name("FontDescriptor"));
        descriptor.set("FontName", name("Mincho"));
        let mut cid_font = Dictionary::new();
        cid_font.set("Type", name("Font"));
        cid_font.set("Subtype", name("CIDFontType0"));
        cid_font.set("BaseFont", name("Mincho"));
        cid_font.set("CIDSystemInfo", Object::Dictionary(info));
        cid_font.set("FontDescriptor", Object::Reference(doc.add_object(descriptor)));
        // The vertical origin on the baseline, as in the book that set its columns with `'`.
        cid_font.set("DW2", vec![Object::Integer(0), Object::Integer(-1000)]);
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type0"));
        font.set("BaseFont", name("Mincho"));
        font.set("Encoding", name(encoding));
        font.set("DescendantFonts", vec![Object::Reference(doc.add_object(cid_font))]);
        let font = doc.add_object(font);
        let page = *doc.get_pages().values().next_back().unwrap();
        let resources = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap();
        resources.get_mut(b"Font").and_then(Object::as_dict_mut).unwrap().set("F3", Object::Reference(font));
        let content = doc.get_page_contents(page)[0];
        let stream = doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap();
        stream.set_plain_content([&stream.content[..], b"\n", ops.as_bytes()].concat());
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn texts(ir: &ArticleIr) -> Vec<&str> {
        ir.blocks.iter().map(|b| b.text.as_str()).collect()
    }

    #[test]
    fn text_from_a_japanese_font_with_no_tounicode_is_read() {
        // Two kana by their CIDs, 843 and 887: in F3 as it is set, as a Q brings it back, and shown by a quote.
        let quoted = "BT /F3 10 Tf 12 TL 72 612 Td <034B0377> ' ET";
        for ops in ["BT /F3 10 Tf 72 600 Td <034B0377> Tj ET", "BT /F3 10 Tf ET q BT /F1 10 Tf ET Q BT 72 600 Td <034B0377> Tj ET", quoted] {
            let ir = to_ir(&japanese(&[vec![(72., 100., 10., "Cats")]], "Identity-H", ops), None).unwrap();
            assert_eq!(texts(&ir), ["Cats", "あの"], "{ops}");
        }
    }

    #[test]
    fn vertical_writing_is_read_as_paragraphs_down_the_columns() {
        // Kana down three columns from the right, each column one string: a paragraph that ends short in the second, and
        // one that starts a character down in the third. Page numbers are set across, at the foot and at the head.
        let ops = "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D034F03510353> Tj 1 0 0 1 488 700 Tm <03540356> Tj \
            1 0 0 1 476 690 Tm <0358035A035C> Tj ET";
        let bytes = japanese(&[vec![(300., 760., 10., "12"), (300., 20., 10., "13")]], "Identity-V", ops);
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()), ["あいうえおかき", "くけこ"]);
        assert!(regions(&bytes).unwrap().is_empty());
    }

    #[test]
    fn a_paragraph_that_runs_on_to_a_turned_page_keeps_its_region_on_the_page_set_across() {
        // One line at the foot of a page set across, read on into the column of the next page, which is turned.
        let line = vec![(72., 740., 10., "The cat sat on the mat by the door, as it does every day, and then it")];
        let bytes = japanese(&[line, vec![]], "Identity-V", "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D034F03510353> Tj ET");
        assert_eq!(regions(&bytes).unwrap().iter().map(|r| r.page).collect::<Vec<_>>(), [0]);
    }

    #[test]
    fn latin_set_across_on_a_turned_page_keeps_the_spaces_its_pen_moves_make() {
        // Three columns of ten kana: most of the page is set down it, so it is turned.
        let column = |x: f64| format!("1 0 0 1 {x} 700 Tm <034B034D034F035103530354035603580359035A> Tj ");
        let columns = format!("BT /F3 10 Tf {}{}{}ET", column(500.), column(488.), column(476.));
        for across in ["BT /F1 10 Tf 1 0 0 1 100 400 Tm [(Hello) -300 (world)] TJ ET", "BT /F1 10 Tf 100 400 Td (Hello) Tj 26 0 Td (world) Tj ET"] {
            let ir = to_ir(&japanese(&[vec![]], "Identity-V", &format!("{columns} {across}")), None).unwrap();
            assert!(texts(&ir).iter().any(|t| t.contains("Hello world")), "{across}: {:?}", texts(&ir));
        }
    }

    #[test]
    fn the_columns_of_a_turned_page_are_read_from_the_right_in_whatever_order_they_are_drawn() {
        // The rightmost column, a heading's place, drawn after the two left of it, as the book draws its headings.
        let ops = "BT /F3 10 Tf 1 0 0 1 488 700 Tm <0354035603580359035A> Tj 1 0 0 1 476 700 Tm <035C035E> Tj \
            1 0 0 1 500 700 Tm <034B034D034F03510353> Tj ET";
        assert_eq!(texts(&to_ir(&japanese(&[vec![]], "Identity-V", ops), None).unwrap()).concat(), "あいうえおかきくぐけこさ");
    }

    #[test]
    fn a_page_mostly_across_is_not_turned_for_a_label_set_down_it() {
        let paragraph = vec![(72., 100., 10., "The cat sat on the mat by the door, as it does every day."), (72., 112., 10., "Then it slept.")];
        let label = "BT /F3 10 Tf 1 0 0 1 500 300 Tm <034B034D> Tj ET";
        let (_, pages) = glyphs(&japanese(&[paragraph], "Identity-V", label), true).unwrap();
        assert!(!pages[0].vertical);
    }

    #[test]
    fn text_turned_on_a_page_set_across_is_left_out() {
        // A figure's label turned a quarter clockwise, beside a paragraph.
        let paragraph = vec![(72., 100., 10., "The cat sat on the mat by the door, as it does every day."), (72., 112., 10., "Then it slept.")];
        let label = "BT /F1 10 Tf 0 -1 1 0 500 400 Tm (Figure label) Tj ET";
        let ir = to_ir(&japanese(&[paragraph], "Identity-H", label), None).unwrap();
        assert_eq!(texts(&ir), ["The cat sat on the mat by the door, as it does every day. Then it slept."]);
    }

    #[test]
    fn a_turned_page_keeps_its_glyphs_and_images_on_it() {
        // On a page 612 wide: a glyph down the column at 500, and an image.
        let glyph = Glyph { x: 500., y: 100., end: 510., size: 10., text: "あ".into(), face: Face::Body, vertical: true, turned: false };
        let image = Drawn { id: (1, 0), x0: 100., y0: 200., x1: 300., y1: 400. };
        let mut page = Page { width: 612., height: 792., glyphs: vec![glyph], drawn: vec![image], ..Default::default() };
        turn(&mut page);
        assert_eq!((page.width, page.height, page.vertical), (792., 612., true));
        assert_eq!(page.glyphs.iter().map(|g| (g.x, g.end, g.y)).collect::<Vec<_>>(), [(100., 110., 112.)]);
        assert_eq!(page.drawn.iter().map(|d| (d.x0, d.y0, d.x1, d.y1)).collect::<Vec<_>>(), [(200., 312., 400., 512.)]);
    }

    #[test]
    fn a_japan1_font_gets_a_tounicode_of_only_the_cids_it_shows() {
        let mut doc = Document::load_mem(&japanese(&[vec![]], "Identity-H", "BT /F3 10 Tf 72 600 Td <034B0377034B> Tj ET")).unwrap();
        give_japan1_text(&mut doc);
        let font = doc.objects.values().filter_map(|o| o.as_dict().ok()).find(|d| d.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Type0"));
        let cmap = doc.get_object(font.unwrap().get(b"ToUnicode").and_then(Object::as_reference).unwrap()).and_then(Object::as_stream).unwrap();
        assert!(String::from_utf8_lossy(&cmap.content).contains("2 beginbfchar\n<034B> <3042>\n<0377> <306e>\nendbfchar"));
    }

    #[test]
    fn a_cid_font_that_gives_its_own_text_or_is_not_japan1_is_left_as_it_is() {
        let read = |change: &dyn Fn(&mut Document, ObjectId)| {
            let mut doc = Document::load_mem(&japanese(&[vec![(72., 100., 10., "Cats")]], "Identity-H", "BT /F3 10 Tf 72 600 Td <034B0377> Tj ET")).unwrap();
            let is_type0 = |o: &Object| o.as_dict().is_ok_and(|d| d.get(b"Subtype").and_then(Object::as_name).is_ok_and(|n| n == b"Type0"));
            let font = doc.objects.iter().find(|(_, o)| is_type0(o)).map(|(&id, _)| id).unwrap();
            change(&mut doc, font);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            texts(&to_ir(&bytes, None).unwrap()).join("|")
        };
        // A ToUnicode of its own, which reads the two CIDs as X and Y.
        let own = |doc: &mut Document, font: ObjectId| {
            let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
                2 beginbfchar\n<034B> <0058>\n<0377> <0059>\nendbfchar\nendcmap end end\n";
            let id = doc.add_object(Stream::new(Dictionary::new(), cmap.as_bytes().to_vec()));
            doc.get_dictionary_mut(font).unwrap().set("ToUnicode", Object::Reference(id));
        };
        // Adobe-Identity, whose CIDs are the font's own glyph numbers.
        let identity = |doc: &mut Document, font: ObjectId| {
            let cid_font = doc.get_dictionary(font).unwrap().get(b"DescendantFonts").and_then(Object::as_array).unwrap()[0].as_reference().unwrap();
            let info = doc.get_dictionary_mut(cid_font).unwrap().get_mut(b"CIDSystemInfo").and_then(Object::as_dict_mut).unwrap();
            info.set("Ordering", Object::string_literal("Identity"));
        };
        assert_eq!([read(&own), read(&identity)], ["Cats|XY", "Cats"]);
    }

    #[test]
    fn columns_put_in_place_by_cm_are_read_as_columns() {
        // The columns of `vertical_writing_is_read_as_paragraphs_down_the_columns`, each moved into place by a cm, which
        // pdf-extract does not tell as it does a Tm.
        let column = |x: f64, y: f64, cids: &str| format!("q 1 0 0 1 {x} {y} cm BT /F3 10 Tf <{cids}> Tj ET Q ");
        let ops = [column(500., 700., "034B034D034F03510353"), column(488., 700., "03540356"), column(476., 690., "0358035A035C")].concat();
        assert_eq!(texts(&to_ir(&japanese(&[vec![]], "Identity-V", &ops), None).unwrap()), ["あいうえおかき", "くけこ"]);
    }

    #[test]
    fn columns_moved_to_by_td_or_set_a_quote_a_character_are_read_as_columns() {
        // The columns of `vertical_writing_is_read_as_paragraphs_down_the_columns`, with the first kana twice: moved to by
        // Td or TD, and set as the book sets them, each character by a quote, which goes down a line first. Kept at the top
        // of its column, the second あ would be drawn where the first is, and dropped.
        let td = "BT /F3 10 Tf 500 700 Td <034B034B034F03510353> Tj -12 0 Td <03540356> Tj -12 -10 Td <0358035A035C> Tj ET";
        let quoted = |x: f64, y: f64, cids: &[&str]| format!("1 0 0 1 {x} {y} Tm {}", cids.iter().map(|c| format!("<{c}> ' ")).collect::<String>());
        let columns = [
            quoted(500., 710., &["034B", "034B", "034F", "0351", "0353"]),
            quoted(488., 710., &["0354", "0356"]),
            quoted(476., 700., &["0358", "035A", "035C"]),
        ];
        let quotes = format!("BT /F3 10 Tf 10 TL {}ET", columns.concat());
        for ops in [td.to_string(), td.replace("Td", "TD"), quotes] {
            assert_eq!(texts(&to_ir(&japanese(&[vec![]], "Identity-V", &ops), None).unwrap()), ["ああうえおかき", "くけこ"], "{ops}");
        }
    }

    #[test]
    fn a_vertical_page_read_again_as_written_keeps_its_columns() {
        // A quote shown before any font is set, then two columns: read again without the quote, the page is still turned.
        let ops = "BT 12 TL 72 692 Td (x) ' ET BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D034F03510353> Tj 1 0 0 1 488 700 Tm <03540356> Tj ET";
        let bytes = japanese(&[vec![]], "Identity-V", ops);
        assert!(glyphs(&bytes, true).unwrap().1[0].vertical);
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()), ["あいうえおかき"]);
    }

    #[test]
    fn strings_shown_one_after_another_go_on_down_their_column() {
        // One column as a TJ of two strings, the next as two Tj after one Tm.
        let ops = "BT /F3 10 Tf 1 0 0 1 500 700 Tm [<034B034D> <034F0351>] TJ 1 0 0 1 488 700 Tm <0353> Tj <0354> Tj ET";
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", ops), None).unwrap();
        assert_eq!(texts(&ir), ["あいうえおか"]);
    }

    #[test]
    fn a_gap_in_a_tj_does_not_end_its_column() {
        // A TJ number of an em, which pdf-extract takes back along the line it believes the string runs on.
        let ops = "BT /F3 10 Tf 1 0 0 1 500 700 Tm [<034B034D034F03510353> 1000 <0354035603580359>] TJ 1 0 0 1 488 700 Tm <035A035C> Tj ET";
        assert_eq!(texts(&to_ir(&japanese(&[vec![]], "Identity-V", ops), None).unwrap()), ["あいうえおかきくぐけこ"]);
    }

    #[test]
    fn a_string_put_beside_a_column_at_its_top_starts_its_own() {
        // The left column drawn first, then the right one from the same height. The layout reads a page in the order it
        // is drawn, so the text is the same either way: on the turned page the right column is a line of its own, 12pt
        // above the left one and starting as far in, where joined it would go on along the left one's line.
        let ops = "BT /F3 10 Tf 1 0 0 1 488 700 Tm <034B> Tj 1 0 0 1 500 700 Tm <034D034F> Tj ET";
        let (_, pages) = glyphs(&japanese(&[vec![]], "Identity-V", ops), true).unwrap();
        let [a, i, u] = &pages[0].glyphs[..] else {
            panic!("{} glyphs", pages[0].glyphs.len());
        };
        let from_a = [a, i, u].map(|g| (g.text.as_str(), (g.x - a.x).round(), (g.y - a.y).round()));
        assert_eq!(from_a, [("あ", 0., 0.), ("い", 0., -12.), ("う", 10., -12.)]);
    }

    #[test]
    fn latin_turned_to_run_down_a_column_is_read_in_its_place() {
        // Two kana, whose em boxes end at 688.8; "If it" in Helvetica from there, 13.3pt long, turned a quarter clockwise
        // with its baseline 3.8pt left of the column's middle; two kana more. An arXiv stamp, turned the other way, stays out.
        let ops = "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D> Tj ET BT /F1 10 Tf 0 -1 1 0 496.2 688.8 Tm (If it) Tj ET \
            BT /F3 10 Tf 1 0 0 1 500 666.6 Tm <034F0351> Tj ET";
        let stamp = vec![(30., 400., 10., "arXiv:2401.00001")];
        assert_eq!(texts(&to_ir(&japanese(&[stamp], "Identity-V", ops), None).unwrap()), ["あいIf itうえ"]);
    }

    #[test]
    fn a_number_set_sideways_in_a_column_is_read_in_its_place() {
        // Kana by CID at 10pt steps down a column, and "25" across in Helvetica where the third would be.
        let ops = "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B> Tj 1 0 0 1 500 690 Tm <034D> Tj ET BT /F1 10 Tf 1 0 0 1 494.4 680 Tm (25) Tj ET \
            BT /F3 10 Tf 1 0 0 1 500 670 Tm <034F> Tj 1 0 0 1 500 660 Tm <0351> Tj ET";
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", ops), None).unwrap();
        assert_eq!(texts(&ir), ["あい25うえ"]);
    }

    #[test]
    fn a_turned_page_leaves_the_room_of_the_other_pages_regions_as_it_was() {
        // A paragraph halfway down a page, then a page of columns, whose lines once turned start higher up and, from a
        // column at the left edge, end lower down.
        let paragraph = vec![(72., 400., 10., "The cat sat on the mat by the door, as it does every day."), (72., 412., 10., "Then it slept.")];
        let ops = "BT /F3 10 Tf 1 0 0 1 500 760 Tm <034B034D034F03510353> Tj 1 0 0 1 488 760 Tm <03540356> Tj 1 0 0 1 60 760 Tm <0358> Tj ET";
        let room = |bytes: &[u8]| regions(bytes).unwrap().iter().filter(|r| r.page == 0).map(|r| (r.room_up, r.room_down)).collect::<Vec<_>>();
        let alone = room(&pdf(std::slice::from_ref(&paragraph), None));
        assert!(alone[0].0 > 0., "{alone:?}");
        assert_eq!(room(&japanese(&[paragraph, vec![]], "Identity-V", ops)), alone);
    }

    #[test]
    fn a_gap_between_japanese_characters_is_no_space() {
        // 10pt glyphs, 10pt apart: a heading's spacing. 25pt apart: a table's cells.
        let spaced = |text: &str, step: f64| {
            let at = |i: usize| i as f64 * step;
            let glyphs: Vec<Glyph> = text
                .chars()
                .enumerate()
                .map(|(i, c)| Glyph { x: at(i), y: 100., end: at(i) + 10., size: 10., text: c.to_string(), face: Face::Body, vertical: false, turned: false })
                .collect();
            line(0, &glyphs.iter().collect::<Vec<_>>()).unwrap().text
        };
        assert_eq!([spaced("目次", 20.), spaced("ab", 20.), spaced("第1", 20.), spaced("名前", 35.)], ["目次", "a b", "第 1", "名 前"]);
    }

    #[test]
    fn faces_come_from_fonts_written_into_the_page_tree() {
        let line: Vec<Run> = vec![(72., 100., 10., "An event"), (120., 100., 10., "/i e"), (130., 100., 10., "happens.")];
        let mut doc = Document::load_mem(&pdf(&[line], None)).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let dict = doc.get_dictionary_mut(page).unwrap();
        let mut resources = dict.remove(b"Resources").unwrap().as_dict().unwrap().clone();
        let parent = dict.get(b"Parent").and_then(Object::as_reference).unwrap();
        // The Font dictionary written in the Resources, or referred to from them.
        let fonts = resources.remove(b"Font").unwrap();
        let referred = Object::Reference(doc.add_object(fonts.clone()));
        for fonts in [fonts, referred] {
            resources.set("Font", fonts);
            // The Resources written in place, which lopdf's `get_page_fonts` does not look for up the tree.
            doc.get_dictionary_mut(parent).unwrap().set("Resources", resources.clone());
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            let math: Vec<String> = regions(&bytes).unwrap()[0].runs.iter().filter(|r| r.math).map(|r| r.text.clone()).collect();
            assert_eq!(math, ["e"], "{:?}", resources.get(b"Font"));
        }
    }

    /// A PDF of `objects`, numbered from 1, listed in a cross-reference stream: each written out, or as `Err(container)`
    /// the first object of that object stream.
    fn cross_referenced(objects: &[Result<&[u8], u32>]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.5\n".to_vec();
        let mut entries = vec![(0u8, 0u32, 0xffffu16)];
        for (i, object) in objects.iter().enumerate() {
            entries.push(match object {
                Ok(body) => {
                    let at = pdf.len();
                    pdf.extend([format!("{} 0 obj\n", i + 1).as_bytes(), *body, b"\nendobj\n"].concat());
                    (1, at as u32, 0)
                }
                Err(container) => (2, *container, 0),
            });
        }
        let at = pdf.len();
        entries.push((1, at as u32, 0));
        let data: Vec<u8> = entries.iter().flat_map(|&(kind, field, index)| [&[kind][..], &field.to_be_bytes(), &index.to_be_bytes()].concat()).collect();
        let size = entries.len();
        pdf.extend(format!("{} 0 obj\n<</Type /XRef /Size {size} /W [1 4 2] /Length {}>>\nstream\n", size - 1, data.len()).as_bytes());
        pdf.extend(data);
        pdf.extend(format!("\nendstream\nendobj\nstartxref\n{at}\n%%EOF\n").as_bytes());
        pdf
    }

    #[test]
    fn stream_lengths_that_lead_round_or_far_fail_the_import() {
        // lopdf 0.42.0 resolved a stream's /Length by recursion until the stack overflowed.
        if !in_child("pdf::tests::stream_lengths_that_lead_round_or_far_fail_the_import") {
            return;
        }
        // Object 2 lies in object stream 2, which it would have to be read from first.
        let round = cross_referenced(&[Ok(b"<</Length 2 0 R>>\nstream\nx\nendstream"), Err(2)]);
        // The /Length of each stream is the next stream, far more of them than the stack holds.
        let bodies: Vec<String> = (2..10_000).map(|next| format!("<</Length {next} 0 R>>\nstream\nx\nendstream")).collect();
        let far = cross_referenced(&bodies.iter().map(|b| Ok(b.as_bytes())).collect::<Vec<_>>());
        for (bytes, how) in [(round, "round"), (far, "far")] {
            assert_eq!(to_ir(&bytes, None).unwrap_err(), msg!("pdf.noText"), "{how}");
        }
    }

    #[test]
    fn a_stream_length_kept_in_an_object_stream_is_read() {
        // Object 2, the length, lies in object stream 3, whose own /Length is object 4.
        let objects: [Result<&[u8], u32>; 4] =
            [Ok(b"<</Length 2 0 R>>\nstream\nx\nendstream"), Err(3), Ok(b"<</Type /ObjStm /N 1 /First 4 /Length 4 0 R>>\nstream\n2 0 1\nendstream"), Ok(b"5")];
        let doc = Document::load_mem(&cross_referenced(&objects)).unwrap();
        assert_eq!(doc.get_object((1, 0)).and_then(Object::as_stream).unwrap().content, b"x");
    }

    /// Two pages: one of `text`, and one of `ops`, which draw streams named `/X0`, `/X1`.. in the page's XObjects, as the
    /// streams may too. Each stream: whether its Subtype is Form (pdf-extract draws a stream without one as if it were), its
    /// content, and whether it has Resources of its own, a copy of the page's, or takes those it is drawn with.
    fn drawing(text: Vec<Run>, ops: &str, streams: &[(bool, String, bool)]) -> Vec<u8> {
        let mut doc = Document::load_mem(&pdf(&[text, vec![]], None)).unwrap();
        let page = *doc.get_pages().values().nth(1).unwrap();
        let xobjects = doc.new_object_id();
        let mut resources = doc.get_dictionary(page).unwrap().get(b"Resources").and_then(Object::as_dict).unwrap().clone();
        resources.set("XObject", Object::Reference(xobjects));
        let mut named = Dictionary::new();
        for (i, (form, content, own)) in streams.iter().enumerate() {
            let mut dict = Dictionary::new();
            if *form {
                dict.set("Subtype", name("Form"));
            }
            if *own {
                dict.set("Resources", resources.clone());
            }
            named.set(format!("X{i}"), Object::Reference(doc.add_object(Stream::new(dict, content.clone().into_bytes()))));
        }
        doc.objects.insert(xobjects, Object::Dictionary(named));
        let dict = doc.get_dictionary_mut(page).unwrap();
        dict.set("Resources", resources);
        let content = dict.get(b"Contents").and_then(Object::as_reference).unwrap();
        doc.get_object_mut(content).and_then(Object::as_stream_mut).unwrap().set_plain_content(ops.as_bytes().to_vec());
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn showing(text: &str) -> String {
        format!("BT /F1 10 Tf 72 100 Td ({text}) Tj ET")
    }

    /// `depth` forms, each drawing the next, the last showing `text`.
    fn nested(depth: usize, text: &str) -> Vec<(bool, String, bool)> {
        (0..depth)
            .map(|i| {
                (
                    true,
                    if i + 1 < depth {
                        format!("/X{} Do", i + 1)
                    } else {
                        showing(text)
                    },
                    true,
                )
            })
            .collect()
    }

    /// Whether the PDF reads with `text` in it.
    fn reads(bytes: &[u8], text: &str) -> bool {
        to_ir(bytes, None).unwrap().blocks.iter().any(|b| b.text.contains(text))
    }

    #[test]
    fn forms_that_draw_themselves_are_left_out() {
        // pdf-extract would draw them until the stack overflowed.
        if !in_child("pdf::tests::forms_that_draw_themselves_are_left_out") {
            return;
        }
        let me = |i: usize| format!("/X{i} Do");
        let without = to_ir(&drawing(quorum_text(), "", &[]), None).unwrap();
        for (streams, how) in [
            (vec![(true, me(0), true)], "a form"),
            (vec![(true, me(1), true), (true, me(0), false)], "two forms that draw each other"),
            (
                (0..10_000)
                    .map(|i| {
                        (
                            true,
                            if i < 9_999 {
                                me(i + 1)
                            } else {
                                String::new()
                            },
                            false,
                        )
                    })
                    .collect(),
                "a chain of forms",
            ),
        ] {
            // Forms are drawn only for a page without text of its own, which then stays without.
            assert_eq!(kinds(&to_ir(&drawing(quorum_text(), "/X0 Do", &streams), None).unwrap()), kinds(&without), "{how}");
        }
        // A stream without a Subtype is drawn along with the text, so the PDF is refused.
        assert_eq!(to_ir(&drawing(quorum_text(), "/X0 Do", &[(false, me(0), false)]), None).unwrap_err(), msg!("pdf.parseFailed"));
    }

    #[test]
    fn forms_are_read_as_deep_as_they_nest_in_a_pdf() {
        // Text inside an included page, and so on: deeper than any PDF nests them.
        let deep = |depth| reads(&drawing(quorum_text(), "/X0 Do", &nested(depth, "Deep inside")), "Deep inside");
        assert!(deep(32));
        assert!(!deep(33), "one deeper, the page is read without its forms");
    }

    #[test]
    fn forms_drawn_over_and_over_are_left_out() {
        // Forms that each draw the next twice: pdf-extract would draw the last 2^21 times, which takes it minutes.
        let twice = |depth: usize, padding: usize| -> Vec<(bool, String, bool)> {
            let next = |i: usize| format!("{}/X{} Do /X{1} Do", " ".repeat(padding), i + 1);
            (0..depth)
                .map(|i| {
                    (
                        true,
                        if i + 1 < depth {
                            next(i)
                        } else {
                            showing("Over and over")
                        },
                        true,
                    )
                })
                .collect()
        };
        assert!(!reads(&drawing(quorum_text(), "/X0 Do", &twice(22, 0)), "Over and over"), "small forms");
        // Fewer times, but each time a quarter megabyte to read.
        assert!(!reads(&drawing(quorum_text(), "/X0 Do", &twice(10, 256 << 10)), "Over and over"), "large forms");
        // A form drawn in many places on a page is read.
        let shown = format!("{}/X0 Do", "q 1 0 0 1 0 -10 cm /X0 Do Q ".repeat(1000));
        assert!(reads(&drawing(quorum_text(), &shown, &nested(1, "Every time")), "Every time"));
    }

    #[test]
    fn a_page_s_own_image_hides_the_one_its_parent_names_alike() {
        let mut doc = Document::load_mem(&quorum()).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let dict = doc.get_dictionary(page).unwrap();
        let (inherited, parent) =
            (dict.get(b"Resources").and_then(Object::as_dict).unwrap().clone(), dict.get(b"Parent").and_then(Object::as_reference).unwrap());
        let mut masked = rgb(30, 10, [0, 0, 0]);
        masked.dict.set("SMask", Object::Reference((1, 0)));
        let masked = doc.add_object(masked);
        // The page names its own masked image by each name its parent gives a figure.
        let mut own = inherited.clone();
        let xobjects = own.get_mut(b"XObject").and_then(Object::as_dict_mut).unwrap();
        for (_, o) in xobjects.iter_mut() {
            *o = Object::Reference(masked);
        }
        let shared = doc.add_object(inherited);
        doc.get_dictionary_mut(parent).unwrap().set("Resources", Object::Reference(shared));
        // Written in the page or, as most producers write them, referred to: lopdf then lists them with the inherited ones.
        let referred = Object::Reference(doc.add_object(own.clone()));
        for resources in [Object::Dictionary(own), referred] {
            doc.get_dictionary_mut(page).unwrap().set("Resources", resources);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            let ir = to_ir(&bytes, None).unwrap();
            assert_eq!(ir.blocks.iter().filter(|b| b.kind == BlockKind::Image).count(), 0, "{:?}", kinds(&ir));
        }
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
        let labels = ["Fig. 2. A", "Table IV: B", "Figure 2.1: C", "Figure 6-13. If w", "Figure 3.", "Table 1 shows", "Figure 3 shows", "Figure 1.5 shows"];
        assert_eq!(labels.map(caption_label), [Some("Fig. 2"), Some("Table IV"), Some("Figure 2.1"), Some("Figure 6-13"), Some("Figure 3"), None, None, None]);
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
