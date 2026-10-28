//! Local database backups (`app_data/backups/lattice-<unix secs>.db`), kept to the newest N
//! generations. Retention is by count, not age, so nothing disappears while the app is unused.

use std::path::Path;

use serde::Serialize;

use crate::msg;
use crate::store::Store;
use ts_rs::TS;

const KEEP: &str = "backup.keep_generations";
pub const DEFAULT_KEEP: u64 = 30;
const MAX_KEEP: u64 = 1000;

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct LocalBackup {
    pub path: String,
    /// Set when the backup was written but pruning older ones failed.
    pub warning: Option<String>,
}

pub fn check_keep(n: u64) -> Result<(), String> {
    if (1..=MAX_KEEP).contains(&n) {
        Ok(())
    } else {
        Err(msg!("backup.keepRange", max = MAX_KEEP))
    }
}

pub fn keep_generations(store: &Store) -> Result<u64, String> {
    Ok(store.setting(KEEP).map_err(|e| e.to_string())?.and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_KEEP))
}

pub fn set_keep_generations(store: &Store, n: u64) -> Result<(), String> {
    check_keep(n)?;
    store.set_setting(KEEP, Some(&n.to_string())).map_err(|e| e.to_string())
}

/// Everything beyond the newest `keep` generations, `current` counting as one and never returned.
pub(crate) fn stale<T: Ord>(mut items: Vec<T>, keep: u64, current: &T) -> Vec<T> {
    items.retain(|i| i != current);
    items.sort_by(|a, b| b.cmp(a));
    items.into_iter().skip(keep.saturating_sub(1) as usize).collect()
}

/// Writes `dir/lattice-<now>.db` from the database at `db` on a connection of its own (the app's
/// store stays free for the copy), then deletes older local backups beyond `keep`.
pub fn backup_local(db: &Path, dir: &Path, now: u64, keep: u64) -> Result<LocalBackup, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = format!("lattice-{now}.db");
    let path = dir.join(&name);
    Store::open(db).and_then(|s| s.backup_to(&path)).map_err(|e| e.to_string())?;
    log::info!("backup written to {}", path.display());
    let warning = match prune(dir, keep, (now, name)).map_err(|e| e.to_string()) {
        Ok(n) => {
            if n > 0 {
                log::info!("deleted {n} old local backups");
            }
            None
        }
        Err(e) => {
            log::warn!("pruning local backups failed: {e}");
            Some(msg!("backup.pruneFailed", error = e.to_string()))
        }
    };
    Ok(LocalBackup { path: path.display().to_string(), warning })
}

/// `lattice-<digits>.db` only, so R2's `r2-upload-*` temp files and anything else are never touched.
fn stamp(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("lattice-")?.strip_suffix(".db")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn prune(dir: &Path, keep: u64, current: (u64, String)) -> std::io::Result<usize> {
    let mut found = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(t) = stamp(&name)
            && e.file_type()?.is_file()
        {
            found.push((t, name));
        }
    }
    let old = stale(found, keep, &current);
    for (_, name) in &old {
        std::fs::remove_file(dir.join(name))?;
    }
    Ok(old.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_keeps_newest_and_current() {
        assert_eq!(stale(vec![1, 5, 3, 4, 2], 3, &5), vec![2, 1]);
        assert_eq!(stale(vec![1, 2, 3], 1, &3), vec![2, 1]);
        // The current item is kept even if a clock skew makes it look older.
        assert_eq!(stale(vec![10, 20, 5], 2, &5), vec![10]);
        assert_eq!(stale(vec![1, 2], 5, &2), Vec::<i32>::new());
        assert_eq!(stale(Vec::new(), 1, &7), Vec::<i32>::new());
    }

    #[test]
    fn local_names() {
        assert_eq!(stamp("lattice-1700000000.db"), Some(1_700_000_000));
        for bad in
            ["lattice-.db", "lattice-12a.db", "lattice-1.db-journal", "r2-upload-1.db", "r2-upload-1.db.gz", "lattice.db", "lattice-1.db.gz", "lattice--1.db"]
        {
            assert_eq!(stamp(bad), None, "{bad}");
        }
    }

    #[test]
    fn backup_prunes_only_old_backups() {
        let dir = std::env::temp_dir().join(format!("lattice-prune-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lattice-5.db")).unwrap(); // a directory, not a backup
        // Different digit counts: must sort numerically, not by name.
        for name in ["lattice-9.db", "lattice-10.db", "lattice-11.db", "r2-upload-1.db", "r2-upload-1.db.gz", "notes.txt", "lattice-1.db-journal"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let s = Store::open_in_memory().unwrap();
        assert_eq!(keep_generations(&s).unwrap(), DEFAULT_KEEP);
        assert!(set_keep_generations(&s, 0).is_err());
        set_keep_generations(&s, 2).unwrap();
        assert_eq!(keep_generations(&s).unwrap(), 2);
        // The source database lives outside `dir`, whose listing is asserted below.
        let src_dir = std::env::temp_dir().join(format!("lattice-prune-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let src = src_dir.join("lattice.db");
        drop(Store::open(&src).unwrap());
        let b = backup_local(&src, &dir, 12, 2).unwrap();
        assert!(b.warning.is_none(), "{:?}", b.warning);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["lattice-1.db-journal", "lattice-11.db", "lattice-12.db", "lattice-5.db", "notes.txt", "r2-upload-1.db", "r2-upload-1.db.gz"]);
        assert!(Store::open(&dir.join("lattice-12.db")).is_ok(), "the copy opens");
        std::fs::remove_dir_all(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&src_dir);
    }
}
