# Lattice 0.1.0 release checklist

This checklist records release evidence. An unchecked item is pending. Preparation started on 2026-10-26 in Japan. The version is `0.1.0`, and the publication date remains unset.

On 2026-10-27, the user reported that the checklist checks looked good overall. This records user validation on the known Windows 11 VirtualBox environment, rather than per-scenario logs or evidence for another OS. The subsequent storage-folder, Open folder, hidden network settings and installed CLI changes require focused retesting. Publication steps and checks without specific evidence remain pending below.

## Prepared

- [x] The version files already specify `0.1.0`.
- [x] The initial changelog covers learning tools, collections, CLI, MCP, network policy and development data separation.
- [x] The English and Japanese guides describe local backup restoration, excluded credentials and excluded local preferences.
- [x] The release procedure requires local tests, E2E, CI for the tagged commit and native packaged-app checks.

These entries record source and documentation preparation. They do not record a successful test run or a tested release artifact.

## Source and automation

- [x] Reproduce the Windows formatting failure and fix checkout line endings with `.gitattributes`. Remote CI remains required below.
- [x] Verify the fix for search results being filtered after candidate truncation, including many higher-ranked articles outside the selected scope.
- [ ] Verify first-run AI guidance with no configuration, an absent CLI, an unauthenticated CLI and invalid API credentials.
- [x] Run local lint, workspace Rust tests, frontend tests, typechecking and frontend build. See evidence below.
- [x] Run the complete browser E2E suite on the final application source.
- [x] Regenerate `THIRD_PARTY_LICENSES` and inspect license changes.
- [x] Review the final diff and commit the intended release changes.
- [ ] Push the release commit and record green CI for that exact SHA, including E2E.

The search restriction and first-run explanation are covered by automated tests. Actual missing or unauthenticated providers still need packaged-app verification.

## Signing and update delivery

The signing key pair and both repository Secrets were configured on 2026-10-26. Automatic update installation remains unverified.

- [x] Generate a password-protected updater key pair outside the repository and verify the pair by signing a challenge.
- [ ] Back up both keys and the password independently of this Windows account. The local password copy is DPAPI-protected and cannot be recovered on another computer.
- [x] Configure the matching public key in `src-tauri/tauri.conf.json`. Include it in the release preparation commit.
- [x] Set repository Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- [x] Verify the Secret names without printing their values.
- [x] Defer Windows Authenticode code signing until after 0.1.0; recorded in `docs/roadmap.md`. Updater signatures are separate.
- [ ] Test a newer signed package through a controlled endpoint with a disposable installation.
- [ ] Verify rejection of an altered package, successful installation, restart and preserved library data.

## Packaged Windows checks

Record evidence for Windows 10 and Windows 11. Use a clean user profile without developer toolchains. Test the installer and portable archive on each OS.

- [ ] Install, start, close and restart the app. Cover an installer run without WebView2.
- [ ] On a machine without the Visual C++ x64 runtime, verify that the installer installs it before starting Lattice. Also test cancelled administrator approval, a failed prerequisite, a newer installed runtime and the portable GUI/CLI prerequisites.
- [ ] Save and read an article with no AI provider. Restart and run full-text search.
- [ ] Check the search model's first download, failure while offline, full-text fallback and retry after reconnecting using the steps below.
- [ ] Use one real API provider and one real CLI provider for translation, summary, quiz and chat. Correct invalid credentials and retry.
- [ ] Save a real JavaScript page, translate Page content, split panes and move a tab between windows.
- [ ] Create a collection, save a word, answer a quiz, complete a due review and confirm persistence.
- [ ] Verify the installed CLI next to the GUI, CLI and MCP read access, then explicitly enabled write access. Stop the MCP client and confirm that upgrade and uninstall also replace or remove the CLI.
- [ ] Confirm that settings hide destination rules. Verify default private-address rejection for direct HTTP downloads and preservation of existing saved rules.
- [ ] Verify debug and release data separation, portable `data` and CLI data-directory overrides.
- [ ] Verify the `Lattice` / `Lattice Dev` defaults, preservation of the previous profile's data during rename, and Open folder for default, custom and portable storage.
- [ ] Restore a backup with articles, images, translations, words and review history. Re-enter credentials and confirm the records.
- [ ] Move the data directory and restart. Reinstall and confirm that the library remains.
- [ ] Verify that portable update guidance preserves `data` and replaces the application binaries.

### Search model checks

The model is multilingual-e5-small, used locally for semantic search. It is separate from the configured translation/chat AI provider and downloads about 470 MB on first use. Use a disposable library with no cached model; a VM snapshot taken before the first article is useful.

1. Disconnect the VM from the network before importing an article. Import a short Markdown document without images or links, such as `# Test` followed by a paragraph containing `MVCC prevents write conflicts.`. An empty library does not exercise model loading.
2. Search for `MVCC`. After the model request fails or times out, confirm that the matching paragraph is still returned and the search panel explains that only full-text results are available. This is the full-text fallback.
3. Reconnect the VM. In Jobs, retry the Search index job and wait for it to complete. This exercises the first successful model download and article indexing. In Japanese, the job is `検索 index`, with `今すぐ再実行` or `再実行` depending on its state.
4. Use Retry in the search panel. Confirm that the full-text-only explanation disappears and the matching result can include a semantic match. Search Retry alone does not retry a failed article-indexing job.
5. Close the app, disconnect again and reopen it. Confirm that semantic search works with the cached model without an AI API key or another download.

## Release assets and publication

- [ ] Set the changelog publication date to the actual release day.
- [ ] Confirm that the tag points to the final SHA with green CI.
- [ ] Build the draft release and record its workflow run.
- [ ] Inspect the installer, portable zip, notices and third-party license list.
- [ ] Check `latest.json`, the installer signature, version and download URL.
- [ ] Write notes with supported Windows versions, AI setup, backup guidance and known limitations.
- [ ] Complete all required checks before publishing the draft.

## Evidence

Fill in the SHA, run URL or artifact, environment and result as each check completes. Do not mark a runtime check passed from source inspection alone.

| Check | Commit or artifact | Environment | Result and evidence |
|---|---|---|---|
| Local tests | Release preparation working tree, 2026-10-26 | Windows, pinned mise tools | Rust 224 passed and 1 ignored; frontend/script tests 126 passed; lint, Clippy and frontend build passed. |
| Local E2E | Release preparation working tree, 2026-10-26 | Chromium, real frontend with mock IPC | 135 passed. Native integration is not covered. |
| Updated source checks | Storage and release cleanup working tree, 2026-10-27 | Windows, pinned mise tools | Workspace Rust tests: 298 passed, 1 ignored. Final storage tests: 17 passed. Frontend/script tests: 126 passed. Clippy, lint, React Compiler, generated IPC type consistency, typechecking and production frontend build passed. |
| Updated E2E | Storage and release cleanup working tree, 2026-10-27 | Chromium, real frontend with mock IPC, one worker | 137 passed, including hidden destination settings and Open folder IPC for default and portable storage. Native Explorer integration is not covered by these tests. |
| Release CLI MCP | Fresh release CLI, 2026-10-27 | Disposable empty library, real stdio JSON-RPC | Initialize, tool discovery and read-only article listing passed. Mutating tools are absent by default. |
| Updated release artifacts | Local `Lattice_0.1.0_x64-setup.exe`, SHA-256 `dbbe1a8be42be72e08b1ab91ec8440e09d75c0c53789b5ebcf7dc951ca6f2575` | Windows development host, pinned Tauri release build | NSIS and updater signature generation passed. Extracted CLI, Microsoft runtime and prerequisite helper match their inputs. Installer GUI differs from the release executable only in Tauri's three-byte NSIS bundle-type marker. Updater signature verification passed. Portable archive contains the matching GUI, CLI, marker and notices, with no library data. Installer upgrade and uninstall remain untested in the VM. |
| Native storage UI | Exact GUI executable from the updated portable archive, 2026-10-27 | Windows development host, disposable portable library | App starts with embedded frontend. Destination settings are absent. Open folder opens Explorer at the displayed portable data path. The fixture app and Explorer window were closed afterward. Default and custom storage still need native checks. |
| Signing setup | `scripts/setup-updater.ps1` and `scripts/verify-updater.mjs` | Disposable keys, then local release key | Real Tauri generation, signature verification, repeat without rotation and wrong-password refusal passed; both GitHub Secret names confirmed. |
| Visual C++ prerequisite packaging | Local working tree, 2026-10-27 | Windows development host; existing release binary rebundled | Installer and updater signature built; extracted Microsoft runtime and helper match the verified inputs; updater signature verified. Native NSIS version checks accept the installed runtime and reject an unmet version. Tampered runtime and missing/unsigned helper inputs rejected. User subsequently confirmed app launch in the Windows 11 VM; prerequisite cancellation/failure and restart-required cases remain pending. |
| CI | Pending | GitHub Actions, Windows | Pending |
| Installer smoke | Pending | Windows 10 | Pending |
| Installer smoke | Release preparation installer, then runtime prerequisite fix | Windows 11, VirtualBox | 2026-10-27: initial launch failed because `MSVCP140.dll` was missing. User confirmed that the app now starts. Close/restart, prerequisite cancellation/failure and the other native checks remain pending. |
| Portable smoke | Pending | Windows 10 | Pending |
| Portable smoke | Pending | Windows 11 | Pending |
| Backup restoration | Pending | Disposable library | Pending |
| Signed update | Pending | Controlled endpoint, disposable installation | Pending |
