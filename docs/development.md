# Developing Lattice

This guide is for people who build, change or release Lattice. For using the app, see the [README](../README.md).

## Requirements

- Windows 10 or 11 with WebView2 (preinstalled on Windows 11). Lattice is developed on Windows; macOS and Linux builds are untested.
- [mise](https://mise.jdx.dev/), which installs the pinned Node.js and Rust versions from `mise.toml`.
- Visual Studio 2022 Build Tools 17.10 or later (MSVC 14.4x) with the "Desktop development with C++" workload. ONNX Runtime, used for semantic search, requires it.

## Setup

```bash
git clone https://github.com/Maru32768/lattice.git
```

```bash
cd lattice
```

```bash
mise install
```

```bash
mise exec -- npm install
```

```bash
mise run dev
```

`mise run dev` starts the app with hot reload. The first build compiles the Rust workspace and takes several minutes. The dev build uses the same data folder as an installed copy (`%APPDATA%\dev.lattice.app`), so it opens your real library.

### API keys in development

Put provider keys in `mise.local.toml` at the repository root; mise loads it after `mise.toml`, and git ignores it.

```bash
cp mise.local.toml.example mise.local.toml
```

Keys saved in the app (Settings › AI providers) take precedence over these environment variables.

## Checks

```bash
mise run test
```

`mise run test` runs `mise run lint` (rustfmt, clippy with `-D warnings`, oxlint, Prettier, and a check that React Compiler compiled every component), then the Rust and frontend unit tests, and type-checks (the unit tests too) and builds the frontend.

```bash
mise exec -- npm run format
```

formats the TypeScript with Prettier (`.prettierrc.json`); `npm run lint` fails on unformatted files.

```bash
mise exec -- npx playwright install chromium
```

```bash
mise run e2e
```

`mise run e2e` runs the browser tests in `e2e/`: Vite serves the real frontend with the Tauri IPC replaced by a mock backend (`e2e/mock.ts`) over sample data (`e2e/fixtures.ts`), and Playwright drives it in Chromium. The app itself is not started and no real data is touched. Set `E2E_PORT` when several checkouts run the suite at once. `e2e/commands.test.ts` fails when `src/api.ts` gains a command the mock does not answer.

CI (`.github/workflows/ci.yml`) runs the lints, all tests and the e2e suite on Windows for every push and pull request to `master`.

## Conventions

- **UI text** lives in `src/i18n/ja.ts` (the key source) and `src/i18n/en.ts` (must match it). A Japanese literal in UI code fails `src/i18n/literals.test.ts`.
- **Backend messages** that reach the UI are codes: `msg!("code", name = value)` in Rust, with a `be.<code>` entry in both catalogs (checked by `src/i18n/backend.test.ts`).
- **Untrusted content.** Article text, pages and feed data are untrusted: the UI renders them as text only, and LLM providers never get tools.
- **Migrations** are append-only (`crates/lattice-core/src/store.rs`); a migration test should find its migration by content, not by index.

## Building

```bash
mise exec -- npm run tauri build
```

The installer is in `target/release/bundle/nsis/` and the executable is `target/release/lattice.exe`. Releases are cut from a tag by GitHub Actions; see [release.md](release.md).

The CLI can be installed from source:

```bash
mise exec -- cargo install --path crates/lattice-cli
```

The app icon is drawn in `src-tauri/icons/icon*.svg`: `icon.svg` for 64px and up, and its own pixel-grid source for each of 16, 24, 32 and 48px so the weave stays sharp. After editing them, regenerate the PNG / ICO / ICNS set and the title bar logo (`src/app/logo.svg`):

```bash
mise exec -- node scripts/icons.mjs
```

## Project layout

| Path | Contents |
|---|---|
| `crates/lattice-core` | Domain logic without Tauri: fetching, extraction, storage, jobs, translation, search, chat, backup. |
| `crates/lattice-cli` | The `lattice-cli` command and its MCP server, on `lattice-core` alone. |
| `src-tauri` | The Tauri app: commands, background runners, the in-app browser, pop-out windows. |
| `src` | The React frontend, one folder per feature (`library`, `reader`, `browser`, `chat`, `search`, `feeds`, `import`, `quiz`, `vocab`, `jobs`, `settings`), the app shell (`app`) and pane layout (`layout`), with shared UI parts in `ui` and helpers in `lib`. `api.ts` (the IPC client) and `main.tsx` stay at the top. |
| `src/i18n` | The UI text catalogs and the translation functions. |
| `src/overlay` | The script injected into pages in the in-app browser (translation overlay, page snapshots, shortcut forwarding). |
| `e2e` | Browser tests: the mock backend, sample data and Playwright specs. |
| `infra/r2` | Terraform for the R2 backup bucket. |
| `scripts` | Version bump, license list, i18n extraction, icon generation. |

## Design notes

- [design-review.md](design-review.md): design decisions per feature (in Japanese).
- [roadmap.md](roadmap.md): what is done and what is planned (in Japanese).
- [release.md](release.md): versioning, signing and publishing.
