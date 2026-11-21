//! The text of each CID in Adobe-Japan1, the character collection most Japanese fonts draw from. A font that shows its
//! CIDs as they are (`Identity-H`, `Identity-V`) needs nothing more for a viewer to draw it, and many leave out the
//! ToUnicode CMap that would give their text.
//!
//! The table is Adobe's `Adobe-Japan1-UCS2` CMap (BSD-3-Clause, see THIRD_PARTY_NOTICES.md) in the binary form pdfjs-dist
//! ships in `cmaps/`, read here as pdf.js's `BinaryCMapReader` reads it.

use std::collections::HashMap;
use std::sync::LazyLock;

/// Each CID's text in UTF-16BE.
static TABLE: LazyLock<HashMap<u32, Vec<u8>>> = LazyLock::new(|| read(include_bytes!("Adobe-Japan1-UCS2.bcmap")).expect("bundled CMap"));

pub(crate) fn utf16(cid: u32) -> Option<&'static [u8]> {
    TABLE.get(&cid).map(Vec::as_slice)
}

/// A CID takes two bytes in this CMap.
const CID: usize = 2;

fn read(data: &[u8]) -> Option<HashMap<u32, Vec<u8>>> {
    // The first byte only says whether the CMap is vertical.
    let mut r = Reader(data.get(1..)?.iter());
    let mut map = HashMap::new();
    while let Some(b) = r.byte() {
        // A comment; a `usecmap` would be 0xE1, which this table has none of.
        if b == 0xE0 {
            r.string()?;
            continue;
        }
        let (kind, sequence, size) = (b >> 5, b & 0x10 != 0, usize::from(b & 15) + 1);
        let count = r.number()?;
        match kind {
            // codespacerange, whose ranges are not needed
            0 => {
                r.raw(size)?;
                for _ in 1..2 * count {
                    r.number()?;
                }
            }
            // bfchar
            4 => {
                let (mut cid, mut text) = (r.raw(CID)?, r.raw(size)?);
                map.insert(cid as u32, bytes(text, size));
                for _ in 1..count {
                    cid += 1;
                    if !sequence {
                        cid += r.hex(CID)?;
                    }
                    text = text.wrapping_add(1).wrapping_add(r.signed(size)?);
                    map.insert(cid as u32, bytes(text, size));
                }
            }
            // bfrange: each CID from `start` to `end` has the text after the one before
            5 => {
                let mut end = 0;
                for i in 0..count {
                    let start = if i == 0 {
                        r.raw(CID)?
                    } else if sequence {
                        end + 1
                    } else {
                        end + 1 + r.hex(CID)?
                    };
                    end = start + r.hex(CID)?;
                    let text = r.raw(size)?;
                    for (j, cid) in (start..=end).enumerate() {
                        map.insert(cid as u32, bytes(text.wrapping_add(j as u128), size));
                    }
                }
            }
            _ => return None,
        }
    }
    Some(map)
}

/// The low `size` bytes of `n`, most significant first.
fn bytes(n: u128, size: usize) -> Vec<u8> {
    n.to_be_bytes()[16 - size..].to_vec()
}

struct Reader<'a>(std::slice::Iter<'a, u8>);

impl Reader<'_> {
    fn byte(&mut self) -> Option<u8> {
        self.0.next().copied()
    }

    /// Seven bits a byte, most significant first; a set top bit means more follow.
    fn number(&mut self) -> Option<u128> {
        let mut n = 0u128;
        loop {
            let b = self.byte()?;
            n = n << 7 | u128::from(b & 0x7f);
            if b & 0x80 == 0 {
                return Some(n);
            }
        }
    }

    /// `size` bytes as they stand.
    fn raw(&mut self, size: usize) -> Option<u128> {
        (0..size).try_fold(0u128, |n, _| Some(n << 8 | u128::from(self.byte()?)))
    }

    /// A number cut to `size` bytes.
    fn hex(&mut self, size: usize) -> Option<u128> {
        Some(self.number()? & mask(size))
    }

    /// A number whose lowest bit is its sign, cut to `size` bytes in two's complement.
    fn signed(&mut self, size: usize) -> Option<u128> {
        let n = self.hex(size)?;
        Some(if n & 1 == 1 {
            !(n >> 1) & mask(size)
        } else {
            n >> 1
        })
    }

    fn string(&mut self) -> Option<()> {
        (0..self.number()?).try_for_each(|_| self.number().map(drop))
    }
}

fn mask(size: usize) -> u128 {
    u128::MAX >> (128 - 8 * size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(cid: u32) -> String {
        let units: Vec<u16> = utf16(cid).unwrap().chunks(2).map(|b| u16::from_be_bytes([b[0], b[1]])).collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn the_table_gives_the_text_of_each_cid() {
        // Proportional Latin from CID 1, kana from 842, kanji in JIS order from 1125.
        assert_eq!([1, 34, 843, 887, 1125].map(text), [" ", "A", "あ", "の", "亜"]);
        assert!(TABLE.len() > 20_000, "{}", TABLE.len());
    }
}
