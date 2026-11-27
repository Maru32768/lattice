//! A reference to an article or to a run of its blocks, as the user copies it in Lattice and hands it to an agent or to
//! `lattice-cli`: `lattice:article/12`, `lattice:article/12#b345` or `lattice:article/12#b345-b347` (design-review §23).

use std::fmt;
use std::str::FromStr;

use serde::Deserialize;
use serde::de::{Deserializer, Error};

const PREFIX: &str = "lattice:article/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArticleRef {
    pub id: i64,
    /// The first and the last block id as written: block ids are global, so the run between them goes by the article's
    /// order, and either may come first.
    pub blocks: Option<(i64, i64)>,
}

impl From<i64> for ArticleRef {
    fn from(id: i64) -> Self {
        ArticleRef { id, blocks: None }
    }
}

fn not_a_ref(s: &str) -> String {
    format!("not an article reference {s:?}: use an article id or {PREFIX}ID, {PREFIX}ID#bBLOCK, {PREFIX}ID#bFROM-bTO")
}

/// Digits only: `i64::from_str` would also take `+12`.
fn positive(s: &str) -> Option<i64> {
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n| *n > 0)
}

impl FromStr for ArticleRef {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (id, blocks) = match s.strip_prefix(PREFIX) {
            None => (s, None),
            Some(rest) => match rest.split_once('#') {
                None => (rest, None),
                Some((id, blocks)) => (id, Some(blocks)),
            },
        };
        let block = |b: &str| b.strip_prefix('b').and_then(positive);
        let blocks = match blocks {
            None => None,
            Some(b) => {
                let (from, to) = b.split_once('-').unwrap_or((b, b));
                Some(block(from).zip(block(to)).ok_or_else(|| not_a_ref(s))?)
            }
        };
        Ok(ArticleRef { id: positive(id).ok_or_else(|| not_a_ref(s))?, blocks })
    }
}

impl fmt::Display for ArticleRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{PREFIX}{}", self.id)?;
        match self.blocks {
            None => Ok(()),
            Some((from, to)) if from == to => write!(f, "#b{from}"),
            Some((from, to)) => write!(f, "#b{from}-b{to}"),
        }
    }
}

impl<'de> Deserialize<'de> for ArticleRef {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Id(i64),
            Text(String),
        }
        match Raw::deserialize(d)? {
            Raw::Id(id) if id > 0 => Ok(id.into()),
            Raw::Id(id) => Err(D::Error::custom(not_a_ref(&id.to_string()))),
            Raw::Text(s) => s.parse().map_err(D::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_id_and_the_three_forms_and_prints_them_back() {
        let r = |id, blocks| ArticleRef { id, blocks };
        for (text, want) in [
            ("12", r(12, None)),
            (" 12\n", r(12, None)),
            ("lattice:article/12", r(12, None)),
            ("lattice:article/12#b345", r(12, Some((345, 345)))),
            ("lattice:article/12#b345-b347", r(12, Some((345, 347)))),
            ("  lattice:article/12#b347-b345 ", r(12, Some((347, 345)))),
        ] {
            assert_eq!(text.parse::<ArticleRef>(), Ok(want), "{text:?}");
        }
        for canonical in ["lattice:article/12", "lattice:article/12#b345", "lattice:article/12#b345-b347", "lattice:article/12#b347-b345"] {
            assert_eq!(canonical.parse::<ArticleRef>().unwrap().to_string(), canonical);
        }
        assert_eq!(r(12, Some((345, 345))).to_string(), "lattice:article/12#b345", "a single block prints once");
    }

    #[test]
    fn refuses_anything_else_naming_the_forms() {
        for bad in [
            "",
            "article/12",
            "lattice:article/",
            "lattice:article/12#",
            "lattice:article/12#b",
            "lattice:article/12#bx",
            "lattice:article/12#b3-",
            "lattice:article/12#b3-4",
            "lattice:article/12#b3-b4-b5",
            "lattice:feed/3",
            "lattice:article/x",
            "12#b3",
            "+12",
            "0",
            "-3",
            "lattice:article/0",
            "lattice:article/12#b0",
        ] {
            let e = bad.parse::<ArticleRef>().unwrap_err();
            assert!(e.contains("lattice:article/ID, lattice:article/ID#bBLOCK, lattice:article/ID#bFROM-bTO"), "{bad:?}: {e}");
        }
    }

    #[test]
    fn deserializes_from_an_integer_or_a_string() {
        let de = |v: serde_json::Value| serde_json::from_value::<ArticleRef>(v).map_err(|e| e.to_string());
        assert_eq!(de(serde_json::json!(12)), Ok(12.into()));
        assert_eq!(de(serde_json::json!("lattice:article/12#b3")), Ok(ArticleRef { id: 12, blocks: Some((3, 3)) }));
        for bad in [serde_json::json!(0), serde_json::json!(-1), serde_json::json!("lattice:feed/3")] {
            assert!(de(bad.clone()).unwrap_err().contains("lattice:article/ID#bBLOCK"), "{bad}");
        }
        assert!(de(serde_json::json!(true)).is_err());
    }
}
