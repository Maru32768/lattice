//! Version information in lattice-cli.exe, as Tauri gives Lattice.exe: Windows shows it in the file's
//! properties, and code signing services check it (docs/authenticode.md).
fn main() -> std::io::Result<()> {
    #[cfg(windows)]
    tauri_winres::WindowsResource::new().set("ProductName", "Lattice").set("CompanyName", "marulabs").compile()?;
    Ok(())
}
