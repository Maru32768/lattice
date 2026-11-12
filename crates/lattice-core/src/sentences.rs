//! A snippet's sentences, for the local engine (`local.rs`): its model answers with translated lines and no
//! sentence pairs, so Lattice cuts the snippet itself, sends one sentence per line and pairs the lines back.
//!
//! Cuts come from UAX #29 over the snippet's visible text and fall only where no element is open, so every
//! sentence's HTML is balanced, and the space after a sentence stays in that sentence's source.

use unicode_segmentation::UnicodeSegmentation;

/// Elements with no content, which open nothing to close.
const VOID: &[&str] = &["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"];
/// Abbreviations a capitalized name follows without a sentence ending ("Dr. Smith").
const TITLES: &[&str] = &["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "St.", "vs.", "Fig.", "No."];
/// Opening brackets, which UAX #29 counts as closing ones: it keeps the 「 of 「設定」 with the sentence before it.
const OPENING: &[char] = &['「', '『', '（', '［', '【', '〈', '《', '〔', '〖', '〘', '｛', '“', '‘', '(', '[', '{'];

/// A snippet cut into sentences. `ends` are byte offsets into `html`, strictly increasing, the last one
/// `html.len()`: each source is a slice of the one string, so together they spell the snippet.
pub(crate) struct Sentences<'a> {
    html: &'a str,
    ends: Vec<usize>,
}

impl<'a> Sentences<'a> {
    pub fn len(&self) -> usize {
        self.ends.len()
    }

    /// Exact substrings of the snippet, in order.
    pub fn sources(&self) -> impl Iterator<Item = &'a str> {
        let html = self.html;
        std::iter::once(0).chain(self.ends.iter().copied()).zip(self.ends.iter().copied()).map(move |(from, to)| &html[from..to])
    }

    /// What goes on the wire for each sentence: its source on one line, whitespace collapsed, tags kept.
    pub fn lines(&self) -> impl Iterator<Item = String> {
        self.sources().map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}

/// Where a cut after one visible char would fall.
struct Mark {
    /// Offset in the visible text just past the char.
    text_end: usize,
    /// Offset in the HTML past the char and the closing tags right after it.
    html_end: usize,
    /// Whether no element is open at `html_end`.
    top: bool,
}

pub(crate) fn split(html: &str) -> Sentences<'_> {
    let (text, marks) = visible(html);
    let bounds = text.split_sentence_bound_indices().skip(1).map(|(start, _)| text[..start].trim_end_matches(OPENING).len());
    let cuts = bounds.filter(|&start| !keeps_together(&text[..start], &text[start..])).filter_map(|start| {
        let mark = &marks[marks.binary_search_by_key(&start, |m| m.text_end).ok()?];
        mark.top.then_some((mark.text_end, mark.html_end))
    });
    // A piece with no letter or digit (a lone ⟦1⟧, a stray ")") is no sentence: it joins the one before it,
    // or the next one when it comes first.
    let mut ends: Vec<(usize, usize)> = Vec::new();
    for (text_end, html_end) in cuts.chain([(text.len(), html.len())]) {
        let from = ends.last().map_or(0, |e| e.0);
        let wordy = text[from..text_end].chars().any(char::is_alphanumeric);
        match ends.last_mut() {
            Some(last) if !wordy => *last = (text_end, html_end),
            None if !wordy && html_end < html.len() => {}
            _ => ends.push((text_end, html_end)),
        }
    }
    Sentences { html, ends: ends.into_iter().map(|e| e.1).collect() }
}

/// Whether a UAX #29 bound is no sentence end: a Japanese quote the sentence goes on after
/// (「…になってる？」と問いかけたり), or a title before a name ("Dr. Smith").
fn keeps_together(before: &str, after: &str) -> bool {
    let before = before.trim_end();
    let next = after.chars().next();
    let quoted = before.ends_with(['」', '』']) && next.is_some_and(|c| ('\u{3041}'..='\u{309F}').contains(&c));
    let word = before.rsplit(char::is_whitespace).next().unwrap_or_default().trim_start_matches(|c: char| !c.is_alphanumeric());
    quoted || (TITLES.contains(&word) && next.is_some_and(char::is_uppercase))
}

/// The text UAX #29 reads (tags left out, entities decoded, a ⟦n⟧ token as one char, `<br>` as a line
/// break, other whitespace as a space), and a mark for each of its chars.
fn visible(html: &str) -> (String, Vec<Mark>) {
    let (mut text, mut marks) = (String::new(), Vec::<Mark>::new());
    let (mut i, mut depth) = (0, 0usize);
    // Whether a closing tag here still ends where the last char does: "<em>One.</em> Two." cuts after the space.
    let mut after_char = false;
    while let Some(c) = html[i..].chars().next() {
        let rest = &html[i..];
        if let Some(len) = tag_len(rest) {
            let tag = &rest[..len];
            i += len;
            let name = tag.trim_start_matches(['<', '/']).split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or_default().to_ascii_lowercase();
            if tag.starts_with("</") {
                depth = depth.saturating_sub(1);
                if let Some(m) = marks.last_mut().filter(|_| after_char) {
                    (m.html_end, m.top) = (i, depth == 0);
                }
                continue;
            }
            if name != "br" {
                if !(tag.starts_with("<!") || tag.starts_with("<?") || tag.ends_with("/>") || VOID.contains(&name.as_str())) {
                    depth += 1;
                    after_char = false;
                }
                continue;
            }
            text.push('\n');
        } else {
            let plain = Some(c).filter(|c| !c.is_whitespace()).unwrap_or(' ');
            let (len, shown) = entity(rest).or_else(|| token(rest)).unwrap_or((c.len_utf8(), plain));
            i += len;
            text.push(shown);
        }
        marks.push(Mark { text_end: text.len(), html_end: i, top: depth == 0 });
        after_char = true;
    }
    (text, marks)
}

/// The length of the tag `rest` starts with, quoted attribute values included. One never closed runs to
/// the end, as an HTML parser drops it; read as text, each later `<` would scan to the end again.
fn tag_len(rest: &str) -> Option<usize> {
    let mut chars = rest.char_indices();
    let (_, '<') = chars.next()? else {
        return None;
    };
    if !chars.clone().next().is_some_and(|(_, c)| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?')) {
        return None;
    }
    let mut quote = None;
    for (at, c) in chars {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '>') => return Some(at + 1),
            _ => {}
        }
    }
    Some(rest.len())
}

/// The length of the character reference `rest` starts with, and the char it stands for: one of
/// what the snippets escape, else a letter, which reads like the word most references are.
fn entity(rest: &str) -> Option<(usize, char)> {
    let end = rest.bytes().take(12).position(|b| b == b';')?;
    let name = rest.strip_prefix('&')?.get(..end - 1)?;
    let shown = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        _ => match name.strip_prefix('#') {
            Some(n) => {
                let (digits, radix) = n.strip_prefix(['x', 'X']).map_or((n, 10), |hex| (hex, 16));
                char::from_u32(u32::from_str_radix(digits, radix).ok()?)?
            }
            None if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()) => 'x',
            None => return None,
        },
    };
    Some((end + 1, shown))
}

/// A ⟦n⟧ placeholder (an image or a formula) as one char that is not a letter, so a cut never falls inside one.
fn token(rest: &str) -> Option<(usize, char)> {
    let end = rest.strip_prefix('⟦')?.find('⟧')?;
    Some(('⟦'.len_utf8() + end + '⟧'.len_utf8(), '\u{FFFC}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Snippets and the sentences they cut into.
    const CASES: &[(&str, &[&str])] = &[
        ("One sentence.", &["One sentence."]),
        ("First one. Second one.", &["First one. ", "Second one."]),
        ("Use <code>git status</code>. Then commit.", &["Use <code>git status</code>. ", "Then commit."]),
        ("Read <a href=\"https://x.dev/a. B\">the docs. They help</a>. Done.", &["Read <a href=\"https://x.dev/a. B\">the docs. They help</a>. ", "Done."]),
        ("<em>One.</em> Two.", &["<em>One.</em> ", "Two."]),
        ("One. <em>Two.</em>", &["One. ", "<em>Two.</em>"]),
        ("<em>Closed after the space. </em>Next.", &["<em>Closed after the space. </em>", "Next."]),
        ("<b><i>Deep. </i></b>Out.", &["<b><i>Deep. </i></b>", "Out."]),
        ("A &amp; B. C &lt;div&gt; D.", &["A &amp; B. ", "C &lt;div&gt; D."]),
        ("End.&nbsp;Next one.", &["End.&nbsp;", "Next one."]),
        ("Time ⟦1⟧ ticks. Next.", &["Time ⟦1⟧ ticks. ", "Next."]),
        ("Done.⟦12⟧ Next part.", &["Done.", "⟦12⟧ Next part."]),
        ("Done. ⟦2⟧", &["Done. ⟦2⟧"]),
        ("⟦3⟧ A caption.", &["⟦3⟧ A caption."]),
        ("H<sub>2</sub>O boils. It is water.", &["H<sub>2</sub>O boils. ", "It is water."]),
        ("Line one<br>Line two", &["Line one<br>", "Line two"]),
        ("Kept <img src=\"a.png\"> inline. Next.", &["Kept <img src=\"a.png\"> inline. ", "Next."]),
        ("最初の文です。次の文です。", &["最初の文です。", "次の文です。"]),
        ("「それ『曳光弾』になってる？」と問いかけたり、考えたりする。次の文。", &["「それ『曳光弾』になってる？」と問いかけたり、考えたりする。", "次の文。"]),
        ("彼は「行く。」と言った。", &["彼は「行く。」と言った。"]),
        ("「終わり。」次の文。", &["「終わり。」", "次の文。"]),
        ("メニューを開きます。「設定」を選びます。", &["メニューを開きます。", "「設定」を選びます。"]),
        ("次に進みます。（詳しくは後述します。）最後です。", &["次に進みます。", "（詳しくは後述します。）", "最後です。"]),
        ("「はい。」「いいえ。」", &["「はい。」", "「いいえ。」"]),
        ("開きます。<b>『入門』</b>を読みます。", &["開きます。", "<b>『入門』</b>を読みます。"]),
        ("Done.[1] Next one.", &["Done.", "[1] Next one."]),
        ("Use a cache, e.g. the page cache. Done.", &["Use a cache, e.g. the page cache. ", "Done."]),
        ("Ask Dr. Smith or (Prof. Jones). They know.", &["Ask Dr. Smith or (Prof. Jones). ", "They know."]),
        ("See Fig. 3 and No. Five. Then go.", &["See Fig. 3 and No. Five. ", "Then go."]),
        ("Apples, pears, etc. They grow.", &["Apples, pears, etc. ", "They grow."]),
        ("It works. (Mostly.) Done.", &["It works. ", "(Mostly.) ", "Done."]),
        ("Wait... )", &["Wait... )"]),
        ("Broken <b>bold. Never closed.", &["Broken <b>bold. Never closed."]),
        ("Stray </b>close. Then more.", &["Stray </b>close. ", "Then more."]),
        ("A <b title=\"x>y. Z\">quoted. </b>Tag.", &["A <b title=\"x>y. Z\">quoted. </b>", "Tag."]),
        ("Unclosed <a href=\"x. Y", &["Unclosed <a href=\"x. Y"]),
        ("Unquoted <a. Then <b. More.", &["Unquoted <a. Then <b. More."]),
        ("Lone & sign. Then.", &["Lone & sign. ", "Then."]),
    ];

    fn sources(html: &str) -> Vec<&str> {
        split(html).sources().collect()
    }

    #[test]
    fn snippets_cut_into_their_sentences() {
        for (html, want) in CASES {
            assert_eq!(sources(html), *want, "{html}");
        }
    }

    /// Opening minus closing tags (void ones aside): zero for a source that keeps every pair it opens.
    fn open_tags(s: &str) -> isize {
        let opens = s.match_indices('<').filter(|(i, _)| s[i + 1..].starts_with(|c: char| c.is_ascii_alphabetic())).count();
        let voids = s.matches("<br").count() + s.matches("<img").count();
        opens as isize - voids as isize - s.matches("</").count() as isize
    }

    #[test]
    fn every_cut_keeps_the_snippet_whole_and_each_sentence_balanced() {
        for (html, _) in CASES {
            let s = split(html);
            let parts: Vec<&str> = s.sources().collect();
            assert_eq!(parts.concat(), *html, "the sources spell the snippet");
            assert_eq!(s.len(), parts.len());
            for (i, part) in parts.iter().enumerate() {
                assert!(!part.is_empty(), "{html}: empty sentence {i}");
                let unmarked: String = part.split('⟦').map(|p| p.split_once('⟧').map_or(p, |(_, rest)| rest)).collect();
                assert!(unmarked.chars().any(char::is_alphanumeric), "{html}: {part:?} has no letter or digit");
                if open_tags(html) == 0 {
                    assert_eq!(open_tags(part), 0, "{html}: {part:?} splits a tag pair");
                }
                if let Some(next) = parts.get(i + 1) {
                    assert!(!next.starts_with(char::is_whitespace), "{html}: the space before {next:?} belongs to the sentence before it");
                    assert!(part.rfind('⟦') <= part.rfind('⟧'), "{html}: a cut inside a token");
                    let entity = part.rfind('&').map(|a| &part[a..]);
                    assert!(entity.is_none_or(|e| e.contains(';') || e.contains(' ')), "{html}: a cut inside {entity:?}");
                }
            }
        }
    }

    #[test]
    fn a_line_is_one_sentence_with_its_whitespace_collapsed() {
        let lines: Vec<String> = split("Use <code>git\n  status</code>.\tThen <a href=\"x\">commit</a>. ").lines().collect();
        assert_eq!(lines, ["Use <code>git status</code>.", "Then <a href=\"x\">commit</a>."]);
    }

    #[test]
    fn odd_input_is_one_sentence_at_worst() {
        for html in ["", " ", "<", "<b>", "&", "&#xZZ;", "⟦", "⟦1⟧", "</p></p>", "<!-- c. D -->x. Y", "a\u{1F600}. B"] {
            let parts = sources(html);
            assert_eq!(parts.concat(), html);
            assert!(!parts.is_empty(), "{html:?}");
        }
    }
}
