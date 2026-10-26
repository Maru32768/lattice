# Lattice 0.1.0 release checklist

This checklist records release evidence. An unchecked item is pending. Preparation started on 2026-10-26 in Japan. The version is `0.1.0`, and the publication date remains unset.

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
- [ ] Review the final diff and commit the intended release changes.
- [ ] Push the release commit and record green CI for that exact SHA, including E2E.

The search restriction and first-run explanation are covered by automated tests. Actual missing or unauthenticated providers still need packaged-app verification.

## Signing and update delivery

The signing key pair and both repository Secrets were configured on 2026-10-26. Automatic update installation remains unverified.

- [x] Generate a password-protected updater key pair outside the repository and verify the pair by signing a challenge.
- [ ] Back up both keys and the password independently of this Windows account. The local password copy is DPAPI-protected and cannot be recovered on another computer.
- [x] Configure the matching public key in `src-tauri/tauri.conf.json`. Include it in the release preparation commit.
- [x] Set repository Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- [x] Verify the Secret names without printing their values.
- [ ] Decide whether to use Windows Authenticode code signing and record the decision. Updater signatures are separate.
- [ ] Test a newer signed package through a controlled endpoint with a disposable installation.
- [ ] Verify rejection of an altered package, successful installation, restart and preserved library data.

## Packaged Windows checks

Record evidence for Windows 10 and Windows 11. Use a clean user profile without developer toolchains. Test the installer and portable archive on each OS.

- [ ] Install, start, close and restart the app. Cover an installer run without WebView2.
- [ ] Save and read an article with no AI provider. Restart and run full-text search.
- [ ] Check the model's first download, failure while offline, full-text fallback and download retry after reconnecting.
- [ ] Use one real API provider and one real CLI provider for translation, summary, quiz and chat. Correct invalid credentials and retry.
- [ ] Save a real JavaScript page, translate Page content, split panes and move a tab between windows.
- [ ] Create a collection, save a word, answer a quiz, complete a due review and confirm persistence.
- [ ] Verify CLI and MCP read access, then explicitly enabled write access.
- [ ] Check network allow and deny rules against public and local test destinations.
- [ ] Verify debug and release data separation, portable `data` and CLI data-directory overrides.
- [ ] Restore a backup with articles, images, translations, words and review history. Re-enter credentials and confirm the records.
- [ ] Move the data directory and restart. Reinstall and confirm that the library remains.
- [ ] Verify that portable update guidance preserves `data` and replaces the application binaries.

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
| Signing setup | `scripts/setup-updater.ps1` and `scripts/verify-updater.mjs` | Disposable keys, then local release key | Real Tauri generation, signature verification, repeat without rotation and wrong-password refusal passed; both GitHub Secret names confirmed. |
| CI | Pending | GitHub Actions, Windows | Pending |
| Installer smoke | Pending | Windows 10 | Pending |
| Installer smoke | Pending | Windows 11 | Pending |
| Portable smoke | Pending | Windows 10 | Pending |
| Portable smoke | Pending | Windows 11 | Pending |
| Backup restoration | Pending | Disposable library | Pending |
| Signed update | Pending | Controlled endpoint, disposable installation | Pending |
