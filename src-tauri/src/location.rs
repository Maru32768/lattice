//! Where Lattice keeps its data. In order: a `portable` marker next to the exe puts everything
//! in `<exe dir>/data`; else a bootstrap file in the default folder names a folder the user
//! chose (the database cannot hold its own location); else the default app data folder.

use std::io;
use std::path::{Path, PathBuf};

use lattice_core::store::Store;

pub const PORTABLE_MARKERS: [&str; 2] = ["portable", "lattice.portable"];
/// In the default app data folder, whichever folder is in use.
pub const BOOTSTRAP_FILE: &str = "data-location.json";
pub const DB_FILE: &str = "lattice.db";
/// Copied when the user moves the data folder; logs and the WebView2 profile stay behind.
const DATA_DIRS: [&str; 3] = ["backups", "exports", "models"];

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

/// `bootstrap`: the bootstrap file's text, `None` when there is no such file.
pub fn resolve(portable: bool, exe_dir: &Path, default_dir: &Path, bootstrap: Option<io::Result<String>>) -> Location {
    let default = |warning| Location { kind: Kind::Default, dir: default_dir.to_path_buf(), warning };
    if portable {
        return Location { kind: Kind::Portable, dir: exe_dir.join("data"), warning: None };
    }
    let Some(text) = bootstrap else { return default(None) };
    let parsed = text
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<Bootstrap>(&t).map_err(|e| e.to_string()))
        .and_then(|b| if b.data_dir.is_absolute() { Ok(b.data_dir) } else { Err("絶対パスではありません".into()) });
    match parsed {
        Ok(dir) => Location { kind: Kind::Custom, dir, warning: None },
        Err(e) => default(Some(format!("{} を読めないため既定の場所を使っています: {e}", default_dir.join(BOOTSTRAP_FILE).display()))),
    }
}

/// Resolves for this process and makes sure the folder exists; a chosen folder that cannot be
/// created (a removed drive) falls back to the default with a warning rather than failing to start.
pub fn detect(default_dir: &Path) -> Location {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let portable = PORTABLE_MARKERS.iter().any(|m| exe_dir.join(m).is_file());
    let bootstrap = match std::fs::read_to_string(default_dir.join(BOOTSTRAP_FILE)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        r => Some(r),
    };
    let loc = resolve(portable, &exe_dir, default_dir, bootstrap);
    match std::fs::create_dir_all(&loc.dir) {
        Err(e) if loc.kind == Kind::Custom => Location {
            kind: Kind::Default,
            dir: default_dir.to_path_buf(),
            warning: Some(format!("保存場所 {} を使えないため既定の場所を使っています: {e}", loc.dir.display())),
        },
        _ => loc,
    }
}

/// Refuses the folder in use and folders inside it (copying would recurse into itself).
pub fn check_target(current: &Path, target: &Path) -> Result<(), String> {
    if target == current {
        return Err("今の保存場所と同じフォルダです".into());
    }
    if target.starts_with(current) {
        return Err("今の保存場所の中のフォルダは選べません".into());
    }
    Ok(())
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
    store.copy_to(&to.join(DB_FILE)).map_err(|e| format!("データベースをコピーできませんでした: {e}"))?;
    for d in DATA_DIRS {
        if from.join(d).is_dir() {
            copy_dir(&from.join(d), &to.join(d)).map_err(|e| format!("{d} をコピーできませんでした: {e}"))?;
        }
    }
    Ok(())
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
    fn targets_inside_the_current_folder_are_refused() {
        let cur = Path::new(DEFAULT);
        assert!(check_target(cur, cur).is_err());
        assert!(check_target(cur, &cur.join("sub")).is_err());
        assert!(check_target(cur, Path::new(r"D:\Lattice")).is_ok());
        assert!(check_target(cur, Path::new(r"C:\Users\me\AppData\Roaming")).is_ok());
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
    fn an_unwritable_bootstrap_is_an_error() {
        let dir = temp("unwritable");
        let not_a_dir = dir.join("file");
        std::fs::write(&not_a_dir, "").unwrap();
        assert!(write_bootstrap(&not_a_dir, Path::new(r"D:\Lattice")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
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
