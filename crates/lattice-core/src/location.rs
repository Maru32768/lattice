//! Where Lattice keeps its data. In order: a `portable` marker next to the exe puts everything
//! in `<exe dir>/data`; else a bootstrap file in the default folder names a folder the user
//! chose (the database cannot hold its own location); else the default app data folder.
//! Shared by the app and the CLI, so both open the same database.

use std::io;
use std::path::{Path, PathBuf};

use crate::msg;

pub const PORTABLE_MARKERS: [&str; 2] = ["portable", "lattice.portable"];
/// In the default app data folder, whichever folder is in use.
pub const BOOTSTRAP_FILE: &str = "data-location.json";
pub const DB_FILE: &str = "lattice.db";
/// The app's Tauri identifier (`tauri.conf.json`), which names its default data folder.
pub const APP_IDENTIFIER: &str = "dev.lattice.app";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
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

/// The folder Tauri's `app_data_dir` gives the app, found without Tauri (the CLI): Tauri builds
/// it from the same `dirs` crate.
pub fn default_dir() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(APP_IDENTIFIER))
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
pub fn detect(default_dir: &Path) -> Location {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let portable = PORTABLE_MARKERS.iter().any(|m| exe_dir.join(m).is_file());
    let bootstrap = match std::fs::read_to_string(default_dir.join(BOOTSTRAP_FILE)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        r => Some(r),
    };
    let loc = in_use(resolve(portable, &exe_dir, default_dir, bootstrap), default_dir);
    let _ = std::fs::create_dir_all(&loc.dir);
    loc
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
    const DEFAULT: &str = r"C:\Users\me\AppData\Roaming\dev.lattice.app";

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
    fn the_default_folder_is_named_by_the_identifier() {
        let dir = default_dir().expect("the test environment has a home folder");
        assert!(dir.is_absolute() && dir.ends_with(APP_IDENTIFIER), "{dir:?}");
    }
}
