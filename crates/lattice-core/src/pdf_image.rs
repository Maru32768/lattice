//! A PDF image as a file the Reader shows: a DCT stream is a JPEG as stored, 8-bit gray or RGB becomes a PNG, written
//! here over flate2. Anything else stays in the Page view.

use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use pdf_extract::{Dictionary, Document, Object};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Format {
    /// DCTDecode in gray or RGB: the data is a JPEG file.
    Jpeg,
    /// 8-bit gray (1 channel) or RGB (3), unfiltered or FlateDecode.
    Png { width: u32, height: u32, channels: u8, rows: Rows },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Rows {
    /// FlateDecode with a PNG predictor over the image's own colours and columns: the stream is a PNG's IDAT as it stands.
    Filtered,
    /// No predictor: each row gets PNG's filter byte 0 in front.
    Plain { flate: bool },
}

/// A figure is a few megapixels (DDIA's are 2900x1100 RGB, 9.6 MB of rows); an image larger than this is not one.
const MAX_ROWS_BYTES: u64 = 64 * 1024 * 1024;

impl Format {
    // shortcut: CMYK, Indexed, depths other than 8, LZW/JPX/JBIG2/CCITT, SMask, Mask, ImageMask and Decode stay in the Page
    // view; add one when a user's PDF needs it (one DDIA chapter's figures are DCT CMYK with an SMask).
    /// How an image with this dictionary becomes a file, or `None` when the Reader cannot show it.
    pub(crate) fn of(doc: &Document, image: &Dictionary) -> Option<Format> {
        let get = |key: &[u8]| image.get_deref(key, doc).ok();
        if [&b"SMask"[..], b"Mask", b"ImageMask", b"Decode"].iter().any(|k| image.has(k)) {
            return None;
        }
        let channels = channels(doc, get(b"ColorSpace")?)?;
        let filters = match get(b"Filter") {
            None => Vec::new(),
            Some(Object::Name(n)) => vec![n.as_slice()],
            Some(Object::Array(a)) => a.iter().map(|o| o.as_name().ok()).collect::<Option<_>>()?,
            Some(_) => return None,
        };
        let flate = match filters.as_slice() {
            [b"DCTDecode"] => return Some(Format::Jpeg),
            [] => false,
            [b"FlateDecode"] => true,
            _ => return None,
        };
        let int = |key: &[u8]| get(key)?.as_i64().ok();
        let (width, height) = (u32::try_from(int(b"Width")?).ok()?, u32::try_from(int(b"Height")?).ok()?);
        let row = u64::from(width) * u64::from(channels);
        if int(b"BitsPerComponent") != Some(8) || width == 0 || height == 0 || (row + 1) * u64::from(height) > MAX_ROWS_BYTES {
            return None;
        }
        let parms = match get(b"DecodeParms") {
            Some(Object::Array(a)) => a.first().and_then(|o| doc.dereference(o).ok()).and_then(|(_, o)| o.as_dict().ok()),
            Some(o) => o.as_dict().ok(),
            None => None,
        };
        let parm = |key: &[u8], default: i64| parms.and_then(|p| p.get(key).ok()).map_or(Some(default), |o| o.as_i64().ok());
        let rows = match parm(b"Predictor", 1)? {
            1 => Rows::Plain { flate },
            10..=15
                if flate && parm(b"Colors", 1)? == i64::from(channels) && parm(b"Columns", 1)? == i64::from(width) && parm(b"BitsPerComponent", 8)? == 8 =>
            {
                Rows::Filtered
            }
            _ => return None,
        };
        Some(Format::Png { width, height, channels, rows })
    }

    /// The image's MIME type and file. `None` when the data does not hold the image its dictionary describes.
    pub(crate) fn encode(self, data: &[u8]) -> Option<(&'static str, Vec<u8>)> {
        let Format::Png { width, height, channels, rows } = self else {
            return (crate::images::sniff(data) == Some("image/jpeg")).then(|| ("image/jpeg", data.to_vec()));
        };
        let row = width as usize * usize::from(channels);
        let size = row * height as usize;
        let idat = match rows {
            Rows::Filtered => {
                // Inflated only to see that it holds every row and nothing more, as an IDAT must.
                inflate(data, size + height as usize).filter(|rows| rows.len() == size + height as usize)?;
                data.to_vec()
            }
            Rows::Plain { flate } => {
                let pixels = if flate {
                    inflate(data, size)?
                } else {
                    data.to_vec()
                };
                let pixels = pixels.get(..size)?;
                let mut z = ZlibEncoder::new(Vec::with_capacity(size / 4), Compression::fast());
                for r in pixels.chunks_exact(row) {
                    z.write_all(&[0]).ok()?;
                    z.write_all(r).ok()?;
                }
                z.finish().ok()?
            }
        };
        Some(("image/png", png(width, height, channels, &idat)))
    }
}

fn channels(doc: &Document, space: &Object) -> Option<u8> {
    match space {
        Object::Name(n) if n == b"DeviceGray" => Some(1),
        Object::Name(n) if n == b"DeviceRGB" => Some(3),
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let profile = doc.dereference(a.get(1)?).ok()?.1.as_stream().ok()?;
            match profile.dict.get(b"N").ok()?.as_i64().ok()? {
                1 => Some(1),
                3 => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Inflated no further than a byte past `size`: the dictionary, not the stream, says how large the image is.
fn inflate(data: &[u8], size: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(size + 1);
    ZlibDecoder::new(data).take(size as u64 + 1).read_to_end(&mut out).ok()?;
    Some(out)
}

/// Signature, IHDR (8 bits, gray or RGB), IDAT, IEND.
fn png(width: u32, height: u32, channels: u8, idat: &[u8]) -> Vec<u8> {
    let colour = if channels == 1 {
        0
    } else {
        2
    };
    // Bit depth, colour type, then compression, filter and interlace methods 0.
    let ihdr = [&width.to_be_bytes()[..], &height.to_be_bytes(), &[8, colour, 0, 0, 0]].concat();
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    for (kind, data) in [(b"IHDR", &ihdr[..]), (b"IDAT", idat), (b"IEND", &[])] {
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend((data.len() as u32).to_be_bytes());
        out.extend(kind);
        out.extend(data);
        out.extend(crc.sum().to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pdf_extract::{Stream, StringFormat};

    fn name(s: &str) -> Object {
        Object::Name(s.as_bytes().to_vec())
    }

    fn dict(entries: &[(&str, Object)]) -> Dictionary {
        let mut d = Dictionary::new();
        for (k, v) in entries {
            d.set(*k, v.clone());
        }
        d
    }

    fn rgb(width: i64, height: i64, more: &[(&str, Object)]) -> Dictionary {
        let mut d = dict(&[
            ("Subtype", name("Image")),
            ("Width", Object::Integer(width)),
            ("Height", Object::Integer(height)),
            ("ColorSpace", name("DeviceRGB")),
            ("BitsPerComponent", Object::Integer(8)),
        ]);
        for (k, v) in more {
            d.set(*k, v.clone());
        }
        d
    }

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(data).unwrap();
        z.finish().unwrap()
    }

    /// Each chunk of a PNG with its CRC checked: (type, data).
    fn chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let mut out = Vec::new();
        let mut at = 8;
        while at < png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let (kind, data) = (&png[at + 4..at + 8], &png[at + 8..at + 8 + len]);
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(data);
            assert_eq!(png[at + 8 + len..at + 12 + len], crc.sum().to_be_bytes(), "CRC of {}", String::from_utf8_lossy(kind));
            out.push((String::from_utf8_lossy(kind).into_owned(), data.to_vec()));
            at += 12 + len;
        }
        out
    }

    fn inflated(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        ZlibDecoder::new(data).read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn rows_become_a_png() {
        let doc = Document::with_version("1.5");
        let pixels: Vec<u8> = (0..18).collect();
        let flate = rgb(3, 2, &[("Filter", name("FlateDecode"))]);
        let (mime, png) = Format::of(&doc, &flate).unwrap().encode(&deflate(&pixels)).unwrap();
        assert_eq!(mime, "image/png");
        let c = chunks(&png);
        assert_eq!(c.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(), ["IHDR", "IDAT", "IEND"]);
        assert_eq!(c[0].1, [0, 0, 0, 3, 0, 0, 0, 2, 8, 2, 0, 0, 0], "3x2, 8 bits, RGB");
        let rows = [&[0][..], &pixels[..9], &[0], &pixels[9..]].concat();
        assert_eq!(inflated(&c[1].1), rows, "each row after filter byte 0");

        let gray = dict(&[
            ("Width", Object::Integer(2)),
            ("Height", Object::Integer(2)),
            ("ColorSpace", name("DeviceGray")),
            ("BitsPerComponent", Object::Integer(8)),
        ]);
        let (_, png) = Format::of(&doc, &gray).unwrap().encode(&[1, 2, 3, 4]).unwrap();
        let c = chunks(&png);
        assert_eq!(c[0].1[9], 0, "gray");
        assert_eq!(inflated(&c[1].1), [0, 1, 2, 0, 3, 4], "unfiltered rows taken as stored");
    }

    #[test]
    fn a_png_predicted_stream_is_the_idat_as_stored() {
        let doc = Document::with_version("1.5");
        let parms = Object::Dictionary(dict(&[("Predictor", Object::Integer(15)), ("Colors", Object::Integer(3)), ("Columns", Object::Integer(2))]));
        let image = rgb(2, 2, &[("Filter", name("FlateDecode")), ("DecodeParms", parms)]);
        let stored = deflate(&[1, 9, 9, 9, 8, 8, 8, 2, 7, 7, 7, 6, 6, 6]);
        let (_, png) = Format::of(&doc, &image).unwrap().encode(&stored).unwrap();
        assert_eq!(chunks(&png)[1].1, stored);
        assert_eq!(Format::of(&doc, &image).unwrap().encode(&deflate(&[1, 9, 9, 9])), None, "fewer rows than the image has");
        assert_eq!(Format::of(&doc, &image).unwrap().encode(&deflate(&[0; 15])), None, "more rows than the image has");
    }

    #[test]
    fn a_dct_stream_is_the_jpeg_as_stored() {
        let doc = Document::with_version("1.5");
        let image = rgb(2, 2, &[("Filter", name("DCTDecode"))]);
        let jpeg = b"\xff\xd8\xff\xe0\0\x10JFIF".to_vec();
        assert_eq!(Format::of(&doc, &image).unwrap().encode(&jpeg), Some(("image/jpeg", jpeg)));
        assert_eq!(Format::of(&doc, &image).unwrap().encode(b"not a jpeg"), None);
    }

    #[test]
    fn a_broken_stream_gives_nothing() {
        let doc = Document::with_version("1.5");
        let format = Format::of(&doc, &rgb(3, 2, &[("Filter", name("FlateDecode"))])).unwrap();
        let mut broken = deflate(&(0..18).collect::<Vec<u8>>());
        broken[4] ^= 0xff;
        assert_eq!(format.encode(&broken), None);
        assert_eq!(format.encode(b""), None);
        assert_eq!(Format::of(&doc, &rgb(3, 2, &[])).unwrap().encode(&[0; 17]), None, "a byte short");
    }

    #[test]
    fn only_what_the_reader_can_show_has_a_format() {
        let mut doc = Document::with_version("1.5");
        let mut icc = |n| Object::Reference(doc.add_object(Stream::new(dict(&[("N", Object::Integer(n))]), vec![])));
        let (rgb_profile, cmyk_profile) = (icc(3), icc(4));
        let space = |s: Object| [("ColorSpace", s)];
        assert!(Format::of(&doc, &rgb(2, 2, &space(Object::Array(vec![name("ICCBased"), rgb_profile])))).is_some(), "ICCBased RGB");
        let flate = ("Filter", name("FlateDecode"));
        let parms =
            |columns| ("DecodeParms", Object::Dictionary(dict(&[("Predictor", Object::Integer(10)), ("Colors", Object::Integer(3)), ("Columns", columns)])));
        assert!(Format::of(&doc, &rgb(2, 2, &[flate.clone(), parms(Object::Integer(2))])).is_some());
        for (why, more) in [
            ("ICCBased CMYK", space(Object::Array(vec![name("ICCBased"), cmyk_profile])).to_vec()),
            ("CMYK", space(name("DeviceCMYK")).to_vec()),
            (
                "Indexed",
                space(Object::Array(vec![name("Indexed"), name("DeviceRGB"), Object::Integer(1), Object::String(vec![0; 6], StringFormat::Hexadecimal)]))
                    .to_vec(),
            ),
            ("16 bits", vec![("BitsPerComponent", Object::Integer(16))]),
            ("SMask", vec![("SMask", Object::Reference((1, 0)))]),
            ("Mask", vec![("Mask", Object::Array(vec![Object::Integer(0), Object::Integer(0)]))]),
            ("Decode", vec![("Decode", Object::Array(vec![Object::Integer(1), Object::Integer(0)]))]),
            ("LZW", vec![("Filter", name("LZWDecode"))]),
            ("two filters", vec![("Filter", Object::Array(vec![name("ASCII85Decode"), name("FlateDecode")]))]),
            ("TIFF predictor", vec![flate.clone(), ("DecodeParms", Object::Dictionary(dict(&[("Predictor", Object::Integer(2))])))]),
            ("other columns", vec![flate.clone(), parms(Object::Integer(3))]),
        ] {
            assert_eq!(Format::of(&doc, &rgb(2, 2, &more)), None, "{why}");
        }
        assert_eq!(Format::of(&doc, &rgb(20_000, 20_000, &[])), None, "larger than a figure");
        assert_eq!(Format::of(&doc, &rgb(0, 2, &[])), None);
    }
}
