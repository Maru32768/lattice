//! The unread count on the taskbar button (G46). Windows has no badge API, so the count is
//! drawn into the window's overlay icon; other desktops take the number.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::{App, err};

/// "off" hides the badge; absent means on.
const SETTING: &str = "taskbar_badge";
/// The app's accent (`--acc` in theme.css): reads on light and dark taskbars.
const FILL: [u8; 3] = [0x2f, 0x55, 0x97];

/// The last unread count the UI reported, shown again when the badge is switched back on.
#[derive(Default)]
pub struct Badge(Mutex<i64>);

fn enabled(app: &App) -> Result<bool, String> {
    Ok(app.store.setting(SETTING).map_err(err)?.as_deref() != Some("off"))
}

/// The text on the badge: nothing at 0, at most "99+".
fn label(count: i64) -> Option<String> {
    match count {
        ..=0 => None,
        1..=99 => Some(count.to_string()),
        _ => Some("99+".into()),
    }
}

/// 3×5 pixel glyphs, one row per entry, high bit on the left.
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [7, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 7],
        '2' => [7, 1, 7, 4, 7],
        '3' => [7, 1, 7, 1, 7],
        '4' => [5, 5, 7, 1, 1],
        '5' => [7, 4, 7, 1, 7],
        '6' => [7, 4, 7, 5, 7],
        '7' => [7, 1, 1, 1, 1],
        '8' => [7, 5, 7, 5, 7],
        '9' => [7, 5, 7, 1, 7],
        '+' => [0, 2, 7, 2, 0],
        _ => [0; 5],
    }
}

/// A `size`×`size` RGBA image: an accent disc with `text` in white, scaled by whole pixels so
/// the digits stay sharp.
fn draw(text: &str, size: u32) -> Vec<u8> {
    let mut px = vec![0u8; (size * size * 4) as usize];
    let r = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 + 0.5 - r).powi(2) + (y as f32 + 0.5 - r).powi(2)).sqrt();
            let alpha = (r - d + 0.5).clamp(0.0, 1.0);
            let i = ((y * size + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[FILL[0], FILL[1], FILL[2], (alpha * 255.0) as u8]);
        }
    }
    let s = (size / 16).max(1);
    let chars: Vec<char> = text.chars().collect();
    let width = (chars.len() as u32 * 4).saturating_sub(1) * s;
    let (left, top) = (size.saturating_sub(width) / 2, size.saturating_sub(5 * s) / 2);
    for (n, c) in chars.into_iter().enumerate() {
        for (row, bits) in glyph(c).into_iter().enumerate() {
            for col in 0..3 {
                if bits & (4 >> col) == 0 {
                    continue;
                }
                for (dy, dx) in (0..s).flat_map(|dy| (0..s).map(move |dx| (dy, dx))) {
                    let (x, y) = (left + (n as u32 * 4 + col) * s + dx, top + row as u32 * s + dy);
                    if x < size && y < size {
                        let i = ((y * size + x) * 4) as usize;
                        px[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    px
}

fn show(handle: &AppHandle, count: i64) -> Result<(), String> {
    let Some(window) = handle.get_window("main") else { return Ok(()) };
    #[cfg(windows)]
    {
        // Overlay icons are small-icon sized: 16 px at 100 %.
        let size = (16.0 * window.scale_factor().unwrap_or(1.0)).round() as u32;
        let icon = label(count).map(|text| tauri::image::Image::new_owned(draw(&text, size), size, size));
        window.set_overlay_icon(icon).map_err(err)
    }
    #[cfg(not(windows))]
    {
        let _ = (label, draw); // only the Windows overlay draws the text
        window.set_badge_count((count > 0).then_some(count)).map_err(err)
    }
}

/// The UI reports the unread count whenever it changes (debounced).
#[tauri::command(async)]
pub fn set_unread_badge(app: State<'_, App>, badge: State<'_, Badge>, handle: AppHandle, count: i64) -> Result<(), String> {
    *badge.0.lock().unwrap_or_else(|e| e.into_inner()) = count;
    show(&handle, if enabled(&app)? { count } else { 0 })
}

#[tauri::command(async)]
pub fn get_taskbar_badge(app: State<'_, App>) -> Result<bool, String> {
    enabled(&app)
}

#[tauri::command(async)]
pub fn set_taskbar_badge(app: State<'_, App>, badge: State<'_, Badge>, handle: AppHandle, on: bool) -> Result<(), String> {
    app.store.set_setting(SETTING, (!on).then_some("off")).map_err(err)?;
    let count = *badge.0.lock().unwrap_or_else(|e| e.into_inner());
    show(&handle, if on { count } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_cap_at_99_plus() {
        assert_eq!([0, -3, 1, 99, 100, 5000].map(label), [None, None, Some("1".into()), Some("99".into()), Some("99+".into()), Some("99+".into())]);
    }

    #[test]
    fn draws_white_digits_on_an_accent_disc() {
        let at = |px: &[u8], size: u32, x: u32, y: u32| px[((y * size + x) * 4) as usize..][..4].to_vec();
        let px = draw("1", 16);
        assert_eq!(px.len(), 16 * 16 * 4);
        assert_eq!(at(&px, 16, 0, 0)[3], 0, "outside the disc is transparent");
        assert_eq!(at(&px, 16, 8, 2), [0x2f, 0x55, 0x97, 255]);
        // "1" (3 px wide) is centred: columns 6..9, rows 5..10; its stem is the middle column.
        assert_eq!(at(&px, 16, 7, 9), [255; 4]);
        assert_eq!(at(&px, 16, 6, 6), [255; 4], "the 1's flag");
        assert_eq!(at(&px, 16, 6, 7)[0], 0x2f);
        // At 200 % the glyph pixels double and "99+" still fits inside the disc.
        let big = draw("99+", 32);
        assert_eq!(at(&big, 32, 5, 11), [255; 4], "first column of the first 9");
        assert_eq!(at(&big, 32, 4, 11)[0], 0x2f);
    }
}
