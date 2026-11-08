//! The app's log: one file a day in the log folder, the last `KEEP_DAYS` kept. Lines carry local
//! time, but tracing-appender rolls and names the files by the UTC date (it has no local option).
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
    subscribe(dir, EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))?;
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A release build has no console, so a panic outside a job (which records it as its error)
        // left nothing behind.
        log::error!("{info}\n{}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));
    Ok(())
}

fn subscribe(dir: &Path, filter: EnvFilter) -> Result<(), Box<dyn std::error::Error>> {
    // Written synchronously, not through tracing-appender's background thread: the lines just before a
    // crash are the ones worth having.
    let file =
        RollingFileAppender::builder().rotation(Rotation::DAILY).filename_prefix("lattice").filename_suffix("log").max_log_files(KEEP_DAYS).build(dir)?;
    let time = ChronoLocal::new("%Y-%m-%d %H:%M:%S%.3f".to_string());
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(file).with_ansi(false).with_timer(time.clone()))
        .with(fmt::layer().with_timer(time))
        .try_init()?;
    Ok(())
}

/// A UI error as one record: every line break a viewer shows (`\r` alone too) becomes an indented
/// continuation, so a message quoting page text cannot pass for a line of its own. Longer messages
/// are cut at 4000 characters, before the indenting, and end with "…".
pub fn ui_record(message: &str) -> String {
    let mut cut: String = message.chars().take(4000).collect();
    if cut.len() < message.len() {
        cut.push('…');
    }
    cut.replace("\r\n", "\n").replace(['\r', '\u{85}', '\u{2028}', '\u{2029}'], "\n").replace('\n', "\n    ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The only test that installs the global subscriber: a second one in this process would fail.
    #[test]
    fn log_calls_reach_the_file_named_for_the_utc_date_with_the_job_span() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("lattice-log-{}-{nanos}", std::process::id()));
        subscribe(&dir, EnvFilter::new("info")).unwrap();
        tracing::info_span!("job", id = 7, kind = %"translate").in_scope(|| log::warn!("provider failed"));
        let utc_date = chrono::Utc::now().format("%Y-%m-%d");
        let text = std::fs::read_to_string(dir.join(format!("lattice.{utc_date}.log")));
        std::fs::remove_dir_all(&dir).unwrap();
        let text = text.unwrap();
        assert!(text.contains("job{id=7 kind=translate}") && text.contains("provider failed"), "{text}");
    }

    #[test]
    fn a_ui_error_stays_one_record() {
        assert_eq!(ui_record("Error: x\n    at f"), "Error: x\n        at f");
        for forged in ["a\rERROR job", "a\r\nERROR job", "a\u{2028}ERROR job", "a\u{85}ERROR job"] {
            assert_eq!(ui_record(forged), "a\n    ERROR job", "{forged:?}");
        }
        assert_eq!(ui_record(&"x".repeat(4001)), format!("{}…", "x".repeat(4000)));
        assert_eq!(ui_record(&"x".repeat(4000)), "x".repeat(4000));
    }
}
