//! The icon in the notification area that keeps Lattice running with its windows closed: the job runners, the feed
//! updates and the server for the phone go on. It is there while the setting is on and the main window's UI has sent
//! the menu's text, and closing the main window keeps the app only while it is there (`popout::on_window_event`), so
//! the app never runs with nothing on screen to bring it back.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, State};

use crate::browser::lock;
use crate::{App, err, popout};

/// "on" keeps Lattice in the tray when the main window closes; absent means off.
const SETTING: &str = "close_to_tray";
const ID: &str = "lattice";
const OPEN: &str = "tray-open";
const QUIT: &str = "tray-quit";
/// What the sign-in registration passes, so that launch can start in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";

/// The menu's text in the display language (open, quit), from the main window's UI; none until it sends it.
#[derive(Default)]
pub struct TrayMenu(Mutex<Option<(String, String)>>);

pub fn enabled(app: &App) -> Result<bool, String> {
    Ok(app.store.setting(SETTING).map_err(err)?.as_deref() == Some("on"))
}

/// Whether the icon is there to bring the windows back.
pub fn shown(handle: &AppHandle) -> bool {
    handle.tray_by_id(ID).is_some()
}

pub fn launched_at_sign_in() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

/// Registered once on the app: a menu handler given to each new icon stays after the icon is removed.
pub fn on_menu_event(handle: &AppHandle, e: MenuEvent) {
    match e.id().as_ref() {
        OPEN => popout::bring_back(handle),
        QUIT => popout::quit(handle),
        _ => {}
    }
}

/// Puts the icon there with `menu` as its menu's text, or removes it for none. The callers hold the `TrayMenu` lock
/// while this waits for the main thread, which is safe only because no code on the main thread takes that lock.
fn apply(handle: &AppHandle, menu: Option<(String, String)>) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let on_main = handle.clone();
    // The icon's reference count is not atomic, and its hidden window can be destroyed only by the thread that made it.
    handle
        .run_on_main_thread(move || {
            let _ = tx.send(update(&on_main, menu));
        })
        .map_err(err)?;
    rx.recv().map_err(err)?.map_err(err)
}

fn update(handle: &AppHandle, menu: Option<(String, String)>) -> tauri::Result<()> {
    let Some((open, quit)) = menu else {
        handle.remove_tray_by_id(ID);
        return Ok(());
    };
    let open = MenuItem::with_id(handle, OPEN, open, true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, QUIT, quit, true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &quit])?;
    if let Some(icon) = handle.tray_by_id(ID) {
        return icon.set_menu(Some(menu));
    }
    let mut icon = TrayIconBuilder::with_id(ID).menu(&menu).tooltip("Lattice").show_menu_on_left_click(false).on_tray_icon_event(|icon, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            popout::bring_back(icon.app_handle());
        }
    });
    if let Some(image) = handle.default_window_icon() {
        icon = icon.icon(image.clone());
    }
    icon.build(handle).map(drop)
}

#[tauri::command(async)]
pub fn get_close_to_tray(app: State<'_, App>) -> Result<bool, String> {
    enabled(&app)
}

#[tauri::command(async)]
pub fn set_close_to_tray(app: State<'_, App>, menu: State<'_, TrayMenu>, handle: AppHandle, on: bool) -> Result<(), String> {
    let text = lock(&menu.0);
    app.store.set_setting(SETTING, on.then_some("on")).map_err(err)?;
    apply(&handle, text.clone().filter(|_| on))
}

/// The main window's UI sends the menu's text at startup and whenever the display language changes: the menu is native.
#[tauri::command(async)]
pub fn set_tray_menu(app: State<'_, App>, menu: State<'_, TrayMenu>, handle: AppHandle, open: String, quit: String) -> Result<(), String> {
    let mut text = lock(&menu.0);
    *text = Some((open, quit));
    let on = enabled(&app)?;
    apply(&handle, text.clone().filter(|_| on))
}
