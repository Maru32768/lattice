# Changelog

All notable changes to Lattice are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). See [docs/release.md](docs/release.md) for how a release is cut.

## [Unreleased]

### Added

- **Notes.** Write a plain-text note on any article beside the Reader or Page view; it saves as you type and is included in the JSON export.
- **Genres.** Add a genre in Settings › Genres before any article has it; auto classification can then choose it.

### Changed

- The article on screen is translated (and summarized, and quizzed) right away in a slot of its own, instead of waiting behind queued jobs and the job already running.
- When an AI provider step fails and the next step answers instead, Settings › AI providers and Jobs show which step failed and why (for example, a CLI that is not installed). Before, only the log said so.
- Automatic translation of saved articles skips articles written in the display language (before, it always skipped Japanese articles). Turn on **Also translate articles in the display language** to include them.
- Translation runs several requests at once, across the batches of a long article or several articles, so it finishes sooner, and it no longer holds up summaries and classification. Set how many in Settings › Translation › Parallel requests (default 3).
- Importance weighs what you would gain from an article as well as how close it is to your interests, following what About you says you value, and looks at the headings and the middle and end of the text, not only the start. Earlier ratings show as rated by earlier criteria until you choose **Rate again**.
- The feed manager reorders feeds and folders by dragging their ⋮⋮ handle, as the AI provider chain does, instead of up and down buttons.

### Fixed

- A tab dragged out of its window appears in its new window at once and under the pointer. Before, the window took 2-3 seconds to show and came up away from the pointer until the pointer moved.
- A web page no longer reloads when its tab moves to another window, by dragging or with **Open in new window** or **Move back to the main window**; it keeps its back and forward history and scroll position.
- A page saved from a feed that links `http://` no longer shows **Add to Index** when opened in the built-in browser over `https://`.

## [0.1.0] - 2026-10-27

The first public release. Everything below is new.

### Getting started

- Windows 10 and Windows 11, x64. The installer sets up required runtimes; the portable version requires WebView2 and the Microsoft Visual C++ x64 runtime separately.
- Configure an AI provider in Settings to use translation, summaries, quizzes and chat. Search and reading work without one.
- Back up your library regularly. Restoring a backup does not restore credentials or local preferences; see the [backup guide](https://github.com/Maru32768/lattice/blob/v0.1.0/docs/guide.md#restore-a-backup).
- Windows code signing is deferred, so Windows may show an unknown-publisher warning. Updates are signed separately. Data in older identifier-named test folders is not moved automatically, and the browser profile starts fresh.

### Added

- **Collecting.** Save a URL, or add the page open in the built-in browser as it is rendered. Bulk import any text with URLs (lists, bookmarks HTML, CSV, JSON), fetched in the background with at most one request per host at a time. RSS and Atom feeds with autodiscovery, polling, custom names and icons, and the feed's own text for pages that refuse the fetch. Pages built with JavaScript are rendered in a hidden webview. Markdown files or pasted Markdown become articles, with images read from the file's folder. Re-extract an article from its stored snapshot.
- **Reading.** A Reader for the extracted article that shows the original, the translation, or a mix with an adjustable ratio, block by block. A Page view with the live page, an in-page translation overlay adapted from Mazelingo, back and forward history, a URL bar that also searches, and a home button. Images are saved in the database. Japanese articles are translated into English.
- **AI.** Translation, summaries, automatic genre, tag and difficulty classification, and a chat pane that answers from saved articles with citations that jump to the cited block. A fallback chain of up to three providers (Claude Code CLI, Codex CLI, OpenAI, Gemini, Anthropic), each with an optional reasoning effort, reordered by drag and drop. Extra instructions for translation, summaries and chat, a mode that keeps technical terms in English, and retranslation after changing the prompt or model.
- **Organizing.** Collections with manual article membership, feed folders, import filters, scopes (unread, favorites, recent, genres, feeds) with stackable facets, sort by added or published date, genre management, favorites, tags, read state, and deleting an article with everything derived from it.
- **Learning.** Article quizzes with grading and explanations, saved English vocabulary with meanings, pronunciation and examples, and daily spaced review of quiz and word cards using SM-2. Vocabulary import and CSV export.
- **Searching.** Hybrid full-text and semantic search (multilingual-e5-small, run locally) that points to the matching block.
- **Keeping data.** One SQLite file. Local backups by generation count, JSONL export, and automatic backup to Cloudflare R2 with a Terraform-managed bucket.
- **CLI and MCP.** Search, read and ask about the same library from the terminal or an MCP client. Read access is the default. Saving articles, adding tags, marking read and adding favorites require explicit write access.
- **App.** A processing-jobs screen with retry and cancel, a command palette (`Ctrl+K`), configurable shortcuts with tmux-style pane navigation, resizable panes, a custom title bar and app icon, site favicons, and an unread badge on the taskbar button.
- **Updates.** Support for signed updates from GitHub Releases, checked at startup and from Settings. When configured with a signing key, installed copies can download, verify, install and restart. Portable copies link to the download page.
- **Data location.** Move the data folder from Settings › Logs & storage (the data is copied, the old copy is kept), and a portable mode that keeps everything next to the exe when a `portable` file sits beside it.
- **Development data.** Debug builds use `%APPDATA%\Lattice Dev`; release builds use `%APPDATA%\Lattice`. The app and CLI share this distinction. Browser profiles, caches, logs and saved data-folder selections are separate. Portable and explicit CLI data-directory overrides keep their existing behavior. Existing release data is not moved.
- **Network destinations.** Direct downloads reject private networks by default. Allow and deny rules support hostnames, wildcard subdomains, IP addresses and CIDR ranges, with allowlist-only and allow-all modes. The rules cover article, PDF, feed, image and favicon downloads, including redirects. The built-in browser, JavaScript rendering, AI providers and backups use separate network paths.
- **Project.** MIT license, third-party notices, English and Japanese READMEs, and toolchains pinned with mise.

[Unreleased]: https://github.com/Maru32768/lattice/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Maru32768/lattice/releases/tag/v0.1.0
