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

1. Open **Settings** (the gear at the bottom left) › **AI providers** and set up at least one provider. Translation, summaries, classification, chat and quizzes need one. Saving, reading and full-text search work without one.
2. Press `Ctrl+K` and paste a URL to open it or add it to your library. To import files, use **Bulk import** under **Tools**. To subscribe to a feed, use **Manage** next to **Source**.
3. Open an article. Switch between **Original**, **Mixed** and **Translated** in the toolbar, or open the live page with **Page**.

## User guide

The [user guide](docs/guide.md) explains every feature, from collecting and reading to quizzes, shortcuts and the CLI.

## Settings and data

AI providers, translation, backups, export, where your data is stored and updates are covered in the guide's [Settings](docs/guide.md#settings) and [Data, privacy and safety](docs/guide.md#data-privacy-and-safety).

## Keyboard

Press `Ctrl+K` for the command palette. Every shortcut is listed in [Keyboard shortcuts](docs/guide.md#keyboard-shortcuts), and you can change them in **Settings › Shortcuts**.

## CLI and MCP

`lattice-cli`, in the portable zip next to `Lattice.exe`, searches and reads your library from a terminal and serves it to agents such as Claude Code as an MCP server:

```bash
claude mcp add lattice -- lattice-cli mcp
```

Saved articles are web pages written by other people, so an agent that reads them can be steered by instructions hidden in the text. Read [CLI and MCP](docs/guide.md#cli-and-mcp) for every command and for how to keep write access and other tools away from that agent.

## Development

To build Lattice from source, run its tests or cut a release, see the [developer guide](docs/development.md).

## License

MIT. See [LICENSE](LICENSE). Lattice adapts code from [Mazelingo](https://github.com/Yeq6X/mazelingo) and bundles fonts under the SIL Open Font License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
