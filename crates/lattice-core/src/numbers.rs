//! Checks a summary's numbers against its article (J17): each number the summary writes in digits must have its
//! value somewhere in the article, however the article writes it. A Japanese summary of an English article turns
//! `80,000` into `8万` and `six projects` into `6プロジェクト`, so the article is read for values, not for strings.

use std::collections::HashSet;

/// `m` × 10^`e` with no trailing zeros in `m`, so equal values are equal (`120000` and `0.12M` both `(12, 4)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Dec {
    m: u128,
    e: i32,
}

impl Dec {
    const ZERO: Self = Self { m: 0, e: 0 };

    fn new(mut m: u128, mut e: i32) -> Self {
        if m == 0 {
            return Self::ZERO;
        }
        while m.is_multiple_of(10) {
            m /= 10;
            e += 1;
        }
        Self { m, e }
    }

    fn int(n: u128) -> Self {
        Self::new(n, 0)
    }

    /// `12` or `12.5`; `None` past 30 digits, which `u128` could not hold scaled.
    fn parse(s: &str) -> Option<Self> {
        let (int, frac) = s.split_once('.').unwrap_or((s, ""));
        if int.len() + frac.len() > 30 || frac.contains('.') {
            return None;
        }
        Some(Self::new(format!("{int}{frac}").parse().ok()?, -(frac.len() as i32)))
    }

    /// The value when it is a whole number.
    fn whole(self) -> Option<u128> {
        self.m.checked_mul(10u128.checked_pow(u32::try_from(self.e).ok()?)?)
    }

    fn shifted(self, places: i32) -> Self {
        Self::new(self.m, self.e + places)
    }

    fn plus(self, o: Self) -> Option<Self> {
        if self.m == 0 || o.m == 0 {
            return Some(if self.m == 0 {
                o
            } else {
                self
            });
        }
        let e = self.e.min(o.e);
        let widen = |d: Self| d.m.checked_mul(10u128.checked_pow((d.e - e) as u32)?);
        Some(Self::new(widen(self)?.checked_add(widen(o)?)?, e))
    }

    /// `a / b` when it ends within six decimal places (`1/2`, `3/4`), not `1/3`.
    fn ratio(a: u128, b: u128) -> Option<Self> {
        (0..=6).find_map(|k| {
            let scaled = a.checked_mul(10u128.pow(k))?;
            (b != 0 && scaled % b == 0).then(|| Self::new(scaled / b, -(k as i32)))
        })
    }
}

/// A number's value; a version (`3.12.1`) or a number too long for `Dec` by its digits.
#[derive(Debug, PartialEq, Eq, Hash)]
enum Num {
    Dec(Dec),
    Text(String),
}

/// A number written in digits in chars `start..end`, with Japanese units, a `k`/`M`/`B` suffix or a scale word joined
/// (`2億1,100万`, `1.5M`, `10 million`).
struct Mention {
    start: usize,
    end: usize,
    value: Num,
    /// The same digits read otherwise, which an article may have meant: `{1,100}` as 1 and 100, `1M` as 1.
    others: Vec<Num>,
    /// A summary may mean `others` as much as `value`: 52 after `1946-` is 1952 or 52 (`2019～20年` against
    /// `2019年から20年`).
    either: bool,
}

/// Every value `texts` write: numbers in digits, also read the other ways an article may mean them; fractions;
/// English number words, ordinals and months; kanji numerals.
#[derive(Debug, PartialEq)]
pub struct Article(HashSet<Num>);

impl Article {
    pub fn new<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut values = HashSet::new();
        for text in texts {
            let cs = folded(text);
            let mentions = mentions(&cs);
            values.extend(fractions(&cs, &mentions).map(Num::Dec));
            values.extend(mentions.into_iter().flat_map(|m| std::iter::once(m.value).chain(m.others)));
            values.extend(words(&cs).into_iter().chain(kanji(&cs)).map(Num::Dec));
        }
        Self(values)
    }

    /// Whether the article has a value the summary's `m` may mean.
    fn has(&self, m: &Mention) -> bool {
        self.0.contains(&m.value) || (m.either && m.others.iter().any(|o| self.0.contains(o)))
    }
}

/// Where `text` writes in digits a number whose value `article` lacks, in order: UTF-16 ranges, as JavaScript slices
/// strings, so the Reader marks exactly what was checked.
pub fn unverified(text: &str, article: &Article) -> Vec<(usize, usize)> {
    let utf16: Vec<usize> = std::iter::once(0).chain(text.chars().scan(0, |at, c| Some(*at + c.len_utf16()).inspect(|&n| *at = n))).collect();
    mentions(&folded(text)).into_iter().filter(|m| !article.has(m)).map(|m| (utf16[m.start], utf16[m.end])).collect()
}

/// Chars with full-width digits and odd spaces and hyphens made ASCII, one for one so positions carry over.
fn folded(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| match c {
            '０'..='９' => char::from_digit(c as u32 - '０' as u32, 10).unwrap_or(c),
            '．' => '.',
            '，' => ',',
            '／' => '/',
            '\u{a0}' | '\u{2009}' | '\u{202f}' | '\u{3000}' => ' ',
            '\u{2010}'..='\u{2013}' | '\u{2212}' => '-',
            c => c,
        })
        .collect()
}

fn digit_run(cs: &[char], from: usize) -> usize {
    cs[from..].iter().take_while(|c| c.is_ascii_digit()).count() + from
}

/// The digits from `i` (a digit) to their end: `1,234.5` with thousands separators, else `1.2.3` or `12`.
fn digits_at(cs: &[char], i: usize) -> (usize, String) {
    let mut end = digit_run(cs, i);
    let group = |at: usize| cs.get(at) == Some(&',') && digit_run(cs, at + 1) == at + 4;
    if end - i <= 3 && group(end) {
        while group(end) {
            end += 4;
        }
        if cs.get(end) == Some(&'.') && cs.get(end + 1).is_some_and(char::is_ascii_digit) {
            end = digit_run(cs, end + 1);
        }
    } else {
        while cs.get(end) == Some(&'.') && cs.get(end + 1).is_some_and(char::is_ascii_digit) {
            end = digit_run(cs, end + 1);
        }
    }
    (end, cs[i..end].iter().collect())
}

/// A token's value and its other readings: commas are thousands separators, and a token with two or more dots is a
/// version.
fn read(token: &str) -> (Num, Vec<Num>) {
    let parts = |sep| token.split(sep).filter_map(Dec::parse).map(Num::Dec).collect::<Vec<_>>();
    if token.contains(',') {
        let value = Dec::parse(&token.replace(',', "")).map_or_else(|| Num::Text(token.into()), Num::Dec);
        (value, parts(','))
    } else if token.matches('.').count() > 1 {
        (Num::Text(token.into()), parts('.'))
    } else {
        (Dec::parse(token).map_or_else(|| Num::Text(token.into()), Num::Dec), Vec::new())
    }
}

fn ja_small(c: char) -> Option<i32> {
    "十百千".chars().position(|u| u == c).map(|i| i as i32 + 1)
}

fn ja_large(c: char) -> Option<i32> {
    "万億兆".chars().position(|u| u == c).map(|i| 4 * (i as i32 + 1))
}

const SCALES: [(&str, i32); 5] = [("hundred", 2), ("thousand", 3), ("million", 6), ("billion", 9), ("trillion", 12)];

/// The ASCII letters from `i`.
fn word_at(cs: &[char], i: usize) -> String {
    cs[i.min(cs.len())..].iter().take_while(|c| c.is_ascii_alphabetic()).collect()
}

fn mentions(cs: &[char]) -> Vec<Mention> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if !cs[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let (mut end, token) = digits_at(cs, i);
        let (mut value, mut others) = read(&token);
        let mut either = false;
        if let Num::Dec(first) = value {
            let (joined, at) = japanese(cs, first, end);
            if let Some(v) = joined {
                (value, end) = (Num::Dec(v), at);
            } else if let Some((places, at)) = scale_after(cs, end) {
                others.push(value);
                (value, end) = (Num::Dec(first.shifted(places)), at);
            } else if let Some(year) = out.last().and_then(|prev| year_after(cs, prev, i, &token)) {
                others.push(value);
                (value, either) = (Num::Dec(year), true);
            }
        }
        out.push(Mention { start: i, end, value, others, either });
        i = end;
    }
    out
}

/// The year a two-digit `token` at `start` stands for after a year and a dash: 52 in `1946-52` and `1946～52`.
fn year_after(cs: &[char], prev: &Mention, start: usize, token: &str) -> Option<Dec> {
    let dash = prev.end + 1 == start && matches!(cs[prev.end], '-' | '—' | '~' | '～' | '〜');
    let Num::Dec(prev) = prev.value else {
        return None;
    };
    let year = prev.whole().filter(|y| (1000..10_000).contains(y))?;
    if !dash || token.len() != 2 {
        return None;
    }
    Dec::int(year / 100 * 100).plus(Dec::parse(token)?)
}

/// `first` (ending at `end`) with the Japanese units after it, and where they end: `4百万`, `2億1,100万`, `3万3,500`.
/// `None` when no unit follows.
fn japanese(cs: &[char], first: Dec, end: usize) -> (Option<Dec>, usize) {
    let (mut total, mut cur, mut at, mut joined) = (Dec::ZERO, first, end, false);
    loop {
        while let Some(p) = cs.get(at).copied().and_then(ja_small) {
            (cur, at, joined) = (cur.shifted(p), at + 1, true);
        }
        let Some(p) = cs.get(at).copied().and_then(ja_large) else {
            break;
        };
        let Some(sum) = total.plus(cur.shifted(p)) else {
            return (None, end);
        };
        (total, cur, at, joined) = (sum, Dec::ZERO, at + 1, true);
        if cs.get(at).is_some_and(char::is_ascii_digit) {
            let (next_end, token) = digits_at(cs, at);
            if let (Num::Dec(next), _) = read(&token) {
                (cur, at) = (next, next_end);
                continue;
            }
        }
        break;
    }
    (joined.then(|| total.plus(cur)).flatten(), at)
}

/// The power of ten of a `k`/`K`/`M`/`B`/`bn`/`mn` suffix or a scale word right after a number ending at `end`
/// (`1.5M`, `13 B`, `10 million`, `3-billion`), and where it ends.
fn scale_after(cs: &[char], end: usize) -> Option<(i32, usize)> {
    let at = if matches!(cs.get(end), Some(' ' | '-')) {
        end + 1
    } else {
        end
    };
    let word = word_at(cs, at);
    let places = match word.as_str() {
        "k" | "K" => 3,
        "M" | "mn" => 6,
        "B" | "bn" => 9,
        w => SCALES.iter().find(|(s, _)| s.eq_ignore_ascii_case(w))?.1,
    };
    Some((places, at + word.len()))
}

/// `a/b` and `n a/b` (`1/2`, `3 1/2`) among `mentions`.
fn fractions<'a>(cs: &'a [char], mentions: &'a [Mention]) -> impl Iterator<Item = Dec> + 'a {
    let int = |m: &Mention| match m.value {
        Num::Dec(d) => d.whole(),
        Num::Text(_) => None,
    };
    mentions.windows(2).enumerate().filter_map(move |(k, w)| {
        let [a, b] = w else {
            return None;
        };
        if cs.get(a.end) != Some(&'/') || b.start != a.end + 1 {
            return None;
        }
        let part = Dec::ratio(int(a)?, int(b)?)?;
        let whole = k.checked_sub(1).map(|j| &mentions[j]).filter(|n| n.end + 1 == a.start && cs[n.end] == ' ').and_then(int);
        Some(whole.and_then(|n| Dec::int(n).plus(part)).unwrap_or(part))
    })
}

const UNITS: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 8] = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINALS: [&str; 12] = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];
const MONTHS: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/// Words that stand for a number on their own: `a day` for 1日, `twice` for 2倍.
const SINGLES: [(&str, u128); 11] =
    [("a", 1), ("an", 1), ("single", 1), ("once", 1), ("twice", 2), ("double", 2), ("thrice", 3), ("triple", 3), ("quadruple", 4), ("dozen", 12), ("sept", 9)];

/// The value of a number word: `zero` to `nineteen`, or `twenty` to `ninety`.
fn cardinal(w: &str) -> Option<u128> {
    let at = |list: &[&str]| list.iter().position(|x| *x == w).map(|i| i as u128);
    at(&UNITS).or_else(|| at(&TENS).map(|i| 20 + 10 * i))
}

/// The value of a word alone: a number word, an ordinal, a month or its abbreviation, or one of `SINGLES`.
fn word_value(w: &str) -> Option<u128> {
    let at = |list: &[&str]| list.iter().position(|x| *x == w);
    let short = |list: &[&str]| (w.len() == 3).then(|| list.iter().position(|x| x.starts_with(w))).flatten();
    cardinal(w)
        .or_else(|| at(&ORDINALS).or_else(|| at(&MONTHS)).or_else(|| short(&MONTHS)).map(|i| i as u128 + 1))
        .or_else(|| SINGLES.iter().find(|(s, _)| *s == w).map(|(_, v)| *v))
}

/// The values of English number words: each word alone, and runs read whole (`twenty-seven`, `three hundred`,
/// `four million`, `three hundred and five`, `three and a half`). A run ends at anything but one space or hyphen
/// between its words, and at `and` unless a scale word comes before it.
fn words(cs: &[char]) -> Vec<Dec> {
    let mut words: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i].is_ascii_alphabetic() && (i == 0 || !cs[i - 1].is_ascii_alphabetic()) {
            let w = word_at(cs, i);
            let len = w.len();
            words.push((i, w.to_ascii_lowercase()));
            i += len;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    let mut run: Option<(Dec, Dec)> = None;
    for (k, (at, w)) in words.iter().enumerate() {
        let joined = k > 0 && {
            let (prev_at, prev) = &words[k - 1];
            *at == prev_at + prev.len() + 1 && matches!(cs[at - 1], ' ' | '-')
        };
        if !joined {
            out.extend(run.take().and_then(|(total, cur)| total.plus(cur)));
        }
        let unit = cardinal(w);
        let scale = SCALES.iter().find(|(s, _)| s == w).map(|(_, p)| *p);
        match (unit, scale, run) {
            (Some(n), _, _) => {
                let (total, cur) = run.unwrap_or((Dec::ZERO, Dec::ZERO));
                run = cur.plus(Dec::int(n)).map(|cur| (total, cur));
            }
            (_, Some(2), Some((total, cur))) => run = Some((total, cur.shifted(2))),
            (_, Some(p), Some((total, cur))) => run = total.plus(cur.shifted(p)).map(|t| (t, Dec::ZERO)),
            (_, Some(p), None) => out.push(Dec::int(1).shifted(p)),
            (None, None, Some((total, cur))) if w == "and" => {
                let half = words.get(k + 1).zip(words.get(k + 2)).is_some_and(|((_, a), (_, h))| a == "a" && h == "half");
                if half {
                    out.extend(total.plus(cur).and_then(|v| v.plus(Dec::new(5, -1))));
                }
                if !SCALES.iter().any(|(s, _)| *s == words[k - 1].1) {
                    out.extend(total.plus(cur));
                    run = None;
                }
            }
            (None, None, _) => out.extend(run.take().and_then(|(total, cur)| total.plus(cur))),
        }
        match w.as_str() {
            "half" => out.push(Dec::new(5, -1)),
            "quarter" => out.push(Dec::new(25, -2)),
            _ => {}
        }
        out.extend(word_value(w).map(Dec::int));
    }
    out.extend(run.and_then(|(total, cur)| total.plus(cur)));
    out
}

/// The values of kanji numerals: `三` in `三つ`, `二十三`, `一万`.
fn kanji(cs: &[char]) -> Vec<Dec> {
    let digit = |c: char| "〇一二三四五六七八九".chars().position(|d| d == c).map(|d| d as u128);
    let is_kanji = |c: char| digit(c).is_some() || ja_small(c).is_some() || ja_large(c).is_some();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if !is_kanji(cs[i]) {
            i += 1;
            continue;
        }
        let (mut total, mut section, mut cur) = (Dec::ZERO, Dec::ZERO, 0u128);
        while let Some(&c) = cs.get(i).filter(|&&c| is_kanji(c)) {
            if let Some(d) = digit(c) {
                cur = cur.saturating_mul(10).saturating_add(d);
            } else if let Some(p) = ja_small(c) {
                section = section.plus(Dec::int(cur.max(1)).shifted(p)).unwrap_or(section);
                cur = 0;
            } else if let Some(p) = ja_large(c) {
                let group = section.plus(Dec::int(cur)).filter(|g| g.m > 0).unwrap_or(Dec::int(1));
                total = total.plus(group.shifted(p)).unwrap_or(total);
                (section, cur) = (Dec::ZERO, 0);
            }
            i += 1;
        }
        out.extend(total.plus(section).and_then(|v| v.plus(Dec::int(cur))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The numbers `unverified` finds, as written.
    fn check(summary: &str, article: &str) -> Vec<String> {
        let units: Vec<u16> = summary.encode_utf16().collect();
        unverified(summary, &Article::new([article])).into_iter().map(|(start, end)| String::from_utf16_lossy(&units[start..end])).collect()
    }

    #[test]
    fn a_number_the_article_has_passes_and_one_it_lacks_is_returned_as_written() {
        assert_eq!(check("6プロジェクトの1,129テストは約3.9秒で完了する。", "All 1129 tests in 6 projects ran in 3.9 s."), Vec::<String>::new());
        assert_eq!(check("Art Nouveauは1880年代末〜1900年代に広がった。", "It spread around 1900, after the 19th century."), ["1880"]);
        assert_eq!(check("400エラーと400応答を返す。", "It returns an error."), ["400", "400"], "each place it is written");
        assert_eq!(unverified("😀は2倍と2万", &Article::new(["20,000"])), [(3, 4)], "UTF-16 offsets, the 2 of 2万 not among them");
        assert_eq!(check("\u{ff11}\u{ff12}\u{ff18}MBを使う。", "uses 128MB"), Vec::<String>::new(), "full-width digits");
        assert_eq!(check("p99は38.9秒", "p99 rose to 38.95 seconds"), ["38.9"], "not a prefix of another number");
    }

    #[test]
    fn japanese_units_join_into_one_value() {
        let article = "About 80,000 owners, 33,500 people, 211 million lines, 3-4 million customers, €718.55 million and 1M tokens.";
        for ok in ["約8万人", "人口約3万3,500人", "2億1,100万行", "約3〜4百万人", "7億1,855万ユーロ", "100万トークン"] {
            assert_eq!(check(ok, article), Vec::<String>::new(), "{ok}");
        }
        assert_eq!(check("20万件超のセッション", "We study 207,000 sessions."), ["20万"], "a rounded number is not the article's");
        assert_eq!(check("8万人", "8 people"), ["8万"], "the unit is part of the value");
    }

    #[test]
    fn suffixes_and_scale_words_join_the_number_before_them() {
        let article = "$0.12 / 1 M tokens, Llama-3-13B, 10 million rows, 4.65 million euros, 10k RPS";
        for ok in ["100万トークンあたり$0.12", "Llama‑3‑13B", "1,000万行", "€4.65 million", "10 k RPS", "4,650,000ユーロ"] {
            assert_eq!(check(ok, article), Vec::<String>::new(), "{ok}");
        }
        assert_eq!(check("16GBと10MB", "16 GB and 10 MB"), Vec::<String>::new(), "a unit's letters are not a suffix");
        assert_eq!(check("1万3千行", "13 thousand lines"), Vec::<String>::new());
    }

    #[test]
    fn english_number_words_ordinals_and_months_count() {
        // Each against an article of its own, so that no other word in it has the value.
        for (summary, article) in [
            ("2つの利用アプリ", "Two consuming apps"),
            ("6プロジェクト", "six projects"),
            ("27州", "twenty-seven states"),
            ("300人", "three hundred users"),
            ("5年前のノートPC", "a five-year-old laptop"),
            ("1回", "once"),
            ("4百万人", "four million customers"),
            ("100万人", "a million users"),
            ("5分の1", "one-fifth of it"),
            ("3.5星", "a 3 1/2 star rating"),
            ("3.5秒", "three and a half seconds"),
            ("10月", "in October"),
            ("10月", "Oct 2024"),
            ("1日未満", "under a day"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("7百万人", "three, four million customers"), ["7百万"], "three, four million is not seven million");
        assert_eq!(check("305人と7人", "three hundred and five people, three and four"), ["7"], "and joins only after a scale word");
        assert_eq!(check("2倍", "It doubled."), ["2"], "only the words listed");
        assert_eq!(check("0.25ポイント", "a quarter percentage point"), Vec::<String>::new());
    }

    #[test]
    fn the_articles_digits_count_in_their_other_readings_too() {
        for (summary, article) in [("Python 3で", "Python 3.12.1"), ("1件", "1M tokens"), ("52件", "1946-52")] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
    }

    #[test]
    fn kanji_numerals_and_odd_digits_in_the_article_count() {
        assert_eq!(check("3つの方式と23件", "三つの方式と二十三件"), Vec::<String>::new());
        assert_eq!(check("1万件と2億人", "一万件と二億人"), Vec::<String>::new());
        assert_eq!(check("1〜100文字", "'^[a-zA-Z0-9 ]{1,100}$'"), Vec::<String>::new(), "a comma in a pattern, not a thousands separator");
        assert_eq!(check("Python 3.12.1で", "Python 3.12.1"), Vec::<String>::new());
        assert_eq!(check("Python 3.12.2で", "Python 3.12.1 and 2"), ["3.12.2"], "a version by its text");
        assert_eq!(check("1946～52年分と1990-99年", "for 1946-1952 and 1990 to 1999"), Vec::<String>::new(), "a year cut short after a dash");
        assert_eq!(check("2019～20年に", "2019年から20年にかけて"), Vec::<String>::new(), "a year cut short may be the year or the number");
        assert_eq!(check("2024-11-19に", "on November 19, 2024"), Vec::<String>::new());
        assert_eq!(check("1946～53年分", "for 1946-1952"), ["53"], "neither 1953 nor 53");
    }

    #[test]
    fn decimals_compare_by_value() {
        assert_eq!(Dec::parse("0.120").map(|d| d.shifted(6)), Some(Dec::int(120_000)));
        assert_eq!(Dec::ratio(1, 3), None);
        assert_eq!(Dec::ratio(7, 4), Dec::parse("1.75"));
        assert_eq!(Dec::parse(&"9".repeat(31)), None);
        assert_eq!(check(&"9".repeat(40), &"9".repeat(40)), Vec::<String>::new(), "too long for a value, compared by its digits");
    }
}
