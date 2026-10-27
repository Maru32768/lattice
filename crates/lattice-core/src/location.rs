//! Where Lattice keeps its data. In order: a `portable` marker next to the exe puts everything
//! in `<exe dir>/data`; else a bootstrap file in the default folder names a folder the user
//! chose (the database cannot hold its own location); else the default app data folder.
//! Shared by the app and the CLI, so both open the same database.

use std::io;
use std::path::{Path, PathBuf};

use crate::msg;
use ts_rs::TS;

pub const PORTABLE_MARKERS: [&str; 2] = ["portable", "lattice.portable"];
/// In the default app data folder, whichever folder is in use.
pub const BOOTSTRAP_FILE: &str = "data-location.json";
pub const DB_FILE: &str = "lattice.db";
/// The installed app's Tauri identifier (`tauri.conf.json`).
pub const RELEASE_APP_IDENTIFIER: &str = "dev.lattice.app";
/// Debug builds of the app and CLI share a separate default data folder.
pub const APP_IDENTIFIER: &str = if cfg!(debug_assertions) {
    "dev.lattice.app.debug"
} else {
    RELEASE_APP_IDENTIFIER
};
pub const APP_DATA_FOLDER: &str = if cfg!(debug_assertions) {
    "Lattice Dev"
} else {
    "Lattice"
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, TS)]
#[ts(export, rename = "LocationKind")]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Default,
    Custom,
    Portable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub kind: Kind,
    pub dir: PathBuf,
    /// Why the chosen folder is not in use (the app then runs from the default folder).
    pub warning: Option<String>,
}

impl Location {
    /// Portable mode keeps the WebView2 profile (cookies, cache) with the data too.
    pub fn webview_dir(&self) -> Option<PathBuf> {
        (self.kind == Kind::Portable).then(|| self.dir.join("webview"))
    }

    pub fn log_dir(&self) -> Option<PathBuf> {
        (self.kind == Kind::Portable).then(|| self.dir.join("logs"))
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Bootstrap {
    data_dir: PathBuf,
}

/// User-facing storage is separate from the stable Tauri application identifier.
pub fn default_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(APP_DATA_FOLDER))
}

/// `bootstrap`: the bootstrap file's text, `None` when there is no such file.
pub fn resolve(portable: bool, exe_dir: &Path, default_dir: &Path, bootstrap: Option<io::Result<String>>) -> Location {
    let default = |warning| Location { kind: Kind::Default, dir: default_dir.to_path_buf(), warning };
    if portable {
        return Location { kind: Kind::Portable, dir: exe_dir.join("data"), warning: None };
    }
    let Some(text) = bootstrap else {
        return default(None);
    };
    let parsed = text.map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Bootstrap>(&t).map_err(|e| e.to_string())).and_then(|b| {
        if b.data_dir.is_absolute() {
            Ok(b.data_dir)
        } else {
            Err(msg!("location.notAbsolute"))
        }
    });
    match parsed {
        Ok(dir) => Location { kind: Kind::Custom, dir, warning: None },
        Err(e) => default(Some(msg!("location.unreadable", path = default_dir.join(BOOTSTRAP_FILE).display().to_string(), error = e))),
    }
}

/// Resolves for this process and makes sure the folder exists. A chosen folder always holds a
/// database (choosing one copies the data there first), so one without it (moved, deleted, a
/// removed drive) falls back to the default with a warning instead of starting an empty library.
pub fn detect() -> io::Result<Location> {
    let exe = std::env::current_exe()?;
    let exe_dir = exe.parent().ok_or_else(|| io::Error::other(msg!("location.noExecutableFolder")))?;
    let data_root = dirs::data_dir().ok_or_else(|| io::Error::other(msg!("location.noDefaultFolder")))?;
    detect_at(exe_dir, &data_root)
}

fn detect_at(exe_dir: &Path, data_root: &Path) -> io::Result<Location> {
    let portable = PORTABLE_MARKERS.iter().any(|m| exe_dir.join(m).is_file());
    if portable {
        let loc = resolve(true, exe_dir, data_root, None);
        std::fs::create_dir_all(&loc.dir)?;
        return Ok(loc);
    }
    let default_dir = data_root.join(APP_DATA_FOLDER);
    let legacy_dir = data_root.join(APP_IDENTIFIER);
    migrate_legacy(&legacy_dir, &default_dir)?;
    let bootstrap = match std::fs::read_to_string(default_dir.join(BOOTSTRAP_FILE)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        r => Some(r),
    };
    let mut loc = resolve(false, exe_dir, &default_dir, bootstrap);
    if loc.kind == Kind::Custom
        && !legacy_dir.try_exists()?
        && let Ok(relative) = loc.dir.strip_prefix(&legacy_dir)
    {
        let relocated = default_dir.join(relative);
        if relocated.join(DB_FILE).is_file() {
            loc.dir = relocated;
        }
    }
    let loc = in_use(loc, &default_dir);
    std::fs::create_dir_all(&loc.dir)?;
    Ok(loc)
}

fn migrate_legacy(legacy: &Path, target: &Path) -> io::Result<()> {
    let migrate = || -> io::Result<()> {
        if target.try_exists()? || !legacy.try_exists()? {
            return Ok(());
        }
        if !std::fs::metadata(legacy)?.is_dir() {
            return Err(io::Error::other("the existing data location is not a directory"));
        }
        match std::fs::rename(legacy, target) {
            Ok(()) => Ok(()),
            Err(_) if target.is_dir() && !legacy.try_exists()? => Ok(()),
            Err(e) => Err(e),
        }
    };
    migrate().map_err(|e| {
        io::Error::new(e.kind(), msg!("location.migrateFailed", from = legacy.display().to_string(), to = target.display().to_string(), error = e.to_string()))
    })
}

fn in_use(loc: Location, default_dir: &Path) -> Location {
    if loc.kind != Kind::Custom {
        return loc;
    }
    let error = match std::fs::metadata(loc.dir.join(DB_FILE)) {
        Ok(m) if m.is_file() => return loc,
        Err(e) if e.kind() != io::ErrorKind::NotFound => e.to_string(),
        _ => msg!("location.noData"),
    };
    Location {
        kind: Kind::Default,
        dir: default_dir.to_path_buf(),
        warning: Some(msg!("location.unusable", path = loc.dir.display().to_string(), error = error)),
    }
}

/// Records `target` for the next start; choosing the default folder removes the record.
pub fn write_bootstrap(default_dir: &Path, target: &Path) -> io::Result<()> {
    let file = default_dir.join(BOOTSTRAP_FILE);
    if target == default_dir {
        return match std::fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(default_dir)?;
    let json = serde_json::to_string_pretty(&Bootstrap { data_dir: target.to_path_buf() }).map_err(io::Error::other)?;
    std::fs::write(file, json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-location-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const EXE: &str = r"C:\Apps\Lattice";
    const DEFAULT: &str = r"C:\Users\me\AppData\Roaming\Lattice";

    fn resolve_with(portable: bool, bootstrap: Option<io::Result<String>>) -> Location {
        resolve(portable, Path::new(EXE), Path::new(DEFAULT), bootstrap)
    }

    #[test]
    fn the_portable_marker_wins_over_everything() {
        let loc = resolve_with(true, Some(Ok(r#"{"data_dir":"D:\\Lattice"}"#.into())));
        assert_eq!((loc.kind, loc.dir.clone()), (Kind::Portable, Path::new(EXE).join("data")));
        assert_eq!(loc.webview_dir(), Some(Path::new(EXE).join("data").join("webview")));
        assert_eq!(loc.log_dir(), Some(Path::new(EXE).join("data").join("logs")));
    }

    #[test]
    fn without_marker_or_bootstrap_the_default_folder_is_used() {
        let loc = resolve_with(false, None);
        assert_eq!(loc, Location { kind: Kind::Default, dir: DEFAULT.into(), warning: None });
        assert_eq!((loc.webview_dir(), loc.log_dir()), (None, None));
    }

    #[test]
    fn a_valid_bootstrap_names_the_folder() {
        let loc = resolve_with(false, Some(Ok(r#"{"data_dir":"D:\\Lattice"}"#.into())));
        assert_eq!(loc, Location { kind: Kind::Custom, dir: r"D:\Lattice".into(), warning: None });
        assert_eq!(loc.webview_dir(), None, "only portable mode moves the browser profile");
    }

    #[test]
    fn an_invalid_bootstrap_falls_back_with_a_warning() {
        for text in [Ok("not json".to_string()), Ok(r#"{"data_dir":"relative\\dir"}"#.into()), Ok("{}".into()), Err(io::Error::other("denied"))] {
            let loc = resolve_with(false, Some(text));
            assert_eq!((loc.kind, loc.dir.as_path()), (Kind::Default, Path::new(DEFAULT)));
            assert!(loc.warning.as_deref().is_some_and(|w| w.contains(BOOTSTRAP_FILE)), "{loc:?}");
        }
    }

    #[test]
    fn the_bootstrap_round_trips_and_choosing_the_default_removes_it() {
        let default = temp("bootstrap");
        let target = Path::new(r"D:\Lattice data");
        write_bootstrap(&default, target).unwrap();
        let read = std::fs::read_to_string(default.join(BOOTSTRAP_FILE));
        assert_eq!(resolve(false, Path::new(EXE), &default, Some(read)).dir, target);
        write_bootstrap(&default, &default).unwrap();
        assert!(!default.join(BOOTSTRAP_FILE).exists());
        write_bootstrap(&default, &default).unwrap(); // nothing to remove is fine
        std::fs::remove_dir_all(&default).unwrap();
    }

    #[test]
    fn a_chosen_folder_without_a_database_falls_back_to_the_default() {
        let root = temp("in-use");
        let custom = |dir: &Path| Location { kind: Kind::Custom, dir: dir.to_path_buf(), warning: None };
        let (chosen, default) = (root.join("chosen"), root.join("default"));
        std::fs::create_dir_all(&chosen).unwrap();
        for dir in [chosen.clone(), root.join("deleted")] {
            let loc = in_use(custom(&dir), &default);
            assert_eq!((loc.kind, loc.dir.as_path()), (Kind::Default, default.as_path()), "{dir:?}");
            assert!(loc.warning.as_deref().is_some_and(|w| w.contains("location.unusable") && w.contains("location.noData")), "{loc:?}");
        }
        std::fs::write(chosen.join(DB_FILE), "").unwrap();
        assert_eq!(in_use(custom(&chosen), &default), custom(&chosen));
        let portable = Location { kind: Kind::Portable, dir: root.join("fresh"), warning: None };
        assert_eq!(in_use(portable.clone(), &default), portable, "a new portable install starts empty");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_unwritable_bootstrap_is_an_error() {
        let dir = temp("unwritable");
        let not_a_dir = dir.join("file");
        std::fs::write(&not_a_dir, "").unwrap();
        assert!(write_bootstrap(&not_a_dir, Path::new(r"D:\Lattice")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_default_folder_uses_a_friendly_name() {
        let dir = default_dir().expect("the test environment has a home folder");
        assert!(dir.is_absolute() && dir.ends_with(APP_DATA_FOLDER), "{dir:?}");
    }

    #[test]
    fn the_build_profile_selects_the_default_folder() {
        #[cfg(debug_assertions)]
        assert_eq!((APP_IDENTIFIER, APP_DATA_FOLDER), ("dev.lattice.app.debug", "Lattice Dev"));
        #[cfg(not(debug_assertions))]
        assert_eq!((APP_IDENTIFIER, APP_DATA_FOLDER), (RELEASE_APP_IDENTIFIER, "Lattice"));
        assert_eq!(RELEASE_APP_IDENTIFIER, "dev.lattice.app");
    }

    #[test]
    fn the_development_folder_does_not_follow_the_release_bootstrap() {
        let root = temp("build-profiles");
        let release = root.join(if cfg!(debug_assertions) {
            RELEASE_APP_IDENTIFIER
        } else {
            "dev.lattice.app.debug"
        });
        let development = root.join(APP_DATA_FOLDER);
        let custom = root.join("custom");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join(DB_FILE), "release data").unwrap();
        write_bootstrap(&release, &custom).unwrap();

        let loc = detect_at(&root.join("exe"), &root).unwrap();
        assert_eq!(loc, Location { kind: Kind::Default, dir: development.clone(), warning: None });
        assert!(!development.join(BOOTSTRAP_FILE).exists());
        assert!(!development.join(DB_FILE).exists());
        assert!(release.join(BOOTSTRAP_FILE).exists());
        assert_eq!(std::fs::read_to_string(custom.join(DB_FILE)).unwrap(), "release data");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_data_moves_together_and_repeated_detection_keeps_it() {
        let root = temp("legacy-move");
        let legacy = root.join(APP_IDENTIFIER);
        std::fs::create_dir_all(legacy.join("models")).unwrap();
        for name in [DB_FILE, "lattice.db-wal", "lattice.db-shm", "models/model.onnx"] {
            std::fs::write(legacy.join(name), name).unwrap();
        }
        let first = detect_at(&root.join("exe"), &root).unwrap();
        assert_eq!(first.dir, root.join(APP_DATA_FOLDER));
        assert!(!legacy.exists());
        for name in [DB_FILE, "lattice.db-wal", "lattice.db-shm", "models/model.onnx"] {
            assert_eq!(std::fs::read_to_string(first.dir.join(name)).unwrap(), name);
        }
        assert_eq!(detect_at(&root.join("exe"), &root).unwrap(), first);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_custom_folder_selection_survives_the_move() {
        let root = temp("legacy-custom");
        let legacy = root.join(APP_IDENTIFIER);
        let custom = root.join("custom");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join(DB_FILE), "custom library").unwrap();
        write_bootstrap(&legacy, &custom).unwrap();
        let loc = detect_at(&root.join("exe"), &root).unwrap();
        assert_eq!((loc.kind, loc.dir), (Kind::Custom, custom));
        assert!(root.join(APP_DATA_FOLDER).join(BOOTSTRAP_FILE).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_custom_folder_inside_the_legacy_folder_keeps_its_library_after_migration() {
        let root = temp("legacy-nested-custom");
        let legacy = root.join(APP_IDENTIFIER);
        let custom = legacy.join("nested");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join(DB_FILE), "nested library").unwrap();
        write_bootstrap(&legacy, &custom).unwrap();
        let relocated = root.join(APP_DATA_FOLDER).join("nested");
        let first = detect_at(&root.join("exe"), &root).unwrap();
        assert_eq!((first.kind, &first.dir), (Kind::Custom, &relocated));
        assert_eq!(std::fs::read_to_string(relocated.join(DB_FILE)).unwrap(), "nested library");
        assert!(!root.join(APP_DATA_FOLDER).join(DB_FILE).exists());
        assert_eq!(detect_at(&root.join("exe"), &root).unwrap(), first);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_destination_is_used_without_merging_or_overwriting_legacy_data() {
        let root = temp("legacy-existing");
        let legacy = root.join(APP_IDENTIFIER);
        let target = root.join(APP_DATA_FOLDER);
        for (dir, content) in [(&legacy, "old library"), (&target, "new library")] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(DB_FILE), content).unwrap();
        }
        assert_eq!(detect_at(&root.join("exe"), &root).unwrap().dir, target);
        assert_eq!(std::fs::read_to_string(legacy.join(DB_FILE)).unwrap(), "old library");
        assert_eq!(std::fs::read_to_string(target.join(DB_FILE)).unwrap(), "new library");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_move_returns_an_error_without_creating_an_empty_library() {
        let root = temp("legacy-failed");
        let legacy = root.join(APP_IDENTIFIER);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join(DB_FILE), "old library").unwrap();
        let blocked = root.join("file");
        std::fs::write(&blocked, "not a directory").unwrap();
        let target = blocked.join(APP_DATA_FOLDER);
        assert!(migrate_legacy(&legacy, &target).is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read_to_string(legacy.join(DB_FILE)).unwrap(), "old library");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_detection_does_not_touch_default_or_legacy_data() {
        let root = temp("portable-migration");
        let exe = root.join("exe");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join(PORTABLE_MARKERS[0]), "").unwrap();
        let legacy = root.join(APP_IDENTIFIER);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join(DB_FILE), "installed library").unwrap();
        let loc = detect_at(&exe, &root).unwrap();
        assert_eq!((loc.kind, loc.dir), (Kind::Portable, exe.join("data")));
        assert!(!root.join(APP_DATA_FOLDER).exists());
        assert_eq!(std::fs::read_to_string(legacy.join(DB_FILE)).unwrap(), "installed library");
        std::fs::remove_dir_all(root).unwrap();
    }
}
