**English** | [日本語](README.ja.md)

# Lattice

Lattice is a local-first desktop app for collecting, reading and searching technical articles. It stores each article's text on your machine. It translates and summarizes with the AI provider you choose, and you can read any article as a mix of the original and the translation.

- **Collect.** Save a URL, browse in the built-in browser and add the page you are reading, subscribe to RSS / Atom feeds (with filters for what gets added), or import bookmarks, URL lists, Markdown and PDF papers. Pages built with JavaScript are rendered before saving.
- **Read.** The Reader shows the extracted article. Switch between the original, the translation and a mix with an adjustable ratio, block by block. The Page view shows the live page with the same translation overlay. Open documents in tabs, split panes, or separate windows.
- **Organize.** Genres, tags, difficulty and an importance rating based on your own interests are assigned automatically, and you can change them. Collect articles into your own collections. Filter the list by scope and stack facets.
- **Search and ask.** Hybrid search combines full-text and semantic search, so a Japanese query finds English passages. The chat pane answers from your saved articles, with citations that jump to the cited passage.
- **Learn.** Check your understanding with an AI-made quiz, save unknown words with the sentence they came from, and review both with spaced repetition.
- **Keep it.** Everything is in one SQLite file. Local backups, JSON export and automatic backup to Cloudflare R2 are built in.

## Install

Lattice runs on Windows 10 and 11 (WebView2 is required; it is preinstalled on Windows 11).

Download it from the [Releases page](https://github.com/Maru32768/lattice/releases):

- **Installer** (`Lattice_x.y.z_x64-setup.exe`): installs Lattice and keeps it up to date.
- **Portable zip**: unzip anywhere and run `Lattice.exe`. All data stays in a `data` folder next to it.

If no release has been published yet, build it from source: see the [developer guide](docs/development.md).

## Getting started

1. Open Settings (gear icon at the bottom left) › AI providers and set at least one provider. Translation, summaries, classification, chat and quizzes need one; saving, reading and full-text search work without.
2. Press `Ctrl+K` and paste a URL to open it or add it to your library, or use ＋ in the sidebar to import or subscribe to a feed.
3. Open an article. Switch 原文 / 混在 / 訳文 (original / mixed / translated) in the toolbar, or open the live page with Page.

## Settings

### Display language

The UI is in Japanese or English. Lattice starts in the language of the system; Settings › Display language switches it at once, without a restart. It does not change how articles are translated: Japanese articles are translated into English and others into Japanese either way.

### AI providers

Settings › AI providers holds a fallback chain of up to three providers. Lattice uses the first one and moves to the next when a call fails (for example, on a usage limit). A provider that failed is skipped for 5 minutes.

| Provider | What it needs |
|---|---|
| Claude CLI | The `claude` command installed and signed in. |
| Codex CLI | The `codex` command installed and signed in. |
| OpenAI API | An API key |
| Gemini API | An API key |
| Anthropic API | An API key |

Enter API keys in Settings › AI providers. They are stored in the local database and never included in backups or exports. Lattice also reads the environment variables `OPENAI_API_KEY`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` when no key is saved.

Settings › Summaries & chat lets you describe yourself (interests, background knowledge). Summaries, chat answers, quizzes and importance ratings take it into account.

Article text is untrusted input. Lattice never gives an AI provider tools. The CLI providers run with tools, MCP servers and user settings disabled, in an empty temporary directory.

### Semantic search

Semantic search uses the multilingual-e5-small model (about 470 MB). It runs locally and is downloaded on first use. Until it is ready, search shows full-text results only.

### Backups

- **Local.** Settings › Backup writes a copy of the database and keeps the number of generations you set.
- **Export.** Settings › Export writes articles, translations, summaries, tags, feeds and chats as gzipped JSON lines, for the whole library or one collection.
- **Cloudflare R2.** Settings › Cloud backup (R2) uploads compressed backups on a schedule. [`infra/r2`](infra/r2/README.md) has Terraform that creates the bucket and an API token.

### Where data is stored

All data is in one SQLite file, `%APPDATA%\dev.lattice.app\lattice.db`. The same folder holds `backups\`, `exports\` and the semantic search model (`models\`). Logs are in `%LOCALAPPDATA%\dev.lattice.app\logs\`. Settings › Logs & storage shows the exact paths.

To keep the data somewhere else, press Change… in Settings › Logs & storage and pick a folder. Lattice copies the database, backups, exports and model there, uses the new folder after a restart, and leaves the old copy in place for you to delete.

The portable zip keeps everything in a `data` folder next to `Lattice.exe`, including logs and the in-app browser's cookies and cache. Update a portable copy by replacing `Lattice.exe` with the one from a newer zip.

### Updates

The installed version checks the Releases page at startup and offers to update in place (Settings › Updates).

## Keyboard

Press `Ctrl+K` for the command palette. It opens articles, tags, sources, genres and collections, runs commands, searches, and opens or saves a pasted URL. Settings › Shortcuts lists every shortcut and lets you change them, including several keys for one action.

## CLI and MCP

`lattice-cli` reads and adds to the same library from a terminal, and serves it to agents such as Claude Code as an MCP server. The portable zip has `lattice-cli.exe` next to `Lattice.exe`. It works while the app is running.

```bash
lattice-cli search "MVCC write skew" --limit 5
```

```bash
lattice-cli --format text get 42
```

Output is JSON unless you pass `--format text`. The commands are `search`, `get` (`--blocks`, `--translation`), `list`, `summary`, `tags`, `genres`, `feeds`, `jobs` and `ask`. `--scope` takes `unread`, `favorites`, `tag:NAME`, `genre:NAME`, `feed:ID`, `group:ID`, `important[:MIN]` (importance, default 4) or `article:ID` (several as `article:3,7`). `lattice-cli --help` lists everything.

- **Search** is hybrid, like the app's. If the app has not downloaded the semantic search model yet, results are full text only and the JSON says so.
- **Ask** answers from your saved articles through the AI providers set in the app, and the question shows up in the app's chat history.
- **Changes** (`save`, `tag`, `read`, `favorite`) need `--allow-write` or `LATTICE_ALLOW_WRITE=1`.

To use Lattice from Claude Code:

```bash
claude mcp add lattice -- lattice-cli mcp
```

This exposes search, get, list, summary, tags, genres, feeds, jobs and ask as tools. Add `--allow-write` after `mcp` to also expose save, tag, read and favorite.

**Prompt injection.** Saved articles are web pages written by other people, and an agent that reads them can be steered by instructions hidden in the text. Every tool result is marked as untrusted external content and capped in size. Keep write access off unless you need it, and do not give the same agent session tools that can do damage (shell, file writes, email) while it reads articles.

## Development

To build Lattice from source, run its tests or cut a release, see the [developer guide](docs/development.md).

## License

MIT. See [LICENSE](LICENSE). Lattice adapts code from [Mazelingo](https://github.com/Yeq6X/mazelingo) and bundles fonts under the SIL Open Font License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
