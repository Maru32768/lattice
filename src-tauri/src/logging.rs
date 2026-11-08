//! The app's log: one file a day in the log folder, the last `KEEP_DAYS` kept, in local time.
//! `log::` calls (ours and our dependencies') reach it through tracing-log, so a line written while
//! a job runs carries that job's span (`job{id=… kind=… article=…}`).

use std::path::Path;

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::time::ChronoLocal;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{EnvFilter, fmt};

const KEEP_DAYS: usize = 14;

/// `RUST_LOG` overrides the level (`RUST_LOG=lattice_core=debug,info`) for a one-off investigation.
pub fn init(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Written synchronously, not through tracing-appender's background thread: the lines just before a
    // crash are the ones worth having.
    let file =
        RollingFileAppender::builder().rotation(Rotation::DAILY).filename_prefix("lattice").filename_suffix("log").max_log_files(KEEP_DAYS).build(dir)?;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let time = ChronoLocal::new("%Y-%m-%d %H:%M:%S%.3f".to_string());
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(file).with_ansi(false).with_timer(time.clone()))
        .with(fmt::layer().with_timer(time))
        .try_init()?;
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A release build has no console, so a panic outside a job (which records it as its error)
        // left nothing behind.
        log::error!("{info}\n{}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));
    Ok(())
}
