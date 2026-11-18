//! The icon in the notification area that keeps Lattice running with its windows closed: the job runners, the feed
//! updates and the server for the phone go on. It is there while the setting is on, and closing the main window keeps
//! the app only while it is there (`popout::on_window_event`), so the app never runs with nothing on screen to bring
//! it back.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, State};

use crate::browser::lock;
use crate::{App, err, popout, ui_text};

/// "on" keeps Lattice in the tray when the main window closes; absent means off.
const SETTING: &str = "close_to_tray";
const ID: &str = "lattice";
const OPEN: &str = "tray-open";
const QUIT: &str = "tray-quit";
/// What the sign-in registration passes, so that launch can start in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Held from reading the setting and the display language until the icon shows them, so two updates cannot land in
/// the other order. It is held while waiting for the main thread, which is safe only because no code on the main
/// thread takes it.
static UPDATING: Mutex<()> = Mutex::new(());

fn enabled(app: &App) -> Result<bool, String> {
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

/// The menu's text in the display language while the setting is on; none while it is off.
fn menu(app: &App) -> Result<Option<(&'static str, &'static str)>, String> {
    Ok(enabled(app)?.then(|| (ui_text(app, "Latticeを開く", "Open Lattice"), ui_text(app, "Latticeを終了", "Quit Lattice"))))
}

/// Puts the icon there at startup when the setting is on. Setup runs on the main thread, so this updates it directly,
/// without `UPDATING`.
pub fn start(handle: &AppHandle, app: &App) {
    if let Err(e) = menu(app).and_then(|menu| update(handle, menu).map_err(err)) {
        log::warn!("creating the tray icon: {e}");
    }
}

/// Puts the icon there with its menu in the display language while the setting is on, or removes it while off.
pub fn refresh(handle: &AppHandle, app: &App) -> Result<(), String> {
    let _updating = lock(&UPDATING);
    let menu = menu(app)?;
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

fn update(handle: &AppHandle, menu: Option<(&str, &str)>) -> tauri::Result<()> {
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
pub fn set_close_to_tray(app: State<'_, App>, handle: AppHandle, on: bool) -> Result<(), String> {
    app.store.set_setting(SETTING, on.then_some("on")).map_err(err)?;
    refresh(&handle, &app)
}
