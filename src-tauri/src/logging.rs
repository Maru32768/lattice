//! The app's log: one file a day in the log folder, the last `KEEP_DAYS` kept. Lines carry local
//! time, but tracing-appender rolls and names the files by the UTC date (it has no local option).
//! `log::` calls (ours and our dependencies') reach it through tracing-log, so a line written while
//! a job runs carries that job's span (`job{id=… kind=… article=…}`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::time::ChronoLocal;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{EnvFilter, fmt};

const KEEP_DAYS: usize = 14;
const TIME: &str = "%Y-%m-%d %H:%M:%S%.3f";
/// Lines one run may add to `out-of-memory.log`: a failed `try_reserve` is written too, and a page could set off one
/// after another.
const MAX_FAILURES: usize = 100;

static OUT_OF_MEMORY: OnceLock<File> = OnceLock::new();
static FAILURES: AtomicUsize = AtomicUsize::new(0);

/// `RUST_LOG` overrides the level (`RUST_LOG=lattice_core=debug,info`) for a one-off investigation.
pub fn init(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    subscribe(dir, EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))?;
    if let Err(e) = open_out_of_memory_log(dir) {
        log::warn!("no out-of-memory.log, so a crash from low memory leaves no reason: {e}");
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

/// Each run starts with a line naming its pid, in hex as well: Windows Error Reporting's crash event gives it that way.
fn open_out_of_memory_log(dir: &Path) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("out-of-memory.log"))?;
    let pid = std::process::id();
    writeln!(file, "{} started, pid {pid} (0x{pid:X})", chrono::Local::now().format(TIME))?;
    let _ = OUT_OF_MEMORY.set(file);
    Ok(())
}

/// The system allocator, writing a line to `out-of-memory.log` when an allocation fails. Rust reports that only on
/// stderr before it aborts, past any panic hook, and a release build has no console, so a crash from low memory left
/// nothing behind. Sending stderr itself to the file would not do: Tauri prints there whatever a page sends with a wrong
/// invoke key, as much as the page likes, beside the real key.
struct Allocator;

#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

// SAFETY: every call goes to the system allocator unchanged; only its result is looked at.
#[allow(unsafe_code, reason = "a global allocator")]
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract, passed on as it is.
        failed_if_null(unsafe { System.alloc(layout) }, layout.size())
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract, passed on as it is.
        failed_if_null(unsafe { System.alloc_zeroed(layout) }, layout.size())
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller's contract, passed on as it is.
        failed_if_null(unsafe { System.realloc(ptr, layout, new_size) }, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller's contract, passed on as it is.
        unsafe { System.dealloc(ptr, layout) }
    }
}

/// Writes without allocating: the line is formatted into a buffer on the stack.
fn failed_if_null(ptr: *mut u8, size: usize) -> *mut u8 {
    if ptr.is_null()
        && let Some(mut file) = OUT_OF_MEMORY.get()
        && FAILURES.fetch_add(1, Ordering::Relaxed) < MAX_FAILURES
    {
        let mut line = [0u8; 64];
        let mut rest = &mut line[..];
        let _ = writeln!(rest, "memory allocation of {size} bytes failed");
        let written = 64 - rest.len();
        let _ = file.write_all(&line[..written]);
    }
    ptr
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

    /// Rust ends the process after a failed allocation, so each case runs in a child of this test binary.
    #[cfg(windows)]
    #[test]
    fn a_failed_allocation_is_added_to_out_of_memory_log_and_without_that_file_the_app_still_starts() {
        const NAME: &str = "logging::tests::a_failed_allocation_is_added_to_out_of_memory_log_and_without_that_file_the_app_still_starts";
        const DIR: &str = "LATTICE_TEST_LOG_DIR";
        // How Rust's abort ends a process on Windows. A panic in the child, as from `init` failing, ends it with 101.
        const ABORTED: i32 = 0xC000_0409_u32 as i32;
        if let Some(dir) = std::env::var_os(DIR) {
            init(Path::new(&dir)).unwrap();
            // More than any computer has, so the system allocator returns null: through `alloc`, `realloc` and
            // `alloc_zeroed` in turn, at sizes that tell them apart. The last one ends the process, as Rust does.
            let _ = Vec::<u8>::new().try_reserve(isize::MAX as usize);
            let _ = vec![0u8; 1].try_reserve_exact(isize::MAX as usize - 2);
            std::hint::black_box(vec![0u8; isize::MAX as usize - 2]);
            return;
        }
        let run = |prepare: &dyn Fn(&Path)| {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("lattice-oom-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            prepare(&dir);
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", NAME]).env(DIR, &dir).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let mut child = child.spawn().unwrap();
            let pid = child.id();
            let status = child.wait().unwrap();
            let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
            let daily = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|n| n.starts_with("lattice."));
            let (file, daily) = (read("out-of-memory.log"), daily.map(|n| read(&n)).unwrap_or_default());
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!(status.code(), Some(ABORTED), "the child should have got as far as the allocation\n{file}\n{daily}");
            (pid, file, daily)
        };

        let failures = [0, 1, 2].map(|less| format!("memory allocation of {} bytes failed\n", isize::MAX as usize - less)).concat();
        let expected = |pid: u32| format!(" started, pid {pid} (0x{pid:X})\n{failures}");

        let (pid, file, _) = run(&|_| ());
        assert!(file.ends_with(&expected(pid)) && file.lines().count() == 4, "{file}");

        // An earlier run's lines stay, as a crash is followed by a restart.
        let (pid, file, _) = run(&|dir| std::fs::write(dir.join("out-of-memory.log"), "earlier run\n").unwrap());
        assert!(file.starts_with("earlier run\n") && file.ends_with(&expected(pid)), "{file}");

        let (_, _, daily) = run(&|dir| std::fs::create_dir(dir.join("out-of-memory.log")).unwrap());
        assert!(daily.contains("no out-of-memory.log"), "{daily}");
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
