//! Moving the data folder (G38). Resolution is shared with the CLI in `lattice_core::location`.

use std::io;
use std::path::{Path, PathBuf};

pub use lattice_core::location::*;
use lattice_core::msg;
use lattice_core::store::Store;

/// Copied when the user moves the data folder; logs and the WebView2 profile stay behind.
const DATA_DIRS: [&str; 3] = ["backups", "exports", "models"];

pub fn log_dir(loc: &Location, local_data_dir: impl FnOnce() -> tauri::Result<PathBuf>) -> tauri::Result<PathBuf> {
    match loc.log_dir() {
        Some(path) => Ok(path),
        None => Ok(local_data_dir()?.join(APP_DATA_FOLDER).join("logs")),
    }
}

/// Refuses the folder in use and folders inside it (copying would recurse into itself).
pub fn check_target(current: &Path, target: &Path) -> Result<(), String> {
    if target == current {
        return Err(msg!("location.same"));
    }
    if target.starts_with(current) {
        return Err(msg!("location.inside"));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// Copies the database (a consistent copy of the open one, API keys included) and the data
/// folders into `to`. Nothing in `from` is changed or deleted.
pub fn copy_data(store: &Store, from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    store.copy_to(&to.join(DB_FILE)).map_err(|e| msg!("location.copyDbFailed", error = e.to_string()))?;
    for d in DATA_DIRS {
        if from.join(d).is_dir() {
            copy_dir(&from.join(d), &to.join(d)).map_err(|e| msg!("location.copyFailed", name = d, error = e.to_string()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_logs_stay_in_the_profile_when_the_library_moves() {
        let local_root = PathBuf::from(r"C:\Users\me\AppData\Local");
        for kind in [Kind::Default, Kind::Custom] {
            let loc = Location { kind, dir: PathBuf::from(r"D:\Library"), warning: None };
            assert_eq!(log_dir(&loc, || Ok(local_root.clone())).unwrap(), local_root.join(APP_DATA_FOLDER).join("logs"));
        }
    }

    #[test]
    fn log_folder_name_matches_the_build_profile() {
        let loc = Location { kind: Kind::Default, dir: PathBuf::from("library"), warning: None };
        let profile = if cfg!(debug_assertions) {
            "Lattice Dev"
        } else {
            "Lattice"
        };
        assert_eq!(log_dir(&loc, || Ok(PathBuf::from("local"))).unwrap(), PathBuf::from("local").join(profile).join("logs"));
    }

    #[test]
    fn portable_logs_do_not_need_an_os_data_folder() {
        let loc = Location { kind: Kind::Portable, dir: PathBuf::from("portable/data"), warning: None };
        let mut resolved = false;
        let path = log_dir(&loc, || {
            resolved = true;
            Err(std::io::Error::other("no local data folder").into())
        })
        .unwrap();
        assert_eq!(path, loc.dir.join("logs"));
        assert!(!resolved);
    }

    #[test]
    fn installed_logs_report_os_data_folder_errors() {
        let loc = Location { kind: Kind::Default, dir: PathBuf::from("library"), warning: None };
        let error = log_dir(&loc, || Err(std::io::Error::other("no local data folder").into())).unwrap_err();
        assert!(error.to_string().contains("no local data folder"));
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-location-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_release_identifier_matches_the_bundle_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], RELEASE_APP_IDENTIFIER);
    }

    #[test]
    fn targets_inside_the_current_folder_are_refused() {
        let cur = Path::new(r"C:\Users\me\AppData\Roaming\dev.lattice.app");
        assert!(check_target(cur, cur).is_err());
        assert!(check_target(cur, &cur.join("sub")).is_err());
        assert!(check_target(cur, Path::new(r"D:\Lattice")).is_ok());
        assert!(check_target(cur, Path::new(r"C:\Users\me\AppData\Roaming")).is_ok());
    }

    #[test]
    fn copy_data_copies_the_database_and_folders_and_keeps_the_source() {
        let (from, to) = (temp("from"), temp("to").join("new"));
        let store = Store::open(&from.join(DB_FILE)).unwrap();
        store.set_setting("secret.openai_api_key", Some("sk-test")).unwrap();
        std::fs::create_dir_all(from.join("models").join("e5")).unwrap();
        std::fs::write(from.join("models").join("e5").join("model.onnx"), "weights").unwrap();
        std::fs::write(from.join("unrelated.txt"), "x").unwrap();
        copy_data(&store, &from, &to).unwrap();
        assert_eq!(Store::open(&to.join(DB_FILE)).unwrap().setting("secret.openai_api_key").unwrap().as_deref(), Some("sk-test"));
        assert_eq!(std::fs::read_to_string(to.join("models").join("e5").join("model.onnx")).unwrap(), "weights");
        assert!(!to.join("unrelated.txt").exists() && !to.join("backups").exists());
        assert!(from.join(DB_FILE).exists() && from.join("models").exists());
        drop(store);
        let _ = std::fs::remove_dir_all(&from);
        let _ = std::fs::remove_dir_all(to.parent().unwrap());
    }
}
