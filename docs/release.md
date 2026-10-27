# Releasing Lattice

A release is a `v<x.y.z>` tag. Pushing it runs `.github/workflows/release.yml`, which builds the Windows app and leaves a draft GitHub release for you to check and publish.

Track the first release in [the 0.1.0 checklist](release-checklist-0.1.0.md). An unchecked requirement remains pending. Source preparation does not establish that a packaged application works.

## Version

One version number covers the app. It is kept in four files, and `scripts/version.mjs` keeps them in sync:

| File | Field |
|---|---|
| `package.json` | `version` |
| `package-lock.json` | `version` and `packages[""].version` |
| `Cargo.toml` | `[workspace.package] version`, inherited by `src-tauri` and `crates/lattice-core` |
| `Cargo.lock` | the `lattice` and `lattice-core` entries |

`src-tauri/tauri.conf.json` has no `version`, so Tauri uses the one in `Cargo.toml`.

```bash
mise exec -- npm run bump -- 0.2.0
```

Run without a version, `npm run bump` prints what each file holds. `npm test` fails when the files disagree (`scripts/version.test.mjs`), and the release workflow fails when the tag differs from the version. The script is not named `version` because npm runs a script of that name as a hook of `npm version`.

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

The workflow copies the version's section into the release notes, and fails when the section is missing or empty.

The prepared `0.1.0` section is undated while release checks remain open. Add the actual publication date before tagging. If the release is published on 2026-10-26 in Japan, use `## [0.1.0] - 2026-10-26`. Otherwise, use the actual publication date.

## Third-party licenses

`THIRD_PARTY_LICENSES` lists the license of every Rust crate compiled into the app (by [cargo-about](https://github.com/EmbarkStudios/cargo-about), settings in `scripts/about.toml`) and every npm package bundled into the UI (`scripts/licenses.mjs`, from the non-dev packages in `package-lock.json`). Regenerate and commit it when dependencies change:

```bash
mise exec -- cargo install --locked cargo-about --features cli
```

```bash
mise run licenses
```

cargo-about fails on a license that is not in the `accepted` list of `scripts/about.toml`. Check that the new license allows redistribution before adding it. The release workflow regenerates the file before building, so a release never ships a stale list.

## Signed updates

The app checks `https://github.com/Maru32768/lattice/releases/latest/download/latest.json` at startup and from Settings › アップデート, and installs an update only when its signature matches the public key built into the app. The release workflow requires the public key and both signing Secrets. A local development build can use a placeholder key, which disables update checks.

Configure updates before the first public release.

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

An update downloads the installer, checks its signature, and runs it in passive mode; the installer closes Lattice, installs over it and starts the new version. Data in `%APPDATA%\Lattice` is kept. Older test builds' `dev.lattice.app` data is renamed on first start only when the new default folder is absent.

Updater signatures verify the update package. Windows Authenticode code signing identifies the executable's publisher and is configured separately. Decide whether to sign the Windows executables and record the decision in the checklist. An updater signature alone does not remove Windows' unknown-publisher prompts.

To build signed artifacts locally, set the same two variables in the shell and run `mise exec -- npm run tauri build -- --config src-tauri/tauri.updater.conf.json`.

## Cutting a release

1. Finish the version, changelog, public key and license changes. Run both `mise run test` and `mise run e2e` locally.
2. Commit the intended release changes and push to `master`. Record the full commit SHA with `git rev-parse HEAD`.
3. Require a successful CI run for that exact SHA, including E2E. Inspect the run on GitHub, or list it with `gh run list --workflow ci.yml --commit <full-commit-sha>`. A green run for an earlier commit does not cover later changes. If a fix changes the source, repeat the affected local checks and require green CI for the new SHA.
4. Tag only the verified commit and push the tag:

   ```bash
   git tag v0.1.0 <verified-full-commit-sha>
   ```

   ```bash
   git push origin v0.1.0
   ```

5. Wait for the Release workflow to create the draft.
6. Test the draft's installer and portable archive with the native checklist below. Record the artifact, OS, commit SHA and result in the release checklist.
7. Check the notes, license files, installer, portable archive, `latest.json` and installer signature. Confirm that the manifest names the intended version, URL and signature.
8. Complete the release checklist, then publish the draft. Include supported Windows versions, AI setup, backup guidance and known limitations in the notes.

A tag with a hyphen (`v0.2.0-beta.1`) makes a prerelease.

The browser E2E suite uses a mock backend in Chromium. It does not verify native Tauri commands, WebView2, the installer or the updater. A successful release build does not replace the CI gate.

## Test the packaged Windows app

Use a disposable test library or a restored backup. On both Windows 10 and Windows 11, test the installer and portable archive with a clean user profile and no developer toolchains:

- Install, start, close and restart the app. Cover machines without WebView2 and without the Microsoft Visual C++ x64 runtime. Check runtime installation, administrator-approval cancellation and an already installed newer runtime. A failed prerequisite must stop installation.
- Extract the portable archive into a writable folder. Confirm that the GUI and CLI use its adjacent `data` folder and that the license files are present.
- Start with no AI configuration. Save, read and search an article, then restart and confirm persistence. Check the guidance for an absent CLI, an unauthenticated CLI and invalid API credentials.
- Use one authenticated API provider and one authenticated CLI provider for translation, summary, quiz generation and chat. Correct invalid credentials and retry.
- Download the semantic-search model on first run. Start offline before an initial download, verify full-text fallback and its explanation, then reconnect and retry.
- Save a real JavaScript page, translate Page content, split panes and move a tab between windows.
- Create a collection and a vocabulary entry, answer a quiz and complete a due review. Confirm that the state survives a restart.
- Run both the installed CLI and portable CLI, then an MCP client against the same test library. Verify read access and explicitly enabled write access.
- Confirm that settings do not expose destination rules. Verify that direct HTTP downloads still reject private destinations by default and respect any existing saved policy.
- Confirm separate debug and release data, logs, browser profiles and storage selections. Check portable behavior and the CLI's `--data-dir` override.
- Back up a library with articles, images, translations, vocabulary and review history. Restore it with [the user-guide procedure](guide.md#restore-a-backup), re-enter credentials and verify those records after restarting.
- Move the data directory and restart. Reinstall over the test installation and confirm that the library remains.
- Use a separate test build and a controlled update endpoint to offer a newer signed package. Verify that an altered package is rejected and a valid package installs, restarts and preserves data. Confirm that portable mode links to the release page.

The public `latest.json` cannot offer an update before the first release is published. Use a controlled endpoint and a disposable installation for this check. Keep the public endpoint and intended version in the release build.

## What the workflow produces

The draft release `Lattice v<x.y.z>` has these assets:

| Asset | What it is |
|---|---|
| `Lattice_<x.y.z>_x64-setup.exe` | NSIS installer. Installs the GUI and `lattice-cli.exe` together, by default in `%LOCALAPPDATA%\Lattice`. Does not add the CLI to PATH. Updates replace both executables, and uninstall removes both. Stop MCP clients before either operation. Default data stays in `%APPDATA%\Lattice` unless the uninstall data-deletion checkbox is selected. Custom data outside the default folder is retained. |
| `Lattice_<x.y.z>_x64-portable.zip` | `Lattice.exe` and `lattice-cli.exe` (the CLI and MCP server, built in its own step) with a `portable` marker file, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES`. Unzip anywhere; the marker keeps all data, logs and the WebView2 profile in a `data` folder next to the exe. Users update it by replacing `Lattice.exe`; the in-app updater only links to the release. |
| `THIRD_PARTY_LICENSES` | The license list the build shipped with. |
| `Lattice_<x.y.z>_x64-setup.exe.sig`, `latest.json` | The installer's signature and the manifest installed copies read to find updates. Required for published installer releases. |

Both the installer and the zip need the WebView2 runtime, which Windows 11 includes. The installer downloads it on Windows 10 when it is missing. A portable copy on a machine without WebView2 needs the runtime installed separately.

Both executables also need the Microsoft Visual C++ x64 runtime because the prebuilt ONNX Runtime library uses the dynamic C++ runtime. Before bundling, `scripts/prepare-windows-runtime.ps1` downloads the Microsoft-signed Redistributable and verifies its signature and version. The NSIS installer embeds it, installs it with administrator approval when needed, and stops if installation fails. It leaves the shared runtime installed when Lattice is uninstalled. For portable copies, install the [Microsoft Visual C++ x64 runtime](https://aka.ms/vc14/vc_redist.x64.exe) separately. Windows 11 does not guarantee that this prerequisite is present.

To update a portable copy, replace the application binaries with those from the new archive and keep the existing `data` folder.

To build the same installer locally, run `mise exec -- npm run tauri build`. The output is in `target/release/bundle/nsis/`, and `target/release/lattice.exe` is the executable the zip is made from.

## If a release fails

Re-run the workflow on the same tag when the source commit is unchanged. The action updates the existing draft and replaces its assets.

If the source needs a fix, prepare a new verified commit. Replace the tag only while the release is unpublished and nobody relies on its artifacts:

```bash
git push origin :refs/tags/v0.2.0
```

```bash
git tag -d v0.2.0
```

After fixing the source, repeat the CI gate and tag the new verified commit. Never silently replace a published release's tag or binaries. Use a new patch version for a published release.
