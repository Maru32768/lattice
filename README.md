**English** | [日本語](README.ja.md)

# Lattice

Lattice is a local-first desktop app for collecting, reading and searching technical articles. It stores each article's text on your machine. It translates and summarizes with the AI provider you choose, and you can read any article as a mix of the original and the translation.

- **Collect.** Save a URL, browse in the built-in browser and add the page you are reading, subscribe to RSS / Atom feeds, or bulk import bookmarks, CSV, JSON or any text with URLs. Pages built with JavaScript are rendered before saving.
- **Read.** The Reader shows the extracted article. Switch between the original, the translation and a mix with an adjustable ratio, block by block. The Page view shows the live page, with the same translation overlay.
- **Organize.** Genres, tags and difficulty are assigned automatically, and you can change them. Filter the list by scope (unread, favorites, a genre, a feed) and stack facets (tags, source, difficulty, state).
- **Search.** Hybrid search combines full-text and semantic search, so a Japanese query finds English passages. Results point to the matching block inside each article.
- **Ask.** The chat pane answers from your saved articles, with citations that jump to the cited block.
- **Keep it.** Everything is in one SQLite file. Local backups, JSON export and automatic backup to Cloudflare R2 are built in.

## Requirements

- Windows 10 or 11 with WebView2 (preinstalled on Windows 11). The app is developed on Windows; macOS and Linux builds are untested.
- [mise](https://mise.jdx.dev/), which installs the pinned Node.js and Rust versions from `mise.toml`.
- Visual Studio 2022 Build Tools 17.10 or later (MSVC 14.4x) with the "Desktop development with C++" workload. ONNX Runtime, used for semantic search, requires it.
- At least one AI provider for translation, summaries, classification and chat (see [AI providers](#ai-providers)). Saving, reading and full-text search work without one.

## Getting started

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

`mise run dev` starts the app with hot reload. The first build compiles the Rust workspace and takes several minutes.

To build an installer and a standalone executable:

```bash
mise exec -- npm run tauri build
```

The installer is in `target/release/bundle/nsis/` and the executable is `target/release/lattice.exe`. Releases are cut from a tag by GitHub Actions; see [docs/release.md](docs/release.md).

## Configuration

Most settings are in the app (gear icon at the bottom left of the sidebar).

### Display language

The UI is in Japanese or English. Lattice starts in the language of the system (Japanese if it is Japanese, English otherwise); Settings › Display language switches it at once, without a restart. It does not change how articles are translated: Japanese articles are translated into English and others into Japanese either way.

### AI providers

Settings › AI providers holds a fallback chain of up to three providers. Lattice uses the first one and moves to the next when a call fails (for example, on a usage limit). A provider that failed is skipped for 5 minutes.

| Provider | What it needs |
|---|---|
| Claude CLI | The `claude` command on `PATH`, signed in. |
| Codex CLI | The `codex` command on `PATH`, signed in. |
| OpenAI API | `OPENAI_API_KEY` |
| Gemini API | `GEMINI_API_KEY` |
| Anthropic API | `ANTHROPIC_API_KEY` |

You can save API keys in the app (Settings › AI providers). Keys saved there are stored in the local database and are never included in backups or exports. If no key is saved, Lattice reads the environment variable.

To keep keys in environment variables, put them in `mise.local.toml` at the repository root. mise loads it automatically, and git ignores it. Start from the example:

```bash
cp mise.local.toml.example mise.local.toml
```

Then fill in the keys you use. `mise run dev` passes them to the app.

Article text is untrusted input. Lattice never gives an AI provider tools. The CLI providers run with tools, MCP servers and user settings disabled, in an empty temporary directory.

### Semantic search

Semantic search uses the multilingual-e5-small model (about 470 MB). It runs locally and is downloaded on first use. Until it is ready, search shows full-text results only.

### Backups

- **Local.** Settings › Backup writes a copy of the database and keeps the number of generations you set.
- **Export.** Settings › Export writes articles, translations, summaries, tags, feeds and chats as gzipped JSON lines.
- **Cloudflare R2.** Settings › Cloud backup (R2) uploads compressed backups on a schedule. [`infra/r2`](infra/r2/README.md) has Terraform that creates the bucket and an API token.

### Where data is stored

All data is in one SQLite file, `%APPDATA%\dev.lattice.app\lattice.db`. The same folder holds `backups\`, `exports\` and the semantic search model (`models\`). Logs are in `%LOCALAPPDATA%\dev.lattice.app\logs\`. Settings › Logs & storage shows the exact paths.

To keep the data somewhere else, press Change… in Settings › Logs & storage and pick a folder. Lattice copies the database, backups, exports and model there, uses the new folder after a restart, and leaves the old copy in place for you to delete. Picking a folder that already holds Lattice data switches to that data without copying; picking the default folder goes back to it. The choice is stored in `%APPDATA%\dev.lattice.app\data-location.json`.

Portable mode: when a file named `portable` (or `lattice.portable`) sits next to `Lattice.exe`, everything goes to a `data` folder beside the exe, including logs and the in-app browser's cookies and cache. The portable zip on the Releases page ships with that file. A portable copy is updated by replacing `Lattice.exe` with the one from a newer zip.

## Keyboard

Press `Ctrl+K` for the command palette. It opens articles, tags, sources and genres, runs commands, searches, and opens or saves a pasted URL. Settings › Shortcuts lists every shortcut and lets you change them.

## CLI and MCP

`lattice-cli` reads and adds to the same library from a terminal, and serves it to agents such as Claude Code as an MCP server. It finds the data folder the app uses (including a folder you chose and portable mode) and works while the app is running.

Install it from the repository:

```bash
mise exec -- cargo install --path crates/lattice-cli
```

The portable zip on the Releases page also has `lattice-cli.exe` next to `Lattice.exe`; it uses that copy's `data` folder.

```bash
lattice-cli search "MVCC write skew" --limit 5
```

```bash
lattice-cli --format text get 42
```

Output is JSON unless you pass `--format text`. The commands are `search`, `get` (`--blocks`, `--translation`), `list`, `summary`, `tags`, `genres`, `feeds`, `jobs` and `ask`. `--scope` takes `unread`, `favorites`, `tag:NAME`, `genre:NAME`, `feed:ID`, `group:ID`, `important[:MIN]` (importance, default 4) or `article:ID`. `--data-dir` points at another data folder. `lattice-cli --help` lists everything.

- **Search** is hybrid, like the app's. If the app has not downloaded the semantic search model yet, results are full text only and the JSON says so (`"mode": "full_text"`); the CLI never downloads the model.
- **Ask** answers from your saved articles through the AI providers set in the app, and the question shows up in the app's chat history.
- **Changes** (`save`, `tag`, `read`, `favorite`) need `--allow-write` or `LATTICE_ALLOW_WRITE=1`. `save` queues the page for the app, which fetches it within 30 seconds while it runs; `save --run` fetches and indexes it in the CLI instead.

To use Lattice from Claude Code:

```bash
claude mcp add lattice -- lattice-cli mcp
```

This exposes search, get, list, summary, tags, genres, feeds, jobs and ask as tools. Add `--allow-write` after `mcp` to also expose save, tag, read and favorite.

**Prompt injection.** Saved articles are web pages written by other people, and an agent that reads them can be steered by instructions hidden in the text. Every tool result is marked as untrusted external content, results are capped in size, and nothing in an article is ever run. Still, keep write access off unless you need it, and do not give the same agent session tools that can do damage (shell, file writes, email) while it reads articles.

## Development

```bash
mise run test
```

`mise run test` runs `mise run lint` (rustfmt, clippy and oxlint), then the Rust and frontend tests, and type-checks and builds the frontend.

```bash
mise exec -- npx playwright install chromium
```

```bash
mise run e2e
```

`mise run e2e` runs the browser tests in `e2e/`: Vite serves the real frontend with the Tauri IPC replaced by a mock backend (`e2e/mock.ts`) over sample data (`e2e/fixtures.ts`), and Playwright drives it in Chromium. The app itself is not started and no real data is touched. The first command installs the browser once.

CI (`.github/workflows/ci.yml`) runs the lints, all tests and the e2e suite on Windows for every push and pull request to `master`.

| Path | Contents |
|---|---|
| `crates/lattice-core` | Domain logic without Tauri: fetching, extraction, storage, jobs, translation, search, chat, backup. |
| `crates/lattice-cli` | The `lattice-cli` command and its MCP server, on `lattice-core` alone. |
| `src-tauri` | The Tauri app: commands, background runners, the in-app browser. |
| `src` | The React frontend. |
| `src/overlay` | The script injected into pages in the in-app browser (translation overlay, page snapshots). |
| `e2e` | Browser tests: the mock backend, sample data and Playwright specs. |
| `infra/r2` | Terraform for the R2 backup bucket. |
| `docs` | Design notes (`design-review.md`) and the roadmap (`roadmap.md`). |

## License

MIT. See [LICENSE](LICENSE). Lattice adapts code from [Mazelingo](https://github.com/Yeq6X/mazelingo) and bundles fonts under the SIL Open Font License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
