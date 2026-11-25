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
    let blocks = to_blocks(&lines, body, &doc, &figure_prefix(bytes));
    let Some(first) = blocks.iter().find(|b| b.kind != BlockKind::Image) else {
        return Err(msg!("pdf.noText"));
    };
    let non_empty = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    // A table's text has its cells apart by tabs and its rows by line breaks.
    let first_line = || Some(collapse(&first.text).chars().take(80).collect::<String>());
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
    let upright = lines.iter().filter(|l| doc.pages.get(l.page).is_some_and(|p| !p.vertical));
    let extent = |l: &Line| match l.table {
        Some(t) => doc.pages[l.page].tables[t].at,
        None => [l.x0, l.y - l.size, l.x1, l.y + 0.3 * l.size],
    };
    let [_, top, _, bottom] = upright.map(extent).fold(NOTHING, union);
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

/// A region as far up or down as the document's text and tables go has only the margin beyond it, and what is
/// printed there (a running header, a table) stops it. One that ends short of that has a figure or the like
/// beyond it, which is not in the glyphs: figures are skipped.
fn give_room(r: &mut Region, page: &Page, top: f64, bottom: f64) {
    let across = |g: &&Glyph| g.table.is_none() && g.x < r.x1 && g.end > r.x0;
    let tables = || page.tables.iter().map(|t| t.at).filter(|&[x0, _, x1, _]| x0 < r.x1 && x1 > r.x0);
    if r.y0 <= top + r.size {
        let above = page.glyphs.iter().filter(across).filter(|g| g.y < r.y0).map(|g| g.y + 0.3 * g.size);
        let above = above.chain(tables().map(|t| t[3]).filter(|&y| y <= r.y0));
        r.room_up = (r.y0 - above.fold(PAGE_EDGE * page.height, f64::max)).max(0.);
    }
    if r.y1 >= bottom - r.size {
        let below = page.glyphs.iter().filter(across).filter(|g| g.y > r.y1).map(|g| g.y - g.size);
        let below = below.chain(tables().map(|t| t[1]).filter(|&y| y >= r.y1));
        r.room_down = (below.fold((1. - PAGE_EDGE) * page.height, f64::min) - r.y1).max(0.);
    }
    // Only a single line has room at its sides (`region`), so the box's bottom gives its baseline.
    if r.room_left > 0. || r.room_right > 0. {
        let base = r.y1 - 0.3 * r.size;
        let beside = |g: &&Glyph| (g.y - base).abs() < 0.6 * r.size && !g.text.trim().is_empty();
        let level = || page.tables.iter().map(|t| t.at).filter(|&[_, y0, _, y1]| y0 < r.y1 && y1 > r.y0);
        let left = page.glyphs.iter().filter(beside).filter(|g| g.end <= r.x0).map(|g| r.x0 - g.end);
        r.room_left = left.chain(level().filter(|t| t[2] <= r.x0).map(|t| r.x0 - t[2])).fold(r.room_left, f64::min);
        let right = page.glyphs.iter().filter(beside).filter(|g| g.x >= r.x1).map(|g| g.x - r.x1);
        r.room_right = right.chain(level().filter(|t| t[0] >= r.x1).map(|t| t[0] - r.x1)).fold(r.room_right, f64::min);
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
    d.kind == Kind::Table || d.kind == Kind::Paragraph && (short || d.lines.iter().any(|l| l.tabular()))
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

/// The document's lines in reading order, without running headers, the size of its body text, and the front matter
/// taken off the first page.
fn lay_out(doc: &Parsed) -> (Vec<Line>, f64, Front) {
    let mut lines = Vec::new();
    for (i, page) in doc.pages.iter().enumerate() {
        lines.push(page_lines(i, &page.glyphs.iter().collect::<Vec<_>>(), page.width));
    }
    drop_running_lines(&mut lines, &doc.pages);
    let body = body_size(&lines);
    let mut lines: Vec<Line> = lines.into_iter().zip(&doc.pages).flat_map(|(l, p)| order(l, p)).collect();
    let half = doc.pages.first().map_or(0., |p| p.height / 2.);
    let front = take_front_matter(&mut lines, body, half);
    (lines, body, front)
}

/// A table read from a `Grid`: its box, in points from the page's top left, and the lines of its cells row by row.
struct Table {
    at: Bounds,
    rows: Vec<Vec<Vec<Line>>>,
}

/// The tables of the page's grids that hold text in half their cells or more. A glyph is in the cell its middle is in. One
/// in a table stays on the page, marked: the layout reads a table's lines as any others, and so finds where the table goes.
fn take_tables(p: &mut Page, grids: Vec<Grid>, turns: bool) {
    let two = !turns && !grids.is_empty() && {
        let grid_of = |g: &Glyph| grids.iter().position(|grid| grid.cell(g).is_some());
        let set: Vec<Glyph> = p.glyphs.iter().map(|g| Glyph { table: grid_of(g), ..g.clone() }).collect();
        // Less the lines of a table across the middle, which can hold most of the text of a page in two columns.
        let in_half = |l: &&Line| l.table.is_none_or(|t| Side::of(grids[t].at[0], grids[t].at[2], p.width) != Side::Full);
        in_two_columns(page_lines(0, &set.iter().collect::<Vec<_>>(), p.width).iter().filter(in_half), p.width)
    };
    for grid in &grids {
        let cell = |g: &Glyph| grid.cell(g).filter(|_| g.table.is_none());
        let Grid { at, xs, ys } = grid;
        let mut cells = vec![vec![Vec::new(); xs.len() - 1]; ys.len() - 1];
        for g in &p.glyphs {
            if let Some((row, column)) = cell(g) {
                cells[row][column].push(g);
            }
        }
        // shortcut: a page that turns keeps every grid that holds enough text, as numbers set across in the columns beside
        // a table (縦中横) sit on its baselines by chance; tell them from a row's other cells if a partly ruled table turns
        // up in vertical writing.
        if !turns && runs_on(p, grid, &grids, &cells, two) {
            continue;
        }
        let inset = |column: usize| {
            let set = cells.iter().flat_map(|band| &band[column]).filter(|g| !g.text.trim().is_empty());
            // Text in the middle of a wide column is further in than the column's padding.
            set.map(|g| (g.x - xs[column]).min(xs[column + 1] - g.end).min(g.size)).fold(f64::MAX, f64::min).max(0.)
        };
        let widths: Vec<f64> = (0..xs.len() - 1).map(|column| xs[column + 1] - xs[column] - 2. * inset(column)).collect();
        // The first band is the head, one row: a head's cells may each set a unit under their name, which breaks as rows do.
        let breaks: Vec<Option<Vec<f64>>> = cells[1..].iter().map(|band| row_breaks(band, &widths, p.width)).collect();
        // Where more than one band is under the head, its rules most likely part all its rows.
        if let [None] = breaks[..] {
            continue;
        }
        let breaks = std::iter::once(Vec::new()).chain(breaks.into_iter().map(Option::unwrap_or_default));
        let rows: Vec<Vec<Vec<Line>>> = cells.iter().zip(breaks).flat_map(|(band, breaks)| band_rows(band, &breaks, p.width)).collect();
        let filled = rows.iter().flatten().filter(|lines| !lines.is_empty()).count();
        if filled * 2 >= (xs.len() - 1) * rows.len() {
            for g in p.glyphs.iter_mut().filter(|g| cell(g).is_some()) {
                g.table = Some(p.tables.len());
            }
            p.tables.push(Table { at: *at, rows });
        }
    }
}

/// Whether a grid's rows go on past its rules, as a table ruled round only some of its columns does: text beside it, in no
/// other grid, set on the baseline of a line in one of its cells. Taken alone, the ruled columns would leave the rest of
/// each row before them, which as text reads on along the row. On a page set in `two` columns, the other column is not
/// beside a table in one of them.
fn runs_on(p: &Page, grid: &Grid, grids: &[Grid], cells: &[Vec<Vec<&Glyph>>], two: bool) -> bool {
    let [x0, y0, x1, y1] = grid.at;
    let table = Side::of(x0, x1, p.width);
    let across = |g: &Glyph| !g.vertical && !g.text.trim().is_empty();
    let mut baselines: Vec<f64> = cells.iter().flatten().flatten().filter(|g| across(g)).map(|g| g.y).collect();
    baselines.sort_by(f64::total_cmp);
    let on_a_baseline = |g: &Glyph| baselines.get(baselines.partition_point(|&y| y < g.y - 0.3 * g.size)).is_some_and(|&y| y < g.y + 0.3 * g.size);
    let beside = |g: &Glyph| {
        let (y, side) = (g.y - 0.3 * g.size, Side::of(g.x, g.end, p.width));
        let left = g.end <= x0 && (!two || table != Side::Right || side == Side::Right);
        y > y0 && y < y1 && (left || g.x >= x1 && (!two || table != Side::Left || side == Side::Left))
    };
    p.glyphs.iter().any(|g| across(g) && beside(g) && on_a_baseline(g) && !grids.iter().any(|other| other.cell(g).is_some()))
}

/// The baselines that start a further row in the band between two rules across: none, unless it holds rows no rule parts,
/// as a table ruled only round its columns does. Those are told from the lines of one row by how the cells' lines end: one
/// that wraps leaves no room for the first word under it, in the `widths` the columns' text has. Fails where some cells
/// seem to wrap and others to hold rows; a column of numbers settles it.
// shortcut: cells that each break their text at the same baselines read as rows, so a row of cells holding addresses is
// cut up; tell them apart if such tables turn up.
fn row_breaks(band: &[Vec<&Glyph>], widths: &[f64], width: f64) -> Option<Vec<f64>> {
    if band.iter().flatten().any(|g| g.vertical || g.turned) {
        return Some(Vec::new());
    }
    let mut columns: Vec<Vec<Line>> = band.iter().map(|glyphs| page_lines(0, glyphs, width)).collect();
    for lines in &mut columns {
        lines.sort_by(|a, b| a.y.total_cmp(&b.y));
        lines.dedup_by(|next, kept| {
            let piece = next.y - kept.y < 0.3 * kept.size;
            if piece {
                (kept.x0, kept.x1) = (kept.x0.min(next.x0), kept.x1.max(next.x1));
            }
            piece
        });
    }
    let mut lines: Vec<&Line> = columns.iter().flatten().collect();
    lines.sort_by(|a, b| a.y.total_cmp(&b.y));
    // Each baseline, how many columns have text on it, and whether a line there starts a row.
    let mut baselines: Vec<(f64, usize, bool)> = Vec::new();
    for l in lines {
        match baselines.last_mut() {
            Some((y, columns, _)) if l.y - *y < 0.3 * l.size => *columns += 1,
            _ => baselines.push((l.y, 1, false)),
        }
    }
    let (mut parted, mut wrapped, mut words, mut tellers, mut numbers) = (0, 0, 0, 0, false);
    for (lines, &room) in columns.iter().zip(widths) {
        let mut tells = false;
        for (before, after) in lines.iter().zip(lines.iter().skip(1)) {
            let letter = (after.x1 - after.x0) / after.text.chars().count() as f64;
            let word = if after.text.starts_with(joins_without_space) {
                after.text.chars().take(4).count()
            } else {
                after.text.split(' ').next().unwrap_or_default().chars().count()
            };
            let parts = is_number(&before.text) && is_number(&after.text) || before.x1 - before.x0 + (word as f64 + 2.) * letter <= room;
            let at = baselines.partition_point(|b| b.0 <= after.y) - 1;
            let (_, columns, starts) = &mut baselines[at];
            *starts |= parts;
            if *columns > 1 && !is_bullet(&after.text) && !after.text.starts_with('・') {
                tells = true;
                words += usize::from(!parts && is_word(&before.text));
                *(if parts {
                    &mut parted
                } else {
                    &mut wrapped
                }) += 1;
            }
        }
        tellers += usize::from(tells);
        numbers |= tells && lines.iter().all(|l| is_number(&l.text));
    }
    if tellers < 2 || parted + words == 0 {
        return Some(Vec::new());
    }
    let filled = columns.iter().filter(|lines| !lines.is_empty()).count();
    let sure = baselines[0].1 == filled && tellers == filled && (wrapped == 0 || numbers);
    sure.then(|| baselines.iter().skip(1).filter(|b| b.2 || b.1 == filled).map(|b| b.0).collect())
}

/// A number, or a mark among numbers, with nothing after it to go on with.
fn is_number(t: &str) -> bool {
    !t.contains(|c: char| c.is_alphabetic() || c.is_whitespace()) && !t.ends_with(['-', ','])
}

fn is_word(t: &str) -> bool {
    !t.contains(|c: char| c.is_whitespace() || joins_without_space(c))
}

/// The rows of a band, each a cell per column, cut where `breaks` starts one.
fn band_rows(band: &[Vec<&Glyph>], breaks: &[f64], width: f64) -> Vec<Vec<Vec<Line>>> {
    let mut rows = vec![vec![Vec::new(); band.len()]; breaks.len() + 1];
    for (column, glyphs) in band.iter().enumerate() {
        for &g in glyphs {
            rows[breaks.partition_point(|&y| g.y > y - 0.6 * g.size)][column].push(g);
        }
    }
    rows.iter().map(|row| row.iter().map(|glyphs| cell_lines(glyphs, width)).collect()).collect()
}

/// A cell's lines, one set down the page read as a turned page is. Only their text is read, so their page is left 0.
fn cell_lines(glyphs: &[&Glyph], width: f64) -> Vec<Line> {
    let mut down = Page { width, ..Default::default() };
    if glyphs.iter().any(|g| g.vertical || g.turned) {
        down.glyphs = glyphs.iter().map(|&g| g.clone()).collect();
        turn(&mut down);
    }
    let turned: Vec<&Glyph> = down.glyphs.iter().collect();
    page_lines(
        0,
        if turned.is_empty() {
            glyphs
        } else {
            &turned
        },
        down.width,
    )
}

#[derive(Clone)]
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
    /// Which of its page's tables it is in.
    table: Option<usize>,
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

/// The styles, the images and the grids `walk` finds on a page.
type Walked = (Vec<Style>, Vec<Drawn>, Vec<Grid>);

/// What a page's content shows beside what pdf-extract reports, which is glyphs without their fonts and no images: the
/// style of each string, in the order pdf-extract shows them, and the images and the grids its rules make (each line
/// stroked, and each bar filled no thicker than twice `RULE_SLACK`), in the PDF's own coordinates. pdf-extract calls `begin_word` once per string,
/// so the styles line up with what it reports. Images inside forms, and inline images, are not followed. A clip counts
/// by the box around its path.
// shortcut: the Reader shows a clipped image whole (cropping a JPEG or predicted rows means decoding them); crop the
// pixels when a figure's hidden part turns out to matter.
fn walk(doc: &Document, page: ObjectId, resources: Option<&Dictionary>) -> Walked {
    let Ok(content) = doc.get_page_content(page).and_then(|bytes| Content::decode(&bytes)) else {
        return (Vec::new(), Vec::new(), Vec::new());
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
    // The path's current point and the start of its subpath, as the content gives them, and its lines and rectangles.
    let (mut at, mut start, mut sides, mut boxes, mut rules) = ((0., 0.), (0., 0.), Vec::new(), Vec::<Bounds>::new(), Vec::new());
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
                    let corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
                    let rect = bounds(&ctm, &corners);
                    path = union(path, rect);
                    boxes.push(rect);
                    // Each side apart: the box round a turned rectangle is not where its sides are stroked.
                    sides.extend((0..4).map(|i| bounds(&ctm, &[corners[i], corners[(i + 1) % 4]])));
                    (at, start) = ((x, y), (x, y));
                }
            }
            "m" | "l" | "c" | "v" | "y" => {
                let points: Vec<(f64, f64)> = numbers(op).as_chunks::<2>().0.iter().map(|&[x, y]| (x, y)).collect();
                path = union(path, bounds(&ctm, &points));
                if let Some(&end) = points.last() {
                    match op.operator.as_str() {
                        "m" => start = end,
                        "l" => sides.push(bounds(&ctm, &[at, end])),
                        _ => {}
                    }
                    at = end;
                }
            }
            "h" => {
                sides.push(bounds(&ctm, &[at, start]));
                at = start;
            }
            "W" | "W*" => clipping = true,
            // The path ends here, and a clip it was marked for starts. pdf.js clips nothing for an empty path.
            "n" | "f" | "F" | "f*" | "S" | "s" | "B" | "B*" | "b" | "b*" => {
                if clipping && path != NOTHING {
                    clip = Some(clip.map_or(path, |c| intersect(c, path)));
                }
                let paint = op.operator.as_str();
                if matches!(paint, "s" | "b" | "b*") {
                    sides.push(bounds(&ctm, &[at, start]));
                }
                if matches!(paint, "S" | "s" | "B" | "B*" | "b" | "b*") {
                    rules.append(&mut sides);
                } else if paint != "n" {
                    // Not a shaded cell: so thin that what meets its edge is within `RULE_SLACK` of its middle.
                    let bars = boxes.iter().filter(|&&[x0, y0, x1, y1]| (x1 - x0).min(y1 - y0) <= 2. * RULE_SLACK);
                    rules.extend(bars.map(|&[x0, y0, x1, y1]| {
                        let (x, y) = ((x0 + x1) / 2., (y0 + y1) / 2.);
                        if x1 - x0 > y1 - y0 {
                            [x0, y, x1, y]
                        } else {
                            [x, y0, x, y1]
                        }
                    }));
                }
                (path, clipping) = (NOTHING, false);
                sides.clear();
                boxes.clear();
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
    (styles, drawn, grids(rules.into_iter()))
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

/// A table ruled round every one of its cells: its box, the x of its column edges, left to right, and the y of its row
/// edges, top to bottom, in points from the page's top left. `walk` finds it in the PDF's own coordinates, its rows bottom
/// to top.
struct Grid {
    at: Bounds,
    xs: Vec<f64>,
    ys: Vec<f64>,
}

impl Grid {
    /// The row and the column of the cell a glyph's middle is in. A glyph set across is placed by its baseline, one set
    /// down the page by the middle of its column and of its advance down it: a vertical glyph's `y` is its em box's top.
    fn cell(&self, g: &Glyph) -> Option<(usize, usize)> {
        let between =
            |edges: &[f64], at: f64| Some(edges.partition_point(|&e| e < at)).filter(|&i| i > 0 && edges.get(i).is_some_and(|&e| e > at)).map(|i| i - 1);
        let (x, y) = if g.vertical || g.turned {
            (g.x, g.y + (g.end - g.x) / 2.)
        } else {
            ((g.x + g.end) / 2., g.y - 0.3 * g.size)
        };
        Some((between(&self.ys, y)?, between(&self.xs, x)?))
    }
}

/// How far apart rules may be and still meet or run on: more than a rule is thick, and than the gap a book leaves between
/// the strokes it draws a cell's side at a time.
const RULE_SLACK: f64 = 2.;

/// A rule across or down the page: where it lies, and where it runs from and to.
type Rule = (f64, f64, f64);

/// The grids rules make: rules across and down that meet, at least two columns and two rows, each rule running the whole
/// width or height. A chart's grid lines make one too, which `take_tables` passes over when its cells hold little text.
// shortcut: a table with merged cells, or one ruled only across as LaTeX's booktabs rules it, stays text; read those
// when such tables turn up.
fn grids(rules: impl Iterator<Item = Bounds>) -> Vec<Grid> {
    let (mut across, mut down) = (Vec::new(), Vec::new());
    for [x0, y0, x1, y1] in rules {
        if y1 - y0 <= RULE_SLACK && x1 - x0 > y1 - y0 {
            across.push(((y0 + y1) / 2., x0, x1));
        } else if x1 - x0 <= RULE_SLACK && y1 - y0 > x1 - x0 {
            down.push(((x0 + x1) / 2., y0, y1));
        }
    }
    let (across, down) = (joined(across), joined(down));
    // Every rule across is tried against every rule down: a drawing of thousands of each would take seconds.
    if across.len() * down.len() > 1_000_000 {
        return Vec::new();
    }
    let meet = |a: &Rule, d: &Rule| d.0 > a.1 - RULE_SLACK && d.0 < a.2 + RULE_SLACK && a.0 > d.1 - RULE_SLACK && a.0 < d.2 + RULE_SLACK;
    let (mut reached_across, mut reached_down) = (vec![false; across.len()], vec![false; down.len()]);
    let mut groups = Vec::new();
    for first in 0..across.len() {
        if reached_across[first] {
            continue;
        }
        reached_across[first] = true;
        let (mut group_across, mut group_down) = (vec![across[first]], Vec::new());
        let mut reached = vec![(true, first)];
        while let Some((is_across, i)) = reached.pop() {
            if is_across {
                for (j, d) in down.iter().enumerate() {
                    if !reached_down[j] && meet(&across[i], d) {
                        reached_down[j] = true;
                        group_down.push(*d);
                        reached.push((false, j));
                    }
                }
            } else {
                for (j, a) in across.iter().enumerate() {
                    if !reached_across[j] && meet(a, &down[i]) {
                        reached_across[j] = true;
                        group_across.push(*a);
                        reached.push((true, j));
                    }
                }
            }
        }
        groups.push((group_across, group_down));
    }
    groups
        .into_iter()
        .filter_map(|(across, down)| {
            let edges = |rules: &[Rule]| {
                let mut at: Vec<f64> = rules.iter().map(|r| r.0).collect();
                at.sort_by(f64::total_cmp);
                // A double rule parts two cells, not three.
                at.dedup_by(|next, kept| *next - *kept < 2. * RULE_SLACK);
                at
            };
            let (xs, ys) = (edges(&down), edges(&across));
            let (&[left, .., right], &[top, .., bottom]) = (&xs[..], &ys[..]) else {
                return None;
            };
            let whole = |r: &Rule, from: f64, to: f64| r.1 < from + RULE_SLACK && r.2 > to - RULE_SLACK;
            let ruled = across.iter().all(|r| whole(r, left, right)) && down.iter().all(|r| whole(r, top, bottom));
            (ruled && xs.len() >= 3 && ys.len() >= 3).then_some(Grid { at: [left, top, right, bottom], xs, ys })
        })
        .collect()
}

/// Rules on one line joined where they touch or overlap: a book strokes a cell's side at a time.
fn joined(mut rules: Vec<Rule>) -> Vec<Rule> {
    rules.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<Rule> = Vec::new();
    for line in rules.chunk_by(|a, b| b.0 - a.0 <= RULE_SLACK) {
        let at = line.iter().map(|r| r.0).sum::<f64>() / line.len() as f64;
        let mut line = line.to_vec();
        line.sort_by(|a, b| a.1.total_cmp(&b.1));
        let start = out.len();
        for (_, from, to) in line {
            match out[start..].last_mut() {
                Some(last) if from <= last.2 + RULE_SLACK => last.2 = last.2.max(to),
                _ => out.push((at, from, to)),
            }
        }
    }
    out
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
    tables: Vec<Table>,
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
    let (styles, drawn, grids): (Vec<_>, Vec<_>, Vec<_>) = walked.into_iter().collect();
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
                    if let (Some(spelt), Some((written, _, _))) = (out.styles.get_mut(index), walked.get_mut(index)) {
                        *spelt = std::mem::take(written);
                    }
                    let read = catch_unwind(AssertUnwindSafe(|| pdf_extract::output_doc_page(written, &mut out, number)));
                    Ok::<_, String>(read.unwrap_or_else(|panic| resume_unwind(panic)))
                })?;
                read.map_err(|e| unreadable(&e))?;
            }
        }
    }
    let vertical = mostly_down(out.pages.iter().flat_map(|p| &p.glyphs));
    for ((page, drawn), grids) in out.pages.iter_mut().zip(drawn).zip(grids) {
        let (left, top) = (page.left, page.top);
        page.drawn = drawn.into_iter().map(|d| Drawn { x0: d.x0 - left, y0: top - d.y1, x1: d.x1 - left, y1: top - d.y0, ..d }).collect();
        let grids: Vec<Grid> = grids
            .into_iter()
            .map(|Grid { at: [x0, y0, x1, y1], xs, ys }| Grid {
                at: [x0 - left, top - y1, x1 - left, top - y0],
                xs: xs.into_iter().map(|x| x - left).collect(),
                ys: ys.into_iter().rev().map(|y| top - y).collect(),
            })
            .collect();
        // In vertical writing, glyphs set across in a grid have no say: a table set across can hold more of them than the
        // page's columns. In a document set across they have, or a label set down beside a page of tables would turn it.
        // The page's turn is known before its tables are taken, so that a turned glyph goes into its cell, or as a label
        // is dropped before.
        let says = |g: &&Glyph| g.vertical || !vertical || !grids.iter().any(|grid| grid.cell(g).is_some());
        let turns = mostly_down(page.glyphs.iter().filter(says));
        if !turns {
            page.glyphs.retain(|g| !g.turned);
        }
        take_tables(page, grids, turns);
        if turns {
            turn(page);
        }
    }
    Ok((doc, out.pages))
}

/// Whether most of the glyphs are set down the page, as vertical writing is.
fn mostly_down<'a>(glyphs: impl Iterator<Item = &'a Glyph>) -> bool {
    let set = glyphs.filter(|g| !g.turned && !g.text.trim().is_empty());
    let (down, all) = set.fold((0, 0), |(down, all), g| (down + usize::from(g.vertical), all + 1));
    down * 2 > all
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
            && g.table == r.table
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
    for t in &mut page.tables {
        let [x0, y0, x1, y1] = t.at;
        t.at = [y0, width - x1, y1, width - x0];
    }
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
        page.glyphs.push(Glyph { x, y, end: x + width * size, size, text: text.to_string(), face, vertical, turned, table: None });
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

impl Side {
    /// The half of a page `width` across that the span from `x0` to `x1` is in: across the middle by up to 1% of the
    /// width is still in one half, as a column's lines run a little into the gutter.
    fn of(x0: f64, x1: f64, width: f64) -> Side {
        let (mid, tol) = (width / 2., width * 0.01);
        match () {
            _ if x1 <= mid + tol => Side::Left,
            _ if x0 >= mid - tol => Side::Right,
            _ => Side::Full,
        }
    }
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
    /// Which of its page's tables it is in.
    table: Option<usize>,
}

impl Line {
    /// A table row, or an equation and its label. One wide gap in a line that runs to the column's
    /// edge is a heading set in the paragraph's first line.
    fn tabular(&self) -> bool {
        self.wide_gaps > 1 || self.wide_gaps == 1 && self.x1 < self.right - 0.5 * self.size
    }
}

/// Glyphs in content order -> lines: a new line where the baseline moves, the pen jumps back
/// left, it jumps the gutter in the middle of the page (columns written row by row), or it enters or leaves a table. A script
/// is measured from the letter it belongs to: `e` with both a superscript and a subscript moves
/// further up and down than a line break would, and returns left to set the second under the first.
fn page_lines(page: usize, glyphs: &[&Glyph], width: f64) -> Vec<Line> {
    let mid = width / 2.;
    let mut groups: Vec<Vec<&Glyph>> = Vec::new();
    for &g in glyphs {
        let new_line = match groups.last().and_then(|l| Some((l.last()?, *l.iter().rev().find(|x| !is_script(x, l))?))) {
            None => true,
            Some((prev, letter)) => {
                let size = prev.size.max(g.size);
                let back = g.x < prev.x - size && (g.x < letter.x || g.size >= SCRIPT * letter.size);
                (g.y - letter.y).abs() > 0.6 * letter.size.max(g.size)
                    || back
                    || (prev.end < mid && g.x > mid && g.x - prev.end > 1.5 * size)
                    || prev.table != g.table
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
    Some(Line { page, x0, x1, y: base.y, size: main as f64 / 10., text, marked, side: Side::Full, left: x0, right: x1, wide_gaps, table: glyphs[0].table })
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
/// is as far from the page's index on at least a third of the pages. A table goes whole or not at all, and only for its
/// text: numbers alone in one are no page number.
fn drop_running_lines(lines: &mut [Vec<Line>], pages: &[Page]) {
    // A turned page has the top and the bottom of the page at its sides.
    let margin = |page: usize, [x0, y0, x1, y1]: Bounds| {
        let p = &pages[page];
        y1 < p.height * 0.08 || y0 > p.height * 0.92 || p.vertical && (x1 < p.width * 0.08 || x0 > p.width * 0.92)
    };
    let in_margin = |l: &Line| margin(l.page, [l.x0, l.y, l.x1, l.y]);
    let key = |l: &Line| in_margin(l).then(|| running_key(&l.text));
    // Wholly in it: a report's table of the body, one a page with only its numbers changed, can reach into the margin.
    // Its tabs, which no line has, keep it apart from the lines' keys.
    let table_text = |t: &Table| t.rows.iter().flatten().flatten().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\t");
    let table_key = |page: usize, t: &Table| margin(page, t.at).then(|| running_key(&table_text(t)));
    // The number a margin line starts or ends with, less the page's index. A heading starts with its
    // number too ("2 Related Work"), so at the start it counts only when no word follows it.
    let folio = |l: &Line| {
        if !in_margin(l) {
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
    for (i, page) in pages.iter().enumerate() {
        for k in page.tables.iter().filter_map(|t| table_key(i, t)) {
            seen.entry(k).or_default().insert(i);
        }
    }
    let n = pages.len();
    let often = |on: Option<&HashSet<usize>>| on.is_some_and(|p| p.len() >= 2 && p.len() * 3 >= n);
    let running = |k: &str| {
        let number = k.chars().all(|c| c == '#' || !c.is_alphanumeric()) || (k.len() <= 6 && k.chars().all(|c| matches!(c, 'i' | 'v' | 'x')));
        number || often(seen.get(k))
    };
    for (i, page) in lines.iter_mut().enumerate() {
        let kept: Vec<bool> = pages[i].tables.iter().map(|t| table_key(i, t).is_none_or(|k| !often(seen.get(&k)))).collect();
        page.retain(|l| match l.table {
            Some(t) => kept[t],
            None => key(l).is_none_or(|k| !running(&k)) && folio(l).is_none_or(|offset| !often(numbered.get(&offset))),
        });
    }
}

/// A running line's text as it repeats from page to page: lowercased, each number as `#`.
fn running_key(text: &str) -> String {
    let mut k = String::new();
    for c in text.to_lowercase().chars() {
        match c {
            '0'..='9' if k.ends_with('#') => {}
            '0'..='9' => k.push('#'),
            c => k.push(c),
        }
    }
    k
}

/// Whether a page is set in two columns: each half holds a fifth of the text.
fn in_two_columns<'a>(lines: impl Iterator<Item = &'a Line>, width: f64) -> bool {
    let (mut left, mut right, mut total) = (0, 0, 0);
    for l in lines {
        let chars = l.text.chars().count();
        match Side::of(l.x0, l.x1, width) {
            Side::Left => left += chars,
            Side::Right => right += chars,
            Side::Full => {}
        }
        total += chars;
    }
    left * 5 >= total && right * 5 >= total
}

/// Reading order of one page, with each table's lines where the first of them is read. In two columns, lines across the
/// middle (title, wide figures) split the page into bands, read left column then right. Otherwise the content order
/// stands, except that a table goes before what is drawn right before it and lies under it: captions drawn first.
fn order(mut lines: Vec<Line>, page: &Page) -> Vec<Line> {
    // A table set across on a turned page tells nothing of its columns.
    let guides = |l: &&Line| l.table.is_none() || !page.vertical;
    let two = in_two_columns(lines.iter().filter(guides), page.width);
    if two {
        for l in &mut lines {
            l.side = Side::of(l.x0, l.x1, page.width);
        }
        lines.sort_by(|a, b| a.y.total_cmp(&b.y));
    }
    for s in [Side::Left, Side::Right, Side::Full] {
        let of_side = || lines.iter().filter(guides).filter(|l| l.side == s);
        let long = || of_side().filter(|l| l.text.chars().count() >= 20);
        let (lo, hi) = match long().next() {
            Some(_) => (long().map(|l| l.x0).fold(f64::MAX, f64::min), long().map(|l| l.x1).fold(f64::MIN, f64::max)),
            None => (of_side().map(|l| l.x0).fold(f64::MAX, f64::min), of_side().map(|l| l.x1).fold(f64::MIN, f64::max)),
        };
        for l in lines.iter_mut().filter(|l| l.side == s) {
            (l.left, l.right) = (lo, hi);
        }
    }
    let mut tables = vec![Vec::new(); page.tables.len()];
    let mut out: Vec<Line> = Vec::with_capacity(lines.len());
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for mut l in lines {
        let table = l.table.map(|t| page.tables[t].at);
        if let (Some(t), Some([x0, _, x1, _])) = (l.table, table) {
            if two {
                l.side = Side::of(x0, x1, page.width);
            }
            if !tables[t].is_empty() {
                tables[t].push(l);
                continue;
            }
            (l.x0, l.x1) = (x0, x1);
            tables[t].push(l.clone());
        }
        match l.side {
            Side::Left => left.push(l),
            Side::Right => right.push(l),
            Side::Full => {
                out.append(&mut left);
                out.append(&mut right);
                let under = table.map_or(0, |[x0, _, x1, y1]| out.iter().rev().take_while(|o| o.y >= y1 && o.x0 < x1 && o.x1 > x0).count());
                out.insert(out.len() - under, l);
            }
        }
    }
    out.append(&mut left);
    out.append(&mut right);
    let whole = |l: Line| l.table.map(|t| std::mem::take(&mut tables[t])).unwrap_or_else(|| vec![l]);
    out.into_iter().flat_map(whole).collect()
}

/// The size most of the text is set in.
fn body_size(lines: &[Vec<Line>]) -> f64 {
    let mut sizes: HashMap<i64, usize> = HashMap::new();
    for l in lines.iter().flatten() {
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
/// addresses) are dropped from the body; the first of them is taken as the author line. With a table among them they
/// are text, and nothing is dropped, nor is a title in a table, as a form's is.
fn take_front_matter(lines: &mut Vec<Line>, body: f64, half: f64) -> Front {
    let top = |l: &Line| l.page == 0 && l.y < half;
    let Some(max) = lines.iter().filter(|l| top(l)).map(|l| l.size).reduce(f64::max).filter(|&m| m >= body * 1.3) else {
        return Front::default();
    };
    let Some(start) = lines.iter().position(|l| top(l) && l.size >= max - 0.5) else {
        return Front::default();
    };
    let table = lines[start].table;
    let end = start + lines[start..].iter().take_while(|l| l.page == 0 && l.size >= max - 0.5 && l.table == table).count();
    let mut title = String::new();
    for l in &lines[start..end] {
        join(&mut title, &l.text, &HashSet::new());
    }
    if table.is_some() {
        return Front { title: Some(title), author: None };
    }
    let heading = lines[end..].iter().take_while(|l| l.page == 0).position(|l| section_level(l, body).is_some()).unwrap_or(0);
    let front = &lines[end..end + heading];
    let author = front.first().filter(|l| l.table.is_none()).map(|l| l.text.trim_end_matches(['∗', '*', '†', '‡']).to_string());
    let author = author.filter(|a| a.len() <= 150 && !a.contains('@'));
    let dropped = Some(heading).filter(|_| front.iter().all(|l| l.table.is_none())).unwrap_or(0);
    lines.drain(start..end + dropped);
    Front { title: Some(title), author }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Paragraph,
    Heading(u8),
    Caption,
    Item,
    Reference,
    Table,
}

struct Draft<'a> {
    kind: Kind,
    lines: Vec<&'a Line>,
}

/// The drafts' blocks with the figures' among them, each before the draft `place` puts it at, in drawing order. Their
/// `src` starts with `prefix`.
fn to_blocks(lines: &[Line], body: f64, doc: &Parsed, prefix: &str) -> Vec<Block> {
    let vocab = vocabulary(lines);
    let drafts = drafts(lines, body);
    let mut out: Vec<(usize, Block)> = figures(doc)
        .into_iter()
        .map(|(page, f)| {
            let at = place(&drafts, page, f);
            let label = drafts.get(at).filter(|d| d.kind == Kind::Caption).and_then(|d| caption_label(&d.lines[0].text));
            let src = format!("{prefix}{}.{}", f.id.0, f.id.1);
            let attrs = BlockAttrs { src: Some(src), ..Default::default() };
            (at, Block { kind: BlockKind::Image, text: label.unwrap_or_default().to_string(), inlines: Vec::new(), attrs })
        })
        .collect();
    // After the figures: the stable sort keeps each figure before the draft it goes before.
    out.extend(drafts.into_iter().enumerate().filter_map(|(i, d)| Some((i, block(d, &vocab, &doc.pages)?))));
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
        if l.table.is_some() {
            match drafts.last_mut() {
                Some(d) if d.lines[0].table == l.table && d.lines[0].page == l.page => d.lines.push(l),
                _ => drafts.push(Draft { kind: Kind::Table, lines: vec![l] }),
            }
            continue;
        }
        if let Some(level) = heading_level(l, body) {
            refs = is_references(&l.text).then(|| ref_style(&lines[i + 1..], body));
            drafts.push(Draft { kind: Kind::Heading(level), lines: vec![l] });
            continue;
        }
        // Text runs on past a table, as past any float, and the table is read after it.
        let last = drafts.iter().rposition(|d| d.kind != Kind::Table);
        let cur = last.map(|i| &drafts[i]).map(|d| (d.kind, *d.lines.last().expect("a draft has a line"), d.lines[0]));
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
                Kind::Table => false,
                // A table's widest row would carry the short ones past `laid_out_text`.
                Kind::Paragraph if prev.tabular() || l.tabular() => false,
                Kind::Paragraph if (prev.size - l.size).abs() > 0.15 * prev.size.max(l.size) => false,
                Kind::Paragraph if flows => {
                    let indented = l.x0 > prev.x0 + 0.8 * l.size;
                    let ended = prev.x1 < prev.right - 2. * prev.size && prev.text.ends_with(['.', '!', '?', ':']);
                    !indented && !ended
                }
                // Across a column or page: only a paragraph that ran to the column's edge, into
                // a line that is not indented, and past a table only one in the middle of a sentence.
                Kind::Paragraph => {
                    let across = prev.page != l.page || prev.side != l.side || l.y < prev.y;
                    let past = drafts.last().is_some_and(|d| d.kind == Kind::Table);
                    let sentence = prev.text.trim_end_matches(['"', '\'', ')', ']', '”', '’', '）', '」', '』']);
                    let whole = sentence.ends_with(['.', '!', '?', ':', '。', '！', '？']);
                    // "Table 1 What each finds", with no stop for `caption_label` to tell it by.
                    let caption = ["Table", "TABLE", "表"].iter().any(|t| first.text.starts_with(t));
                    across
                        && !(past && (whole || caption))
                        && (prev.x1 >= prev.right - 2. * prev.size || prev.text.ends_with('-'))
                        && l.x0 <= l.left + 0.8 * l.size
                }
            });
        if continues {
            drafts[last.expect("continues a draft")].lines.push(l);
        } else if let Some(cut) = start.is_none().then(|| interrupted(&drafts, l, body)).flatten() {
            // The figure goes before the paragraph it interrupted, as a float would, and so does a table.
            let mut d = drafts.remove(cut);
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
    let float = |d: &Draft| d.kind == Kind::Caption || matches!(d.kind, Kind::Paragraph | Kind::Table) && d.lines.iter().all(|x| x.size < body * 0.95);
    let skipped: Vec<&Draft> = drafts.iter().rev().take_while(|d| float(d) || fragment(d) || d.kind == Kind::Table).collect();
    let i = drafts.len().checked_sub(skipped.len() + 1)?;
    // Past a table, not from under a line of its own: next to a figure's caption then, it would be dropped as a label.
    if skipped.iter().any(|d| d.kind == Kind::Table) && i > 0 && fragment(&drafts[i - 1]) {
        return None;
    }
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

/// The lines as one text.
fn text_of<'a>(lines: impl IntoIterator<Item = &'a Line>, vocab: &HashSet<String>) -> String {
    let mut text = String::new();
    for l in lines {
        join(&mut text, &l.text, vocab);
    }
    collapse(&text).trim().to_string()
}

fn block(d: Draft, vocab: &HashSet<String>, pages: &[Page]) -> Option<Block> {
    let (kind, attrs) = match d.kind {
        Kind::Table => {
            let rows = &pages[d.lines[0].page].tables[d.lines[0].table?].rows;
            return Some(Block::table(rows.iter().map(|row| row.iter().map(|lines| text_of(lines, vocab)).collect()).collect()));
        }
        Kind::Paragraph => (BlockKind::Paragraph, BlockAttrs::default()),
        Kind::Heading(level) => (BlockKind::Heading, BlockAttrs { level: Some(level), ..Default::default() }),
        Kind::Caption => (BlockKind::Caption, BlockAttrs::default()),
        Kind::Item | Kind::Reference => (BlockKind::ListItem, BlockAttrs { ordered: Some(false), depth: Some(0), ..Default::default() }),
    };
    let text = text_of(d.lines, vocab);
    if text.is_empty() {
        return None;
    }
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

    fn glyph(x: f64, y: f64, text: &str) -> Glyph {
        Glyph { x, y, end: x + 10., size: 10., text: text.into(), face: Face::Body, vertical: false, turned: false, table: None }
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
            out.push(Glyph { end: x + 5., face, ..glyph(x, 100., &c.to_string()) });
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

    /// Helvetica at `x` and the baseline `y` from the top of a US Letter page.
    fn shown(x: f64, y: f64, text: &str) -> String {
        sized(x, y, 10., text)
    }

    fn sized(x: f64, y: f64, size: f64, text: &str) -> String {
        format!("BT /F1 {size} Tf {x} {} Td ({text}) Tj ET\n", 792. - y)
    }

    /// Rules round every cell of the grid with column edges `xs` and row edges `ys` (from the top of the page), as a book,
    /// a word processor and LaTeX draw them: a stroke along each side of each cell, a rectangle stroked round each cell,
    /// or thin filled bars.
    fn ruled(xs: &[f64], ys: &[f64], how: &str) -> String {
        let up = |y: f64| 792. - y;
        let mut ops = String::new();
        match how {
            "strokes" => {
                for &y in ys {
                    for x in xs.windows(2) {
                        ops += &format!("{} {} m {} {} l S\n", x[0], up(y), x[1], up(y));
                    }
                }
                for &x in xs {
                    for y in ys.windows(2) {
                        ops += &format!("{x} {} m {x} {} l S\n", up(y[0]) - 0.2, up(y[1]) + 0.2);
                    }
                }
            }
            "boxes" => {
                for x in xs.windows(2) {
                    for y in ys.windows(2) {
                        ops += &format!("{} {} {} {} re S\n", x[0], up(y[1]), x[1] - x[0], y[1] - y[0]);
                    }
                }
            }
            _ => {
                let (left, right, top, bottom) = (xs[0], xs[xs.len() - 1], ys[0], ys[ys.len() - 1]);
                for &y in ys {
                    ops += &format!("{left} {} {} 0.4 re f\n", up(y) - 0.2, right - left);
                }
                for &x in xs {
                    ops += &format!("{} {} 0.4 {} re f\n", x - 0.2, up(bottom), bottom - top);
                }
            }
        }
        ops
    }

    /// Each cell of the grid outlined as a path of its own, ended by `end` (`h S`, `s`, `b`, `h f`), its corners (`x`, `y`
    /// from the top of the page) given through `to`, which puts them in the content's own coordinates under its `cm`.
    fn outlined(xs: &[f64], ys: &[f64], to: &dyn Fn(f64, f64) -> (f64, f64), end: &str) -> String {
        let mut ops = String::new();
        for x in xs.windows(2) {
            for y in ys.windows(2) {
                let [a, b, c, d] = [to(x[0], y[0]), to(x[1], y[0]), to(x[1], y[1]), to(x[0], y[1])];
                ops += &format!("{} {} m {} {} l {} {} l {} {} l {end}\n", a.0, a.1, b.0, b.1, c.0, c.1, d.0, d.1);
            }
        }
        ops
    }

    /// Two tables, each under its caption, drawn as the book that set them does: both captions first, then each table's
    /// rules, drawn by `rules` from its column and row edges, and the text of its cells, one of which runs over two lines.
    fn tables_page(rules: &dyn Fn(&[f64], &[f64]) -> String) -> Vec<u8> {
        let xs = [72., 172., 540.];
        let mut ops = shown(72., 100., "Pros of passion") + &shown(72., 300., "Cons of passion");
        ops += &rules(&xs, &[110., 160., 200.]);
        ops += &(shown(78., 130., "Strong") + &shown(178., 128., "You care a lot about it") + &shown(178., 140., "and keep at it."));
        ops += &(shown(78., 182., "Lasting") + &shown(178., 182., "It holds over the years."));
        ops += &rules(&xs, &[310., 350., 390.]);
        ops += &(shown(78., 330., "Costly") + &shown(178., 330., "It takes time from other duties."));
        ops += &(shown(78., 372., "Easy") + &shown(178., 366., "You stay where it") + &shown(178., 378., "comes easily."));
        with_contents(&pdf(&[vec![]], None), &[(0, &ops)])
    }

    /// The blocks `tables_page` is read as.
    const TABLES_PAGE: [(&str, &str); 4] = [
        ("paragraph", "Pros of passion"),
        ("table", "Strong\tYou care a lot about it and keep at it.\nLasting\tIt holds over the years."),
        ("paragraph", "Cons of passion"),
        ("table", "Costly\tIt takes time from other duties.\nEasy\tYou stay where it comes easily."),
    ];

    #[test]
    fn a_table_ruled_round_every_cell_is_read_as_a_table_after_its_caption() {
        let first = [["Strong", "You care a lot about it and keep at it."], ["Lasting", "It holds over the years."]];
        let second = [["Costly", "It takes time from other duties."], ["Easy", "You stay where it comes easily."]];
        let rows = |rows: &[[&str; 2]]| Some(rows.iter().map(|r| r.map(String::from).to_vec()).collect::<Vec<_>>());
        for how in ["strokes", "boxes", "bars"] {
            let bytes = tables_page(&|xs, ys| ruled(xs, ys, how));
            let ir = to_ir(&bytes, None).unwrap();
            assert_eq!(kinds(&ir), TABLES_PAGE, "{how}");
            assert_eq!((ir.blocks[1].attrs.rows.clone(), ir.blocks[3].attrs.rows.clone()), (rows(&first), rows(&second)), "{how}");
        }
    }

    #[test]
    fn the_cells_of_a_table_have_no_regions() {
        let sentences = ["You care a lot about it.", "It holds over the years.", "It takes a lot of time.", "You stay where it is easy."];
        let ops = shown(72., 100., "A sentence of prose comes before the table.") + &two_by_two([72., 300., 540.], [110., 160., 200.], sentences);
        let texts: Vec<String> = regions(&pages_of(&[ops])).unwrap().into_iter().map(|r| r.text).collect();
        assert_eq!(texts, ["A sentence of prose comes before the table."]);
    }

    #[test]
    fn cells_outlined_as_closed_paths_are_tables() {
        for end in ["h S", "s", "b", "h B"] {
            let bytes = tables_page(&|xs, ys| outlined(xs, ys, &|x, y| (x, 792. - y), end));
            assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), TABLES_PAGE, "{end}");
        }
    }

    #[test]
    fn rules_a_little_off_their_line_are_joined() {
        // Each cell's sides stroked on their own, every other one 0.05pt off its line, as rounding leaves them.
        let rules = |xs: &[f64], ys: &[f64]| {
            let off = |i: usize, j: usize| 0.05 * ((i + j) % 2) as f64;
            let mut ops = String::new();
            for (i, &y) in ys.iter().enumerate() {
                for (j, x) in xs.windows(2).enumerate() {
                    ops += &format!("{} {y} m {} {y} l S\n", x[0], x[1], y = 792. - y + off(i, j));
                }
            }
            for (j, &x) in xs.iter().enumerate() {
                for (i, y) in ys.windows(2).enumerate() {
                    ops += &format!("{x} {} m {x} {} l S\n", 792. - y[0], 792. - y[1], x = x + off(i, j));
                }
            }
            ops
        };
        assert_eq!(kinds(&to_ir(&tables_page(&rules), None).unwrap()), TABLES_PAGE);
    }

    #[test]
    fn a_grid_with_text_in_exactly_half_its_cells_is_a_table() {
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "It lasts.");
        let ops = shown(72., 100., "Pros of passion") + &ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells;
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "Pros of passion"), ("table", "Strong\tIt lasts.\n\t")]);
    }

    #[test]
    fn a_drawing_of_more_rules_than_the_cap_makes_no_grid() {
        let across = (0..1001).map(|i| [0., 3. * i as f64, 3000., 3. * i as f64]);
        let down = (0..1000).map(|j| [3. * j as f64, 0., 3. * j as f64, 3003.]);
        assert!(grids(across.chain(down)).is_empty());
    }

    #[test]
    fn rules_drawn_under_a_transform_are_tables_where_they_show() {
        // Moved down by a `cm`, and flipped and scaled as Chrome's printing writes a page.
        let moved = |x: f64, y: f64| (x, 892. - y);
        let flipped = |x: f64, y: f64| (x / 0.75, y / 0.75);
        for (cm, to) in [("1 0 0 1 0 -100", &moved as &dyn Fn(f64, f64) -> (f64, f64)), ("0.75 0 0 -0.75 0 792", &flipped)] {
            let bytes = tables_page(&|xs, ys| format!("q {cm} cm\n{}Q\n", outlined(xs, ys, to, "h S")));
            assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), TABLES_PAGE, "{cm}");
        }
    }

    #[test]
    fn rules_that_do_not_box_every_cell_with_text_leave_the_text_as_it_was() {
        let cells = shown(78., 130., "Cell one") + &shown(178., 130., "Cell two") + &shown(78., 180., "Cell three") + &shown(178., 180., "Cell four");
        let text = shown(72., 100., "Some prose above the cells.") + &cells;
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        let plain = read(&text);
        let across: String = [110., 160., 200.].iter().map(|&y| format!("72 {y} m 540 {y} l S\n", y = 792. - y)).collect();
        let boxed = format!("70 {} 472 100 re S\n", 792. - 205.);
        let chart = ruled(&[72., 172., 272., 372., 540.], &[110., 160., 200., 250.], "strokes");
        let one_column = ruled(&[72., 540.], &[110., 160., 200.], "strokes");
        let empty = ruled(&[72., 172., 540.], &[300., 350., 400.], "strokes");
        let one_row = ruled(&[72., 172., 540.], &[110., 160.], "strokes");
        // The top row one cell across the table: the rule between the columns runs down the second row only.
        let mut merged: String = [110., 160., 200.].iter().map(|&y| format!("72 {y} m 540 {y} l S\n", y = 792. - y)).collect();
        merged += &[72., 540.].map(|x| format!("{x} 682 m {x} 592 l S\n")).concat();
        merged += "172 632 m 172 592 l S\n";
        // Each cell clipped to its box, as a report writer keeps its text in, or shaded, with nothing stroked.
        let clip = |(x0, x1): (f64, f64), (y0, y1): (f64, f64)| format!("q {x0} {} {} {} re W n Q\n", 792. - y1, x1 - x0, y1 - y0);
        let clipped = [(72., 172.), (172., 540.)].map(|x| [(110., 160.), (160., 200.)].map(|y| clip(x, y)).concat()).concat();
        let shaded = outlined(&[72., 172., 540.], &[110., 160., 200.], &|x, y| (x, 792. - y), "h f");
        // Round the second column and an empty third only, the first left on its own beside them.
        let some_columns = ruled(&[172., 300., 540.], &[110., 160., 200.], "strokes");
        let shapes = [("rules across", across), ("a box round it all", boxed), ("a chart's grid", chart), ("one column", one_column), ("no text", empty)];
        let more = [("one row", one_row), ("a merged cell", merged), ("clipped cells", clipped), ("shaded cells", shaded), ("some columns", some_columns)];
        for (shape, rules) in shapes.into_iter().chain(more) {
            assert_eq!(read(&(rules + &text)), plain, "{shape}");
        }
    }

    #[test]
    fn a_thick_rule_under_the_head_or_round_the_table_is_one_of_its_rules() {
        let (xs, ys) = ([72., 300., 420., 540.], [200., 220., 240., 260.]);
        let rows: &[&[&str]] = &[&["Item", "Quantity", "Price"], &["Widget", "4", "12.00"], &["Gadget", "2", "30.00"]];
        let text: String = (0..9).map(|i| shown(xs[i % 3] + 4., ys[i / 3] + 14., rows[i / 3][i % 3])).collect();
        for thick in [&[1][..], &[0, 3]] {
            let bar = |(i, y): (usize, &f64)| {
                let height = if thick.contains(&i) {
                    2.25
                } else {
                    0.5
                };
                format!("72 {} 468 {height} re f\n", 792. - y - height / 2.)
            };
            let rules = ys.iter().enumerate().map(bar).chain(xs.iter().map(|x| format!("{x} 532 0.5 60 re f\n"))).collect::<String>();
            assert_eq!(texts_of(&(rules + &text)), [as_table(rows)], "{thick:?}");
        }
    }

    #[test]
    fn rows_no_rule_parts_are_read_by_their_lines() {
        // Ruled round the box, under the header and between the columns only. The second table's cells wrap.
        let mut ops = ruled(&[72., 200., 400.], &[110., 130., 200.], "strokes");
        ops += &(shown(78., 124., "Design") + &shown(206., 124., "Insert"));
        ops += &(shown(78., 146., "Adjacency List") + &shown(206., 146., "Easy"));
        ops += &(shown(78., 166., "Nested Sets") + &shown(206., 166., "Hard"));
        ops += &(shown(78., 186., "Closure Table") + &shown(206., 186., "Easy"));
        ops += &ruled(&[72., 160., 262.], &[300., 320., 360.], "strokes");
        ops += &(shown(78., 314., "Design") + &shown(166., 314., "Queries"));
        ops += &(shown(78., 336., "A tree kept as") + &shown(166., 336., "Easy to insert, but"));
        ops += &(shown(78., 348., "references") + &shown(166., 348., "hard to query"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let rows = |rows: &[[&str; 2]]| Some(rows.iter().map(|r| r.map(String::from).to_vec()).collect::<Vec<_>>());
        let unruled = [["Design", "Insert"], ["Adjacency List", "Easy"], ["Nested Sets", "Hard"], ["Closure Table", "Easy"]];
        let wrapped = [["Design", "Queries"], ["A tree kept as references", "Easy to insert, but hard to query"]];
        assert_eq!(ir.blocks.iter().map(|b| b.attrs.rows.clone()).collect::<Vec<_>>(), [rows(&unruled), rows(&wrapped)]);
    }

    /// A head and one band under it, with no rule between the band's rows: each row's cells where `at` puts them.
    fn banded(xs: &[f64], at: &dyn Fn(usize, &str) -> f64, rows: &[&[&str]]) -> String {
        let y = |row: usize| 208. + 14. * row as f64;
        let cells = rows.iter().enumerate().flat_map(|(row, cells)| cells.iter().enumerate().map(move |(column, text)| (row, column, *text)));
        let text: String = cells.map(|(row, column, text)| shown(xs[column] + at(column, text), y(row), text)).collect();
        ruled(xs, &[196., 212., y(rows.len() - 1) + 4.], "strokes") + &text
    }

    /// `rows` as a table's text.
    fn as_table(rows: &[&[&str]]) -> String {
        rows.iter().map(|cells| cells.join("\t")).collect::<Vec<_>>().join("\n")
    }

    const SCORES: &[&[&str]] = &[&["Method", "Accuracy", "F1"], &["Baseline", "71.2", "68.0"], &["Ours", "74.9", "72.3"], &["Ours (large)", "78.1", "75.6"]];

    #[test]
    fn rows_no_rule_parts_are_read_by_their_numbers_in_columns_as_wide_as_their_text() {
        // As LaTeX sets `|l|c|c|`: no line has room for a word after it.
        let letters = |t: &str| 5.6 * t.len() as f64;
        let xs = [72., 152., 206., 244.];
        let in_the_middle = |column: usize, text: &str| {
            if column == 0 {
                6.
            } else {
                (xs[column + 1] - xs[column] - letters(text)) / 2.
            }
        };
        assert_eq!(texts_of(&banded(&xs, &in_the_middle, SCORES)), [as_table(SCORES)]);
        // A cell with nothing in it, and a name that wraps.
        let blank: &[&[&str]] = &[&["Method", "Accuracy", "F1"], &["Baseline", "71.2", "68.0"], &["Ours", "74.9", ""], &["Ours (large)", "78.1", "75.6"]];
        assert_eq!(texts_of(&banded(&xs, &in_the_middle, blank)), [as_table(blank)]);
        let wrapped: &[&[&str]] = &[SCORES[0], SCORES[1], &["Ours, much", "74.9", "72.3"], &["larger", "", ""], SCORES[3]];
        let read: &[&[&str]] = &[SCORES[0], SCORES[1], &["Ours, much larger", "74.9", "72.3"], SCORES[3]];
        assert_eq!(texts_of(&banded(&xs, &in_the_middle, wrapped)), [as_table(read)]);
    }

    #[test]
    fn rows_no_rule_parts_are_read_by_their_lines_in_the_middle_or_at_the_right_of_wide_columns() {
        let xs = [72., 222., 382., 540.];
        let words: &[&[&str]] = &[&["Method", "Speed", "Kind"], &["Baseline", "slow", "old"], &["Ours", "fast", "new"], &["Ours (large)", "faster", "new"]];
        let in_the_middle = |column: usize, text: &str| (xs[column + 1] - xs[column] - 5.6 * text.len() as f64) / 2.;
        let at_the_right = |column: usize, text: &str| xs[column + 1] - xs[column] - 6. - 5.6 * text.len() as f64;
        assert_eq!(texts_of(&banded(&xs, &in_the_middle, words)), [as_table(words)]);
        assert_eq!(texts_of(&banded(&xs, &at_the_right, words)), [as_table(words)]);
    }

    #[test]
    fn a_table_whose_rows_cannot_be_told_stays_text() {
        let left = |_: usize, _: &str| 6.;
        // Some lines end with room for the next word and some do not.
        let mixed: &[&[&str]] = &[&["Name", "Means"], &["id", "the number of a row"], &["title", "what the page shows"], &["at", "when"]];
        // One word to a line and no room in any: entries, or narrow cells that wrap.
        let words: &[&[&str]] = &[&["Name", "Kind"], &["title", "string"], &["count", "number"]];
        // A column with text in one of the rows only.
        let notes: &[&[&str]] = &[&["Name", "Size", "Note"], &["Alpha", "1", ""], &["Beta", "3", ""], &["Gamma", "4", "est."]];
        for (xs, rows) in [(&[72., 108., 216.][..], mixed), (&[72., 108., 150.], words), (&[72., 222., 382., 540.], notes)] {
            let texts = texts_of(&banded(xs, &left, rows));
            assert!(texts.iter().all(|t| !t.contains('\t')), "{texts:?}");
        }
    }

    #[test]
    fn lists_in_the_cells_of_one_row_stay_in_their_cells() {
        let rows: &[&[&str]] = &[&["Pros", "Cons"], &["\\267 Strong", "\\267 Costly"], &["\\267 Lasting", "\\267 Heavy"]];
        let texts = texts_of(&banded(&WIDE, &|_, _| 6., rows));
        assert_eq!(texts, ["Pros\tCons\n• Strong • Lasting\t• Costly • Heavy"]);
    }

    #[test]
    fn japanese_rows_no_rule_parts_are_read_by_their_lines_and_japanese_cells_that_wrap_are_not_rows() {
        let read = |right: f64, cells: &[(f64, f64, usize)]| {
            let text: String =
                cells.iter().map(|&(x, y, n)| format!("1 0 0 1 {x} {} Tm <{}> Tj ", 792. - y, "034B034D034F".repeat(9)[..4 * n].to_string())).collect();
            let ops = ruled(&[72., 200., right], &[100., 120., 180.], "strokes") + &format!("BT /F3 10 Tf {text}ET\n");
            let ir = to_ir(&japanese(&[vec![]], "Identity-H", &ops), None).unwrap();
            ir.blocks[0].attrs.rows.as_ref().map(Vec::len)
        };
        let head = [(78., 114., 2), (206., 114., 2)];
        let entries = [(78., 136., 4), (206., 136., 3), (78., 152., 3), (206., 152., 5), (78., 168., 5), (206., 168., 4)];
        assert_eq!(read(340., &[&head[..], &entries].concat()), Some(4));
        // The second line of the one cell gives up its last letter to the mark that cannot start a line.
        let wrapped = [(78., 136., 11), (206., 136., 12), (78., 152., 11), (206., 152., 11), (78., 168., 5), (206., 168., 4)];
        assert_eq!(read(332., &[&head[..], &wrapped].concat()), Some(2));
    }

    #[test]
    fn a_head_whose_cells_set_their_units_on_a_second_line_is_one_row() {
        let mut ops = ruled(&[72., 200., 400.], &[110., 145., 165.], "strokes");
        ops += &(shown(78., 124., "Latency") + &shown(78., 138., "(ms)") + &shown(206., 124., "Throughput") + &shown(206., 138., "(req/s)"));
        ops += &(shown(78., 159., "12") + &shown(206., 159., "900"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "Latency (ms)\tThroughput (req/s)\n12\t900")]);
    }

    #[test]
    fn a_band_of_a_thousand_rows_no_rule_parts_is_read_in_seconds() {
        // Each of the two cells holds a thousand lines of one letter in 1pt type, 0.7pt apart, so each starts a row. With
        // every glyph's row looked up among all the rows for each row, this took 30 s in a debug build.
        let mut ops = ruled(&[72., 300., 540.], &[40., 60., 780.], "strokes") + &shown(78., 55., "Head") + &shown(306., 55., "Head");
        for x in [78., 306.] {
            for i in 0..1000 {
                ops += &format!("BT /F1 1 Tf {x} {} Td (a) Tj ET\n", 792. - (70. + 0.7 * i as f64));
            }
        }
        let bytes = with_contents(&pdf(&[vec![]], None), &[(0, &ops)]);
        let started = std::time::Instant::now();
        let ir = to_ir(&bytes, None).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "took {:?}", started.elapsed());
        assert_eq!(ir.blocks[0].attrs.rows.as_ref().map(Vec::len), Some(1001));
    }

    /// A page that draws `ops`, then a form that shows `label` at its top.
    fn with_form(ops: &str, label: &str) -> Vec<u8> {
        let mut doc = Document::load_mem(&pdf(&[vec![]], None)).unwrap();
        let mut form = Dictionary::new();
        form.set("Type", name("XObject"));
        form.set("Subtype", name("Form"));
        form.set("BBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
        let form = doc.add_object(Stream::new(form, format!("BT /F1 10 Tf 72 50 Td ({label}) Tj ET").into_bytes()));
        let page = *doc.get_pages().values().next_back().unwrap();
        let content = doc.add_object(Stream::new(Dictionary::new(), format!("{ops}\n/X1 Do").into_bytes()));
        let page = doc.get_dictionary_mut(page).unwrap();
        page.set("Contents", Object::Reference(content));
        let mut xobjects = Dictionary::new();
        xobjects.set("X1", Object::Reference(form));
        page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn a_page_whose_text_is_all_in_a_table_is_not_read_again_with_its_forms() {
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let bytes = with_form(&(ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells), "Form label");
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), [("table", "Strong\tLasting\nCostly\tEasy")]);
    }

    #[test]
    fn a_header_turned_on_its_side_in_a_table_is_dropped_as_a_label_is() {
        let turned = "BT /F1 10 Tf 0 -1 1 0 120 672 Tm (Name) Tj ET\n";
        let cells = shown(178., 130., "Value one") + &shown(78., 182., "Row two") + &shown(178., 182., "Value two");
        let ops = ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + turned + &cells;
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "\tValue one\nRow two\tValue two")]);
    }

    #[test]
    fn a_translation_has_no_room_over_the_tables_above_and_below_it() {
        let table = |top: f64| {
            let cells =
                shown(78., top + 25., "Strong") + &shown(178., top + 25., "Lasting") + &shown(78., top + 70., "Costly") + &shown(178., top + 70., "Easy");
            ruled(&[72., 172., 540.], &[top, top + 45., top + 90.], "strokes") + &cells
        };
        let text = shown(72., 300., "Body text runs on as a sentence of prose between the tables.");
        let rooms = |pages: &[String]| regions(&pages_of(pages)).unwrap().iter().map(|r| (r.room_up.round(), r.room_down.round())).collect::<Vec<_>>();
        // Tables of the body, between which and the text a chart may be.
        assert_eq!(rooms(&[table(110.) + &text + &table(400.)]), [(0., 0.)]);
        // On its own page the text is as far up and down as the body goes; the running tables, in the margins, stop it.
        let running = |top: f64, words| two_by_two([72., 172., 540.], [top, top + 12., top + 24.], words);
        let page = || running(20., PROS) + &text + &running(740., CONS);
        assert_eq!(rooms(&[page(), page()]), [(246., 437.); 2]);
    }

    #[test]
    fn a_line_beside_a_table_has_no_room_over_it() {
        let cells = shown(306., 130., "One") + &shown(406., 130., "Two") + &shown(306., 180., "Three") + &shown(406., 180., "Four");
        let prose = shown(72., 250., "A sentence of prose that runs along the whole width of the page from margin to margin.");
        // Between the rows' baselines: on one, it would be the rest of that row.
        let ops = shown(72., 155., "Aside.") + &ruled(&[300., 400., 540.], &[110., 160., 200.], "strokes") + &cells + &prose;
        let r = regions(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)])).unwrap();
        let aside = r.iter().find(|r| r.text == "Aside.").unwrap();
        assert!(aside.room_right > 0. && aside.x1 + aside.room_right <= 300., "{} + {}", aside.x1, aside.room_right);
    }

    #[test]
    fn a_pdf_that_opens_with_a_table_takes_its_title_from_it_on_one_line() {
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let ops = ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells + &shown(72., 300., "Then a paragraph of prose follows the table.");
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("Strong Lasting Costly Easy"));
    }

    #[test]
    fn squares_turned_on_their_corners_are_not_a_table() {
        // Four squares stroked turned 45 degrees, whose boxes would tile two by two, each with a label inside.
        let diamond = |cx: f64, cy: f64| {
            let s = 50. / 2f64.sqrt();
            format!("q 0.7071 0.7071 -0.7071 0.7071 {cx} {} cm {} {} {s} {s} re S Q\n", 792. - cy, -s / 2., -s / 2.)
        };
        let diamonds = diamond(122., 135.) + &diamond(172., 135.) + &diamond(122., 185.) + &diamond(172., 185.);
        let labels = shown(110., 138., "Yes") + &shown(162., 138., "No") + &shown(108., 188., "Wait") + &shown(160., 188., "Stop");
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        assert_eq!(read(&(diamonds + &labels)), read(&labels));
    }

    #[test]
    fn a_table_on_a_page_whose_mediabox_is_off_the_origin_goes_where_it_is_printed() {
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let page = shown(72., 100., "Pros and cons") + &ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells;
        let ops = format!("q 1 0 0 1 100 200 cm {page}{} Q", shown(72., 300., "Then a paragraph of prose follows the table."));
        let mut doc = Document::load_mem(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)])).unwrap();
        let id = *doc.get_pages().values().next().unwrap();
        doc.get_dictionary_mut(id).unwrap().set("MediaBox", Object::Array([100, 200, 712, 992].map(Object::Integer).to_vec()));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let want = [("paragraph", "Pros and cons"), ("table", "Strong\tLasting\nCostly\tEasy"), ("paragraph", "Then a paragraph of prose follows the table.")];
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), want);
    }

    #[test]
    fn a_table_across_both_columns_is_read_after_the_text_above_it_in_both() {
        let column = |x: f64, y: f64, side: &str| {
            shown(x, y, &format!("The {side} column runs on")) + &shown(x, y + 12., "and on down the page") + &shown(x, y + 24., "to its end.")
        };
        let cells = shown(78., 180., "Strong") + &shown(310., 180., "Lasting") + &shown(78., 230., "Costly") + &shown(310., 230., "Easy");
        let table = ruled(&[72., 300., 540.], &[150., 200., 250.], "strokes") + &cells;
        let ops = column(72., 100., "left") + &column(322., 100., "right") + &table + &column(72., 300., "lower left") + &column(322., 300., "lower right");
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let order: Vec<&str> = ir.blocks.iter().map(|b| b.text.split(" column").next().unwrap_or_default()).collect();
        assert_eq!(order, ["The left", "The right", "Strong\tLasting\nCostly\tEasy", "The lower left", "The lower right"]);
    }

    #[test]
    fn a_table_in_one_column_is_a_table_beside_the_other_columns_lines() {
        // The right column's lines, 12pt apart, fall on the baselines of the left column's table's cells.
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 178., "Costly") + &shown(178., 178., "Easy");
        let mut ops = ruled(&[72., 172., 290.], &[110., 160., 200.], "strokes") + &cells;
        for i in 0..12 {
            ops += &shown(322., 106. + 12. * i as f64, &format!("Line {i} of the right column runs on."));
        }
        for (i, y) in [60., 72., 84., 220., 232., 244.].into_iter().enumerate() {
            ops += &shown(72., y, &format!("Line {i} of the left column runs on."));
        }
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert!(kinds(&ir).contains(&("table", "Strong\tLasting\nCostly\tEasy")), "{:?}", kinds(&ir));
    }

    #[test]
    fn a_table_in_the_left_column_that_ends_in_the_gutter_keeps_the_right_column_whole() {
        // Its right border 4pt past the middle of the page (306), as a line of the left column may run, and the right
        // column's lines 10pt apart, on the baselines of its cells.
        let mut ops = String::new();
        for (i, y) in [100., 112., 124.].into_iter().enumerate() {
            ops += &shown(72., y, &format!("Leftabove {i} has a line of words."));
        }
        for (i, y) in [240., 252., 264.].into_iter().enumerate() {
            ops += &shown(72., y, &format!("Leftbelow {i} has a line of words."));
        }
        for i in 0..14 {
            ops += &shown(330., 104. + 10. * i as f64, &format!("Rightcol {i} has a line of words."));
        }
        ops += &(ruled(&[72., 190., 310.], &[140., 180., 220.], "strokes") + &shown(78., 164., "Strong") + &shown(196., 164., "Lasting"));
        ops += &(shown(78., 204., "Costly") + &shown(196., 204., "Easy"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let texts: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
        let text = texts.join("\n");
        let at = |w: &str| text.find(w).unwrap();
        assert!(texts.contains(&"Strong\tLasting\nCostly\tEasy"), "{texts:?}");
        assert!(at("Leftbelow 0") < at("Rightcol 0"), "{texts:?}");
    }

    #[test]
    fn a_figure_right_under_a_table_comes_after_it() {
        // The table's caption over it, the figure right under the table, and the figure's caption under the figure.
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let ops = shown(72., 100., "Table 1: Pros and cons.") + &ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells;
        let ops = ops + &shown(72., 335., "Figure 1: A chart of the passion.") + &shown(72., 360., "Then a paragraph of prose follows the figure.");
        let bytes = draw(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), rgb(30, 10, [200, 0, 0]), &[(0, L, 215., 300., 100.)]);
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir).iter().map(|k| k.0).collect::<Vec<_>>(), ["caption", "table", "image", "caption", "paragraph"], "{:?}", kinds(&ir));
    }

    #[test]
    fn a_double_rule_parts_two_cells() {
        let mut ops = ruled(&[72., 200., 202.4, 400.], &[110., 130., 150.], "strokes");
        ops += &(shown(78., 124., "Method") + &shown(208., 124., "Returns"));
        ops += &(shown(78., 144., "TT.now()") + &shown(208., 144., "an interval"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "Method\tReturns\nTT.now()\tan interval")]);
        // LaTeX's \hline\hline: a second bar under the first row's, their middles 2.4pt apart.
        let rules = |xs: &[f64], ys: &[f64]| ruled(xs, ys, "bars") + &format!("{} {} {} 0.4 re f\n", xs[0], 792. - (ys[1] + 2.4) - 0.2, xs[2] - xs[0]);
        assert_eq!(kinds(&to_ir(&tables_page(&rules), None).unwrap()), TABLES_PAGE);
    }

    #[test]
    fn a_running_header_ruled_round_is_dropped_as_one_that_is_not() {
        let page = |n: usize, rules: &str| {
            let head = shown(78., 30., "Spec 42") + &shown(300., 30., "Rev 3") + &shown(78., 52., &format!("Page {n}")) + &shown(300., 52., "Confidential");
            rules.to_string() + &head + &shown(72., 120., &format!("Body text of page {n} runs on as a sentence of prose."))
        };
        let read = |rules: &str| {
            let ops: Vec<String> = (1..=3).map(|n| page(n, rules)).collect();
            to_ir(&with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &ops[0]), (1, &ops[1]), (2, &ops[2])]), None).unwrap()
        };
        assert_eq!(read(&ruled(&[72., 294., 540.], &[18., 40., 60.], "strokes")).blocks, read("").blocks);
    }

    #[test]
    fn a_cell_set_lower_than_the_one_beside_it_keeps_its_band_one_row() {
        // The second band's first cell holds three short lines, the other two lines centred lower down.
        let mut ops = ruled(&[72., 200., 400.], &[110., 130., 200., 220.], "strokes");
        ops += &(shown(78., 124., "Design") + &shown(206., 124., "Notes"));
        ops += &(shown(78., 146., "Short") + &shown(78., 158., "Lines") + &shown(78., 170., "Here"));
        ops += &(shown(206., 158., "Centered") + &shown(206., 170., "Text") + &shown(78., 214., "Other") + &shown(206., 214., "None"));
        assert_eq!(texts_of(&ops), ["Design\tNotes\nShort Lines Here\tCentered Text\nOther\tNone"]);
    }

    #[test]
    fn vertical_writing_by_the_left_rule_of_its_cells_is_not_split_into_rows() {
        // `vertical_writing_in_a_table_goes_to_the_cells_its_columns_are_in` with each cell's column 5pt from its left
        // rule, so a one-glyph line has room after it for the next.
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let body = column(580., 100., "034B034D034F035103530354035603580359035A") + &column(566., 100., "034B034D034F035103530354035603580359035A");
        let cells = column(465., 102., "034B034D034F") + &column(405., 102., "03510353") + &column(465., 162., "03540356") + &column(405., 162., "034B034D");
        let ops = format!("BT /F3 10 Tf {body}ET\n") + &ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n");
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &ops), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいう\nあい\tかき")]);
    }

    #[test]
    fn rows_no_rule_parts_take_a_cell_set_a_little_higher() {
        // `rows_no_rule_parts_are_read_by_their_lines` with the second column 1pt higher, as a cell in another font sits.
        let mut ops = ruled(&[72., 200., 400.], &[110., 130., 200.], "strokes");
        ops += &(shown(78., 124., "Design") + &shown(206., 123., "Insert"));
        ops += &(shown(78., 146., "Adjacency List") + &shown(206., 145., "Easy"));
        ops += &(shown(78., 166., "Nested Sets") + &shown(206., 165., "Hard"));
        ops += &(shown(78., 186., "Closure Table") + &shown(206., 185., "Easy"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "Design\tInsert\nAdjacency List\tEasy\nNested Sets\tHard\nClosure Table\tEasy")]);
    }

    #[test]
    fn a_line_whose_next_word_fits_only_in_the_cells_padding_wrapped() {
        // The second column's first line ends where the next line's first word would fit before the rule, but not before
        // the padding the cell keeps on its left (6pt): the line wrapped, so the band is one row. The first column's label
        // is broken by hand, with room after its first line.
        let wrapped = shown(166., 336., "Easy to insert, but") + &shown(166., 348., "hard to query");
        let (_, measured) = glyphs(&with_contents(&pdf(&[vec![]], None), &[(0, &wrapped)]), true).unwrap();
        let lines = page_lines(0, &measured[0].glyphs.iter().collect::<Vec<_>>(), measured[0].width);
        let letter = (lines[1].x1 - lines[1].x0) / lines[1].text.chars().count() as f64;
        let right = lines[0].x1 + 5. * letter + 3.;
        let mut ops = ruled(&[72., 160., right], &[300., 320., 360., 380.], "strokes");
        ops += &(shown(78., 314., "Design") + &shown(166., 314., "Queries"));
        ops += &(shown(78., 336., "Closure") + &shown(78., 348., "Table") + &wrapped + &shown(78., 374., "Sets") + &shown(166., 374., "Hard"));
        assert_eq!(texts_of(&ops), ["Design\tQueries\nClosure Table\tEasy to insert, but hard to query\nSets\tHard"]);
    }

    #[test]
    fn vertical_writing_whose_em_box_runs_past_the_rule_under_it_stays_in_its_cell() {
        // The first cell's column runs 1pt past the rule under it, as an em box a little taller than its glyphs does.
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let body = column(580., 100., "034B034D034F035103530354035603580359035A") + &column(566., 100., "034B034D034F035103530354035603580359035A");
        let cells =
            column(490., 111., "034B034D034F03510353") + &column(430., 102., "03510353") + &column(490., 162., "03540356") + &column(430., 162., "034B034D");
        let ops = format!("BT /F3 10 Tf {body}ET\n") + &ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n");
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &ops), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいうえお\nあい\tかき")]);
    }

    #[test]
    fn a_page_all_in_a_table_is_not_read_again_when_another_page_is() {
        // The first page is drawn inside a form, so the PDF is read again with its forms; the second page's text is all in
        // a table, and its form's label stays out as it does when it is the only page.
        let mut doc = Document::load_mem(&pdf(&[vec![], vec![]], None)).unwrap();
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let contents = ["/X1 Do".to_string(), ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells + "\n/X1 Do"];
        let labels = ["Included page text.", "Form label"];
        let ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
        for (i, id) in ids.into_iter().enumerate() {
            let mut form = Dictionary::new();
            form.set("Type", name("XObject"));
            form.set("Subtype", name("Form"));
            form.set("BBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
            let form = doc.add_object(Stream::new(form, format!("BT /F1 10 Tf 72 400 Td ({}) Tj ET", labels[i]).into_bytes()));
            let content = doc.add_object(Stream::new(Dictionary::new(), contents[i].clone().into_bytes()));
            let page = doc.get_dictionary_mut(id).unwrap();
            page.set("Contents", Object::Reference(content));
            let mut xobjects = Dictionary::new();
            xobjects.set("X1", Object::Reference(form));
            page.get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap().set("XObject", Object::Dictionary(xobjects));
        }
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), [("paragraph", "Included page text."), ("table", "Strong\tLasting\nCostly\tEasy")]);
    }

    #[test]
    fn a_table_repeated_in_the_body_of_every_page_is_kept() {
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let page = |n: usize| {
            shown(72., 100., &format!("Page {n} opens with a sentence of prose.")) + &ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells
        };
        let ops: Vec<String> = (1..=3).map(page).collect();
        let ir = to_ir(&with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &ops[0]), (1, &ops[1]), (2, &ops[2])]), None).unwrap();
        assert_eq!(ir.blocks.iter().filter(|b| b.kind == BlockKind::Table).count(), 3);
    }

    #[test]
    fn a_one_page_pdf_keeps_a_table_in_its_top_margin() {
        // Wholly in the top 8% of the page, as a running header is. Numbers alone there are a page's.
        for (words, table) in [(PROS, PROS_TEXT), (["1", "2", "3", "4"], "1\t2\n3\t4")] {
            let ops = two_by_two(WIDE, [10., 35., 60.], words) + &shown(72., 200., "Then a paragraph of prose follows the table.");
            let ir = to_ir(&pages_of(&[ops]), None).unwrap();
            assert_eq!(kinds(&ir), [("table", table), ("paragraph", "Then a paragraph of prose follows the table.")]);
        }
    }

    #[test]
    fn a_line_beside_a_table_on_its_left_has_no_room_over_it() {
        let cells = shown(78., 130., "One") + &shown(178., 130., "Two") + &shown(78., 180., "Three") + &shown(178., 180., "Four");
        let prose = shown(72., 250., "A sentence of prose that runs along the whole width of the page from margin to margin.");
        // Between the rows' baselines: on one, it would be the rest of that row.
        let ops = shown(400., 155., "Aside.") + &ruled(&[72., 172., 272.], &[110., 160., 200.], "strokes") + &cells + &prose;
        let r = regions(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)])).unwrap();
        let aside = r.iter().find(|r| r.text == "Aside.").unwrap();
        assert!(aside.room_left > 0. && aside.x0 - aside.room_left >= 272., "{} - {}", aside.x0, aside.room_left);
    }

    #[test]
    fn shaded_or_clipped_cells_then_a_stroke_leave_the_text_as_it_was() {
        let cells = shown(78., 130., "Cell one") + &shown(178., 130., "Cell two") + &shown(78., 180., "Cell three") + &shown(178., 180., "Cell four");
        let text = shown(72., 100., "Some prose above the cells.") + &cells;
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        // One rule under it all, stroked after the cells are painted.
        let rule = "72 392 m 540 392 l S\n";
        let plain = read(&(rule.to_string() + &text));
        let (xs, ys) = ([(72., 172.), (172., 540.)], [(110., 160.), (160., 200.)]);
        let each = |f: &dyn Fn((f64, f64), (f64, f64)) -> String| xs.map(|x| ys.map(|y| f(x, y)).concat()).concat();
        let clipped = each(&|(x0, x1), (y0, y1)| format!("q {x0} {} {} {} re W n Q\n", 792. - y1, x1 - x0, y1 - y0));
        let filled = each(&|(x0, x1), (y0, y1)| format!("{x0} {} {} {} re f\n", 792. - y1, x1 - x0, y1 - y0));
        let shaded = outlined(&[72., 172., 540.], &[110., 160., 200.], &|x, y| (x, 792. - y), "h f");
        for (shape, cells) in [("clipped", clipped), ("filled boxes", filled), ("shaded paths", shaded)] {
            assert_eq!(read(&(cells + rule + &text)), plain, "{shape}");
        }
    }

    #[test]
    fn a_table_in_one_column_is_read_within_that_column() {
        let column = |x: f64, y: f64, side: &str| {
            shown(x, y, &format!("The {side} column runs on")) + &shown(x, y + 12., "and on down the page") + &shown(x, y + 24., "to its end.")
        };
        let cells = shown(78., 180., "Strong") + &shown(178., 180., "Lasting") + &shown(78., 230., "Costly") + &shown(178., 230., "Easy");
        let table = ruled(&[72., 172., 290.], &[150., 200., 250.], "strokes") + &cells;
        let ops = column(72., 100., "left") + &column(322., 100., "right") + &table + &column(72., 300., "lower left") + &column(322., 300., "lower right");
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let order: Vec<&str> = ir.blocks.iter().map(|b| b.text.split(" column").next().unwrap_or_default()).collect();
        assert_eq!(order, ["The left", "Strong\tLasting\nCostly\tEasy", "The lower left", "The right", "The lower right"]);
    }

    #[test]
    fn a_table_on_each_page_that_reaches_into_the_margin_is_kept() {
        // The same table on each of three pages, its labels the same and its numbers not, as a report sets one table a
        // page: from 50pt down, past the top 8% of the page, and from 640pt to 740pt, past the bottom 8%.
        for ys in [[50., 100., 150.], [640., 690., 740.]] {
            let page = |n: usize| {
                let (a, b) = ((ys[0] + ys[1]) / 2. + 4., (ys[1] + ys[2]) / 2. + 4.);
                let cells = shown(78., a, "Year") + &shown(178., a, "Count") + &shown(78., b, &format!("20{n}0")) + &shown(178., b, &format!("{n}5"));
                ruled(&[72., 172., 540.], &ys, "strokes") + &cells + &shown(72., 300., &format!("Body text of page {n} runs on as a sentence of prose."))
            };
            let ops: Vec<String> = (1..=3).map(page).collect();
            let ir = to_ir(&with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &ops[0]), (1, &ops[1]), (2, &ops[2])]), None).unwrap();
            assert_eq!(ir.blocks.iter().filter(|b| b.kind == BlockKind::Table).count(), 3, "{ys:?}: {:?}", kinds(&ir));
        }
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
        let objects = figure_ids(&ir);
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
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        for &page in &pages {
            let resources = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap();
            resources.get_mut(b"Font").and_then(Object::as_dict_mut).unwrap().set("F3", Object::Reference(font));
        }
        let content = doc.get_page_contents(*pages.last().unwrap())[0];
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
    fn a_paragraph_that_runs_on_from_a_turned_page_gives_the_page_set_across_its_own_text() {
        let sentence = "the cat sat on the mat by the door, as it does every day.";
        let bytes = japanese(&[vec![(72., 100., 10., sentence)], vec![]], "Identity-V", "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D034F03510353> Tj ET");
        // The turned page first.
        let mut doc = Document::load_mem(&bytes).unwrap();
        let pages = doc.catalog().unwrap().get(b"Pages").and_then(Object::as_reference).unwrap();
        doc.get_dictionary_mut(pages).unwrap().get_mut(b"Kids").and_then(Object::as_array_mut).unwrap().reverse();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(texts(&to_ir(&bytes, None).unwrap()).len(), 1, "one paragraph across the two pages");
        assert_eq!(regions(&bytes).unwrap().iter().map(|r| (r.page, r.text.as_str())).collect::<Vec<_>>(), [(1, sentence)]);
    }

    #[test]
    fn latin_set_across_on_a_turned_page_keeps_the_spaces_its_pen_moves_make() {
        // Three columns of ten kana: most of the page is set down it, so it is turned. A word loosened by a tenth of an
        // em, under the 0.15 em that parts words, stays whole.
        let column = |x: f64| format!("1 0 0 1 {x} 700 Tm <034B034D034F035103530354035603580359035A> Tj ");
        let columns = format!("BT /F3 10 Tf {}{}{}ET", column(500.), column(488.), column(476.));
        let across = [
            "BT /F1 10 Tf 1 0 0 1 100 400 Tm [(Hello) -300 (world)] TJ ET",
            "BT /F1 10 Tf 100 400 Td (Hello) Tj 26 0 Td (world) Tj ET",
            "BT /F1 10 Tf 1 0 0 1 100 400 Tm [(Hel) -100 (lo) -300 (world)] TJ ET",
        ];
        for across in across {
            let bytes = japanese(&[vec![]], "Identity-V", &format!("{columns} {across}"));
            assert!(glyphs(&bytes, true).unwrap().1[0].vertical);
            let ir = to_ir(&bytes, None).unwrap();
            assert!(texts(&ir).iter().any(|t| t.contains("Hello world")), "{across}: {:?}", texts(&ir));
        }
    }

    #[test]
    fn japanese_set_across_on_a_turned_page_takes_no_space_for_a_gap() {
        // Kana set across, 0.3 em apart: one run, with no space between Japanese, as `line` reads it.
        let mut page = Page { width: 612., height: 792., glyphs: vec![glyph(100., 400., "目"), glyph(113., 400., "次")], ..Default::default() };
        turn(&mut page);
        assert_eq!(page.glyphs.iter().map(|g| g.text.as_str()).collect::<Vec<_>>(), ["目次"]);
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
        let glyph = Glyph { vertical: true, ..glyph(500., 100., "あ") };
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

    /// A PDF of vertical writing: a page of columns, then one with `ops`.
    fn after_a_page_of_columns(ops: &str) -> Vec<u8> {
        let column = |x: i32, cids: &str| format!("1 0 0 1 {x} 700 Tm <{cids}> Tj ");
        let full: String = (0..3).map(|i| column(500 - 12 * i, &"034B034D034F03510353".repeat(6))).collect();
        let columns = format!("BT /F3 10 Tf {full}{}ET", column(464, "034B034D027B"));
        with_contents(&japanese(&[vec![], vec![]], "Identity-V", ops), &[(0, &columns)])
    }

    #[test]
    fn a_table_set_across_on_a_page_of_vertical_writing_leaves_the_page_to_turn() {
        // The table holds more glyphs than the columns: counted with them, the page would stay upright and its columns
        // come apart a character at a time.
        let columns = "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D034F03510353> Tj 1 0 0 1 488 700 Tm <03540356> Tj ET\n";
        let cells = shown(78., 625., "Pros") + &shown(178., 625., "It lasts long.") + &shown(78., 665., "Cons") + &shown(178., 665., "It costs time.");
        let bytes = after_a_page_of_columns(&(columns.to_string() + &ruled(&[72., 172., 300.], &[600., 640., 680.], "strokes") + &cells));
        assert!(glyphs(&bytes, true).unwrap().1[1].vertical);
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir)[1..], [("paragraph", "あいうえおかき"), ("table", "Pros\tIt lasts long.\nCons\tIt costs time.")]);
    }

    #[test]
    fn a_table_on_a_turned_page_goes_before_the_column_under_it() {
        // A column right of the table and one left of it: read down the columns from the right, the table comes between.
        let columns = "BT /F3 10 Tf 1 0 0 1 520 700 Tm <034B034D034F03510353> Tj 1 0 0 1 200 700 Tm <03540356034B034D034F> Tj ET\n";
        let cells = shown(306., 125., "Pros") + &shown(386., 125., "Long") + &shown(306., 165., "Cons") + &shown(386., 165., "Slow");
        let bytes = after_a_page_of_columns(&(columns.to_string() + &ruled(&[300., 380., 460.], &[100., 140., 180.], "strokes") + &cells));
        assert!(glyphs(&bytes, true).unwrap().1[1].vertical);
        let ir = to_ir(&bytes, None).unwrap();
        assert_eq!(kinds(&ir)[1..], [("paragraph", "あいうえお"), ("table", "Pros\tLong\nCons\tSlow"), ("paragraph", "かきあいう")]);
    }

    #[test]
    fn vertical_writing_in_a_table_goes_to_the_cells_its_columns_are_in() {
        // Two columns of body text, then a table whose columns start just under the rules above them.
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let body = column(580., 100., "034B034D034F035103530354035603580359035A") + &column(566., 100., "034B034D034F035103530354035603580359035A");
        let cells = column(490., 102., "034B034D034F") + &column(430., 102., "03510353") + &column(490., 162., "03540356") + &column(430., 162., "034B034D");
        let ops = format!("BT /F3 10 Tf {body}ET\n") + &ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n");
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &ops), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいう\nあい\tかき")]);
        // "API" turned a quarter down the first row's second cell beside its column, as vertical writing sets Latin.
        let latin = format!("BT /F1 10 Tf 0 -1 1 0 472 {} Tm (API) Tj ET\n", 792. - 105.);
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &(ops + &latin)), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいう API\nあい\tかき")]);
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
            let glyphs: Vec<Glyph> = text.chars().enumerate().map(|(i, c)| glyph(i as f64 * step, 100., &c.to_string())).collect();
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

    /// `depth` forms, each drawing the next, the last showing `text`.
    fn nested(depth: usize, text: &str) -> Vec<(bool, String, bool)> {
        (0..depth)
            .map(|i| {
                (
                    true,
                    if i + 1 < depth {
                        format!("/X{} Do", i + 1)
                    } else {
                        shown(72., 692., text)
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
                            shown(72., 692., "Over and over")
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

    #[test]
    fn a_number_set_across_beside_a_table_on_a_turned_page_leaves_it_a_table() {
        // Two columns of vertical writing, a table set across between them, and in a third column a number set across
        // (縦中横) on the baseline of the table's first row.
        let columns = "BT /F3 10 Tf 1 0 0 1 540 700 Tm <034B034D034F03510353> Tj 1 0 0 1 200 700 Tm <03540356034B034D034F> Tj ET\n";
        let cells = shown(306., 125., "Pros") + &shown(386., 125., "Long") + &shown(306., 165., "Cons") + &shown(386., 165., "Slow");
        let table = ruled(&[300., 380., 460.], &[100., 140., 180.], "strokes") + &cells;
        let number =
            "BT /F3 10 Tf 1 0 0 1 500 700 Tm <034B034D> Tj ET BT /F1 10 Tf 1 0 0 1 494.4 667 Tm (25) Tj ET BT /F3 10 Tf 1 0 0 1 500 657 Tm <034F0351> Tj ET\n";
        for ops in [columns.to_string() + &table, columns.to_string() + number + &table] {
            let ir = to_ir(&after_a_page_of_columns(&ops), None).unwrap();
            assert!(kinds(&ir).contains(&("table", "Pros\tLong\nCons\tSlow")), "{:?}", kinds(&ir));
        }
    }

    #[test]
    fn a_page_that_is_one_table_of_vertical_writing_keeps_the_latin_turned_down_its_cells() {
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let cells = column(490., 102., "034B034D034F") + &column(430., 102., "03510353") + &column(490., 162., "03540356") + &column(430., 162., "034B034D");
        let latin = format!("BT /F1 10 Tf 0 -1 1 0 472 {} Tm (API) Tj ET\n", 792. - 105.);
        let ops = ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n") + &latin;
        // Alone, and with a page number set across.
        for folio in [vec![], vec![(300., 760., 10., "12")]] {
            let ir = to_ir(&japanese(std::slice::from_ref(&folio), "Identity-V", &ops), None).unwrap();
            assert!(kinds(&ir).contains(&("table", "えお\tあいう API\nあい\tかき")), "folio {}: {:?}", folio.len(), kinds(&ir));
        }
    }

    #[test]
    fn vertical_writing_in_a_grid_that_is_no_table_reads_as_it_was() {
        // Four columns of vertical writing, two paragraphs, in one cell of a grid of four: too little text for a table.
        let ten = "034B034D034F035103530354035603580359035A";
        let col = |x: f64, y: f64, codes: &str| format!("1 0 0 1 {x} {y} Tm <{codes}> Tj ");
        let columns =
            format!("BT /F3 10 Tf {}{}{}{}ET\n", col(500., 700., ten), col(488., 700., ten), col(476., 690., "034B034D034F0351"), col(464., 700., ten));
        let plain = japanese(&[vec![]], "Identity-V", &columns);
        let gridded = japanese(&[vec![]], "Identity-V", &(columns.clone() + &ruled(&[300., 420., 540.], &[60., 200., 400.], "strokes")));
        assert_eq!(kinds(&to_ir(&gridded, None).unwrap()), kinds(&to_ir(&plain, None).unwrap()));
        assert!(glyphs(&gridded, true).unwrap().1[0].vertical);
    }

    /// The object numbers of the figures, in the order the Reader shows them.
    fn figure_ids(ir: &ArticleIr) -> Vec<u32> {
        let id = |src: &str| src.rsplit('/').next()?.split('.').next()?.parse().ok();
        ir.blocks.iter().filter_map(|b| b.attrs.src.as_deref()).filter_map(id).collect()
    }

    #[test]
    fn figures_at_the_foot_of_both_columns_keep_their_drawing_order() {
        // Nothing under either on the page, the right one higher up.
        let left: Vec<String> = (0..20).map(|i| format!("Left column line {i} of the body runs on.")).collect();
        let right: Vec<String> = (0..15).map(|i| format!("Right column line {i} of the body runs on.")).collect();
        let mut page: Vec<Run> = left.iter().enumerate().map(|(i, t)| (72., 100. + 12. * i as f64, 10., t.as_str())).collect();
        page.extend(right.iter().enumerate().map(|(i, t)| (320., 100. + 12. * i as f64, 10., t.as_str())));
        let next = vec![(72., 100., 10., "The next page starts with a paragraph of prose that runs on.")];
        let bytes = draw(&pdf(&[page, next], None), rgb(10, 10, [200, 0, 0]), &[(0, 72., 450., 200., 150.)]);
        let ids = figure_ids(&to_ir(&draw(&bytes, rgb(10, 10, [0, 200, 0]), &[(0, 320., 350., 200., 100.)]), None).unwrap());
        assert!(ids.len() == 2 && ids[0] < ids[1], "{ids:?}");
    }

    #[test]
    fn figures_side_by_side_keep_their_drawing_order_whatever_their_tops() {
        // Over one caption, their feet level and the right one taller.
        let page = vec![
            (72., 100., 10., "A paragraph of prose comes before the figures and runs on."),
            (200., 320., 10., "Figure 1: Two charts side by side."),
            (72., 360., 10., "Then a paragraph of prose follows the figures and runs on."),
        ];
        let bytes = draw(&pdf(&[page], None), rgb(10, 10, [200, 0, 0]), &[(0, 72., 200., 200., 100.)]);
        let ids = figure_ids(&to_ir(&draw(&bytes, rgb(10, 10, [0, 200, 0]), &[(0, 320., 180., 200., 120.)]), None).unwrap());
        assert!(ids.len() == 2 && ids[0] < ids[1], "{ids:?}");
    }

    #[test]
    fn a_table_at_the_foot_of_the_left_column_comes_after_its_caption_and_before_the_right_column() {
        let mut ops = String::new();
        for i in 0..20 {
            ops += &shown(72., 100. + 12. * i as f64, &format!("Left column line {i} of the body runs on."));
        }
        ops += &shown(72., 500., "Table 1: Pros and cons.");
        ops += &(ruled(&[72., 172., 290.], &[510., 560., 600.], "strokes") + &shown(78., 530., "Strong") + &shown(178., 530., "Lasting"));
        ops += &(shown(78., 582., "Costly") + &shown(178., 582., "Easy"));
        for i in 0..30 {
            ops += &shown(320., 100. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let texts: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
        let table = texts.iter().position(|t| *t == "Strong\tLasting\nCostly\tEasy").unwrap();
        assert!(texts[table - 1].starts_with("Table 1") && texts[table + 1].starts_with("Right column line 0"), "{texts:?}");
    }

    #[test]
    fn a_figure_closing_a_page_comes_before_a_table_opening_the_next() {
        // Nothing under the figure on its page, so it goes before the next page's paragraph, as the table does.
        let first = shown(72., 100., "A paragraph of prose opens the first page and runs on.");
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let second = ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells + &shown(72., 300., "Then a paragraph of prose follows the table.");
        let bytes = with_contents(&pdf(&[vec![], vec![]], None), &[(0, &first), (1, &second)]);
        let ir = to_ir(&draw(&bytes, rgb(30, 10, [200, 0, 0]), &[(0, L, 500., 300., 100.)]), None).unwrap();
        let placed: Vec<&str> = kinds(&ir).iter().map(|k| k.0).filter(|k| *k != "paragraph").collect();
        assert_eq!(placed, ["image", "table"], "{:?}", kinds(&ir));
    }

    #[test]
    fn a_table_ruled_round_its_right_columns_on_a_page_of_one_column_is_left_as_text() {
        // Its ruled columns in the right half of the page and its labels, unruled, in the left.
        let mut text = shown(72., 80., "A paragraph of prose runs on across the whole width of the page, as one column does.");
        text += &(shown(78., 130., "Signs documents on any device") + &shown(316., 130., "Yes") + &shown(426., 130., "No"));
        text += &(shown(78., 182., "Keeps an audit trail of each step") + &shown(316., 182., "Yes") + &shown(426., 182., "Yes"));
        text += &shown(72., 240., "Another paragraph of prose runs on across the whole width of the page, as one column does.");
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        assert_eq!(read(&(ruled(&[310., 420., 540.], &[110., 160., 200.], "strokes") + &text)), read(&text));
    }

    #[test]
    fn a_table_ruled_round_only_its_first_columns_is_left_as_text() {
        // The third column, on the right of the ruled ones, is not ruled round.
        let cells = shown(78., 130., "Cell one") + &shown(178., 130., "Cell two") + &shown(420., 130., "Cell three");
        let cells = cells + &shown(78., 180., "Cell four") + &shown(178., 180., "Cell five") + &shown(420., 180., "Cell six");
        let text = shown(72., 100., "Some prose above the cells.") + &cells;
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        assert_eq!(read(&(ruled(&[72., 172., 400.], &[110., 160., 200.], "strokes") + &text)), read(&text));
    }

    #[test]
    fn a_table_beside_another_on_the_same_baselines_is_a_table() {
        let a = ruled(&[72., 172., 380.], &[110., 160., 200.], "strokes") + &shown(78., 130., "Strong") + &shown(178., 130., "Lasting");
        let a = a + &shown(78., 180., "Costly") + &shown(178., 180., "Easy");
        let b = ruled(&[400., 470., 540.], &[110., 160., 200.], "strokes") + &shown(406., 130., "Fast") + &shown(476., 130., "Cheap");
        let b = b + &shown(406., 180., "Slow") + &shown(476., 180., "Dear");
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &(a + &b))]), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "Strong\tLasting\nCostly\tEasy"), ("table", "Fast\tCheap\nSlow\tDear")]);
    }

    #[test]
    fn a_note_beside_a_table_off_its_baselines_leaves_it_a_table() {
        let table = ruled(&[72., 172., 380.], &[110., 160., 200.], "strokes") + &shown(78., 130., "Strong") + &shown(178., 130., "Lasting");
        let table = table + &shown(78., 180., "Costly") + &shown(178., 180., "Easy");
        let note = shown(400., 145., "A note set") + &shown(400., 157., "beside the") + &shown(400., 169., "table.");
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &(table + &note))]), None).unwrap();
        assert!(kinds(&ir).contains(&("table", "Strong\tLasting\nCostly\tEasy")), "{:?}", kinds(&ir));
    }

    #[test]
    fn a_table_in_the_right_column_that_starts_in_the_gutter_keeps_the_left_column_whole() {
        // Its left border 4pt before the middle of the page, and the left column's lines on its cells' baselines.
        let mut ops = String::new();
        for (i, y) in [100., 112., 124.].into_iter().enumerate() {
            ops += &shown(322., y, &format!("Rightabove {i} has a line of words."));
        }
        for (i, y) in [240., 252., 264.].into_iter().enumerate() {
            ops += &shown(322., y, &format!("Rightbelow {i} has a line of words."));
        }
        // The left column's paragraph ends short of its edge, so the right column's starts a paragraph of its own.
        for i in 0..14 {
            ops += &shown(
                72.,
                104. + 10. * i as f64,
                &if i < 13 {
                    format!("Leftcol {i} has a line of words.")
                } else {
                    "Leftcol 13 ends.".to_string()
                },
            );
        }
        ops += &(ruled(&[302., 420., 540.], &[140., 180., 220.], "strokes") + &shown(308., 164., "Strong") + &shown(426., 164., "Lasting"));
        ops += &(shown(308., 204., "Costly") + &shown(426., 204., "Easy"));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        let texts: Vec<&str> = ir.blocks.iter().map(|b| b.text.as_str()).collect();
        let text = texts.join("\n");
        let at = |w: &str| text.find(w).unwrap();
        assert!(texts.contains(&"Strong\tLasting\nCostly\tEasy"), "{texts:?}");
        assert!(at("Leftcol 13") < at("Rightabove 0"), "{texts:?}");
        assert!(at("Rightabove 2") < at("Strong") && at("Strong") < at("Rightbelow 0"), "in the right column: {texts:?}");
    }

    #[test]
    fn a_table_under_the_title_and_authors_is_read_where_it_is_on_the_page() {
        // The title and the author line are taken off the lines the table is read among.
        let title = sized(72., 80., 20., "A Title Set Large");
        let cells = shown(78., 225., "Strong") + &shown(178., 225., "Lasting") + &shown(78., 272., "Costly") + &shown(178., 272., "Easy");
        let mut ops = title + &shown(72., 110., "Ann Author and Bob Writer") + &shown(72., 140., "Introduction");
        ops += &(shown(72., 170., "A paragraph of prose comes before the table and runs on.") + &ruled(&[72., 172., 540.], &[200., 245., 290.], "strokes"));
        ops += &(cells + &shown(72., 320., "Then a paragraph of prose follows the table."));
        let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("A Title Set Large"));
        let want = [
            ("heading", "Introduction"),
            ("paragraph", "A paragraph of prose comes before the table and runs on."),
            ("table", "Strong\tLasting\nCostly\tEasy"),
            ("paragraph", "Then a paragraph of prose follows the table."),
        ];
        assert_eq!(kinds(&ir), want);
    }

    #[test]
    fn latin_turned_down_a_cell_from_just_under_its_rule_stays_in_it() {
        // 1pt under the rule over its cell, as a column of vertical writing can start.
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let body = column(580., 100., "034B034D034F035103530354035603580359035A") + &column(566., 100., "034B034D034F035103530354035603580359035A");
        let cells = column(490., 102., "034B034D034F") + &column(430., 102., "03510353") + &column(490., 162., "03540356") + &column(430., 162., "034B034D");
        let ops = format!("BT /F3 10 Tf {body}ET\n") + &ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n");
        let latin = format!("BT /F1 10 Tf 0 -1 1 0 472 {} Tm (API) Tj ET\n", 792. - 101.);
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &(ops + &latin)), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいう API\nあい\tかき")]);
    }

    #[test]
    fn a_number_set_across_in_a_cell_of_vertical_writing_is_read_in_its_place() {
        // As `a_number_set_sideways_in_a_column_is_read_in_its_place` holds for the body.
        let column = |x: f64, top: f64, codes: &str| format!("1 0 0 1 {x} {} Tm <{codes}> Tj ", 792. - top - 8.8);
        let body = column(580., 100., "034B034D034F035103530354035603580359035A") + &column(566., 100., "034B034D034F035103530354035603580359035A");
        let cells = column(490., 102., "034B034D034F") + &column(430., 102., "03510353") + &column(490., 162., "03540356") + &column(430., 162., "034B034D");
        let ops = format!("BT /F3 10 Tf {body}ET\n") + &ruled(&[400., 460., 520.], &[100., 160., 220.], "strokes") + &format!("BT /F3 10 Tf {cells}ET\n");
        let number = format!("BT /F1 10 Tf 1 0 0 1 484.4 {} Tm (25) Tj ET\n", 792. - 190.8);
        let ir = to_ir(&japanese(&[vec![]], "Identity-V", &(ops + &number)), None).unwrap();
        assert_eq!(kinds(&ir), [("paragraph", "あいうえおかきくぐけあいうえおかきくぐけ"), ("table", "えお\tあいう\nあい\tかき25")]);
    }

    #[test]
    fn a_running_footer_ruled_round_is_dropped_as_one_that_is_not() {
        let page = |n: usize, rules: &str| {
            let foot = shown(78., 755., "Spec 42") + &shown(300., 755., "Rev 3") + &shown(78., 777., &format!("Page {n}")) + &shown(300., 777., "Confidential");
            rules.to_string() + &shown(72., 120., &format!("Body text of page {n} runs on as a sentence of prose.")) + &foot
        };
        let read = |rules: &str| {
            let ops: Vec<String> = (1..=3).map(|n| page(n, rules)).collect();
            to_ir(&with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &ops[0]), (1, &ops[1]), (2, &ops[2])]), None).unwrap()
        };
        assert_eq!(read(&ruled(&[72., 294., 540.], &[740., 762., 782.], "strokes")).blocks, read("").blocks);
    }

    #[test]
    fn a_table_under_its_caption_that_cuts_a_sentence_comes_right_after_the_caption() {
        // The sentence runs on to the next page, past the caption and the table at its top.
        let first = shown(72., 700., "A paragraph of prose opens the first page and it runs on along the line")
            + &shown(72., 712., "until the very foot of the page, where it goes on past the table on the");
        let cells = shown(78., 130., "Strong") + &shown(178., 130., "Lasting") + &shown(78., 182., "Costly") + &shown(178., 182., "Easy");
        let table = ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells;
        let second = shown(72., 100., "Table 1: Pros and cons.") + &table + &shown(72., 220., "next page and comes to its end here.");
        let ir = to_ir(&with_contents(&pdf(&[vec![], vec![]], None), &[(0, &first), (1, &second)]), None).unwrap();
        let k = kinds(&ir);
        assert_eq!(k.iter().map(|b| b.0).collect::<Vec<_>>(), ["caption", "table", "paragraph"], "{k:?}");
        assert!(k[2].1.contains("past the table on the next page"), "{k:?}");
    }

    #[test]
    fn a_table_under_its_caption_that_cuts_a_sentence_in_two_columns_comes_right_after_the_caption() {
        let cells = |x: f64, y: f64| {
            shown(x + 6., y + 20., "Strong") + &shown(x + 106., y + 20., "Lasting") + &shown(x + 6., y + 72., "Costly") + &shown(x + 106., y + 72., "Easy")
        };
        let left = |last: &str| {
            (0..20)
                .map(|i| {
                    shown(
                        72.,
                        100. + 12. * i as f64,
                        &if i < 19 {
                            format!("Left column line {i} of the body runs on and")
                        } else {
                            last.to_string()
                        },
                    )
                })
                .collect::<String>()
        };
        // At the foot of the left column, the sentence going on at the top of the right one.
        let mut foot = left("on until the float cuts it here and then it") + &shown(72., 500., "Table 1: Pros and cons.");
        foot += &(ruled(&[72., 172., 290.], &[510., 560., 600.], "strokes") + &cells(72., 510.));
        for i in 0..30 {
            foot += &shown(
                320.,
                100. + 12. * i as f64,
                &if i == 0 {
                    "goes on in the right column of the page and".to_string()
                } else {
                    format!("Right column line {i} of the body runs on and")
                },
            );
        }
        // At the top of the right column, the left column's sentence going on under it.
        let mut top = left("on past the table in the right column as a") + &shown(320., 100., "Table 1: Pros and cons.");
        top +=
            &(ruled(&[320., 420., 540.], &[110., 160., 200.], "strokes") + &cells(320., 110.) + &shown(320., 220., "sentence does across a float to its end."));
        for i in 0..14 {
            top += &shown(320., 244. + 12. * i as f64, &format!("Right column line {i} of the body runs on and"));
        }
        for (ops, runs_on) in [(foot, "and then it goes on in the right column"), (top, "in the right column as a sentence does")] {
            let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &ops)]), None).unwrap();
            let k = kinds(&ir);
            assert_eq!(k[..3].iter().map(|b| b.0).collect::<Vec<_>>(), ["caption", "table", "paragraph"], "{k:?}");
            assert!(k[2].1.contains(runs_on), "{k:?}");
        }
    }

    #[test]
    fn a_column_that_is_mostly_a_table_keeps_the_page_in_two_columns() {
        // The left column is a ruled table and three lines of prose that run on into the right column. Interleaved, the
        // right column's lines beside the prose come between its lines, as a page set row by row has them.
        let page = |pitch: f64, interleaved: bool| {
            let ys = [100., 130., 160., 190., 220., 250., 280.];
            let mut ops = ruled(&[72., 150., 290.], &ys, "strokes");
            for (i, y) in ys[1..].iter().enumerate() {
                ops += &(shown(78., y - 10., &format!("Row {i}")) + &shown(156., y - 10., &format!("Some cell text {i}")));
            }
            let prose =
                ["The left column ends its prose here and it", "runs on for a line or two more and then it", "goes on into the right column of the page"];
            let right = |i: usize| shown(320., 100. + pitch * i as f64, &format!("right column line {i:02} of the body runs on"));
            if interleaved {
                ops += &(0..14).map(right).collect::<String>();
                for (i, l) in prose.iter().enumerate() {
                    ops += &(shown(72., 100. + pitch * (14 + i) as f64, l) + &right(14 + i));
                }
                ops += &(17..20).map(right).collect::<String>();
            } else {
                for (i, l) in prose.iter().enumerate() {
                    ops += &shown(72., 304. + 12. * i as f64, l);
                }
                ops += &(0..20).map(right).collect::<String>();
            }
            with_contents(&pdf(&[vec![]], None), &[(0, &ops)])
        };
        for (pitch, interleaved) in [(15., false), (15., true), (12., false)] {
            let bytes = page(pitch, interleaved);
            let ir = to_ir(&bytes, None).unwrap();
            let k = kinds(&ir);
            assert!(k.iter().any(|b| b.0 == "table" && b.1.starts_with("Row 0\tSome cell text 0")), "{pitch} {interleaved}: {k:?}");
            assert!(k.iter().any(|b| b.1.contains("of the page right column line 00")), "{pitch} {interleaved}: {k:?}");
            assert!(regions(&bytes).unwrap().iter().any(|r| r.text.starts_with("The left column ends")), "{pitch} {interleaved}");
        }
    }

    /// A table of two rows and columns ruled round every cell, a word in each.
    fn two_by_two(xs: [f64; 3], ys: [f64; 3], words: [&str; 4]) -> String {
        let word = |(i, w): (usize, &str)| shown(xs[i % 2] + 6., (ys[i / 2] + ys[i / 2 + 1]) / 2. + 3., w);
        ruled(&xs, &ys, "strokes") + &words.into_iter().enumerate().map(word).collect::<String>()
    }

    fn texts_of(ops: &str) -> Vec<String> {
        blocks_of(&pages_of(&[ops.to_string()]))
    }

    const LEFT: [f64; 3] = [72., 172., 290.];
    const RIGHT: [f64; 3] = [322., 422., 540.];
    const PROS: [&str; 4] = ["Strong", "Lasting", "Costly", "Easy"];
    const CONS: [&str; 4] = ["Fast", "Cheap", "Slow", "Dear"];

    #[test]
    fn a_caption_with_no_stop_over_a_table_does_not_run_on_past_it() {
        let line = |x: f64, y: f64, words: &str| shown(x, y, &format!("{words} column line of the body runs on to it"));
        let left: String = (0..30).map(|i| line(72., 100. + 12. * i as f64, "Left")).collect();
        let table = sized(72., 480., 9., "Table 1 What each of the methods in the study found") + &two_by_two(LEFT, [490., 510., 530.], PROS);
        let right: String = (0..36).map(|i| line(316., 112. + 12. * i as f64, "Right")).collect();
        let texts = texts_of(&(left + &table + &shown(316., 100., "then goes on atop the right column until it") + &right));
        assert!(texts.iter().any(|t| t == "Table 1 What each of the methods in the study found"), "{texts:?}");
    }

    #[test]
    fn a_table_at_the_foot_of_the_left_column_is_read_before_one_atop_the_right_column() {
        let mut ops = shown(72., 350., "Table 1: The left one.") + &two_by_two(LEFT, [360., 410., 450.], PROS);
        for i in 0..20 {
            ops += &shown(72., 100. + 12. * i as f64, &format!("Left column line {i} of the body runs on."));
        }
        ops += &(two_by_two(RIGHT, [100., 150., 190.], CONS) + &shown(322., 205., "Table 2: The right one."));
        for i in 0..25 {
            ops += &shown(322., 225. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let texts = texts_of(&ops);
        let left = texts.iter().position(|t| t == "Strong\tLasting\nCostly\tEasy").unwrap();
        assert!(texts[left - 1].starts_with("Table 1") && texts[left + 1] == "Fast\tCheap\nSlow\tDear" && texts[left + 2].starts_with("Table 2"), "{texts:?}");
    }

    #[test]
    fn tables_side_by_side_on_a_page_of_vertical_writing_are_read_from_the_right() {
        let columns = "BT /F3 10 Tf 1 0 0 1 520 700 Tm <034B034D034F03510353> Tj 1 0 0 1 80 700 Tm <03540356034B034D034F> Tj ET\n";
        let table = |x: f64, words| two_by_two([x, x + 60., x + 120.], [100., 140., 180.], words);
        let ops = columns.to_string() + &table(330., ["Pros", "Long", "Cons", "Slow"]) + &table(130., ["Fast", "Free", "Dear", "Big"]);
        let ir = to_ir(&after_a_page_of_columns(&ops), None).unwrap();
        let tables: Vec<&str> = kinds(&ir).into_iter().filter(|k| k.0 == "table").map(|k| k.1).collect();
        assert_eq!(tables, ["Pros\tLong\nCons\tSlow", "Fast\tFree\nDear\tBig"]);
    }

    /// A column of vertical writing, its middle at `x` and its top at `top`.
    fn set_down(x: f64, top: f64, cids: &str) -> String {
        format!("BT /F3 10 Tf 1 0 0 1 {x} {} Tm <{cids}> Tj ET\n", 792. - top - 8.8)
    }

    const TEN_DOWN: &str = "034B034D034F035103530354035603580359035A";

    /// A form set across whose row heads are set down.
    fn form() -> String {
        let heads = [105., 225., 345.].map(|top| set_down(115., top, TEN_DOWN)).concat();
        let cells = shown(178., 160., "Ann Author") + &shown(178., 280., "42 Main Street") + &shown(178., 400., "None");
        let table = ruled(&[72., 172., 540.], &[100., 220., 340., 460.], "strokes") + &heads + &cells;
        shown(72., 80., "Fill in this form.") + &table + &shown(72., 500., "Ask the desk.")
    }

    #[test]
    fn a_page_of_a_document_set_across_stays_upright_whatever_is_set_down_by_its_tables() {
        let label = "034B034D034F03510353";
        let read = |ops: &str| {
            let bytes = japanese(&[vec![]], "Identity-V", ops);
            assert!(!glyphs(&bytes, true).unwrap().1[0].vertical);
            let regions = regions(&bytes).unwrap().into_iter().map(|r| r.text).collect::<Vec<_>>();
            (kinds(&to_ir(&bytes, None).unwrap()).into_iter().map(|(kind, text)| format!("{kind}: {text}")).collect::<Vec<_>>(), regions)
        };
        // A form whose row heads are set down, more of them than of what is set across outside it.
        let (blocks, lines) = read(&form());
        assert_eq!((blocks[0].as_str(), blocks[2].as_str()), ("paragraph: Fill in this form.", "paragraph: Ask the desk."));
        assert!(blocks[1].starts_with("table: ") && blocks.len() == 3 && lines == ["Fill in this form.", "Ask the desk."], "{blocks:?} {lines:?}");
        // Text set across in a grid that holds too little to be a table, or that is one, and a label set down beside it.
        let prose: String = (0..5).map(|i| shown(78., 110. + 12. * i as f64, &format!("Prose {i} set across in the first cell."))).collect();
        let few = ruled(&[72., 306., 540.], &[90., 400., 700.], "strokes");
        assert_eq!(read(&(few + &prose + &set_down(560., 200., label))), read(&(prose + &set_down(560., 200., label))));
        let (blocks, _) = read(&(two_by_two([72., 306., 540.], [90., 400., 700.], PROS) + &set_down(560., 200., label)));
        assert!(blocks.contains(&"table: Strong\tLasting\nCostly\tEasy".to_string()), "{blocks:?}");
    }

    #[test]
    fn tables_one_paragraph_runs_on_past_keep_their_reading_order() {
        // The paragraph runs from the left column, past a table at its foot, into the right column, and ends over one there.
        let mut ops = two_by_two(LEFT, [400., 445., 490.], PROS) + &two_by_two(RIGHT, [170., 215., 260.], CONS);
        for i in 0..20 {
            ops += &shown(72., 100. + 12. * i as f64, &format!("Left column line {i} of the body runs on"));
        }
        for i in 0..4 {
            ops += &shown(322., 100. + 12. * i as f64, &format!("and it runs on {i} in the right column"));
        }
        ops += &shown(322., 148., "where it ends.");
        for i in 0..20 {
            ops += &shown(322., 280. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let texts = texts_of(&ops);
        let left = texts.iter().position(|t| t == "Strong\tLasting\nCostly\tEasy").unwrap();
        assert!(texts[left + 1] == "Fast\tCheap\nSlow\tDear" && texts[left + 2].starts_with("Right column line 0"), "{texts:?}");
    }

    #[test]
    fn a_table_is_not_read_among_the_notes_beside_it() {
        // Notes down the right margin, drawn before the body from the bottom up.
        let mut ops: String = (0..7).map(|i| shown(470., 310. - 40. * i as f64, &format!("Note {i}."))).collect();
        let before = "A paragraph of prose comes before the table and runs on.";
        ops += &(shown(72., 100., before) + &two_by_two(LEFT, [110., 160., 200.], PROS));
        ops += &shown(72., 240., "Then a paragraph of prose follows the table and runs on across the page.");
        let texts = texts_of(&ops);
        let before = texts.iter().position(|t| t == before).unwrap();
        assert_eq!(texts[before + 1], "Strong\tLasting\nCostly\tEasy", "{texts:?}");
    }

    #[test]
    fn tables_side_by_side_with_level_tops_are_read_left_then_right() {
        // Set in two columns, they would be read column by column; among lines across the page, only their order says.
        let above = "A sentence of prose that runs along the whole width of the page comes before the tables.";
        let below = "A sentence of prose that runs along the whole width of the page comes after the tables.";
        let tables = two_by_two(LEFT, [120., 170., 210.], PROS) + &two_by_two(RIGHT, [120., 170., 230.], CONS);
        let texts = texts_of(&(shown(72., 100., above) + &tables + &shown(72., 260., below)));
        assert_eq!(texts, [above, "Strong\tLasting\nCostly\tEasy", "Fast\tCheap\nSlow\tDear", below]);
    }

    #[test]
    fn rows_no_rule_parts_drawn_from_the_bottom_up_are_rows() {
        let mut ops = ruled(&[72., 200., 400.], &[110., 130., 200.], "strokes");
        ops += &(shown(78., 186., "Closure Table") + &shown(206., 186., "Easy"));
        ops += &(shown(78., 166., "Nested Sets") + &shown(206., 166., "Hard"));
        ops += &(shown(78., 146., "Adjacency List") + &shown(206., 146., "Easy"));
        ops += &(shown(78., 124., "Design") + &shown(206., 124., "Insert"));
        assert_eq!(texts_of(&ops), ["Design\tInsert\nAdjacency List\tEasy\nNested Sets\tHard\nClosure Table\tEasy"]);
    }

    #[test]
    fn tables_in_a_tier_of_vertical_writing_are_read_from_the_right() {
        // Two tiers of columns (段), and in the upper one two tables, the left one set a little higher.
        let column = |x: f64, top: f64, cid: &str| format!("1 0 0 1 {x} {} Tm <{}> Tj ", 792. - top - 8.8, cid.repeat(20));
        let upper = column(520., 60., "034B") + &column(360., 60., "034D") + &column(200., 60., "034F");
        let lower = column(520., 450., "0351") + &column(360., 450., "0353") + &column(200., 450., "0354");
        let table = |x: f64, top: f64, words| two_by_two([x, x + 40., x + 80.], [top, top + 40., top + 80.], words);
        let tables = table(400., 100., ["Pros", "Long", "Cons", "Slow"]) + &table(250., 90., ["Fast", "Free", "Dear", "Big"]);
        let bytes = japanese(&[vec![]], "Identity-V", &(format!("BT /F3 10 Tf {upper}{lower}ET\n") + &tables));
        assert!(glyphs(&bytes, true).unwrap().1[0].vertical);
        let text = texts(&to_ir(&bytes, None).unwrap()).join("|");
        let at = |w: &str| text.find(w).unwrap_or_else(|| panic!("{w} in {text}"));
        assert!(at("ああ") < at("Pros") && at("Pros") < at("いい") && at("いい") < at("Fast") && at("Fast") < at("うう"), "{text}");
    }

    #[test]
    fn a_table_set_across_under_columns_of_vertical_writing_comes_after_its_caption() {
        // The columns stop short of the table, which holds more text than they do. Its caption is set across in two parts.
        let columns: String = (0..6).map(|i| format!("1 0 0 1 {} 700 Tm <{}> Tj ", 500 - 16 * i, "034B034D034F03510353".repeat(3))).collect();
        let last = "1 0 0 1 404 700 Tm <034B034D027B> Tj ";
        let words = ["Strong", "Lasting for a good long time once it has begun", "Costly", "Easy to lose again and then not to be had back"];
        let table = two_by_two([72., 172., 520.], [480., 560., 640.], words);
        let caption = shown(72., 470., "Table 5") + &shown(150., 470., "Pros and cons");
        let bytes = after_a_page_of_columns(&(format!("BT /F3 10 Tf {columns}{last}ET\n") + &caption + &table));
        assert!(glyphs(&bytes, true).unwrap().1[1].vertical);
        let ir = to_ir(&bytes, None).unwrap();
        let read: Vec<&str> = kinds(&ir)[2..].iter().map(|k| k.1).collect();
        assert_eq!(read.concat(), format!("Table 5Pros and cons{}\t{}\n{}\t{}", words[0], words[1], words[2], words[3]), "{:?}", kinds(&ir));
    }

    #[test]
    fn a_table_across_a_page_of_two_columns_leaves_it_in_two_columns() {
        // The table holds more than three times what each column does.
        let (xs, ys) = ([72., 189., 306., 423., 540.], (0..=24).map(|r| 80. + 18. * r as f64).collect::<Vec<_>>());
        let table: String = (0..24).flat_map(|r| (0..4).map(move |c| shown(xs[c] + 4., 94. + 18. * r as f64, &format!("value {r:02} {c} here")))).collect();
        let table = ruled(&xs, &ys, "strokes") + &table;
        let left = |i: usize| shown(72., 540. + 12. * i as f64, &format!("left line {i} of the body runs on and on and"));
        let right = |i: usize| shown(320., 540. + 12. * i as f64, &format!("right line {i} of the body runs on and on and"));
        let columns: Vec<String> =
            ["left", "right"].map(|s| (0..8).map(|i| format!("{s} line {i} of the body runs on and on and")).collect::<Vec<_>>().join(" ")).into();
        // The columns drawn a line of each at a time, as if their lines ran on, and one after the other.
        for body in [(0..8).map(|i| left(i) + &right(i)).collect::<String>(), (0..8).map(left).chain((0..8).map(right)).collect()] {
            let bytes = with_contents(&pdf(&[vec![]], None), &[(0, &(table.clone() + &body))]);
            let ir = to_ir(&bytes, None).unwrap();
            assert_eq!(ir.blocks[0].kind, BlockKind::Table);
            assert_eq!(ir.blocks[1..].iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join(" "), columns.join(" "));
            assert_eq!(regions(&bytes).unwrap().into_iter().map(|r| r.text).collect::<Vec<_>>(), columns);
        }
    }

    #[test]
    fn a_table_in_one_column_under_one_across_both_is_a_table() {
        // The one across both holds most of the page's text, and the right column's lines are on the other's baselines.
        let (xs, ys) = ([72., 189., 306., 423., 540.], (0..=12).map(|r| 60. + 24. * r as f64).collect::<Vec<_>>());
        let wide: String =
            (0..12).flat_map(|r| (0..4).map(move |c| shown(xs[c] + 4., 74. + 24. * r as f64, &format!("cell {r} {c} with some words")))).collect();
        let mut ops = ruled(&xs, &ys, "strokes") + &wide + &two_by_two(LEFT, [448., 484., 520.], PROS);
        for i in 0..6 {
            ops += &shown(72., 378. + 12. * i as f64, &format!("left line {i} of the body runs on and on and"));
        }
        for i in 0..14 {
            ops += &shown(320., 385. + 12. * i as f64, &format!("right line {i} of the body runs on and on and"));
        }
        let texts = texts_of(&ops);
        assert!(texts.iter().any(|t| t == "Strong\tLasting\nCostly\tEasy"), "{texts:?}");
    }

    #[test]
    fn a_label_turned_on_its_side_does_not_make_two_columns_by_a_partly_ruled_table() {
        // Only the right columns are ruled: the left one's cells go on their rows.
        let table = two_by_two([310., 420., 540.], [110., 150., 190.], ["Yes", "No", "Yes", "Yes"]);
        let rows = shown(78., 133., "Signs documents on any device") + &shown(78., 173., "Keeps an audit trail of steps");
        let label = |i: i32| format!("BT /F1 10 Tf 0 -1 1 0 {} 700 Tm (A label turned a quarter down the page) Tj ET\n", 560 + 12 * i);
        for labels in [String::new(), (0..3).map(label).collect()] {
            let ir = to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, &(table.clone() + &rows + &labels))]), None).unwrap();
            assert!(ir.blocks.iter().all(|b| b.kind != BlockKind::Table), "{:?}", kinds(&ir));
        }
    }

    #[test]
    fn a_table_at_the_foot_of_the_left_column_comes_before_a_figure_atop_the_right_column() {
        let mut ops = shown(72., 500., "Table 1: Pros and cons.") + &two_by_two(LEFT, [510., 550., 590.], PROS);
        for i in 0..20 {
            ops += &shown(72., 100. + 12. * i as f64, &format!("Left column line {i} of the body runs on."));
        }
        for i in 0..20 {
            ops += &shown(320., 350. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let read = |ops: String, figure| {
            let texts = blocks_of(&draw(&pages_of(&[ops]), rgb(30, 10, [200, 0, 0]), &[figure]));
            let at = texts.iter().position(|t| t.starts_with("Table 1")).unwrap();
            texts[at..at + 5].to_vec()
        };
        let left = "Strong\tLasting\nCostly\tEasy";
        // Over the right column's first lines, a figure and its caption.
        let alone = read(ops.clone() + &shown(320., 220., "Figure 1: A chart."), (0, 320., 100., 200., 100.));
        assert_eq!(alone[..4], ["Table 1: Pros and cons.", left, "image", "Figure 1: A chart."]);
        // And another table over the figure.
        let right = two_by_two(RIGHT, [90., 130., 170.], CONS);
        let under = read(ops + &right + &shown(320., 320., "Figure 1: A chart."), (0, 320., 190., 200., 100.));
        assert_eq!(under, ["Table 1: Pros and cons.", left, "Fast\tCheap\nSlow\tDear", "image", "Figure 1: A chart."]);
    }

    #[test]
    fn a_short_line_beyond_a_table_from_a_figure_caption_is_no_label_of_the_figure() {
        let table = two_by_two([72., 172., 540.], [220., 260., 300.], PROS);
        let prose = shown(72., 120., "A paragraph of prose comes before the table and it runs along the width of the page.");
        let end = |y: f64| shown(72., y, "A paragraph of prose comes after the table and it runs along the width of the page.");
        let after = shown(72., 200., "Figure 1: The machine.") + &table + &shown(72., 330., "Source: the maker of the machine");
        assert!(texts_of(&(prose.clone() + &after + &end(370.))).iter().any(|t| t == "Source: the maker of the machine"));
        let before = shown(72., 200., "Parts of the machine") + &table + &shown(72., 450., "Figure 1: The machine.");
        assert!(texts_of(&(prose + &before + &end(490.))).iter().any(|t| t == "Parts of the machine"));
    }

    #[test]
    fn a_table_stays_by_its_caption_when_a_footer_is_drawn_first() {
        let before = "A paragraph of prose comes before the table and it runs along the width of the page.";
        let after = "A paragraph of prose comes after the table and it runs along the width of the page.";
        let (caption, footer) = ("Table 1: Pros and cons.", "Made by the maker of the machine, all rights reserved.");
        let (table, read) = (two_by_two([72., 172., 540.], [160., 200., 240.], PROS), "Strong\tLasting\nCostly\tEasy");
        let foot = shown(72., 750., footer);
        let over = shown(72., 100., before) + &shown(72., 150., caption) + &table + &shown(72., 270., after);
        assert_eq!(texts_of(&(foot.clone() + &over)), [footer, before, caption, read, after]);
        assert_eq!(texts_of(&(over + &foot)), [before, caption, read, after, footer]);
        let under = shown(72., 100., before) + &table + &shown(72., 252., caption) + &shown(72., 290., after);
        assert_eq!(texts_of(&(foot + &under)), [footer, before, read, caption, after]);
    }

    #[test]
    fn a_paragraph_that_ends_over_a_table_does_not_run_on_past_it() {
        // To the column's edge both, and the next page's is not indented: without the table they would be one.
        let first = "A paragraph of prose comes before the table and it runs along the width of the page and on.";
        let next = "paragraph opens the next page, and it runs along the width of the page as the one before did.";
        let ends =
            [("ends whole.", "Another", true), ("ends \\(whole.\\)", "Another", true), ("ends \"whole.\"", "Another", true), ("goes on to", "another", false)];
        for (end, start, whole) in ends {
            let last = format!("It has a second line of prose as wide as the first one is, where the paragraph {end}");
            let pages = [
                shown(72., 600., first) + &shown(72., 612., &last) + &two_by_two([72., 172., 540.], [640., 676., 712.], PROS),
                shown(72., 100., &format!("{start} {next}")) + &shown(72., 112., "It ends here."),
            ];
            let texts = blocks_of(&pages_of(&pages));
            assert_eq!((texts.iter().position(|t| t == PROS_TEXT), texts.len()), (Some(1), 2 + usize::from(whole)), "{texts:?}");
        }
    }

    #[test]
    fn a_book_of_vertical_writing_whose_cover_is_set_across_turns_a_page_with_a_table_set_across() {
        let cover = vec![(72., 100., 10., "The cover of the book is set across.")];
        let columns: String = (0..4).map(|i| set_down(500. - 12. * i as f64, 100., &TEN_DOWN.repeat(3))).collect();
        let table = two_by_two([72., 172., 300.], [600., 640., 680.], ["Pros", "It lasts long.", "Cons", "It costs time."]);
        let ops = set_down(500., 100., TEN_DOWN) + &set_down(488., 100., "03540356") + &table;
        let bytes = with_contents(&japanese(&[cover, vec![], vec![]], "Identity-V", &ops), &[(1, &columns)]);
        let pages = glyphs(&bytes, true).unwrap().1;
        assert_eq!(pages.iter().map(|p| p.vertical).collect::<Vec<_>>(), [false, true, true]);
    }

    #[test]
    fn a_form_in_a_document_set_across_stays_upright_whatever_page_of_it_is_set_down() {
        let prose: String = (0..10).map(|i| shown(72., 100. + 14. * i as f64, "A line of prose set across runs along the page.")).collect();
        let columns = set_down(500., 100., TEN_DOWN) + &set_down(488., 100., "03540356");
        for (first, second) in [(&columns, &prose), (&prose, &columns)] {
            let bytes = with_contents(&japanese(&[vec![], vec![], vec![]], "Identity-V", &form()), &[(0, first), (1, second)]);
            assert!(!glyphs(&bytes, true).unwrap().1[2].vertical);
            let lines: Vec<String> = regions(&bytes).unwrap().into_iter().filter(|r| r.page == 2).map(|r| r.text).collect();
            assert_eq!(lines, ["Fill in this form.", "Ask the desk."]);
        }
    }

    #[test]
    fn a_page_set_across_in_vertical_writing_is_not_turned_for_a_label_set_down_it() {
        let prose = shown(72., 100., "The cat sat on the mat by the door, as it does every day.") + &shown(72., 112., "Then it slept.");
        let bytes = after_a_page_of_columns(&(prose + &set_down(560., 200., "034B034D")));
        assert!(!glyphs(&bytes, true).unwrap().1[1].vertical);
        let lines: Vec<String> = regions(&bytes).unwrap().into_iter().filter(|r| r.page == 1).map(|r| r.text).collect();
        assert_eq!(lines, ["The cat sat on the mat by the door, as it does every day. Then it slept."]);
    }

    #[test]
    fn a_table_on_a_later_page_of_a_paper_with_a_title_is_read_right_after_its_caption() {
        let title = sized(72., 80., 20., "A Title Set Large");
        let authors = shown(72., 110., "Ann Author and Bob Writer") + &shown(72., 124., "The University of Somewhere");
        let first = title + &authors + &shown(72., 150., "Introduction") + &shown(72., 180., "A paragraph of prose opens the paper.");
        let mut second = shown(72., 100., "Table 1: Pros and cons.") + &two_by_two([72., 172., 540.], [110., 160., 200.], PROS);
        for i in 0..4 {
            second += &shown(72., 230. + 30. * i as f64, &format!("Paragraph {i} of prose follows the table."));
        }
        let ir = to_ir(&with_contents(&pdf(&[vec![], vec![]], None), &[(0, &first), (1, &second)]), None).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("A Title Set Large"));
        let kinds: Vec<&str> = kinds(&ir).into_iter().map(|k| k.0).collect();
        assert_eq!(kinds, ["heading", "paragraph", "caption", "table", "paragraph", "paragraph", "paragraph", "paragraph"]);
    }

    #[test]
    fn a_table_across_both_columns_at_the_foot_of_the_page_is_read_after_both() {
        let column =
            |x: f64, side: &str| (0..10).map(|i| shown(x, 100. + 12. * i as f64, &format!("{side} column line {i} of the body runs on."))).collect::<String>();
        let ops = column(72., "Left") + &shown(72., 220., "It ends.") + &column(322., "Right") + &two_by_two([72., 300., 540.], [250., 300., 350.], PROS);
        let texts = texts_of(&ops);
        assert!(texts.last().unwrap() == "Strong\tLasting\nCostly\tEasy" && texts[texts.len() - 2].starts_with("Right column line 0"), "{texts:?}");
    }

    #[test]
    fn a_table_atop_the_right_column_beside_a_taller_one_is_read_over_the_lines_under_it() {
        let mut ops = two_by_two(LEFT, [100., 250., 400.], PROS) + &two_by_two(RIGHT, [104., 140., 180.], CONS);
        for i in 0..12 {
            ops += &shown(72., 420. + 12. * i as f64, &format!("Left column line {i} of the body runs on."));
        }
        ops += &shown(72., 564., "It ends.");
        for i in 0..30 {
            ops += &shown(322., 200. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let texts = texts_of(&ops);
        let right = texts.iter().position(|t| t == "Fast\tCheap\nSlow\tDear").unwrap();
        assert!(texts[0] == "Strong\tLasting\nCostly\tEasy" && texts.get(right + 1).is_some_and(|t| t.starts_with("Right column line 0")), "{texts:?}");
    }

    #[test]
    fn a_table_ruled_round_its_right_columns_with_a_sixth_of_the_text_is_left_as_text() {
        let mut text = shown(72., 80., "A paragraph of prose runs on across the page as one column does.");
        for (i, label) in ["Signs documents on any device", "Keeps an audit trail of a step", "Sends a reminder to a signer"].into_iter().enumerate() {
            let y = 130. + 50. * i as f64;
            text += &(shown(78., y, label) + &shown(316., y, "Yes it does") + &shown(426., y, "No"));
        }
        text += &shown(72., 290., "Another paragraph of prose runs on.");
        let read = |ops: &str| to_ir(&with_contents(&pdf(&[vec![]], None), &[(0, ops)]), None).unwrap();
        assert_eq!(read(&(ruled(&[310., 420., 540.], &[110., 160., 210., 260.], "strokes") + &text)), read(&text));
    }

    #[test]
    fn a_running_box_over_the_right_column_is_dropped_and_the_left_columns_table_kept() {
        let page = |n: usize| {
            let mut ops = ruled(&[322., 422., 540.], &[18., 40., 60.], "strokes") + &shown(328., 30., "Spec 42") + &shown(428., 30., "Rev 3");
            ops += &(shown(328., 52., &format!("Page {n}")) + &shown(428., 52., "Confidential"));
            let words = [format!("Strong{n}"), "Lasting".into(), "Costly".into(), "Easy".into()];
            ops += &two_by_two(LEFT, [100., 150., 190.], [&words[0], &words[1], &words[2], &words[3]]);
            for i in 0..12 {
                ops += &shown(72., 210. + 12. * i as f64, &format!("Left column line {i} of page {n} runs on."));
                ops += &shown(322., 100. + 12. * i as f64, &format!("Right column line {i} of page {n} runs on."));
            }
            ops
        };
        let pages: Vec<String> = (1..=3).map(page).collect();
        let bytes = with_contents(&pdf(&[vec![], vec![], vec![]], None), &[(0, &pages[0]), (1, &pages[1]), (2, &pages[2])]);
        let ir = to_ir(&bytes, None).unwrap();
        let tables: Vec<&str> = kinds(&ir).into_iter().filter(|k| k.0 == "table").map(|k| k.1).collect();
        assert_eq!(tables, [1, 2, 3].map(|n| format!("Strong{n}\tLasting\nCostly\tEasy")), "{:?}", kinds(&ir));
    }

    #[test]
    fn a_table_over_the_rest_of_a_sentence_a_footnote_cuts_is_read_before_it() {
        let first = shown(72., 600., "A paragraph of prose opens the first page and it runs on along the line")
            + &shown(72., 612., "until the very foot of the page, where it goes on past the table on the")
            + &sized(72., 700., 8., "1 A footnote set small says where this comes from.");
        let table = two_by_two([72., 172., 540.], [100., 150., 190.], PROS);
        let second = table + &shown(72., 220., "next page and comes to its end here.");
        let ir = to_ir(&with_contents(&pdf(&[vec![], vec![]], None), &[(0, &first), (1, &second)]), None).unwrap();
        let k = kinds(&ir);
        assert!(k.last().unwrap().1.contains("past the table on the next page") && k[k.len() - 2].1 == "Strong\tLasting\nCostly\tEasy", "{k:?}");
    }

    #[test]
    fn tables_stay_by_captions_drawn_before_the_page_and_in_parts() {
        // The captions and the tables are drawn first, as floats may be, and each caption's unit across the middle from it.
        let caption = |y: f64, n: i32| shown(72., y, &format!("Table {n}: What it brings.")) + &shown(340., y, &format!("Unit {n}: percent"));
        let tables = two_by_two([72., 172., 540.], [100., 150., 190.], PROS) + &two_by_two([72., 172., 540.], [250., 300., 340.], CONS);
        let prose = "A paragraph of prose opens the page and it runs along the whole of its width to the end.";
        let more = "Another paragraph of prose closes it and it runs along the whole of its width to the end.";
        let ops = caption(92., 1) + &caption(242., 2) + &tables + &shown(72., 60., prose) + &shown(72., 400., more);
        let texts = texts_of(&ops);
        let table = |t: &str| texts.iter().position(|x| x == t).unwrap_or_else(|| panic!("{t}: {texts:?}"));
        let (one, two) = (table("Strong\tLasting\nCostly\tEasy"), table("Fast\tCheap\nSlow\tDear"));
        assert!(texts[one - 1].ends_with("Unit 1: percent") && texts[one + 1].starts_with("Table 2"), "{texts:?}");
        assert!(texts[two - 1].ends_with("Unit 2: percent") && texts[two + 1] == prose, "{texts:?}");
    }

    const PROS_TEXT: &str = "Strong\tLasting\nCostly\tEasy";
    const CONS_TEXT: &str = "Fast\tCheap\nSlow\tDear";
    const WIDE: [f64; 3] = [72., 172., 540.];

    /// A line of prose across the page.
    fn across(y: f64, words: &str) -> String {
        shown(72., y, &full(words))
    }

    fn full(words: &str) -> String {
        format!("{words} and it runs along the whole of the width of the page to the margin.")
    }

    fn pages_of(pages: &[String]) -> Vec<u8> {
        let contents: Vec<(usize, &str)> = pages.iter().map(String::as_str).enumerate().collect();
        with_contents(&pdf(&vec![vec![]; pages.len()], None), &contents)
    }

    /// The blocks' texts, a figure's as "image".
    fn blocks_of(bytes: &[u8]) -> Vec<String> {
        let blocks = to_ir(bytes, None).unwrap().blocks.into_iter();
        let text = |b: Block| match b.kind {
            BlockKind::Image => "image".into(),
            _ => b.text,
        };
        blocks.map(text).collect()
    }

    #[test]
    fn a_table_under_blocks_side_by_side_is_read_after_both() {
        let mut ops = across(80., "The first line of the letter is read");
        for (x, lines) in [(72., ["Bill to:", "Ann Author", "Main Street"]), (330., ["Ship to:", "Bob Writer", "Side Street"])] {
            ops += &lines.iter().enumerate().map(|(i, l)| shown(x, 160. + 12. * i as f64, l)).collect::<String>();
        }
        let texts = texts_of(&(ops + &two_by_two(WIDE, [200., 240., 280.], PROS) + &across(320., "The last line is read")));
        assert_eq!(texts.iter().rposition(|t| t == PROS_TEXT), Some(texts.len() - 2), "{texts:?}");
    }

    #[test]
    fn a_table_over_blocks_side_by_side_is_read_before_both() {
        let ops = across(80., "The first line is read") + &two_by_two(WIDE, [100., 140., 180.], PROS);
        let ops = ops + &shown(72., 200., "Signed for the buyer:") + &shown(330., 200., "Signed for the seller:") + &across(320., "The last line is read");
        assert_eq!(
            texts_of(&ops),
            [&full("The first line is read"), PROS_TEXT, "Signed for the buyer:", "Signed for the seller:", &full("The last line is read")]
        );
    }

    #[test]
    fn a_table_set_in_from_the_short_caption_over_it_is_read_after_it() {
        let xs = [220., 305., 390.];
        let pair = |n: i32, y: f64, words| shown(72., y, &format!("Table {n}: Sizes.")) + &two_by_two(xs, [y + 8., y + 28., y + 48.], words);
        let ops = across(80., "The first line is read") + &pair(1, 160., PROS) + &pair(2, 230., CONS);
        let read = [&full("The first line is read"), "Table 1: Sizes.", PROS_TEXT, "Table 2: Sizes.", CONS_TEXT];
        assert_eq!(texts_of(&ops), read);
        assert_eq!(texts_of(&(ops + &across(300., "The last line is read")))[..5], read);
    }

    #[test]
    fn a_table_under_a_heading_hung_in_the_margin_is_read_after_it() {
        let body = |y: f64, words: &str| shown(180., y, &format!("{words} of the body is set in from the headings and runs on and on."));
        let xs = [180., 300., 540.];
        let mut ops = body(100., "The first line") + &body(112., "The second line");
        ops += &(sized(72., 150., 12., "Parameters") + &two_by_two(xs, [160., 200., 240.], PROS));
        ops += &(sized(72., 280., 12., "Returns") + &two_by_two(xs, [290., 330., 370.], CONS));
        ops += &(sized(72., 410., 12., "Errors") + &body(440., "The last line") + &body(452., "The very last line"));
        let texts = texts_of(&ops);
        let order: Vec<&str> = texts.iter().map(String::as_str).filter(|t| !t.contains("of the body")).collect();
        assert_eq!(order, ["Parameters", PROS_TEXT, "Returns", CONS_TEXT, "Errors"]);
    }

    #[test]
    fn a_table_at_the_left_of_vertical_writing_is_read_after_its_caption() {
        let columns = |x: f64, n: i32| (0..n).map(|i| set_down(x - 16. * i as f64, 80., &TEN_DOWN.repeat(5))).collect::<String>();
        let caption = |x: f64| shown(x, 100., "Table 5 Pros and cons");
        let at_the_left = columns(540., 8) + &caption(72.) + &two_by_two([72., 200., 400.], [120., 300., 600.], PROS);
        let in_the_middle = |x1: f64| columns(540., 8) + &caption(210.) + &two_by_two([210., 300., x1], [120., 300., 600.], PROS) + &columns(190., 6);
        for ops in [at_the_left, in_the_middle(400.), in_the_middle(395.)] {
            let texts = blocks_of(&after_a_page_of_columns(&ops));
            let at = texts.iter().position(|t| t == PROS_TEXT).unwrap();
            assert_eq!(texts[at - 1], "Table 5 Pros and cons", "{texts:?}");
        }
    }

    #[test]
    fn headings_parted_by_tables_alone_are_not_all_the_title() {
        for [first, second, third] in [["Overview", "Interfaces", "Details"], ["1 Overview", "2 Interfaces", "3 Details"]] {
            let mut ops = sized(72., 80., 16., first) + &two_by_two(WIDE, [95., 115., 135.], PROS);
            ops += &(sized(72., 170., 16., second) + &two_by_two(WIDE, [185., 205., 225.], CONS));
            ops += &(sized(72., 260., 16., third) + &across(290., "The first line is read") + &across(302., "The second line is read"));
            let ir = to_ir(&pages_of(&[ops]), None).unwrap();
            assert_eq!(ir.meta.title.as_deref(), Some(first));
            assert_eq!(kinds(&ir)[..4], [("table", PROS_TEXT), ("heading", second), ("table", CONS_TEXT), ("heading", third)]);
        }
    }

    #[test]
    fn a_title_in_a_table_is_the_title_and_nothing_goes_with_it() {
        let head = ruled(&[72., 180., 420., 540.], &[60., 100., 120.], "strokes") + &sized(184., 85., 18., "Supplier Quality Manual");
        let head = head + &shown(76., 74., "Widget Works") + &shown(424., 74., "No. 1234") + &shown(76., 114., "Rev. 2") + &shown(184., 114., "Draft");
        let ops = head + &sized(72., 150., 14., "1. Purpose") + &across(170., "The purpose is read") + &sized(72., 200., 14., "2. Scope");
        let ir = to_ir(&pages_of(&[ops]), None).unwrap();
        assert_eq!((ir.meta.title.as_deref(), ir.meta.author.as_deref()), (Some("Supplier Quality Manual"), None));
        let table = "Widget Works\tSupplier Quality Manual\tNo. 1234\nRev. 2\tDraft\t";
        assert_eq!(kinds(&ir), [("table", table), ("heading", "1. Purpose"), ("paragraph", &full("The purpose is read")), ("heading", "2. Scope")]);
    }

    #[test]
    fn text_by_a_table_before_the_first_section_is_no_front_matter() {
        // The second table's rows are numbered as sections are.
        for cells in [PROS, ["1.0 First", "May", "1.1 Next", "June"]] {
            let front = sized(72., 80., 20., "Interface Specification") + &shown(72., 100., "Ann Author") + &two_by_two(WIDE, [115., 135., 155.], cells);
            let ops = front + &across(180., "A notice is read") + &sized(72., 210., 14., "1 Scope") + &across(230., "The scope is read");
            let ir = to_ir(&pages_of(&[ops]), None).unwrap();
            assert_eq!((ir.meta.title.as_deref(), ir.meta.author.as_deref()), (Some("Interface Specification"), Some("Ann Author")));
            let [a, b, c, d] = cells;
            let table = format!("{a}\t{b}\n{c}\t{d}");
            assert!(kinds(&ir).windows(2).any(|k| k == [("table", &*table), ("paragraph", &*full("A notice is read"))]), "{:?}", kinds(&ir));
            assert_eq!(kinds(&ir).last(), Some(&("paragraph", &*full("The scope is read"))));
        }
    }

    #[test]
    fn a_word_hyphenated_in_a_cell_keeps_its_hyphen_across_a_line_break() {
        let prose = shown(72., 100., "Here we look at what a model that was pre-") + &shown(72., 112., "trained does when it is given more words to read.");
        let texts = texts_of(&(prose + &two_by_two(WIDE, [200., 220., 240.], ["Kind", "Score", "a pre-trained one", "1.0"])));
        assert!(texts[0].contains("was pre-trained does"), "{texts:?}");
    }

    #[test]
    fn a_cell_outlined_again_over_a_tables_rules_keeps_it_a_table() {
        let full: String = [110., 160., 200.].iter().map(|y| format!("72 {y} m 540 {y} l S\n", y = 792. - y)).collect();
        let down: String = [72., 172., 540.].iter().map(|x| format!("{x} 682 m {x} 592 l S\n")).collect();
        // The first cell picked out by a border of its own.
        let again = "72 632 100 50 re S\n";
        let cells = shown(78., 138., "Strong") + &shown(178., 138., "Lasting") + &shown(78., 183., "Costly") + &shown(178., 183., "Easy");
        assert_eq!(texts_of(&(full + &down + again + &cells)), [PROS_TEXT]);
    }

    #[test]
    fn a_dot_stroked_on_a_tables_border_leaves_it_a_table() {
        // A dot drawn as a stroke of no length with round caps, as a connector's end is, on the left border.
        let dot = "1 J 4 w 72 660 m 72 660 l S 0 J 1 w\n";
        assert_eq!(texts_of(&(two_by_two(WIDE, [110., 160., 200.], PROS) + dot)), [PROS_TEXT]);
    }

    #[test]
    fn bars_filled_by_the_even_odd_rule_are_rules() {
        for end in ["f*", "F"] {
            let bytes = tables_page(&|xs, ys| ruled(xs, ys, "bars").replace("re f\n", &format!("re {end}\n")));
            assert_eq!(kinds(&to_ir(&bytes, None).unwrap()), TABLES_PAGE, "{end}");
        }
    }

    #[test]
    fn bars_filled_under_a_transform_are_rules_where_they_show() {
        let bars = |xs: &[f64], ys: &[f64]| {
            let mut ops = "q 0.75 0 0 -0.75 0 792 cm\n".to_string();
            let (left, right, top, bottom) = (xs[0], xs[xs.len() - 1], ys[0], ys[ys.len() - 1]);
            for &y in ys {
                ops += &format!("{} {} {} 0.75 re f\n", left / 0.75, y / 0.75, (right - left) / 0.75);
            }
            for &x in xs {
                ops += &format!("{} {} 0.75 {} re f\n", x / 0.75, top / 0.75, (bottom - top) / 0.75);
            }
            ops + "Q\n"
        };
        assert_eq!(kinds(&to_ir(&tables_page(&bars), None).unwrap()), TABLES_PAGE);
    }

    #[test]
    fn a_space_after_each_row_outside_the_rules_leaves_it_a_table() {
        // Word ends each row with a space of its own past the last cell.
        let space = |y: f64| shown(545., y, " ");
        let table = two_by_two(WIDE, [110., 160., 200.], PROS);
        let ops = across(80., "The first line is read") + &table + &space(138.) + &space(183.) + &across(240., "The last line is read");
        assert_eq!(texts_of(&ops), [&full("The first line is read"), PROS_TEXT, &full("The last line is read")]);
    }

    #[test]
    fn a_table_ruled_round_its_last_columns_within_a_column_is_left_as_text() {
        for (labels, xs, other) in [(322., [400., 470., 540.], 72.), (230., [72., 130., 190.], 322.)] {
            let mut text = String::new();
            for i in 0..14 {
                text += &shown(other, 106. + 12. * i as f64, &format!("Line {i} of the other column runs on."));
            }
            let own = if other < 300. {
                322.
            } else {
                72.
            };
            for (i, y) in [60., 72., 84., 220., 232., 244.].into_iter().enumerate() {
                text += &shown(own, y, &format!("Line {i} of its own column runs on."));
            }
            text += &(shown(labels, 133., "Signs it") + &shown(xs[0] + 6., 133., "Yes") + &shown(xs[1] + 6., 133., "No"));
            text += &(shown(labels, 173., "Keeps it") + &shown(xs[0] + 6., 173., "Yes") + &shown(xs[1] + 6., 173., "Yes"));
            assert_eq!(texts_of(&(ruled(&xs, &[110., 150., 190.], "strokes") + &text)), texts_of(&text), "{labels}");
        }
    }

    #[test]
    fn rows_no_rule_parts_are_rows_beside_an_empty_column() {
        let mut ops = ruled(&[72., 200., 300., 400.], &[110., 130., 200.], "strokes");
        ops += &(shown(78., 124., "Design") + &shown(206., 124., "Insert") + &shown(306., 124., "Notes"));
        ops += &(shown(78., 146., "Adjacency List") + &shown(206., 146., "Easy"));
        ops += &(shown(78., 166., "Nested Sets") + &shown(206., 166., "Hard"));
        ops += &(shown(78., 186., "Closure Table") + &shown(206., 186., "Easy"));
        assert_eq!(texts_of(&ops), ["Design\tInsert\tNotes\nAdjacency List\tEasy\t\nNested Sets\tHard\t\nClosure Table\tEasy\t"]);
    }

    #[test]
    fn a_gap_in_the_middle_of_the_page_in_a_cell_is_no_row() {
        // A wide gap there parts a line in two on one baseline.
        let mut ops = ruled(&[72., 440., 540.], &[110., 130., 160.], "strokes") + &shown(78., 124., "Signed by") + &shown(446., 124., "Seen");
        ops += &(shown(78., 148., "Name: Ann Author") + &shown(330., 148., "Date: 1 May") + &shown(446., 148., "Yes"));
        assert_eq!(texts_of(&ops), ["Signed by\tSeen\nName: Ann Author Date: 1 May\tYes"]);
    }

    #[test]
    fn a_superscript_in_a_row_no_rule_parts_stays_in_its_row() {
        // As TeX sets it: 7pt raised 3.6pt.
        let mut ops = ruled(&[72., 200., 400.], &[110., 130., 200.], "strokes");
        ops += &(shown(78., 124., "Design") + &shown(206., 124., "Insert"));
        ops += &(shown(78., 146., "Adjacency List") + &shown(206., 146., "Easy"));
        ops += &(shown(78., 166., "Nested Sets") + &sized(133., 162.4, 7., "a") + &shown(206., 166., "Hard"));
        ops += &(shown(78., 186., "Closure Table") + &shown(206., 186., "Easy"));
        let texts = texts_of(&ops);
        let rows: Vec<&str> = texts[0].split('\n').collect();
        assert!(rows.len() == 4 && rows[1] == "Adjacency List\tEasy" && rows[2].contains('a') && rows[2].starts_with("Nested Sets"), "{texts:?}");
    }

    #[test]
    fn a_cells_japanese_lines_are_joined_without_a_space_and_a_broken_word_whole() {
        let set = |x: f64, y: f64, cids: &str| format!("BT /F3 10 Tf {x} {} Td <{cids}> Tj ET\n", 792. - y);
        let cells = set(78., 130., "034B034D034F") + &set(178., 124., TEN_DOWN) + &set(178., 136., "0351") + &shown(78., 174., "repre-");
        let cells = cells + &shown(78., 186., "sentation") + &shown(178., 180., "Easy");
        let ops = ruled(&[72., 172., 540.], &[110., 160., 200.], "strokes") + &cells;
        let ir = to_ir(&japanese(&[vec![]], "Identity-H", &ops), None).unwrap();
        assert_eq!(kinds(&ir), [("table", "あいう\tあいうえおかきくぐけえ\nrepresentation\tEasy")]);
    }

    #[test]
    fn a_chart_under_a_table_leaves_it_a_table() {
        let chart = ruled(&[72., 172., 272., 372., 540.], &[300., 350., 400., 450.], "strokes") + &shown(300., 330., "1200");
        let ops = two_by_two(WIDE, [110., 160., 200.], PROS) + &chart + &across(500., "The last line is read");
        let texts = texts_of(&ops);
        assert!(texts.contains(&PROS_TEXT.to_string()) && texts.contains(&"1200".to_string()), "{texts:?}");
    }

    #[test]
    fn a_table_drawn_from_its_foot_up_is_read_before_the_note_beside_its_second_row() {
        let mut ops = String::new();
        for (i, y) in [100., 112., 124., 320., 332., 344.].into_iter().enumerate() {
            ops += &shown(72., y, &format!("Left column line {i} of the body runs on."));
        }
        let words = [(78., 263., "Costly"), (136., 263., "Easy"), (78., 223., "Strong"), (136., 223., "Lasting")];
        ops += &ruled(&[72., 130., 190.], &[200., 240., 280.], "strokes");
        ops += &words.map(|(x, y, w)| shown(x, y, w)).concat();
        ops += &shown(200., 243., "A note is here.");
        for i in 0..20 {
            ops += &shown(322., 100. + 12. * i as f64, &format!("Right column line {i} of the body runs on."));
        }
        let texts = texts_of(&ops);
        let at = |w: &str| texts.iter().position(|t| t == w).unwrap_or_else(|| panic!("{w}: {texts:?}"));
        assert!(at(PROS_TEXT) < at("A note is here."), "{texts:?}");
    }

    #[test]
    fn pairs_of_fields_under_a_table_across_the_page_are_read_row_by_row() {
        // The table's middle column is over the middle of the page, so its rows do not part there, and it holds most of the text.
        let (xs, ys) = ([72., 240., 390., 540.], [80., 110., 140., 170., 200.]);
        let cell = |r: usize, c: usize| shown(xs[c] + 6., ys[r] + 18., &format!("Row {r} cell {c} of it holds this"));
        let mut ops = ruled(&xs, &ys, "strokes") + &(0..4).flat_map(|r| (0..3).map(move |c| cell(r, c))).collect::<String>();
        let fields =
            [("Name: Ann Author", "Date: the first of May"), ("Street: 42 Main Street", "Phone: 555 0123"), ("Town: Somewhere", "Seen by: Bob Writer")];
        for (i, (left, right)) in fields.into_iter().enumerate() {
            ops += &(shown(72., 260. + 30. * i as f64, left) + &shown(330., 260. + 30. * i as f64, right));
        }
        let want: Vec<&str> = fields.into_iter().flat_map(|(l, r)| [l, r]).collect();
        assert_eq!(texts_of(&ops)[1..], want);
    }

    #[test]
    fn a_narrow_table_by_a_figures_caption_is_kept() {
        let table = |y: f64| two_by_two([220., 305., 390.], [y, y + 25., y + 50.], PROS);
        let figure = shown(72., 220., "Figure 1: The machine.");
        for ops in [table(150.) + &figure, figure.clone() + &table(240.)] {
            let texts = texts_of(&(across(80., "The first line is read") + &ops + &across(400., "The last line is read")));
            assert!(texts.contains(&PROS_TEXT.to_string()), "{texts:?}");
        }
    }

    #[test]
    fn a_list_of_references_goes_on_past_a_table() {
        let prose = across(80., "The first line is read") + &across(92., "The second line is read") + &across(104., "The third line is read");
        let mut ops = prose + &sized(72., 140., 12., "References");
        ops += &(shown(72., 160., "[1] A. Author. The first of the works it draws on. Press, 2001.") + &two_by_two(WIDE, [180., 220., 260.], PROS));
        ops += &shown(72., 290., "[2] B. Writer. The second of the works it draws on. Press, 2002.");
        ops += &shown(72., 302., "[3] C. Editor. The third of the works it draws on. Press, 2003.");
        let ir = to_ir(&pages_of(&[ops]), None).unwrap();
        let k: Vec<&str> = kinds(&ir).iter().skip_while(|k| k.1 != "References").map(|k| k.0).collect();
        assert_eq!(k, ["heading", "list_item", "table", "list_item", "list_item"], "{:?}", kinds(&ir));
    }

    #[test]
    fn a_reference_that_runs_on_over_the_page_past_a_table_is_whole() {
        let prose = across(80., "The first line is read") + &across(92., "The second line is read") + &across(104., "The third line is read");
        let first = prose + &sized(72., 140., 12., "References") + &shown(72., 160., "[1] A. Author. The first of the works it draws on. Press, 2001.");
        let first = first + &shown(72., 172., "[2] B. Writer. The second of the works it draws on, which has a title that");
        let second = two_by_two(WIDE, [100., 150., 190.], PROS) + &shown(72., 220., "runs on over the page. Press, 2002.");
        let second = second + &shown(72., 232., "[3] C. Editor. The third of the works it draws on. Press, 2003.");
        let ir = to_ir(&pages_of(&[first, second]), None).unwrap();
        assert!(kinds(&ir).iter().any(|k| k.0 == "list_item" && k.1.ends_with("a title that runs on over the page. Press, 2002.")), "{:?}", kinds(&ir));
    }

    #[test]
    fn a_box_in_the_margin_of_two_pages_of_seven_is_kept() {
        let page = |n: usize| {
            let table = if n < 2 {
                two_by_two(WIDE, [10., 35., 60.], PROS)
            } else {
                String::new()
            };
            table + &across(120., &format!("Page number {} of the report is read", ["one", "two", "three", "four", "five", "six", "seven"][n]))
        };
        let ir = to_ir(&pages_of(&(0..7).map(page).collect::<Vec<_>>()), None).unwrap();
        assert_eq!(ir.blocks.iter().filter(|b| b.kind == BlockKind::Table).count(), 2, "{:?}", kinds(&ir));
    }

    #[test]
    fn a_japanese_paragraph_that_ends_in_a_bracket_over_a_table_does_not_run_on_past_it() {
        // `a_japanese_paragraph_that_ends_over_a_table_does_not_run_on_past_it` with 。」 at its end.
        let set = |y: f64, cids: &str| format!("BT /F3 10 Tf 72 {} Td <{cids}> Tj ET\n", 792. - y);
        let line = TEN_DOWN.repeat(4) + &TEN_DOWN[..20];
        let first = set(600., &line) + &set(612., &(line[..line.len() - 8].to_string() + "027B02AF")) + &two_by_two(WIDE, [640., 676., 712.], PROS);
        let second = set(100., &line) + &set(112., "034B034D027B");
        let texts = blocks_of(&with_contents(&japanese(&[vec![], vec![]], "Identity-H", &second), &[(0, &first)]));
        assert!(texts[0].ends_with("。」"), "{texts:?}");
        assert_eq!((texts.iter().position(|t| t == PROS_TEXT), texts.len()), (Some(1), 3), "{texts:?}");
    }

    #[test]
    fn a_hyphen_the_body_writes_is_kept_in_a_cell() {
        let body = shown(72., 100., "A sentence of prose takes a pre-trained model and goes on with it to the end.");
        let cells = shown(78., 226., "Model") + &shown(178., 226., "Accuracy") + &shown(78., 252., "A pre-") + &shown(78., 264., "trained one");
        let texts = texts_of(&(body + &ruled(&WIDE, &[200., 240., 280.], "strokes") + &cells + &shown(178., 256., "High")));
        assert_eq!(texts[1], "Model\tAccuracy\nA pre-trained one\tHigh");
    }

    #[test]
    fn fields_over_a_table_that_holds_most_of_the_text_are_not_one_paragraph() {
        let fields = ["Product: the machine, model 42", "Serial number: 1234 5678", "Delivered on the first of May to the works"];
        let mut ops: String = (0..3).map(|i| shown(72., 80. + 22. * i as f64, fields[i])).collect();
        let ys: Vec<f64> = (0..=8).map(|i| 170. + 48. * i as f64).collect();
        ops += &ruled(&WIDE, &ys, "strokes");
        for y in &ys[..8] {
            ops += &(shown(78., y + 15., "Part") + &shown(178., y + 15., "It is checked before it leaves the works and once more"));
            ops += &(shown(178., y + 27., "when it is there, by the one who sets it up and who then") + &shown(178., y + 39., "signs for it."));
        }
        assert_eq!(texts_of(&ops)[..3], fields);
    }

    #[test]
    fn a_line_of_its_own_over_a_paragraph_a_figure_and_a_table_cut_is_kept() {
        let mut ops: String = (0..4).map(|i| across(44. + 12. * i as f64, "The first paragraph is read")).collect();
        let under = full("The paragraph under the heading is read");
        ops += &(shown(72., 100., "Results of the test") + &shown(72., 124., under.trim_end_matches('.')) + &shown(72., 136., under.trim_end_matches('.')));
        ops += &(shown(72., 300., "Figure 1: The machine at work.") + &shown(72., 330., "Table 1: Pros and cons of it."));
        ops += &(ruled(&WIDE, &[340., 380., 420.], "strokes") + &shown(78., 356., "Strong") + &shown(178., 356., "You care a lot about it and you always"));
        ops += &(shown(178., 368., "keep at it.") + &shown(78., 396., "Costly") + &shown(178., 396., "It takes a lot of the time you would have"));
        ops += &(shown(178., 408., "for other duties.") + &shown(72., 450., "where it goes on to its end under the figure and the table."));
        let texts = texts_of(&ops);
        assert!(texts.iter().any(|t| t == "Results of the test"), "{texts:?}");
    }

    #[test]
    fn the_text_of_a_table_in_a_cell_of_another_is_read_once() {
        let outer = two_by_two([72., 306., 540.], [100., 200., 400.], CONS);
        let texts = texts_of(&(outer + &two_by_two([320., 420., 520.], [220., 250., 280.], PROS))).join(" ");
        for word in PROS.into_iter().chain(CONS) {
            assert_eq!(texts.matches(word).count(), 1, "{word}: {texts}");
        }
    }

    #[test]
    fn headings_among_tables_alone_stay_headings() {
        let mut ops = String::new();
        for (i, heading) in ["Electrical data", "Mechanical data", "Ordering"].into_iter().enumerate() {
            let y = 80. + 160. * i as f64;
            let words = ["Widget made of steel", "About twelve of them", "Gadget made of brass", "About thirty of them"];
            ops += &(sized(72., y, 14., heading) + &two_by_two([72., 300., 540.], [y + 14., y + 38., y + 62.], words));
        }
        let ir = to_ir(&pages_of(&[ops]), None).unwrap();
        assert_eq!(ir.meta.title.as_deref(), Some("Electrical data"));
        let kinds: Vec<&str> = kinds(&ir).into_iter().map(|k| k.0).collect();
        assert_eq!(kinds, ["table", "heading", "table", "heading", "table"]);
    }

    #[test]
    fn a_table_across_the_last_page_leaves_its_columns_two() {
        // The right column holds less than a fifth of the text beside the table's.
        let (xs, ys) = ([72., 170., 310., 430., 540.], [80., 100., 120., 140., 160., 180., 200.]);
        let cells = |y: &f64| shown(76., y + 14., "Method") + &shown(174., y + 14., "Data set number 1 of 9") + &shown(314., y + 14., "1.0 plus or minus 1");
        let table = ruled(&xs, &ys, "strokes") + &ys[..6].iter().map(|y| cells(y) + &shown(434., y + 14., "1 hour and 1 min")).collect::<String>();
        let left = |i: usize| shown(72., 260. + 12. * i as f64, "Left column line of the body runs on to its edge");
        let right = |i: usize| shown(316., 260. + 12. * i as f64, "Right column line of the body runs on to its edge");
        let rows: String = (0..26)
            .map(|i| {
                left(i)
                    + &if i < 6 {
                        right(i)
                    } else {
                        String::new()
                    }
            })
            .collect();
        let bytes = pages_of(&[table + &rows]);
        let texts = blocks_of(&bytes);
        let body = texts[1..].join(" ");
        assert!(body.find("Right").unwrap() > body.rfind("Left").unwrap(), "{texts:?}");
        assert_eq!(regions(&bytes).unwrap().iter().map(|r| &r.text[..4]).collect::<Vec<_>>(), ["Left", "Righ"]);
    }

    #[test]
    fn a_table_drawn_before_the_text_over_it_is_read_after_it_where_its_rows_part_in_the_middle() {
        let (xs, ys) = ([72., 308., 540.], [200., 220., 240., 260., 280., 300., 320., 340.]);
        let cells = |y: &f64| shown(76., y + 14., "Strong in all kinds of weather") + &shown(312., y + 14., "Costly to make and to keep for long");
        let table = ruled(&xs, &ys, "strokes") + &ys[..7].iter().map(cells).collect::<String>();
        let ops =
            table + &across(100., "The text over it is read") + &shown(72., 190., "Table 1: Strong and weak.") + &across(360., "The text under it is read");
        let texts = texts_of(&ops);
        assert!(texts[0].starts_with("The text over") && texts[1].starts_with("Table 1") && texts[2].starts_with("Strong"), "{texts:?}");
    }

    #[test]
    fn tables_drawn_from_the_foot_of_the_page_up_are_read_from_its_top() {
        let table = |y: f64, words| two_by_two(WIDE, [y, y + 20., y + 40.], words);
        let ops = across(310., "The last line is read") + &table(230., CONS) + &table(110., PROS);
        assert_eq!(texts_of(&ops), [PROS_TEXT, CONS_TEXT, &full("The last line is read")]);
    }

    #[test]
    fn a_table_is_not_read_before_what_is_drawn_before_it_beside_it() {
        // The left column holds little text, so the page is not taken as two, and the content order stands.
        let letters = |x: f64, ys: [f64; 3]| two_by_two([x, x + 20., x + 40.], ys, ["a", "b", "c", "d"]);
        let mut ops = shown(72., 200., "Left.") + &letters(142., [220., 240., 260.]) + &letters(142., [300., 320., 340.]);
        ops += &two_by_two(RIGHT, [100., 130., 160.], PROS);
        ops += &(0..20).map(|i| shown(322., 203. + 20. * i as f64, &format!("Right column line {i} of the body runs on."))).collect::<String>();
        assert_eq!(texts_of(&ops)[..4], ["Left.", "a\tb\nc\td", "a\tb\nc\td", PROS_TEXT]);
        let ops = shown(322., 200., "Right.") + &two_by_two(LEFT, [100., 130., 160.], PROS) + &across(400., "The last line is read");
        assert_eq!(texts_of(&ops)[..2], ["Right.", PROS_TEXT]);
    }

    #[test]
    fn text_right_by_a_cell_and_drawn_next_to_it_is_not_in_its_table() {
        // Between the rows' baselines, and near enough to one to be on its line.
        let prose = across(80., "The first line is read");
        let table = two_by_two([160., 220., 290.], [110., 160., 200.], PROS);
        for ops in [prose.clone() + &table + &shown(295., 188., "A note."), prose.clone() + &shown(100., 143., "A note.") + &table] {
            let texts = texts_of(&ops);
            assert!(texts.iter().any(|t| t == "A note.") && texts.iter().any(|t| t == PROS_TEXT), "{texts:?}");
        }
    }

    #[test]
    fn text_set_across_right_by_a_cell_on_a_turned_page_is_not_in_its_table() {
        let columns: String = (0..6).map(|i| set_down(540. - 16. * i as f64, 80., &TEN_DOWN.repeat(3))).collect();
        // Courier's 10pt glyphs are 6pt wide, so the label ends 2pt left of the table, and the cell starts 2pt right of its border.
        let cells = shown(202., 463., "Strong") + &shown(306., 463., "Lasting") + &shown(202., 503., "Costly") + &shown(306., 503., "Easy");
        let ops = columns + &ruled(&[200., 300., 400.], &[440., 480., 520.], "strokes") + &shown(180., 463., "Row") + &cells;
        let texts = blocks_of(&after_a_page_of_columns(&ops));
        assert!(texts.iter().any(|t| t == "Row") && texts.iter().any(|t| t == PROS_TEXT), "{texts:?}");
    }

    #[test]
    fn a_column_that_runs_on_over_the_page_does_so_whatever_table_is_under_the_columns_of_vertical_writing() {
        let columns = |n: i32| (0..n).map(|i| set_down(540. - 16. * i as f64, 80., &TEN_DOWN.repeat(5))).collect::<String>();
        let words = ["Strong for a good long time", "Lasting for a good long time", "Costly for a good long time", "Easy for a good long time"];
        let first = columns(8) + &two_by_two([72., 300., 540.], [600., 640., 680.], words);
        let bytes = with_contents(&japanese(&[vec![], vec![]], "Identity-V", &columns(3)), &[(0, &first)]);
        let texts = blocks_of(&bytes);
        assert_eq!(texts.iter().map(|t| t.chars().count()).collect::<Vec<_>>(), [11 * 50, words.join(" ").len()], "{texts:?}");
    }

    #[test]
    fn the_line_spacing_is_not_measured_from_captions_to_their_tables() {
        let mut ops = across(80., "The first line is read") + &across(92., "The second line is read") + &across(104., "It goes on").replace('.', "");
        for i in 0..4 {
            let y = 150. + 100. * i as f64;
            ops += &(shown(72., y, "Some sizes") + &two_by_two(WIDE, [y + 9., y + 27., y + 45.], PROS));
        }
        ops += &(shown(72., 600., "one line of its own") + &shown(72., 623., "another line of its own"));
        let texts = texts_of(&ops);
        assert!(texts.iter().any(|t| t == "one line of its own"), "{texts:?}");
    }

    #[test]
    fn stacked_tables_keep_their_order_when_the_footer_is_drawn_first() {
        let (head, foot) = ("The maker of the machine and its works", "Made by the maker of the machine, all rights reserved.");
        let tables = two_by_two(WIDE, [120., 270., 420.], PROS) + &two_by_two(WIDE, [440., 540., 640.], CONS);
        let ops = shown(72., 50., head) + &shown(72., 750., foot) + &across(100., "Invoice 42 to the buyer of the machine") + &tables;
        assert_eq!(texts_of(&ops), [head, foot, &full("Invoice 42 to the buyer of the machine"), PROS_TEXT, CONS_TEXT]);
    }

    #[test]
    fn stacked_tables_atop_the_page_are_read_first_when_the_header_is_drawn_last() {
        let tables = two_by_two(WIDE, [70., 110., 150.], PROS) + &two_by_two(WIDE, [170., 210., 250.], CONS);
        let ops = tables + &shown(72., 280., "A paragraph is read.") + &shown(72., 50., "The maker of the machine and its works");
        assert_eq!(texts_of(&ops), [PROS_TEXT, CONS_TEXT, "A paragraph is read.", "The maker of the machine and its works"]);
    }

    #[test]
    fn a_sentence_cut_by_a_table_in_small_print_is_whole_again_after_it() {
        for (size, whole) in [(8., true), (10., false)] {
            let cells = sized(76., 154., size, "Strong") + &sized(304., 154., size, "Lasting");
            let cells = cells + &sized(76., 174., size, "Costly") + &sized(304., 174., size, "Easy");
            let table = ruled(&[72., 300., 540.], &[140., 160., 180.], "strokes") + &cells;
            let before = "A paragraph of prose comes before the table and runs along the width of the page until it is cut by it and";
            let texts =
                texts_of(&(shown(72., 100., before) + &table + &shown(72., 220., "comes to its end down here, where the sentence is whole again as it was.")));
            assert_eq!(texts.iter().position(|t| t == PROS_TEXT), Some(usize::from(!whole)), "{texts:?}");
            assert_eq!(texts.len(), 2 + usize::from(!whole), "{texts:?}");
        }
    }

    #[test]
    fn a_picture_over_a_sentence_a_table_cuts_is_not_between_the_table_and_its_caption() {
        let mut first = across(80., "The first paragraph is read");
        for i in 0..4 {
            first += &shown(72., 420. + 12. * i as f64, full(&format!("a sentence {i} under the picture")).trim_end_matches('.'));
        }
        let second = shown(72., 90., "Table 1: Pros and cons.") + &two_by_two(WIDE, [100., 150., 190.], PROS);
        let second = second + &shown(72., 220., "and over the page it comes to its end here.");
        let texts = blocks_of(&draw(&pages_of(&[first, second]), rgb(30, 10, [200, 0, 0]), &[(0, 72., 300., 200., 100.)]));
        let at = texts.iter().position(|t| t == PROS_TEXT).unwrap();
        assert!(texts.contains(&"image".to_string()) && texts[at - 1] == "Table 1: Pros and cons.", "{texts:?}");
    }

    #[test]
    fn a_figure_over_the_side_of_a_table_its_first_cell_is_not_at_comes_before_it() {
        let ops = across(80., "The first line is read") + &two_by_two(WIDE, [300., 340., 380.], PROS) + &across(420., "The last line is read");
        let texts = blocks_of(&draw(&pages_of(&[ops]), rgb(30, 10, [200, 0, 0]), &[(0, 340., 120., 180., 100.)]));
        assert_eq!(texts[1..3], ["image", PROS_TEXT]);
    }

    #[test]
    fn a_figure_over_a_table_at_the_foot_of_the_right_column_is_read_before_it() {
        let columns = |left: i32, right: i32| {
            let column = |x: f64, side: &str, n: i32| {
                (0..n).map(|i| shown(x, 100. + 12. * f64::from(i), &format!("{side} column line {i} runs on."))).collect::<String>()
            };
            column(72., "Left", left) + &column(322., "Right", right)
        };
        let pages = [columns(40, 10) + &two_by_two(RIGHT, [420., 460., 500.], PROS), columns(20, 20)];
        let texts = blocks_of(&draw(&pages_of(&pages), rgb(30, 10, [200, 0, 0]), &[(0, 322., 300., 200., 100.)]));
        let at = texts.iter().position(|t| t == PROS_TEXT).unwrap();
        assert_eq!(texts[at - 1], "image", "{texts:?}");
    }

    #[test]
    fn a_japanese_paragraph_that_ends_over_a_table_does_not_run_on_past_it() {
        let set = |y: f64, cids: &str| format!("BT /F3 10 Tf 72 {} Td <{cids}> Tj ET\n", 792. - y);
        let line = TEN_DOWN.repeat(4) + &TEN_DOWN[..20];
        // It ends in 。, and then in あ.
        for (end, whole) in [("027B", true), ("034B", false)] {
            let first = set(600., &line) + &set(612., &(line[..line.len() - 4].to_string() + end)) + &two_by_two(WIDE, [640., 676., 712.], PROS);
            let second = set(100., &line) + &set(112., "034B034D027B");
            let texts = blocks_of(&with_contents(&japanese(&[vec![], vec![]], "Identity-H", &second), &[(0, &first)]));
            assert_eq!((texts.iter().position(|t| t == PROS_TEXT), texts.len()), (Some(1), 2 + usize::from(whole)), "{texts:?}");
        }
    }

    #[test]
    fn a_paragraph_runs_on_past_a_full_stop_at_the_page_foot_whatever_table_another_page_has() {
        let first = across(600., "A paragraph of prose is read") + &across(612., "The second line of prose is read");
        let second = across(100., "It goes on over the page and is read") + &shown(72., 112., "It ends here.");
        let texts = blocks_of(&pages_of(&[first, second, two_by_two(WIDE, [100., 150., 190.], PROS) + &across(220., "The last paragraph is read")]));
        assert_eq!((texts.iter().position(|t| t == PROS_TEXT), texts.len()), (Some(1), 3), "{texts:?}");
    }

    #[test]
    fn a_translation_by_a_chart_has_no_room_over_it_where_tables_go_up_and_down_to_the_edges() {
        let tables = two_by_two(WIDE, [60., 100., 140.], PROS) + &two_by_two(WIDE, [600., 640., 680.], CONS);
        let first = tables + &across(300., "The first paragraph is read");
        let second = across(145., "The text under a chart is read") + &across(630., "The text over a chart is read");
        let rooms: Vec<(usize, f64, f64)> = regions(&pages_of(&[first, second])).unwrap().iter().map(|r| (r.page, r.room_up, r.room_down)).collect();
        assert_eq!(rooms, [(0, 0., 0.), (1, 0., 0.), (1, 0., 0.)]);
    }

    #[test]
    fn a_label_turned_on_its_side_in_a_cell_does_not_make_two_columns() {
        let table = two_by_two([310., 420., 540.], [110., 300., 490.], ["Yes", "No", "Yes", "Yes"]);
        let rows = shown(78., 208., "Signs documents on any device") + &shown(78., 398., "Keeps an audit trail of steps");
        let label = |i: i32| format!("BT /F1 10 Tf 0 -1 1 0 {} 670 Tm (A label turned a quarter down the page) Tj ET\n", 320 + 14 * i);
        let ir = to_ir(&pages_of(&[table + &rows + &(0..3).map(label).collect::<String>()]), None).unwrap();
        assert!(ir.blocks.iter().all(|b| b.kind != BlockKind::Table), "{:?}", kinds(&ir));
    }
}
