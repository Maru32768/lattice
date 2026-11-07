# Releasing Lattice

A release is a `v<x.y.z>` tag. Pushing it runs `.github/workflows/release.yml`, which waits for CI, builds the Windows app, checks the result and leaves a draft GitHub release for you to publish.

## Version

One version number covers the app. It is kept in four files, and `scripts/version.ts` keeps them in sync:

| File | Field |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | `version` and `packages[""].version` |
| `Cargo.toml` | `[workspace.package] version`, inherited by `src-tauri` and the crates under `crates/` |
| `Cargo.lock` | the `lattice`, `lattice-core`, `lattice-server` and `lattice-cli` entries |

`src-tauri/tauri.conf.json` has no `version`, so Tauri uses the one in `Cargo.toml`.

```bash
mise exec -- npm run bump -- 0.2.0
```

Run without a version, `npm run bump` prints what each file holds. `npm test` fails when the files disagree (`scripts/version.test.ts`), and the release workflow fails when the tag differs from the version. The script is not named `version` because npm runs a script of that name as a hook of `npm version`.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add entries under `## [Unreleased]` as changes land. To release, rename that heading to the new version and date, add a fresh empty `## [Unreleased]` above it, and update the links at the bottom:

```markdown
## [Unreleased]

## [0.2.0] - 2026-11-01

### Added
...

[Unreleased]: https://github.com/Maru32768/lattice/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Maru32768/lattice/releases/tag/v0.2.0
```

The workflow copies the version's section into the release notes.

`CHANGELOG.ja.md` is its Japanese translation, line for line: make the same edits there (`scripts/doc-pairs.ts` checks). The release notes hold the English section, then the Japanese one under a `## 日本語` heading; the workflow fails when either is missing or empty.

## Third-party licenses

`THIRD_PARTY_LICENSES` lists the license of every Rust crate compiled into the app (by [cargo-about](https://github.com/EmbarkStudios/cargo-about), settings in `scripts/about.toml`) and every npm package bundled into the UI (`scripts/licenses.ts`, from the non-dev packages in `package-lock.json`). Regenerate and commit it when dependencies change:

```bash
mise exec -- cargo install --locked cargo-about --features cli
```

```bash
mise run licenses
```

cargo-about fails on a license that is not in the `accepted` list of `scripts/about.toml`. Check that the new license allows redistribution before adding it. The release workflow regenerates the file before building, so a release never ships a stale list.

## Signed updates

The app checks `https://github.com/Maru32768/lattice/releases/latest/download/latest.json` at startup and from Settings › アップデート, and installs an update only when its signature matches the public key built into the app. The release workflow requires the public key and both signing Secrets. A local development build can use a placeholder key, which disables update checks.

Automatic updates require the matching public key, repository Secrets and a tested signed update. A copy shipped with a placeholder public key requires a manual installation before it can receive signed updates.

On Windows, run the setup script in a local PowerShell 7.2 or later terminal (`pwsh`):

```powershell
pwsh -File ./scripts/setup-updater.ps1 -GeneratePassword -RegisterSecrets
```

Install GitHub CLI and run `gh auth login` first. The script generates a random password, keeps the key in `%USERPROFILE%\.tauri\lattice.key`, writes the public key to the app configuration, and registers both Secrets through standard input. It signs and verifies a test file before changing the configuration. A retry reuses the existing key pair.

The password is saved as `%USERPROFILE%\.tauri\lattice.key.password.xml`, protected by Windows DPAPI. Only the same Windows account on the same computer can decrypt this copy. Save the password in your password manager and back up both key files before releasing. To copy the password without printing it, run `./scripts/setup-updater.ps1 -CopyPassword`, save the clipboard contents, then clear the clipboard. Omit `-GeneratePassword` to choose a password interactively instead.

The following steps are the manual alternative. If the script already generated the key pair, skip generation and use those files. Do not replace an existing release key pair.

1. Generate a key pair on your machine. Choose a password when asked, and keep the private key out of the repository:

   ```bash
   mise exec -- npx tauri signer generate -w "$HOME/.tauri/lattice.key"
   ```

   This writes the private key to `~/.tauri/lattice.key` and the public key to `~/.tauri/lattice.key.pub`. Back up both and the password: without the private key, installed copies can never be updated again, and a new key pair means users must reinstall by hand.

2. In the GitHub repository, open Settings › Secrets and variables › Actions and add two repository secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/lattice.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose.

3. Replace the placeholder in `src-tauri/tauri.conf.json` with the contents of `~/.tauri/lattice.key.pub` (one line), and commit it. The public key is not a secret.

The release workflow builds with `src-tauri/tauri.updater.conf.json`, which signs the installer, and the draft release gets `Lattice_<x.y.z>_x64-setup.exe.sig` and `latest.json`. Missing signing prerequisites stop the workflow before the build. Installed copies see an update only after you publish the draft: `releases/latest` ignores drafts and prereleases.

An update downloads the installer, checks its signature, and runs it in passive mode; the installer closes Lattice, installs over it and starts the new version. Data in `%APPDATA%\Lattice` is kept. Identifier-based folders from older test builds are not moved automatically.

Updater signatures verify the update package. Windows Authenticode code signing identifies the executable's publisher and is separate. It is deferred; [authenticode.md](authenticode.md) records the options and a workflow design. An updater signature alone does not remove Windows' unknown-publisher prompts.

To build signed artifacts locally, set the same two variables in the shell and run `mise exec -- npm run tauri build -- --config src-tauri/tauri.updater.conf.json`.

## Cutting a release

1. Finish the version and changelog changes, and any public key or license changes. Commit them and push to `master`. CI runs the full test suite and E2E, so a release needs no local run of `mise run test` or `mise run e2e`.
2. Tag that commit and push the tag. CI can still be running.

   ```bash
   git tag v0.2.0 <full-commit-sha>
   ```

   ```bash
   git push origin v0.2.0
   ```

3. Wait for the Release workflow. It waits for CI on that exact commit and stops if CI fails. It then builds the draft and runs the [release check](#release-check).
4. Run the [native checks](#native-checks) for what this release changed.
5. Read the notes on the draft, then publish it.
6. Update your own installed copy from the update bar. This is the real update path on a real library.

A tag with a hyphen (`v0.2.0-beta.1`) makes a prerelease.

The browser E2E suite uses a mock backend in Chromium. It does not verify native Tauri commands, WebView2, the installer or the updater. The release check and the native checks cover those.

## Release check

`.github/workflows/release-check.yml` runs after the build and changes nothing on the release. If it fails, the Release workflow fails and the draft stays unpublished.

- `scripts/verify-release.ts` checks the files as uploaded. `latest.json` must name this version, the uploaded installer and its signature. The signature must verify against the public key in the tag, and that key must match the previous tag's, because installed copies reject any other. The portable zip must hold both executables, its marker and the license files. The license list must name this version.
- The job starts the portable copy, then the installed copy after a silent install. Each must render its main window, read through Windows UI Automation, create its database in the right folder and answer `lattice-cli list`. The portable copy must write nothing to `%APPDATA%\Lattice`. Uninstalling must remove both executables and keep the database. On failure, the run keeps a screenshot as the `release-check-screen` artifact.

To recheck a tag without rebuilding:

```bash
gh workflow run release-check.yml -f tag=v0.2.0
```

The runner is a clean Windows Server with WebView2 and the Visual C++ runtime already installed. The check does not cover installing those prerequisites, a Windows 11 desktop, AI providers or updates.

## Native checks

Run only the rows for what the release changed. To list the changes, run `git diff --stat <previous-tag>..<tag>`. After an upgrade of Tauri or ONNX Runtime, run every row.

Use Windows 11, a disposable test library or a restored backup, a clean user profile and no developer toolchains.

| When this changed | Check |
|---|---|
| `src-tauri/installer-hooks.nsh`, `scripts/prepare-windows-*`, `scripts/install-windows-runtime.ps1`, the `bundle` settings | Install on machines without WebView2 and without the Microsoft Visual C++ x64 runtime. Check runtime installation, administrator-approval cancellation and an already installed newer runtime. A failed prerequisite must stop installation. Reinstall over the test installation and confirm that the library remains. |
| `src-tauri/src/update.rs`, `tauri.updater.conf.json`, `tauri-plugin-updater` | Use a separate test build and a controlled update endpoint to offer a newer signed package. The public `latest.json` only offers a published release. Verify that an altered package is rejected and a valid package installs, restarts and preserves data. Confirm that portable mode links to the release page. |
| `llm.rs`, `chain.rs`, `claude.rs`, `codex.rs`, `openai.rs`, `gemini.rs`, `anthropic.rs` | Start with no AI configuration. Check the guidance for an absent CLI, an unauthenticated CLI and invalid API credentials. Use one authenticated API provider and one authenticated CLI provider for translation, summary, quiz generation and chat. Correct invalid credentials and retry. |
| `embed.rs` | Download the semantic-search model on first run. Start offline before an initial download, verify full-text fallback and its explanation, then reconnect and retry. |
| `browser.rs`, `renderer.rs`, `popout.rs`, `tabdrag.rs`, `src/overlay`, `src/pdfview` | Save a real JavaScript page, translate Page content, split panes and move a tab between windows. |
| `store.rs`, a new migration | Save, read and search an article. Create a collection and a vocabulary entry, answer a quiz and complete a due review. Confirm that the state survives a restart. |
| `crates/lattice-cli` | Run both the installed CLI and portable CLI, then an MCP client against the same test library. Verify read access and explicitly enabled write access. |
| `network.rs`, `fetch.rs` | Confirm that settings do not expose destination rules. Verify that direct HTTP downloads still reject private destinations by default and respect any existing saved policy. |
| `location.rs` | Confirm separate debug and release data, logs, browser profiles and storage selections. Check portable behavior and the CLI's `--data-dir` override. Move the data directory and restart. |
| `backup.rs`, `r2.rs` | Back up a library with articles, images, translations, vocabulary and review history. Restore it with [the user-guide procedure](guide.md#restore-a-backup), re-enter credentials and verify those records after restarting. |

## What the workflow produces

The draft release `Lattice v<x.y.z>` has these assets:

| Asset | What it is |
|---|---|
| `Lattice_<x.y.z>_x64-setup.exe` | NSIS installer. Installs the GUI and `lattice-cli.exe` together, by default in `%LOCALAPPDATA%\Lattice`. Does not add the CLI to PATH. Updates replace both executables, and uninstall removes both. Stop MCP clients before either operation. Default data stays in `%APPDATA%\Lattice` unless the uninstall data-deletion checkbox is selected. Custom data outside the default folder is retained. |
| `Lattice_<x.y.z>_x64-portable.zip` | `Lattice.exe` and `lattice-cli.exe` (the CLI and MCP server, built in its own step) with a `portable` marker file, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES`. Unzip anywhere; the marker keeps all data, logs and the WebView2 profile in a `data` folder next to the exe. Users update it by replacing `Lattice.exe`; the in-app updater only links to the release. |
| `THIRD_PARTY_LICENSES` | The license list the build shipped with. |
| `Lattice_<x.y.z>_x64-setup.exe.sig`, `latest.json` | The installer's signature and the manifest installed copies read to find updates. Required for published installer releases. |

Both the installer and the zip need the WebView2 runtime, which Windows 11 includes. The installer downloads it when it is missing. A portable copy on a machine without WebView2 needs the runtime installed separately.

Both executables also need the Microsoft Visual C++ x64 runtime because the prebuilt ONNX Runtime library uses the dynamic C++ runtime. Before bundling, `scripts/prepare-windows-runtime.ps1` downloads the Microsoft-signed Redistributable and verifies its signature and version. The NSIS installer embeds it, installs it with administrator approval when needed, and stops if installation fails. It leaves the shared runtime installed when Lattice is uninstalled. For portable copies, install the [Microsoft Visual C++ x64 runtime](https://aka.ms/vc14/vc_redist.x64.exe) separately. Windows 11 does not guarantee that this prerequisite is present.

To update a portable copy, replace the application binaries with those from the new archive and keep the existing `data` folder.

To build the same installer locally, run `mise exec -- npm run tauri build`. The output is in `target/release/bundle/nsis/`, and `target/release/lattice.exe` is the executable the zip is made from.

## If a release fails

Re-run the workflow on the same tag when the source commit is unchanged. The action updates the existing draft and replaces its assets. When only the release check failed, re-run that job.

If the source needs a fix, push a new commit. Replace the tag only while the release is unpublished and nobody relies on its artifacts:

```bash
git push origin :refs/tags/v0.2.0
```

```bash
git tag -d v0.2.0
```

Then tag the new commit. Never silently replace a published release's tag or binaries. Use a new patch version for a published release.
