# Releasing Lattice

A release is a `v<x.y.z>` tag. Pushing it runs `.github/workflows/release.yml`, which builds the Windows app and leaves a draft GitHub release for you to check and publish.

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

The app checks `https://github.com/Maru32768/lattice/releases/latest/download/latest.json` at startup and from Settings › アップデート, and installs an update only when its signature matches the public key built into the app. Until you set up a key pair, `src-tauri/tauri.conf.json` holds a placeholder (`plugins.updater.pubkey` starting with `NOT_CONFIGURED`), the app makes no update requests, and the settings section says updates are not configured. Releases still build without a key; they just carry no updater files.

To turn updates on, once:

1. Generate a key pair on your machine. Choose a password when asked, and keep the private key out of the repository:

   ```bash
   mise exec -- npx tauri signer generate -w "$HOME/.tauri/lattice.key"
   ```

   This writes the private key to `~/.tauri/lattice.key` and the public key to `~/.tauri/lattice.key.pub`. Back up both and the password: without the private key, installed copies can never be updated again, and a new key pair means users must reinstall by hand.

2. In the GitHub repository, open Settings › Secrets and variables › Actions and add two repository secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/lattice.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose.

3. Replace the placeholder in `src-tauri/tauri.conf.json` with the contents of `~/.tauri/lattice.key.pub` (one line), and commit it. The public key is not a secret.

From the next tag on, the workflow adds `src-tauri/tauri.updater.conf.json` to the build, which signs the installer, and the draft release gets `Lattice_<x.y.z>_x64-setup.exe.sig` and `latest.json`. Installed copies see an update only after you publish the draft: `releases/latest` ignores drafts and prereleases.

An update downloads the installer, checks its signature, and runs it in passive mode; the installer closes Lattice, installs over it and starts the new version. Data in `%APPDATA%\dev.lattice.app` is untouched.

To build signed artifacts locally, set the same two variables in the shell and run `mise exec -- npm run tauri build -- --config src-tauri/tauri.updater.conf.json`.

## Cutting a release

1. Bump the version and edit `CHANGELOG.md` as above, then run `mise run test`.
2. Commit, for example `Release 0.2.0`, and push to `master`.
3. Tag the commit and push the tag:

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin v0.2.0
   ```

4. Wait for the Release workflow in the Actions tab (about 30 to 40 minutes on a cold cache).
5. Open the draft on the Releases page, check the notes and assets, and press **Publish release**.

A tag with a hyphen (`v0.2.0-beta.1`) makes a prerelease.

## What the workflow produces

The draft release `Lattice v<x.y.z>` has these assets:

| Asset | What it is |
|---|---|
| `Lattice_<x.y.z>_x64-setup.exe` | NSIS installer. Installs for the current user and keeps data in `%APPDATA%\dev.lattice.app`. |
| `Lattice_<x.y.z>_x64-portable.zip` | `Lattice.exe` with a `portable` marker file, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES`. Unzip anywhere; the marker keeps all data, logs and the WebView2 profile in a `data` folder next to the exe. Users update it by replacing `Lattice.exe`; the in-app updater only links to the release. |
| `THIRD_PARTY_LICENSES` | The license list the build shipped with. |
| `Lattice_<x.y.z>_x64-setup.exe.sig`, `latest.json` | Only with the signing key secrets: the installer's signature and the manifest installed copies read to find updates. |

Both the installer and the zip need the WebView2 runtime, which Windows 11 includes. The installer downloads it on Windows 10 when it is missing.

To build the same installer locally, run `mise exec -- npm run tauri build`. The output is in `target/release/bundle/nsis/`, and `target/release/lattice.exe` is the executable the zip is made from.

## If a release fails

Delete the draft release and the tag, fix the cause on `master`, and tag again:

```bash
git push origin :refs/tags/v0.2.0
```

```bash
git tag -d v0.2.0
```

Re-running the workflow on the same tag also works: the action updates the existing draft and replaces its assets.
