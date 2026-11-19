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

    fn times(self, n: u128) -> Option<Self> {
        Some(Self::new(self.m.checked_mul(n)?, self.e))
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
        Some(Self::new(self.widened(e)?.checked_add(o.widened(e)?)?, e))
    }

    /// The mantissa for exponent `e`, at most `self.e`.
    fn widened(self, e: i32) -> Option<u128> {
        self.m.checked_mul(10u128.checked_pow((self.e - e) as u32)?)
    }

    fn at_most(self, o: Self) -> bool {
        let e = self.e.min(o.e);
        match (self.widened(e), o.widened(e)) {
            (Some(a), Some(b)) => a <= b,
            // The one too wide for u128 is the larger.
            (a, _) => a.is_some(),
        }
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

/// Every value `texts` write: numbers in digits, also read the other ways an article may mean them; fractions; a
/// range's left end with its right end's scale; English number words, ordinals and months; kanji numerals.
#[derive(Debug, PartialEq)]
pub struct Article(HashSet<Num>);

impl Article {
    pub fn new<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut values = HashSet::new();
        for text in texts {
            let cs = folded(text);
            let mut mentions = mentions(&cs);
            for m in &mut mentions {
                m.others.extend(any_case_suffix(&cs, m.start).map(Num::Dec));
            }
            values.extend(fractions(&cs, &mentions).chain(ranges(&cs, &mentions)).chain(digit_readings(&cs, &mentions)).map(Num::Dec));
            values.extend(mentions.into_iter().flat_map(|m| std::iter::once(m.value).chain(m.others)));
            // An en dash writes a range, never one number: five hundred–one thousand is not 501,000.
            let mut spelled = cs.clone();
            for (s, c) in spelled.iter_mut().zip(text.chars()).filter(|(_, c)| *c == '\u{2013}') {
                *s = c;
            }
            values.extend(words(&spelled).into_iter().chain(kanji(&cs)).map(Num::Dec));
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
            '\u{2010}'..='\u{2013}' | '\u{2015}' | '\u{2212}' | '\u{ff0d}' => '-',
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
/// The most words an English number below a quadrillion takes (nine hundred ninety-nine trillion … ninety-nine).
const NUMBER_WORDS: usize = 24;

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

/// `first` (ending at `end`) with the Japanese units after it, and where they end: `4百万`, `2千500`, `2億1,100万`,
/// `3万3,500`. `None` when no unit follows.
fn japanese(cs: &[char], first: Dec, end: usize) -> (Option<Dec>, usize) {
    // `part` holds the places below the next 万, 億 or 兆: 2千500万 is 2,500 of 万, not 2千 and 500万.
    let (mut total, mut part, mut cur, mut at, mut joined) = (Dec::ZERO, Dec::ZERO, first, end, false);
    loop {
        let c = cs.get(at).copied();
        let sum = if let Some(p) = c.and_then(ja_small) {
            part.plus(cur.shifted(p)).map(|part| (total, part))
        } else if let Some(p) = c.and_then(ja_large) {
            part.plus(cur).and_then(|v| total.plus(v.shifted(p))).map(|total| (total, Dec::ZERO))
        } else {
            break;
        };
        let Some(sum) = sum else {
            return (None, end);
        };
        (total, part, cur, at, joined) = (sum.0, sum.1, Dec::ZERO, at + 1, true);
        if cs.get(at).is_some_and(char::is_ascii_digit) {
            let (next_end, token) = digits_at(cs, at);
            if let (Num::Dec(next), _) = read(&token) {
                (cur, at) = (next, next_end);
            }
        }
    }
    (joined.then(|| total.plus(part).and_then(|v| v.plus(cur))).flatten(), at)
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

/// The value of the digits from `start`, without what follows them, and where they end.
fn token_at(cs: &[char], start: usize) -> (usize, Option<Dec>) {
    let (end, token) = digits_at(cs, start);
    let value = match read(&token).0 {
        Num::Dec(d) => Some(d),
        Num::Text(_) => None,
    };
    (end, value)
}

/// The digits from `start` with an `m`, `mn`, `b` or `bn` suffix in any case (`$5m`, `1.2Bn`). Only the article reads
/// these: a summary's `5m` may be five metres.
fn any_case_suffix(cs: &[char], start: usize) -> Option<Dec> {
    let (end, value) = token_at(cs, start);
    let at = end + usize::from(cs.get(end) == Some(&' '));
    let places = match word_at(cs, at).to_ascii_lowercase().as_str() {
        "m" | "mn" => 6,
        "b" | "bn" => 9,
        _ => return None,
    };
    Some(value?.shifted(places))
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

/// Other ways an article writes digits: `.05` for 0.05, `10^6` for a power, and thousands grouped by dots or spaces
/// (`1.000.000`, `1 000 000`).
fn digit_readings(cs: &[char], mentions: &[Mention]) -> Vec<Dec> {
    let mut out = Vec::new();
    for m in mentions {
        let (_, token) = digits_at(cs, m.start);
        if m.start > 0 && cs[m.start - 1] == '.' && !(m.start > 1 && cs[m.start - 2].is_ascii_digit()) {
            out.extend(Dec::parse(&format!("0.{token}")));
        }
        if cs.get(m.end) == Some(&'^')
            && let (Num::Dec(base), (_, Some(power))) = (&m.value, token_at(cs, m.end + 1))
        {
            out.extend(base.whole().zip(power.whole()).and_then(|(b, p)| b.checked_pow(u32::try_from(p).ok()?)).map(Dec::int));
        }
        let mut groups = token.split('.');
        if groups.next().is_some_and(|g| g.len() <= 3 && !g.starts_with('0')) && groups.all(|g| g.len() == 3) {
            out.extend(Dec::parse(&token.replace('.', "")));
        }
        let first = digit_run(cs, m.start);
        let (mut digits, mut end): (String, _) = (cs[m.start..first].iter().collect(), first);
        // Past 30 digits `Dec::parse` reads no value, and stopping there keeps a page of groups linear.
        while first - m.start <= 3 && digits.len() <= 30 && cs.get(end) == Some(&' ') && digit_run(cs, end + 1) == end + 4 {
            digits.extend(&cs[end + 1..end + 4]);
            end += 4;
        }
        if end > first {
            out.extend(Dec::parse(&digits));
        }
    }
    out
}

const CURRENCIES: [char; 5] = ['$', '€', '£', '¥', '￥'];

/// Whether `gap`, between a range's two ends, separates them: a dash or a tilde, `to`, or `and` after `between`.
fn separates(gap: &str, between: bool) -> bool {
    match gap.trim_matches(' ') {
        "-" | "\u{2013}" | "\u{2014}" | "~" | "～" | "〜" | "to" => true,
        "and" => between,
        _ => false,
    }
}

/// A range's left end with the scale its right end writes: 3 as 3,000,000 in `3-4 million` and `$3-$4M`, as 30,000 in
/// `3～4万`, as 3,000,000,000 in `between 3 and 4 billion`. The right end has a scale where its value is its own digits
/// shifted.
fn ranges(cs: &[char], mentions: &[Mention]) -> Vec<Dec> {
    let mut out = Vec::new();
    for w in mentions.windows(2) {
        let [a, b] = w else {
            continue;
        };
        let ((a_end, Some(left)), (_, Some(right))) = (token_at(cs, a.start), token_at(cs, b.start)) else {
            continue;
        };
        let gap: String = cs[a.end..b.start].iter().collect();
        let before: String = cs[..a.start].iter().rev().skip_while(|c| **c == ' ' || CURRENCIES.contains(c)).take_while(|c| c.is_ascii_alphabetic()).collect();
        let between = before.to_ascii_lowercase().chars().rev().eq("between".chars());
        if a_end != a.end || !separates(gap.trim_end_matches(CURRENCIES), between) || !left.at_most(right) {
            continue;
        }
        for v in std::iter::once(&b.value).chain(&b.others) {
            if let Num::Dec(v) = v
                && v.m == right.m
            {
                out.push(left.shifted(v.e - right.e));
            }
        }
    }
    out
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
/// The ordinals that are not their cardinal with `th` (`fourth`) or with `y` for `ieth` (`twentieth`).
const ORDINALS: [(&str, &str); 7] =
    [("first", "one"), ("second", "two"), ("third", "three"), ("fifth", "five"), ("eighth", "eight"), ("ninth", "nine"), ("twelfth", "twelve")];
const MONTHS: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/// Words that stand for a number on their own: `a day` for 1日, `twice` for 2倍.
const SINGLES: [(&str, u128); 11] =
    [("a", 1), ("an", 1), ("single", 1), ("once", 1), ("twice", 2), ("double", 2), ("thrice", 3), ("triple", 3), ("quadruple", 4), ("dozen", 12), ("sept", 9)];

/// The value of a number word: `zero` to `nineteen`, or `twenty` to `ninety`.
fn cardinal(w: &str) -> Option<u128> {
    let at = |list: &[&str]| list.iter().position(|x| *x == w).map(|i| i as u128);
    at(&UNITS).or_else(|| at(&TENS).map(|i| 20 + 10 * i))
}

fn scale(w: &str) -> Option<i32> {
    SCALES.iter().find(|(s, _)| *s == w).map(|(_, p)| *p)
}

/// The value of a word alone: a number word, a month or its abbreviation, or one of `SINGLES`.
fn word_value(w: &str) -> Option<u128> {
    let month = MONTHS.iter().position(|x| *x == w || (w.len() == 3 && x.starts_with(w))).map(|i| i as u128 + 1);
    cardinal(w).or(month).or_else(|| SINGLES.iter().find(|(s, _)| *s == w).map(|(_, v)| *v))
}

/// A word of `cs`: where it starts and ends, and its text in lowercase.
type Word = (usize, usize, String);

fn word_list(cs: &[char]) -> Vec<Word> {
    let mut words = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i].is_ascii_alphabetic() && (i == 0 || !cs[i - 1].is_ascii_alphabetic()) {
            let w = word_at(cs, i);
            let end = i + w.len();
            words.push((i, end, w.to_ascii_lowercase()));
            i = end;
        } else {
            i += 1;
        }
    }
    words
}

/// Whether word `k` follows word `k - 1` after one space or hyphen, so that both may be one number.
fn joined(cs: &[char], words: &[Word], k: usize) -> bool {
    k > 0 && words[k].0 == words[k - 1].1 + 1 && matches!(cs[words[k].0 - 1], ' ' | '-')
}

/// `words` with ordinals and `Xfold` as their cardinal (`twenty-first` as twenty-one, `tenfold` as ten) and `a` before a
/// scale word as `one` (`a hundred thousand`). Each word keeps its place, so the runs join as written.
fn respelled(words: &[Word]) -> Vec<Word> {
    let respell = |k: usize, w: &str| {
        if let Some((_, c)) = ORDINALS.iter().find(|(o, _)| *o == w) {
            return Some((*c).to_string());
        }
        if w == "a" && words.get(k + 1).is_some_and(|next| scale(&next.2).is_some()) {
            return Some("one".into());
        }
        // Any other word loses its `th` or `fold` too: a stem that is no number word (`mon` of `month`) reads as nothing, as
        // the word did.
        w.strip_suffix("ieth").map(|stem| format!("{stem}y")).or_else(|| w.strip_suffix("th").or_else(|| w.strip_suffix("fold")).map(str::to_string))
    };
    words.iter().enumerate().map(|(k, (start, end, w))| (*start, *end, respell(k, w).unwrap_or_else(|| w.clone()))).collect()
}

/// The values of English number words, read as written and respelled: each word alone, and runs read whole
/// (`twenty-seven`, `three hundred`, `four million`, `three hundred and five`, `three and a half`, `one and a half
/// million`, `half a million`, `two dozen`).
fn words(cs: &[char]) -> Vec<Dec> {
    let list = word_list(cs);
    let respelled = respelled(&list);
    [list, respelled].iter().flat_map(|list| [read_words(cs, list), years(cs, list), word_ranges(cs, list)]).flatten().collect()
}

/// A range's left end with the scale words its right end writes, and its right end: 3,000,000 and 4,000,000 in
/// `three to four million`, 200,000 in `two hundred to three hundred thousand`. The left end gets the right end's scale
/// words above its own, and counts only when it stays no larger than the right end: `twenty-one million` is no range,
/// as 20 million is more than 1. Each end is at most `NUMBER_WORDS` long, so a page of joined number words is read in
/// linear time.
fn word_ranges(cs: &[char], words: &[Word]) -> Vec<Dec> {
    let number = |w: &str| cardinal(w).is_some() || scale(w).is_some();
    let read = |list: &[&str]| {
        let text: Vec<char> = list.join(" ").chars().collect();
        read_words(&text, &word_list(&text)).last().copied()
    };
    let mut out = Vec::new();
    for k in 0..words.len() {
        let mut l = k;
        while l > 0 && k - l + 1 < NUMBER_WORDS && joined(cs, words, l) && number(&words[l - 1].2) {
            l -= 1;
        }
        let left: Vec<&str> = words[l..=k].iter().map(|w| w.2.as_str()).collect();
        // Thousand or more in the left end would end the number at the scale words it gets (five hundred thousand
        // million).
        if cardinal(left[0]).is_none() || !left.iter().all(|w| cardinal(w).is_some() || scale(w) == Some(2)) {
            continue;
        }
        let between = l > 0 && words[l - 1].2 == "between";
        for r in [k + 1, k + 2] {
            let Some(start) = words.get(r).map(|w| w.0) else {
                continue;
            };
            if !separates(&cs[words[k].1..start].iter().collect::<String>(), between) {
                continue;
            }
            let right: Vec<&str> = (r..words.len())
                .take_while(|&j| number(&words[j].2) && (j == r || joined(cs, words, j)))
                .take(NUMBER_WORDS)
                .map(|j| words[j].2.as_str())
                .collect();
            let Some(end) = read(&right) else {
                continue;
            };
            // The scale words above the left end's own, or failing that the thousand and above alone: ninety-nine to one
            // hundred thousand is not ninety-nine hundred thousand.
            let own = left.iter().rev().find_map(|w| scale(w)).map_or(i32::MIN, |p| p + 1);
            let scaled = [own, 3].into_iter().find_map(|least| {
                let given: Vec<&str> = right.iter().copied().filter(|w| scale(w).is_some_and(|p| p >= least)).collect();
                read(&[left.as_slice(), &given].concat()).filter(|s| !given.is_empty() && s.at_most(end))
            });
            if let Some(scaled) = scaled {
                // A hyphen joins the right end to the left one when a ten meets a unit (one hundred twenty-one hundred
                // fifty thousand), so the right end is read alone here.
                out.extend([scaled, end]);
            }
        }
    }
    out
}

/// Years said in two parts: `nineteen eighty-four` (1984), `twenty twenty` (2020).
fn years(cs: &[char], words: &[Word]) -> Vec<Dec> {
    let value = |k: usize| words.get(k).and_then(|w| cardinal(&w.2));
    (1..words.len())
        .filter_map(|k| {
            let (century, year) = (value(k - 1).filter(|c| (10..=20).contains(c))?, value(k).filter(|y| *y >= 10)?);
            if !joined(cs, words, k) || cs[words[k].0 - 1] != ' ' {
                return None;
            }
            let unit = value(k + 1).filter(|u| *u < 10 && TENS.contains(&words[k].2.as_str()) && joined(cs, words, k + 1));
            Some(Dec::int(century * 100 + year + unit.unwrap_or(0)))
        })
        .collect()
}

/// The values of `words`. A run ends at anything but one space or hyphen between its words, and at `and` unless a scale
/// word comes before it.
fn read_words(cs: &[char], words: &[Word]) -> Vec<Dec> {
    let mut out = Vec::new();
    // The run's total up to its last scale word, the part since, and that scale word's power.
    let mut run: Option<(Dec, Dec, i32)> = None;
    for (k, (_, _, w)) in words.iter().enumerate() {
        if !joined(cs, words, k) {
            out.extend(run.take().and_then(|(total, cur, _)| total.plus(cur)));
        }
        if w == "dozen" {
            out.extend(run.and_then(|(total, cur, _)| total.plus(cur)?.times(12)));
        }
        let unit = cardinal(w);
        match (unit, scale(w), run) {
            (Some(n), _, _) => {
                let (total, cur, last) = run.unwrap_or((Dec::ZERO, Dec::ZERO, i32::MAX));
                // A word goes on the number only where one can (after hundreds or a scale word, a unit after a ten);
                // elsewhere it starts a new one, so three-four million is 3 and 4 million, not 7 million.
                if cur.whole().is_some_and(|c| c % 100 == 0 || (c % 100 >= 20 && c % 10 == 0 && n < 10)) {
                    run = cur.plus(Dec::int(n)).map(|cur| (total, cur, last));
                } else {
                    out.extend(total.plus(cur));
                    run = Some((Dec::ZERO, Dec::int(n), i32::MAX));
                }
            }
            // A number's hundreds come once and its scale words get smaller (one million two hundred thousand), so
            // two hundred three hundred and three million four million are two numbers each.
            (_, Some(2), Some((total, cur, last))) => match cur.whole() {
                Some(c) if c >= 100 => {
                    out.extend(total.plus(Dec::int(c - c % 100)));
                    run = Some((Dec::ZERO, Dec::int(c % 100).shifted(2), i32::MAX));
                }
                _ => run = Some((total, cur.shifted(2), last)),
            },
            (_, Some(p), Some((total, cur, last))) if p >= last => {
                out.push(total);
                run = Some((cur.shifted(p), Dec::ZERO, p));
            }
            (_, Some(p), Some((total, cur, _))) => run = total.plus(cur.shifted(p)).map(|t| (t, Dec::ZERO, p)),
            (_, Some(p), None) => out.push(Dec::int(1).shifted(p)),
            (None, None, Some((total, cur, _))) if w == "and" => {
                let half = words.get(k + 1).zip(words.get(k + 2)).is_some_and(|((_, _, a), (_, _, h))| a == "a" && h == "half");
                if half {
                    let value = total.plus(cur).and_then(|v| v.plus(Dec::new(5, -1)));
                    let places = words.get(k + 3).and_then(|(_, _, s)| scale(s));
                    out.extend(value.into_iter().chain(value.zip(places).map(|(v, p)| v.shifted(p))));
                }
                if scale(&words[k - 1].2).is_none() {
                    out.extend(total.plus(cur));
                    run = None;
                }
            }
            (None, None, _) => out.extend(run.take().and_then(|(total, cur, _)| total.plus(cur))),
        }
        match w.as_str() {
            "half" => {
                out.push(Dec::new(5, -1));
                if words.get(k + 1).is_some_and(|(_, _, a)| a == "a") {
                    out.extend(words.get(k + 2).and_then(|(_, _, s)| scale(s)).map(|p| Dec::new(5, p - 1)));
                }
            }
            "quarter" => out.push(Dec::new(25, -2)),
            _ => {}
        }
        out.extend(word_value(w).map(Dec::int));
    }
    out.extend(run.and_then(|(total, cur, _)| total.plus(cur)));
    out
}

fn kanji_digit(c: char) -> Option<u128> {
    "〇一二三四五六七八九".chars().position(|d| d == c).map(|d| d as u128)
}

/// The values of kanji numerals: `三` in `三つ`, `二十三`, `一万`. A digit and the next one up, with no other digit beside
/// them, also read as either:
/// `二三日` is two or three days and `三四百万` three or four million, besides 23 and 3,400万 by position (`一九九九`).
fn kanji(cs: &[char]) -> Vec<Dec> {
    let is_kanji = |c: char| kanji_digit(c).is_some() || ja_small(c).is_some() || ja_large(c).is_some();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let end = cs[i..].iter().position(|&c| !is_kanji(c)).map_or(cs.len(), |n| i + n);
        if end == i {
            i += 1;
            continue;
        }
        let numeral = &cs[i..end];
        out.extend(kanji_value(numeral));
        let digit = |k: usize| numeral.get(k).copied().and_then(kanji_digit);
        // The longest numeral (九千九百九十九兆…九十九) is 31 kanji. A longer run is no number, and copying it for each pair
        // would take quadratic time.
        let pairs = if numeral.len() <= 31 {
            1..numeral.len()
        } else {
            0..0
        };
        for k in pairs {
            let pair = digit(k - 1).zip(digit(k)).is_some_and(|(a, b)| a + 1 == b);
            if pair && (k < 2 || digit(k - 2).is_none()) && digit(k + 1).is_none() {
                for skip in [k - 1, k] {
                    let alone: Vec<char> = numeral.iter().enumerate().filter(|(j, _)| *j != skip).map(|(_, c)| *c).collect();
                    out.extend(kanji_value(&alone));
                }
            }
        }
        i = end;
    }
    out
}

fn kanji_value(numeral: &[char]) -> Option<Dec> {
    let (mut total, mut section, mut cur) = (Dec::ZERO, Dec::ZERO, 0u128);
    for &c in numeral {
        if let Some(d) = kanji_digit(c) {
            cur = cur.saturating_mul(10).saturating_add(d);
        } else if let Some(p) = ja_small(c) {
            section = section.plus(Dec::int(cur.max(1)).shifted(p)).unwrap_or(section);
            cur = 0;
        } else if let Some(p) = ja_large(c) {
            let group = section.plus(Dec::int(cur)).filter(|g| g.m > 0).unwrap_or(Dec::int(1));
            total = total.plus(group.shifted(p)).unwrap_or(total);
            (section, cur) = (Dec::ZERO, 0);
        }
    }
    total.plus(section).and_then(|v| v.plus(Dec::int(cur)))
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
        assert_eq!(check("400件と1880年と52個", "It returns an error."), ["400", "1880", "52"], "in the order written, not by text or value");
        assert_eq!(unverified("😀は2倍と2万", &Article::new(["20,000"])), [(3, 4)], "UTF-16 offsets, the 2 of 2万 not among them");
        assert_eq!(check("\u{ff11}\u{ff12}\u{ff18}MBを使う。", "uses 128MB"), Vec::<String>::new(), "full-width digits");
        assert_eq!(check("\u{ff11}\u{ff12}\u{ff19}MBを使う。", "uses 128MB"), ["\u{ff11}\u{ff12}\u{ff19}"], "read as digits, returned as written");
        assert_eq!(check("128MBを使う。", "uses \u{ff11}\u{ff12}\u{ff18}MB"), Vec::<String>::new(), "full-width digits in the article");
        assert_eq!(check("p99は38.9秒", "p99 rose to 38.95 seconds"), ["38.9"], "not a prefix of another number");
        assert_eq!(check("1,234.5件", "1234.5 rows"), Vec::<String>::new(), "a decimal after thousands groups");
    }

    #[test]
    fn japanese_units_join_into_one_value() {
        let article = "About 80,000 owners, 33,500 people, 211 million lines, 3-4 million customers, €718.55 million and 1M tokens.";
        for ok in ["約8万人", "人口約3万3,500人", "2億1,100万行", "約3〜4百万人", "7億1,855万ユーロ", "100万トークン"] {
            assert_eq!(check(ok, article), Vec::<String>::new(), "{ok}");
        }
        assert_eq!(check("20万件超のセッション", "We study 207,000 sessions."), ["20万"], "a rounded number is not the article's");
        assert_eq!(check("8万人", "8 people"), ["8万"], "the unit is part of the value");
        for (summary, article) in [
            ("2千500件", "2,500 rows"),
            ("1千200万人", "12 million people"),
            ("1万2千500件", "12,500 rows"),
            ("2500件", "2千500件の行"),
            ("2千5百件", "2,500 rows"),
            ("1万2,300件", "1万2千3百件"),
            ("3,500万円", "3千5百万円"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("2千500件", "2,000 and 500"), ["2千500"], "the digits after 千 are its lower places");
    }

    #[test]
    fn suffixes_and_scale_words_join_the_number_before_them() {
        let article = "$0.12 / 1 M tokens, Llama-3-13B, 10 million rows, 4.65 million euros, 10k RPS";
        for ok in ["100万トークンあたり$0.12", "Llama‑3‑13B", "1,000万行", "€4.65 million", "10 k RPS", "4,650,000ユーロ"] {
            assert_eq!(check(ok, article), Vec::<String>::new(), "{ok}");
        }
        assert_eq!(check("16GBと10MB", "16 GB and 10 MB"), Vec::<String>::new(), "a unit's letters are not a suffix");
        assert_eq!(check("1.5M件", "took 1.5 seconds"), ["1.5M"], "the suffix is part of the value");
        assert_eq!(check("1万3千行", "13 thousand lines"), Vec::<String>::new());
    }

    #[test]
    fn an_articles_m_and_b_suffixes_count_in_any_case() {
        for (summary, article) in
            [("500万ドル", "$5m"), ("500万ドル", "$5 m"), ("500万ドル", "$5Mn"), ("12億ドル", "$1.2b"), ("12億ドル", "$1.2Bn"), ("12億ドル", "$1.2BN")]
        {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("1.5mのケーブル", "a 1.5m cable"), Vec::<String>::new(), "the digits keep their own value");
        assert_eq!(check("5mの距離", "5000000 users"), ["5"], "a summary's 5m stays five metres");
        assert_eq!(check("図5b", "Figure 5 (b)"), Vec::<String>::new(), "a summary's 5b stays five");
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
        for (summary, article) in
            [("3〜4百万人", "three\u{2013}four million customers"), ("400万人", "three-four million customers"), ("300人", "two three hundred people")]
        {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("7百万人", "three\u{2013}four million customers"), ["7百万"], "a range of words is not their sum");
        assert_eq!(check("23件", "twenty-three five-star reviews"), Vec::<String>::new(), "a unit after twenty-three starts a number");
        assert_eq!(check("3000万人", "twenty\u{2013}thirty million users"), Vec::<String>::new(), "a ten after a ten starts a number");
        for (summary, article) in [
            ("300万～400万人", "three million\u{2013}four million customers"),
            ("1000～2000件", "one thousand\u{2013}two thousand rows"),
            ("200～300人", "two hundred\u{2013}three hundred people"),
            ("50万～100万人", "five hundred thousand\u{2013}one million users"),
            ("100〜200人", "between one hundred and two hundred people"),
            ("2,000〜3,000件", "between two thousand and three thousand rows"),
            ("1,200,000件", "one million two hundred thousand rows"),
            ("500～1,000人", "five hundred\u{2013}one thousand users"),
            ("1,500～2,000件", "one thousand five hundred\u{2013}two thousand rows"),
            ("20～100人", "twenty\u{2013}one hundred people"),
            ("2,100人", "twenty-one hundred people"),
            ("20万～30万人", "between two hundred thousand and three hundred thousand users"),
            ("100万、200万、300万人", "one million and two million and three million users"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("700万人", "three million\u{2013}four million customers"), ["700万"], "a range of scaled words is not their sum");
        assert_eq!(check("123人と1,200件", "one hundred twenty-three people, one thousand two hundred rows"), Vec::<String>::new());
        assert_eq!(check("305人と7人", "three hundred and five people, three and four"), ["7"], "and joins only after a scale word");
        assert_eq!(check("2倍", "It doubled."), ["2"], "only the words listed");
        assert_eq!(check("0.25ポイント", "a quarter percentage point"), Vec::<String>::new());
    }

    #[test]
    fn ordinals_xfold_and_a_before_a_scale_word_read_as_their_cardinals() {
        for (summary, article) in [
            ("1位", "in first place"),
            ("2位", "came second"),
            ("3位", "came third"),
            ("4番目", "the fourth"),
            ("5番目", "the fifth"),
            ("8番目", "the eighth"),
            ("9番目", "the ninth"),
            ("12番目", "the twelfth"),
            ("13位", "the thirteenth place"),
            ("20回目", "the twentieth time"),
            ("21世紀", "the twenty-first century"),
            ("121番目", "the one hundred twenty-first entry"),
            ("100周年", "its hundredth anniversary"),
            ("1000人目", "the thousandth user"),
            ("100万人目", "the millionth user"),
            ("10倍", "a tenfold rise"),
            ("3倍", "grew threefold"),
            ("100倍", "a hundredfold"),
            ("10万人", "a hundred thousand users"),
            ("1,500件", "a thousand five hundred rows"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("21件", "twenty a day"), ["21"], "a is one only before a scale word");
    }

    #[test]
    fn halves_of_a_scale_and_dozens_count() {
        for (summary, article) in [
            ("150万人", "one and a half million users"),
            ("250万件", "two and a half million rows"),
            ("1,500件", "one and a half thousand rows"),
            ("50万人", "half a million users"),
            ("5億ドル", "half a billion dollars"),
            ("24個", "two dozen eggs"),
            ("36個", "three dozen eggs"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        assert_eq!(check("50万人", "half the million users"), ["50万"], "half a, not half the");
        assert_eq!(check("24日", "two days"), ["24"], "only dozen counts twelve times");
    }

    #[test]
    fn years_said_in_two_parts_count() {
        for (summary, article) in
            [("1984年", "in nineteen eighty-four"), ("1984年", "in nineteen eighty four"), ("2024年", "in twenty twenty-four"), ("2020年", "in twenty twenty")]
        {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        for (summary, article, why) in [
            ("520", "five twenty", "the first part is ten to twenty"),
            ("3020", "thirty twenty", "the first part is ten to twenty"),
            ("1905", "nineteen five", "the second part is ten or more"),
            ("1980", "nineteen, eighty", "the parts are joined"),
            ("2020", "twenty-twenty vision", "by a space"),
            ("1920", "nineteen fifteen five", "a unit only after a ten"),
            ("1992", "nineteen eighty twelve", "a unit is below ten"),
            ("1984", "nineteen eighty, four", "the unit is joined"),
        ] {
            assert_eq!(check(summary, article), [summary], "{article:?}: {why}");
        }
    }

    #[test]
    fn a_ranges_left_end_takes_the_scale_of_its_right_end() {
        for (summary, article) in [
            ("300万～400万人", "about 3-4 million users"),
            ("300万～400万人", "about 3 to 4 million users"),
            ("300万～400万人", "about 3 - 4 million users"),
            ("300万～400万人", "about 3\u{2014}4 million users"),
            ("300万～400万人", "about 3~4 million users"),
            ("300万～400万人", "about 3-4M users"),
            ("300万～400万人", "about 3-4m users"),
            ("300万～400万人", "約3〜4百万人"),
            ("3万～4万人", "約3～4万人"),
            ("200万～300万人", "between 2 and 3 million users"),
            ("200万～300万ドル", "between $2 and $3 million"),
            ("200万～300万人", "Between 2 and 3 million users"),
            ("300万～400万ドル", "$3-$4 million"),
            ("300万～400万ユーロ", "€3-€4 million"),
            ("3,000～4,000件", "3-4k rows"),
            ("5,000～10,000件", "5-10k rows"),
            ("100万～150万人", "1-1.5 million users"),
            ("300万～400万人", "about three to four million users"),
            ("300万～400万人", "about three-four million users"),
            ("300万～400万人", "about three\u{2013}four million users"),
            ("300万～400万人", "about three \u{2014} four million users"),
            ("200万～300万人", "between two and three million users"),
            ("2,500万～3,000万人", "twenty-five to thirty million users"),
            ("20万～30万人", "two to three hundred thousand users"),
            ("20万～30万人", "two hundred to three hundred thousand users"),
            ("25万～35万件", "two hundred fifty to three hundred fifty thousand rows"),
            ("10万～20万人", "a hundred to two hundred thousand users"),
            ("300万～420万人", "three to four million two hundred thousand users"),
            ("300万人", "twenty, three to four million users"),
            ("12万～15万人", "one hundred twenty-one hundred fifty thousand users"),
            ("9万9000～10万人", "ninety-nine to one hundred thousand users"),
            ("5000万～6億人", "fifty to six hundred million users"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        for (summary, article, why) in [
            ("300万", "3k-4 million users", "the left end has a scale of its own"),
            ("300万", "3, 4 million users", "a comma is no range"),
            ("300万", "3 and 4 million users", "and only after between"),
            ("7000", "7～8万5千人", "8万5千 is not 8 with a scale"),
            ("5億", "500-1 million users", "no larger than the right end"),
            ("300万", "three, four million users", "a comma is no range"),
            ("300万", "three and four million users", "and only after between"),
            ("2000万", "twenty-one million users", "no larger than the right end"),
            ("0", "five hundred thousand to one million users", "no thousand in the left end"),
            ("1000", "a hundred to two hundred thousand users", "the left end starts with a number word"),
            ("300万", "three to four, million users", "the right end is joined"),
            ("0", "three to four million users and five billion", "the right end is number words"),
            ("500", "twenty-five hundred users", "the left end gets a scale word"),
        ] {
            assert_eq!(check(summary, article), [summary], "{article:?}: {why}");
        }
    }

    #[test]
    fn a_decimal_without_its_zero_and_a_power_count() {
        for (summary, article) in [("0.05", "p < .05"), ("0.5", "a .5 rating"), ("100万", "10^6 samples"), ("1024", "2^10 bytes")] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        for (summary, article, why) in
            [("0.5", "version 5", "a dot comes before the digits"), ("0.78", "1,234.56.78", "the dot follows no digit"), ("8", "2-3", "a power follows ^")]
        {
            assert_eq!(check(summary, article), [summary], "{article:?}: {why}");
        }
        assert_eq!(check("99", "10^99"), Vec::<String>::new(), "a power too large for a value is left out");
        assert_eq!(check("0.22", ".22 of them"), Vec::<String>::new(), "a dot at the start of the text");
    }

    #[test]
    fn thousands_grouped_by_dots_or_spaces_count() {
        for (summary, article) in [
            ("100万ユーロ", "1.000.000 euros"),
            ("1500ユーロ", "1.500 euros"),
            ("1.5ユーロ", "1.500 euros"),
            ("100万件", "1 000 000 rows"),
            ("1万2345件", "12 345 rows"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        for (summary, article, why) in [
            ("1234567", "1234.567", "a first group of at most three digits"),
            ("500", "0.500", "a first group not starting with 0"),
            ("3121", "3.12.1", "groups of three digits"),
            ("1234567", "1234 567", "a first group of at most three digits"),
            ("1234", "1 2345", "groups of three digits"),
            ("1234", "1-234", "groups after a space"),
            ("1", "1.5", "a number with no group is read as written"),
        ] {
            assert_eq!(check(summary, article), [summary], "{article:?}: {why}");
        }
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
        assert_eq!(check("2019\u{ff0d}20年と2019\u{2015}20年", "from 2019 to 2020"), Vec::<String>::new(), "a full-width hyphen and a horizontal bar");
        for article in ["for 1946\u{ff0d}52", "for 1946\u{2013}52", "for 1946\u{2014}52", "for 1946~52"] {
            assert_eq!(check("1952年", article), Vec::<String>::new(), "{article:?}");
        }
        assert_eq!(check("2020-2021年", "from 2020 to 2021"), Vec::<String>::new());
        assert_eq!(check("4021件", "2020-2021"), ["4021"], "only two digits are a year cut short");
    }

    #[test]
    fn two_kanji_digits_one_apart_read_as_either() {
        for (summary, article) in [
            ("2～3日", "二三日"),
            ("23日", "二十三日"),
            ("300万～400万人", "三四百万人"),
            ("12～13人", "十二三人"),
            ("20～30人", "二三十人"),
            ("1万2000～1万3000人", "一万二三千人"),
            ("1999年", "一九九九年"),
        ] {
            assert_eq!(check(summary, article), Vec::<String>::new(), "{summary} against {article:?}");
        }
        for (summary, article, why) in [("2", "二四日", "one apart"), ("12", "一二三件", "a pair alone"), ("23", "一二三件", "a pair alone")] {
            assert_eq!(check(summary, article), [summary], "{article:?}: {why}");
        }
    }

    #[test]
    fn long_runs_of_number_words_groups_and_kanji_pairs_read_in_linear_time() {
        // Read again from each word, group or pair, each of these took from 24 s to a minute in a debug build.
        for (unit, times) in [("one-", 3_000), ("one ", 16_000), (" 000", 16_000), ("一二十", 6_000)] {
            let text = format!("1{}", unit.repeat(times));
            let started = std::time::Instant::now();
            Article::new([text.as_str()]);
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "{unit:?} × {times} took {:?}", started.elapsed());
        }
    }

    #[test]
    fn decimals_compare_by_value() {
        assert_eq!(Dec::parse("0.120").map(|d| d.shifted(6)), Some(Dec::int(120_000)));
        assert_eq!(Dec::ratio(1, 3), None);
        assert_eq!(Dec::ratio(7, 4), Dec::parse("1.75"));
        assert_eq!(Dec::parse(&"9".repeat(31)), None);
        assert!(Dec::new(1, -30).at_most(Dec::new(1, 29)), "the one too wide for u128 is the larger");
        assert!(!Dec::new(1, 29).at_most(Dec::new(1, -30)));
        assert_eq!(check(&"9".repeat(40), &"9".repeat(40)), Vec::<String>::new(), "too long for a value, compared by its digits");
    }

    /// `n` in English words, American (`one hundred twenty-three`) or British (`one hundred and twenty-three`).
    fn english(n: u128, british: bool) -> String {
        let below_hundred = |r: usize| match r {
            0..20 => UNITS[r].to_string(),
            _ if r.is_multiple_of(10) => TENS[r / 10 - 2].to_string(),
            _ => format!("{}-{}", TENS[r / 10 - 2], UNITS[r % 10]),
        };
        let mut words = Vec::new();
        for (p, scale) in [(12, "trillion"), (9, "billion"), (6, "million"), (3, "thousand"), (0, "")] {
            let group = (n / 10u128.pow(p) % 1000) as usize;
            if group == 0 {
                continue;
            }
            if group >= 100 {
                words.push(format!("{} hundred", UNITS[group / 100]));
            }
            if group >= 100 && !group.is_multiple_of(100) && british {
                words.push("and".into());
            }
            if !group.is_multiple_of(100) {
                words.push(below_hundred(group % 100));
            }
            if !scale.is_empty() {
                words.push(scale.into());
            }
        }
        words.join(" ")
    }

    fn english_ordinal(cardinal: &str) -> String {
        let (head, last) = cardinal.split_at(cardinal.rfind([' ', '-']).map_or(0, |i| i + 1));
        let last = match last {
            "one" => "first".into(),
            "two" => "second".into(),
            "three" => "third".into(),
            "five" => "fifth".into(),
            "eight" => "eighth".into(),
            "nine" => "ninth".into(),
            "twelve" => "twelfth".into(),
            w => w.strip_suffix('y').map_or_else(|| format!("{w}th"), |stem| format!("{stem}ieth")),
        };
        format!("{head}{last}")
    }

    const KANJI_DIGITS: [char; 10] = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

    /// `n` in 万, 億 and 兆 sections (`1234万5678`), each nonzero section written by `section`.
    fn sections(n: u128, section: impl Fn(u128) -> String) -> String {
        [(12, "兆"), (8, "億"), (4, "万"), (0, "")]
            .into_iter()
            .filter_map(|(p, unit)| Some(n / 10u128.pow(p) % 10_000).filter(|s| *s > 0).map(|s| format!("{}{unit}", section(s))))
            .collect()
    }

    /// A section below 万 with 千 and 百 (`5千6百78`).
    fn sen_hyaku(s: u128) -> String {
        let mut out = String::new();
        for (p, unit) in [(3, '千'), (2, '百')] {
            if !(s / 10u128.pow(p)).is_multiple_of(10) {
                out.push_str(&format!("{}{unit}", s / 10u128.pow(p) % 10));
            }
        }
        if !s.is_multiple_of(100) {
            out.push_str(&(s % 100).to_string());
        }
        out
    }

    /// A section below 万 in kanji (`五千六百七十八`), the 一 before 千, 百 and 十 left out.
    fn kanji_section(s: u128) -> String {
        let mut out = String::new();
        for (p, unit) in [(3, '千'), (2, '百'), (1, '十')] {
            match s / 10u128.pow(p) % 10 {
                0 => {}
                1 => out.push(unit),
                d => out.extend([KANJI_DIGITS[d as usize], unit]),
            }
        }
        if !s.is_multiple_of(10) {
            out.push(KANJI_DIGITS[(s % 10) as usize]);
        }
        out
    }

    fn grouped(n: u128, separator: char) -> String {
        let digits = n.to_string();
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out.push(separator);
            }
            out.push(c);
        }
        out
    }

    /// `n / 10^p` in digits when it has at most three decimals.
    fn quotient(n: u128, p: u32) -> Option<String> {
        let (whole, frac) = (n / 10u128.pow(p), n % 10u128.pow(p));
        let frac = format!("{frac:0width$}", width = p as usize);
        let frac = frac.trim_end_matches('0');
        (frac.len() <= 3).then(|| {
            if frac.is_empty() {
                whole.to_string()
            } else {
                format!("{whole}.{frac}")
            }
        })
    }

    /// The ways a summary writes `n` in digits.
    fn summary_notations(n: u128) -> Vec<String> {
        let mut out = vec![n.to_string(), grouped(n, ','), sections(n, |s| s.to_string()), sections(n, |s| grouped(s, ',')), sections(n, sen_hyaku)];
        for (p, suffix, word) in [(3, "k", "thousand"), (6, "M", "million"), (9, "B", "billion")] {
            if n >= 10u128.pow(p) && (p == 9 || n < 10u128.pow(p + 3)) {
                out.extend(quotient(n, p).into_iter().flat_map(|q| [format!("{q}{suffix}"), format!("{q} {word}")]));
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// The ways an article writes `n`: a summary's, and in words, kanji and other notations.
    fn article_notations(n: u128) -> Vec<String> {
        let mut out = summary_notations(n);
        let american = english(n, false);
        out.extend([american.clone(), english(n, true), english_ordinal(&american), sections(n, kanji_section)]);
        out.push(n.to_string().chars().map(|c| KANJI_DIGITS[c as usize - '0' as usize]).collect());
        if let Some(rest) = american.strip_prefix("one ").filter(|rest| SCALES.iter().any(|(s, _)| rest.starts_with(s))) {
            out.push(format!("a {rest}"));
        }
        if !american.contains([' ', '-']) {
            out.push(format!("{american}fold"));
        }
        if let Some(scale) = american.strip_prefix("one ").filter(|rest| !rest.contains(' ')) {
            out.push(format!("{scale}fold"));
        }
        if n >= 1000 {
            out.extend([grouped(n, '.'), grouped(n, ' ')]);
        }
        if let Some(p) = (1..13).find(|p| 10u128.pow(*p) == n) {
            out.push(format!("10^{p}"));
        }
        for (p, suffixes) in [(6, ["m", "mn", "Mn", "MN", " m"]), (9, ["b", "bn", "Bn", "BN", " b"])] {
            if n >= 10u128.pow(p) && (p == 9 || n < 10u128.pow(p + 3)) {
                out.extend(quotient(n, p).into_iter().flat_map(|q| suffixes.map(|s| format!("{q}{s}"))));
            }
        }
        if n.is_multiple_of(12) && n < 120 {
            out.push(format!("{} dozen", english(n / 12, false)));
        }
        for (p, scale) in [(3, "thousand"), (6, "million"), (9, "billion")] {
            let halves = 2 * n / 10u128.pow(p);
            if (2 * n).is_multiple_of(10u128.pow(p)) && halves % 2 == 1 && halves < 20 {
                out.push(if halves == 1 {
                    format!("half a {scale}")
                } else {
                    format!("{} and a half {scale}", english(halves / 2, false))
                });
            }
        }
        out
    }

    /// A scale's power with the ways digits write it after a range's right end, and its English words. Digits take one
    /// scale word (`4 hundred thousand` reads 400 in the summary too), so hundred thousand is written in words only.
    const RANGE_SCALES: [(u32, &[&str], Option<&str>); 9] = [
        (2, &[" hundred", "百"], Some("hundred")),
        (3, &[" thousand", "k", "千"], Some("thousand")),
        (4, &["万"], None),
        (5, &["十万"], Some("hundred thousand")),
        (6, &[" million", "M", "百万"], Some("million")),
        (7, &["千万"], None),
        (8, &["億"], Some("hundred million")),
        (9, &[" billion", "B"], Some("billion")),
        (12, &[" trillion", "兆"], Some("trillion")),
    ];

    /// A small xorshift, so the generated values are the same on every run.
    fn xorshift(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn every_notation_of_a_value_passes_against_every_other() {
        // Each power of ten and the values around it, the multiples of twelve a dozen writes, and a few with many digits.
        let mut values = vec![12, 24, 36, 108, 115, 2024, 12_345, 1_200_000, 12_345_678, 123_456_789, 9_999_999_999_999];
        for p in 0..13 {
            let power = 10u128.pow(p);
            values.extend([power / 2, power - 1, power, power + 1, power * 101 / 100, power * 11 / 10, power * 3 / 2, power * 5 / 2]);
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..300 {
            let mantissa = 1 + u128::from(xorshift(&mut seed) % 9999);
            values.push(mantissa * 10u128.pow((xorshift(&mut seed) % 9) as u32));
        }
        values.retain(|n| *n > 0);
        values.sort_unstable();
        values.dedup();
        // Each article with the summaries checked against it.
        let mut cases: Vec<(String, Vec<String>)> = Vec::new();
        for &n in &values {
            let summaries = summary_notations(n);
            cases.extend(article_notations(n).into_iter().map(|a| (a, summaries.clone())));
        }
        let mut ends = vec![(1, 2), (2, 3), (3, 4), (5, 10), (9, 15), (10, 20), (15, 25), (21, 22), (25, 30), (99, 100)];
        ends.extend([(2, 350), (50, 600), (100, 200), (120, 150), (250, 350), (517, 602), (998, 999)]);
        for _ in 0..40 {
            let low = 1 + u128::from(xorshift(&mut seed) % 998);
            ends.push((low, low + 1 + u128::from(xorshift(&mut seed)) % (999 - low)));
        }
        for &(low, high) in &ends {
            for (p, digit_scales, word_scale) in RANGE_SCALES {
                // In words, a scale with hundred goes with one-digit ends only: twenty to thirty hundred thousand is not
                // English, and the ends written whole would meet between five hundred and one thousand, read as 501,000.
                let in_words = p % 3 != 2 || high < 10;
                let (lo, hi) = (low * 10u128.pow(p), high * 10u128.pow(p));
                let summaries = [
                    format!("{}～{}", sections(lo, |s| s.to_string()), sections(hi, |s| s.to_string())),
                    format!("{}～{}", grouped(lo, ','), grouped(hi, ',')),
                ];
                let mut articles = Vec::new();
                for scale in digit_scales {
                    for separator in ["-", "\u{2013}", "\u{2014}", "~", "～", "〜", " to ", " - "] {
                        articles.push(format!("{low}{separator}{high}{scale}"));
                    }
                    articles.extend([format!("between {low} and {high}{scale}"), format!("${low}-${high}{scale}"), format!("{low}{scale} to {high}{scale}")]);
                }
                // A one-digit left end against a right end with hundred (two to three hundred fifty thousand) reads as two
                // hundred thousand. The ends are American: and ends a range's end (one hundred and twenty to one hundred
                // and fifty thousand).
                if let Some(scale) = word_scale.filter(|_| in_words && (low >= 10 || high < 100)) {
                    let (l, h) = (english(low, false), english(high, false));
                    for separator in [" to ", "-", "\u{2013}", "\u{2014}", " \u{2013} ", "~"] {
                        articles.push(format!("{l}{separator}{h} {scale}"));
                    }
                    articles.push(format!("between {l} and {h} {scale}"));
                }
                if in_words {
                    let (l, h) = (english(lo, false), english(hi, false));
                    articles.extend([format!("{l} to {h}"), format!("{l}\u{2013}{h}"), format!("between {l} and {h}")]);
                }
                cases.extend(articles.into_iter().map(|a| (a, summaries.to_vec())));
            }
        }
        let mut failed = Vec::new();
        for (article, summaries) in &cases {
            let read = Article::new([format!("about {article} items").as_str()]);
            for summary in summaries {
                let text = format!("約{summary}件");
                if !unverified(&text, &read).is_empty() {
                    failed.push((summary, article));
                }
            }
        }
        let pairs: usize = cases.iter().map(|(_, summaries)| summaries.len()).sum();
        assert!(failed.is_empty(), "{} of {pairs} pairs flagged, the first: {:#?}", failed.len(), &failed[..failed.len().min(20)]);
    }
}
