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
const TIME: &str = "%Y-%m-%d %H:%M:%S%.3f";

/// `RUST_LOG` overrides the level (`RUST_LOG=lattice_core=debug,info`) for a one-off investigation.
pub fn init(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    subscribe(dir, EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))?;
    #[cfg(windows)]
    if let Err(e) = stderr_to_file(dir) {
        log::warn!("stderr goes nowhere, so a crash from low memory leaves no reason: {e}");
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A release build has no console, so a panic outside a job (which records it as its error)
        // left nothing behind.
        log::error!("{info}\n{}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));
    Ok(())
}

/// Without a console (a release build), stderr goes to `stderr.log` in the log folder. Rust reports a failed allocation
/// (`memory allocation of … bytes failed`) only on stderr and then aborts, past any panic hook, so a crash from low memory
/// left nothing behind. Each run starts with a line naming its pid, which the crash's Windows Error Reporting event names too.
#[cfg(windows)]
#[allow(unsafe_code, reason = "sets the process's stderr handle")]
fn stderr_to_file(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    use std::os::windows::io::{AsRawHandle, IntoRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};
    if !std::io::stderr().as_raw_handle().is_null() {
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("stderr.log"))?;
    writeln!(file, "{} started, pid {}", chrono::Local::now().format(TIME), std::process::id())?;
    // SAFETY: `into_raw_handle` gives up the open file's handle, so it stays open for the rest of the process.
    unsafe { SetStdHandle(STD_ERROR_HANDLE, HANDLE(file.into_raw_handle())) }?;
    Ok(())
}

fn subscribe(dir: &Path, filter: EnvFilter) -> Result<(), Box<dyn std::error::Error>> {
    // Written synchronously, not through tracing-appender's background thread: the lines just before a
    // crash are the ones worth having.
    let file =
        RollingFileAppender::builder().rotation(Rotation::DAILY).filename_prefix("lattice").filename_suffix("log").max_log_files(KEEP_DAYS).build(dir)?;
    let time = ChronoLocal::new(TIME.to_string());
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
        // Dated before and after the write, in case UTC midnight falls between them.
        let before = chrono::Utc::now().format("%Y-%m-%d").to_string();
        tracing::info_span!("job", id = 7, kind = %"translate").in_scope(|| log::warn!("provider failed"));
        let after = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let read = |date: &str| std::fs::read_to_string(dir.join(format!("lattice.{date}.log")));
        let text = read(&before).or_else(|_| read(&after));
        std::fs::remove_dir_all(&dir).unwrap();
        let text = text.unwrap();
        assert!(text.contains("job{id=7 kind=translate}") && text.contains("provider failed"), "{text}");
    }

    /// Rust reports a failed allocation only on stderr and then aborts, so the test runs in a child of this test binary.
    #[cfg(windows)]
    #[allow(unsafe_code, reason = "takes away the child's stderr handle")]
    #[test]
    fn an_allocation_failure_reaches_stderr_or_without_a_console_the_log_folder() {
        const NAME: &str = "logging::tests::an_allocation_failure_reaches_stderr_or_without_a_console_the_log_folder";
        const DIR: &str = "LATTICE_TEST_LOG_DIR";
        const NO_CONSOLE: &str = "LATTICE_TEST_NO_CONSOLE";
        if let Some(dir) = std::env::var_os(DIR) {
            if std::env::var_os(NO_CONSOLE).is_some() {
                use windows::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};
                // SAFETY: sets a process-wide setting to null, as a release build starts without a console.
                unsafe { SetStdHandle(STD_ERROR_HANDLE, windows::Win32::Foundation::HANDLE::default()) }.unwrap();
            }
            init(Path::new(&dir)).unwrap();
            std::alloc::handle_alloc_error(std::alloc::Layout::from_size_align(12345, 8).unwrap());
        }
        let failure = "memory allocation of 12345 bytes failed";
        for no_console in [false, true] {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("lattice-stderr-{}-{nanos}", std::process::id()));
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", NAME]).env(DIR, &dir).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
            if no_console {
                child.env(NO_CONSOLE, "1");
            }
            let child = child.spawn().unwrap();
            let pid = child.id();
            let out = child.wait_with_output().unwrap();
            let file = std::fs::read_to_string(dir.join("stderr.log"));
            std::fs::remove_dir_all(&dir).unwrap();
            assert!(!out.status.success(), "the child should have aborted");
            let stderr = String::from_utf8_lossy(&out.stderr);
            if no_console {
                let file = file.unwrap();
                assert!(file.contains(&format!("started, pid {pid}\n")) && file.contains(failure), "{file}");
            } else {
                assert!(stderr.contains(failure) && file.is_err(), "{stderr}");
            }
        }
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
