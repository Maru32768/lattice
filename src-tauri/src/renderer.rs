//! Background renderer for JS-built pages (core `render` jobs). One job at a time, each in a
//! fresh child webview of the main window that is closed afterwards, so no page or script
//! outlives its job and no blank page is ever needed (`on_navigation` allows only http(s)).
//! It sits outside the window's client area: never seen, but laid out like a real viewport.
//! Same trust boundary as the visible browser: overlay script only, `browser-overlay`
//! capability, no pop-ups, and `overlay_config` keeps translation off here.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use lattice_core::render;
use lattice_core::store::Store;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use tokio::sync::{Notify, oneshot};

use crate::browser::{self, Browser, OVERLAY_JS, RENDER_LABEL, http_url, is_http, lock};

const LOAD_TIMEOUT: Duration = Duration::from_secs(12);
/// The overlay snapshots once the DOM has had no mutations for 1.5 s, or after 6 s regardless.
const SETTLE_MS: (u32, u32) = (1_500, 6_000);
/// Longer than the settle cap; load + snapshot stay under ~20 s per page.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(8);
const OFFSCREEN: (f64, f64) = (-20_000.0, -20_000.0);
const VIEWPORT: (f64, f64) = (1280.0, 900.0);
const IDLE_POLL: Duration = Duration::from_secs(30);

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub async fn run(app: AppHandle, store: Arc<Store>, embed_model: String, wake: Arc<Notify>, on_change: impl Fn(i64) + Send + Sync) {
    loop {
        match run_next(&app, &store, &embed_model, &on_change).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => log::error!("render runner: {e}"),
        }
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(IDLE_POLL) => {}
        }
    }
}

async fn run_next(app: &AppHandle, store: &Store, embed_model: &str, on_change: &impl Fn(i64)) -> Result<bool, String> {
    let Some(job) = store.claim_next_job(render::JOBS).map_err(err)? else { return Ok(false) };
    let id = job.article_id.unwrap_or_default();
    on_change(id);
    // Render failures are recorded on the article; only storage errors fail (and retry) the job.
    let result = match store.article_url(id).map_err(err) {
        Ok(Some(url)) => {
            let page = render_page(app, &url).await;
            if let Err(e) = &page {
                log::warn!("render article {id} ({url}): {e}");
            }
            render::finish(store, id, page, embed_model).map(drop)
        }
        Ok(None) => Err("article no longer exists".into()),
        Err(e) => Err(e),
    };
    store.finish_job(job.id, result.err().as_deref()).map_err(err)?;
    on_change(id);
    Ok(true)
}

/// Loads `url` in the hidden webview and returns its rendered DOM as (final URL, html).
async fn render_page(app: &AppHandle, url: &str) -> Result<(String, String), String> {
    let url = http_url(url)?;
    if let Some(old) = app.get_webview(RENDER_LABEL) {
        let _ = old.close(); // left over if a previous job's close failed
    }
    let window = app.get_window("main").ok_or("main window missing")?;
    let (tx, loaded) = oneshot::channel();
    let tx = Mutex::new(Some(tx));
    // shortcut: pages may still play audio while hidden; mute through the WebView2 COM API if that bothers.
    let builder = WebviewBuilder::new(RENDER_LABEL, WebviewUrl::External(url))
        .initialization_script(OVERLAY_JS)
        .on_navigation(is_http)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(move |_, p| {
            if matches!(p.event(), PageLoadEvent::Finished) {
                if let Some(tx) = lock(&tx).take() {
                    let _ = tx.send(());
                }
            }
        })
        .focused(false);
    let wv = window
        .add_child(builder, LogicalPosition::new(OFFSCREEN.0, OFFSCREEN.1), LogicalSize::new(VIEWPORT.0, VIEWPORT.1))
        .map_err(err)?;
    let result = async {
        match tokio::time::timeout(LOAD_TIMEOUT, loaded).await {
            Ok(Ok(())) => {}
            _ => return Err("ページの読み込みが終わりませんでした".to_string()),
        }
        let browser = app.state::<Browser>();
        browser::snapshot_of(&wv, &browser, Some(SETTLE_MS), SNAPSHOT_TIMEOUT).await.ok_or_else(|| "ページから DOM を取得できませんでした".to_string())
    }
    .await;
    if let Err(e) = wv.close() {
        log::warn!("closing the render webview: {e}");
    }
    result
}
