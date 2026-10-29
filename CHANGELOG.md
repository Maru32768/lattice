# Changelog

All notable changes to Lattice are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). See [docs/release.md](docs/release.md) for how a release is cut.

## [Unreleased]

### Added

- **Notes.** Write a plain-text note on any article beside the Reader or Page view; it saves as you type and is included in the JSON export.
- **Genres.** Add a genre in Organize › Genres before any article has it; auto classification can then choose it.
- **Sites not to translate.** The Page view does not translate pages on the sites or URLs listed in Settings › Translation. `*` is allowed, and as in `.gitignore`, a line starting with `!` marks an exception (pages to translate). By default, the list holds the major search engines.

### Changed

- The navigation has a ＋ at its top (**Add articles**). It leads to pasting a URL, subscribing to a feed, bulk import and importing Markdown or a PDF, also once the library has articles.
- The navigation drops **Tools**. **Chat**, **Learn** (**Today's review**, **Vocabulary**), **Jobs** and **Settings** are fixed at its bottom, in view however long the article lists get. **Bulk import** moved to the ＋. A closed feed tree stays closed at the next start.
- Recent searches show under the empty search box instead of in the navigation, so starting a search no longer shifts the navigation's items.
- The set of saved articles is called the library everywhere: **Add to Index** is now **Save to library**, **Remove from Index…** is **Remove from library…**, and **Indexed** is **Saved**. The search method **Hybrid** is now **All**. **Recently added** and the **Needs attention** filter say what they hold in a tooltip.
- The **Collections**, **Genres** and **Source** headings in the navigation all have **Manage** beside them. Collections and genres are created, renamed and deleted with their article counts on a new **Organize** screen; genre management moved there from Settings, and collections are created there instead of with **+ New**.
- The article on screen is translated, summarized and quizzed right away, even while other jobs are queued or running.
- When an AI provider step fails and the next step answers instead, Settings › AI providers and Jobs show which step failed and why (for example, a CLI that is not installed). Before, only the log said so.
- Automatic translation of saved articles skips articles written in the display language (before, it always skipped Japanese articles). Turn on **Also translate articles in the display language** to include them.
- Translation runs several requests at once, across the batches of a long article or several articles, so it finishes sooner, and it no longer holds up summaries and classification. Set how many in Settings › Translation › Parallel requests (default 3).
- Importance is rated on both how close an article is to your interests and what you would gain from it. What you would gain is judged against what About you says you value. The rating reads the headings and the middle and end of the text as well as the start. Earlier ratings show as rated by earlier criteria until you choose **Rate again**.
- The feed manager drops its up and down buttons: feeds and folders are reordered by dragging their ⋮⋮ handle, as in the AI provider chain.
- Closing a document window closes its tabs instead of returning them to the main window. **Move back to the main window** still returns a tab.
- The article list shows a title in up to two lines and tags in one, cut off with "…", so that every row is the same height.

### Fixed

- Opening a fifth Page tab (with four already hidden behind other tabs) no longer freezes the app. The oldest hidden page is still closed as designed, and opens again when its tab is shown.
- When you drag a tab, the tab itself now moves along its row with the pointer, as in Chrome. Before, a faded copy followed the pointer. It swaps with the next tab once its edge passes that tab's middle (before, its middle had to pass).
- A tab dragged over another window's tab row moves into that window right away and shows its content there before you let go, as in Chrome.
- A tab dragged out of its window appears in its new window at once and under the pointer. Before, the window took 2-3 seconds to show and came up away from the pointer until the pointer moved.
- A web page no longer reloads when its tab moves to another window, by dragging or with **Open in new window** or **Move back to the main window**; it keeps its back and forward history and scroll position.
- A page saved from a feed that links `http://` no longer shows **Add to Index** when opened in the built-in browser over `https://`.
- A job that crashed partway, or whose result could not be recorded because the database was busy, used to stay **running** until the app restarted. It is now retried like any other failure.
- Opening Settings, closing the app and writing a local backup no longer wait for a running job to finish. The backup copies the database on a connection of its own, and the window closes once its position is saved.
- Importing a large URL list (bookmarks, CSV) no longer takes minutes to find the URLs in it.
- When a feed's entries could not be marked as imported, they were sent to the import filter again and again. This is fixed.
- Saving a page whose HTML tags are nested thousands deep crashed the app. Now the part that is too deep is cut off and the page is saved.
- A translation request to the built-in browser no longer freezes the app when a page finishes loading at the same time.
- A web page in the built-in browser can now trigger only the Lattice shortcuts the overlay was told to forward. Before, it could press any key the app binds.
- When the Claude or Codex CLI exits early (not logged in, usage limit reached), Jobs shows the CLI's own message. Before, it showed a broken-pipe error.
- A database written by a newer version of Lattice is refused when you open it, with a message giving the reason. Before, it opened and failed later.
- `lattice-cli`: the MCP server answers invalid requests (before, it stayed silent), survives invalid UTF-8 on its input, and reports a call to an unknown tool as a protocol error. `--format text` also prints backend errors as readable text.

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
