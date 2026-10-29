# Windows Authenticode signing (deferred)

Lattice releases are not Authenticode-signed, so Windows shows an unknown-publisher warning when the installer runs. Updates are verified separately by the updater signature ([release.md](release.md#signed-updates)). On 2026-10-27 we looked at signing through SignPath Foundation and deferred it: the project has not been public long enough, and the warning causes no real trouble yet. This page keeps what we found so the work can resume. Roadmap: J5 in [roadmap.md](roadmap.md).

## Options

| Option | Notes |
|---|---|
| [SignPath Foundation](https://signpath.org) | Free for open-source projects. Requires an application and acceptance (see below). The certificate is issued to SignPath Foundation. Every signing request is approved by hand. |
| Azure Artifact Signing (formerly Trusted Signing) | In 2026, open to organizations in a few regions and to individual developers in the USA and Canada only. Not available to an individual in Japan. |
| OV certificate on a cloud HSM | Paid every year. Pick a vendor whose key CI can use, so a release can be signed from GitHub Actions. |

## SignPath Foundation requirements

From the [terms](https://signpath.org/terms) (marked as a draft when read):

- An OSI-approved license for all of the project's own code, with no proprietary components (Lattice: MIT). The project is actively maintained, already released in the form to be signed, and its features are described on the download page.
- Only the project's own binaries are signed: `Lattice.exe`, `lattice-cli.exe` and the installer. Bundled third-party binaries, such as the Microsoft Visual C++ Redistributable inside the installer, are not signed with the project's certificate.
- Every signed binary has its product name and version set, and the artifact configuration enforces them. Tauri sets them on `Lattice.exe` and the installer; `crates/lattice-cli/build.rs` sets them on the CLI.
- Multi-factor authentication on GitHub and SignPath for every team member. The roles are authors, reviewers (changes from outside the team are reviewed) and approvers (each signing request is approved).
- The project page (README) and the release pages have a section titled **Code signing policy** that contains the sentence "Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)", the team roles with their members, and a privacy policy. The privacy policy can be a link or the sentence "This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it". The guide's [Network connections](guide.md#network-connections) table is the basis for it. Lattice checks GitHub for updates at startup without being asked, so link the table rather than use the sentence.
- Software that sends user data to systems the user did not choose must show its privacy policy during installation and offer to turn that off. Lattice sends none (the update check carries no library data), but confirm this reading with SignPath when applying.
- Builds run on GitHub-hosted runners, from source, and pass origin verification. The signing policy names the allowed branches, and the build must not reuse caches from earlier runs. Turn off `Swatinem/rust-cache` and the `jdx/mise-action` cache when signing.

Apply at https://signpath.org/apply.

## Release workflow design

What the release workflow would do. A draft was written and then dropped before it was run; nothing here has been tested on a real release.

1. Build without bundling: `npm run tauri build -- --no-bundle`, then `cargo build --release --locked -p lattice-cli`.
2. Upload `lattice.exe` and `lattice-cli.exe` with `actions/upload-artifact` (v4 or later), and submit them with `signpath/github-action-submit-signing-request@v3`. Inputs: `api-token`, `organization-id`, `project-slug`, `signing-policy-slug`, `artifact-configuration-slug: binaries`, `github-artifact-id`, `wait-for-completion: true`, `wait-for-completion-timeout-in-seconds` (approval is manual; allow an hour), `output-artifact-directory`, and `parameters: version: …`. Check each returned file with `Get-AuthenticodeSignature` and copy it back into `target/release`.
3. Build the installer from the signed files: `npm run tauri bundle -- --bundles nsis --no-binary-patching --config src-tauri/tauri.updater.conf.json`.
   - **`--no-binary-patching` is required.** The bundler writes the bundle type into the main binary before packing (`__TAURI_BUNDLE_TYPE_VAR_UNK` → `…_NSS`, `patch_binary` in tauri-bundler 2.10) and restores the unpatched copy afterwards. Either step breaks a signature applied earlier. Only NSIS is shipped, so the updater does not need the bundle type, and the portable copy refuses updates on its own.
   - `beforeBundleCommand` (`scripts/prepare-windows-bundle.ps1`) builds the CLI again. Cargo then copies its unsigned output over the signed `lattice-cli.exe`, so the script needs a switch (for example `LATTICE_CLI_PREBUILT`) to skip that build.
4. Upload and submit the installer (`artifact-configuration-slug: installer`), then copy the signed installer back.
5. Make the updater signature last, because Authenticode changes the file: `npx tauri signer sign <setup.exe>` with `TAURI_SIGNING_PRIVATE_KEY` and its password. Then check it with `scripts/verify-updater.ts` against the public key in `tauri.conf.json`.
6. Draft the release with `gh release` instead of `tauri-action`, which signs and uploads in one step. Write `latest.json` (`version`, `notes`, `pub_date`, and `platforms` with `windows-x86_64` and `windows-x86_64-nsis` entries holding `signature` and `url`). Add the code signing policy link to the notes. A re-run on the same tag must edit the existing draft (`gh release upload --clobber`).

Gate every signing step on the SignPath repository variables (`SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, secret `SIGNPATH_API_TOKEN`), so that a release still builds unsigned when they are missing. The job needs a longer `timeout-minutes`, because each request waits for an approver.

## Artifact configurations

The upload is a zip, so the root element is `<zip-file>`. Paths are relative to the zip's root. The `version` parameter is passed from the workflow.

`binaries`:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <zip-file>
    <pe-file path="lattice.exe" product-name="Lattice" product-version="${version}">
      <authenticode-sign />
    </pe-file>
    <pe-file path="lattice-cli.exe" product-name="Lattice" product-version="${version}">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

`installer` (SignPath's documentation does not mention NSIS; the setup is a PE file):

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <zip-file>
    <pe-file path="Lattice_${version}_x64-setup.exe" product-name="Lattice" product-version="${version}">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

## Open questions

- Whether a build triggered by a `v*` tag passes origin verification when the signing policy allows only the `master` branch.
- Whether SignPath reads the startup update check as a transfer that needs an installer privacy page.
- How the signed installer looks on a clean Windows machine. SmartScreen reputation builds up over time even with a valid signature.
