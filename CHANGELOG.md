# Changelog

All notable changes to Lattice are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). See [docs/release.md](docs/release.md) for how a release is cut.

## [Unreleased]

### Added

- **Read on a phone.** While the PC is on, a phone's browser can read the article list and each article's original, mixed or translated text, mark articles read, add favorites, save URLs and send words to the word book, with the same list filters as the PC. Turn it on and scan the QR code in **Settings › Read on a phone**. Away from home, it works behind a tunnel such as Tailscale, and a snapshot in Cloudflare R2 lets the phone read while the PC is off. `lattice-cli serve` runs the same server without the app.
- **Read with the keyboard.** In the Reader and the Page view (web pages and PDFs), `f` opens a link by its label, `gw` picks a word, `v` gives a caret and visual mode (`y` copies, `s` saves to Vocabulary, `a` quotes in the chat), `/` finds in the document, `]]` and `[[` go to headings, `gi` goes to an input field, and `yy` copies the URL. Counts work too, as in `5j`.
- **tmux pane actions.** After `Ctrl+B`, `;` goes to the previous pane, `q` to a numbered pane, `Shift+H` and its neighbors resize (within 500 ms the second key alone repeats), `{` and `}` swap, `Shift+E` evens, `1` to `9` and `0` go to a numbered tab, and `w` lists the tabs.
- **Vim editing and the vimrc.** Vim key bindings now work in both the chat box and notes, with the rest of Vim's editing. `:w`, `:q`, `:wincmd`, `:split` and others work too. Paste or load the text of a `.vimrc` in **Settings › Shortcuts**: mappings and some `set` options take effect, and each line left out is listed with its reason.
- `?` opens the key list. `:` or `;` opens the palette with `>` already typed. In the palette, `t:` searches the open tabs.

### Changed

- **The default keys are now Vim first.** The command palette is `Ctrl+P` (it was `Ctrl+K`), panes move with `Ctrl+H` `Ctrl+J` `Ctrl+K` `Ctrl+L`, and printing is `Ctrl+Shift+P`. On a document `j` and `k` scroll, and the next and previous article are `Shift+J` and `Shift+K`. `v` moved to `g v`, `y` to `g y`, `[` and `]` to `-` and `=`, and `f` to `Ctrl+B z`. Keys you changed in **Settings › Shortcuts** stay as they are.
- **Focus mode shows only the focused pane.** The navigation, the article list, the chat and the other panes hide. Press it again to bring them back.
- The Vim key bindings setting moved from **Settings › Summaries & chat** to **Settings › Shortcuts**. Your setting stays as it was.
- `Esc` in a web page's text field leaves the field, unless the page uses it itself.
- Windows 10 is no longer a supported platform, and releases are no longer tested on it. The app is not blocked from running there.
- **The log keeps two weeks.** It used to keep only the last 40 KB. It is now one file a day (`lattice.YYYY-MM-DD.log`, named by the UTC date; the lines carry local time), and it also records errors the UI did not catch, crashes outside a job, and which job and article each line came from.

### Fixed

- Images placed inside paragraphs or links were left out of the text and never showed in the Reader (the figures of many tech blogs). They are kept now, and saved articles are read again from their stored pages. Reading them again uses no network and no LLM, and while the words are the same, translations and summaries stay. The images it finds are downloaded if saving images is on in Settings. In a translated article, paragraphs that now break otherwise are translated if automatic translation is on.
- The Reader went back to the top when its pane split, closed or swapped, and when you came back to its tab. It now keeps the paragraph you were reading.
- Saving several articles from a site that names one page (often its home page) as canonical on every page kept only the first. Articles now merge only when their text matches. When they do merge, the tags, star, note and collections you gave the merged article move to the one that stays.
- While your data folder was unusable and Lattice ran from the default location, backups to R2 kept running, and uploads of the old data there replaced your library's backups one by one. Backups to R2 now stop until the folder is back.
- If Lattice could not open its database at startup, for example one written by a newer version, the app quit without a word at every launch. A chosen data folder now falls back to the default location with the reason in Settings, and otherwise a message says what is wrong.
- Interrupting a move of the data folder left a partial database in the new folder, which Lattice then offered to switch to. The database is now written last, and only once complete. Lattice also stays responsive during the copy.
- A job whose run ended the app, or stopped it some other way, ran again without limit at every start. It now counts as a failed try and waits like one, up to the usual five. Closing the app normally doesn't count, and its jobs resume at once at the next start.
- An internal error while rendering a page stopped page rendering until the next start, and one in a feed stopped feed updates. Each now fails only that job or that feed.
- A local backup that failed partway, for example on a full disk, stayed in the backups folder with your API keys in it and counted as one of the backups to keep. A backup now gets its name only once it is complete and free of keys, and what a failed one leaves is removed.
- An article you saved from the in-app browser while a bulk import or a feed still had it queued could be replaced by the queued fetch: by a thin page from the server, or marked as failed. The queued fetch now leaves an article that is already saved alone.
- Closing Lattice during a translation or another AI task left the `claude` and `codex` processes running, which went on using your quota. They now end with the app, however it ends.
- When one batch of a translation failed completely, the translations already returned for later batches were thrown away and paid for again on each retry, and a paragraph that always failed kept the rest of the article from being saved. Returned translations are now always saved, and the rest of the article goes on.
- When your AI provider was down or at its limit, each translation batch made up to 13 calls at once, beyond the parallel translations setting. A batch now stops after the first failed calls.
- When the app and `lattice-cli` or its MCP server opened the library at the same moment after an update, one of them could fail on the database upgrade. Writes from them at the same moment could also fail at once instead of waiting their turn.
- One article that the AI provider refused failed the classification or importance rating of up to 20 articles with it, on all five tries. Each retry now takes half as many articles, so the others get through.
- Asking for a translation, fetch, image download or search indexing while the same job was running was ignored, so a change made meanwhile could stay undone until the next start, or for good. For example, a feed article whose page refused could keep failing even though the feed had its text. These jobs now run once more when they finish.
- Closing Lattice while it fetched a URL you had just saved left the article loading forever. The fetch now resumes at the next start.
- A meaning you typed for a word while the AI was still looking it up was replaced by the AI's answer. Your meaning now stays.
- An article with many images on a site that did not answer stopped all other fetches from its site for a long time. Saving an article's images now pauses after five minutes and resumes later.
- The first search waited for the search model's download, about 470 MB. Search now shows full-text matches until it is ready.
- One article an API provider refused put that provider on a five-minute break, which sent all other jobs to the next one in the chain, possibly a paid API. A refusal now affects only that text.
- Deleting an article in one window left it in the lists and tabs of the others.
- An MCP server left running after you moved the data folder kept reading and writing the old copy. It now asks to be restarted.
- Sessions shorter than 15 minutes never made a backup to R2. The first check now comes after a minute.
- A translation that the AI returned under the wrong paragraph's number was saved, and the same wrong text then showed wherever that paragraph appeared. Such answers, and empty ones, are now asked again.
- Switching tabs while a web page was first opening could leave that page drawn over the tab you switched to.

## [0.3.0] - 2026-11-06

### Added

- **Pick the importance by hand.** Choose 1 to 5 under the title in the Reader. Your pick overrides the AI rating in sorting, **Important** and automatic summaries, and stays when articles are rated again; **Leave it to AI** goes back.
- The ✓ button beside the article list’s title (**Mark all as read**) marks every unread article the list shows as read, after asking.
- **Save to library** in the Page view also puts the page into the collection whose list is open.
- A middle-click or `Ctrl`+click on an article in the list, a search result, a chat citation or a link opens it in a new tab behind the current one, as in a browser, and so does a page's request to open a new window. Several line up in the order you opened them. From the palette the new tab still comes to the front.
- Right-click an article (in the list or on its tab) to set its importance, difficulty and genre from submenus, or to edit its tags; with several articles picked, the change applies to all of them.
- The import screen's files (URL list, Markdown, PDF), OPML and feed icons can also be dragged and dropped or pasted, besides being chosen. Relative images in Markdown are still read only with **Choose a file…**.
- `y` opens and closes the summary. In the Page view it shows the whole summary above the page, and pressing it again gives the page its full height back. Change the key in Settings › Shortcuts.
- **Settings › Logs & storage** has an **Open folder** button for the log folder too.
- The Page view of a PDF shows the saved original. It works for a PDF imported from a file too, and offline. **Mixed** and **Translated** draw the translation over the original's paragraphs. The ☰ at the top left opens the contents, and links inside the PDF work. `Ctrl`+wheel zooms and `Ctrl`+`P` prints.
- In a PDF's Page view, the button at the top right of a page translates only that page, or translates it again. Retranslating a whole long PDF is no longer the only way to redo a page.
- Automatic translation can be turned off per article in the ⋯ menu, and per file on the import screen's Markdown and PDF tabs. Importing, switching the view and scrolling in the Page view then start no translation for it, and **Translate** still works.
- **Settings › Shortcuts** can give any action a two-step key, as in tmux. The first key can be any key: click **+ Add key** and press two keys in turn. For a single key, press `Enter` after the first key. The keys after `Ctrl+B`, such as `"`, `%` and the pane moves, can be removed or changed there too.

### Changed

- The Codex CLI now gets short instructions fitted to this work, which takes about a third off the input tokens of each call.
- Importance rating now sees the titles of the articles a page links to on other sites, and rates a roundup (a newsletter issue or link collection) by its best entries instead of rating it low as a thin list. Earlier ratings show **(rated by earlier criteria)** until you rate them again.

### Fixed

- Images inside a paragraph or a link (as on many blogs) were dropped when an article was saved, so the Reader never showed them. For an article saved before, choose **Re-extract (from the saved HTML)** in the Reader’s ⋯ menu to get its images.
- Opening the editor of a feed low in the Feeds table no longer scrolls the whole window, which left a blank band under the app.
- With animation effects turned off in Windows, scrolling to the end of a long article list was pulled back a row just before the last article.
- Launching Lattice while it is already running now brings the open window to the front instead of starting a second copy. The two copies ran the same jobs, so the same request could be sent to an AI provider (and paid for) twice.
- Starting the app while `lattice-cli save --run` or the MCP server's `save` works on an article no longer makes the app take over its job and run it a second time. A job left running by a CLI stopped mid-run, or one whose result could not be recorded, now goes back to the queue within about a minute instead of staying stuck until a restart.
- A translation still running could keep going after being stopped, and mark a different job done when it finished, because a deleted job's number went to the next job. Job numbers are no longer reused.
- When an AI provider rate limited the Codex CLI, one call could take minutes. If another step is set up, Lattice now moves on to it without waiting, and returns to the Codex CLI once the limit is over. With no other step, or when the other steps fail too, it waits for the limit to end.
- A Codex CLI call cancelled partway no longer leaves its temporary files in `%TEMP%`.
- A dialog or the palette now dims the Page view together with the rest of the app. The app used to darken first.
- In the Page view, a page that changes its own address while its text waits for translation, as single-page sites do, no longer has that text marked as failed.
- With automatic translation off, translating an article from the palette now shows the result in its open Page view. It used to show nothing until a reload.
- Choosing **Translated** in the Page view of a Japanese page left it in Japanese instead of showing the English.
- The Page view now shows saved translations at once. Until now, sending them together with text that had none, such as a sidebar, left the article's text on "Translating…" until the AI provider answered. The same text also no longer goes to the AI provider several times.
- A table in a PDF stays visible under the translation in the Page view. A row as wide as the page made the whole table count as text and hid it.
- Text with a stacked superscript and subscript in a PDF stays one paragraph. It broke into overlapping pieces in the Page view.
- Superscripts and subscripts in a PDF's text stay raised and lowered in its translation in the Page view. They used to run into the letters before them.
- An appendix heading such as `A Paxos Leader-Lease Management` is now a heading, keeps its `A` in the translation and no longer merges with the text after it. To apply this to a saved PDF, use **Re-extract**.
- A PDF's Page view now uses the saved translation for a paragraph broken across columns or pages. It used to translate them again. A part that ends in the middle of a sentence still goes to the AI provider, as before.
- In a translated PDF, formulas look as they do in the paper. They are not sent to the AI provider: they go into the translation as they are.
- In a translated PDF, a paragraph at the top or bottom of a page also uses the margin, so its text shrinks less.
- Translated text in a PDF has wider line spacing. A paragraph that does not fit tightens its spacing before its text gets smaller.
- **Translate again** on a PDF also replaces the translations the Page view saved for parts of a paragraph. They used to keep showing there.

## [0.2.0] - 2026-10-30

### Added

- **Notes.** Write a plain-text note on any article beside the Reader or Page view; it saves as you type and is included in the JSON export.
- **Genres.** Add a genre in Organize › Genres before any article has it; auto classification can then choose it.
- **Sites not to translate.** The Page view does not translate pages on the sites or URLs listed in Settings › Translation. `*` is allowed, and as in `.gitignore`, a line starting with `!` marks an exception (pages to translate). By default, the list holds the major search engines.
- **Automatic summaries.** **Summarize automatically** in Settings › Summaries & chat writes a summary for each newly saved article, for all of them or only for those rated at or above an importance you choose. It is off by default.

### Changed

- The navigation has a ＋ at its top (**Add articles**). It leads to pasting a URL, subscribing to a feed, bulk import and importing Markdown or a PDF, also once the library has articles.
- The navigation drops **Tools**. **Chat**, **Learn** (**Today's review**, **Vocabulary**), **Jobs** and **Settings** are fixed at its bottom, in view however long the article lists get. **Bulk import** moved to the ＋. A closed feed tree stays closed at the next start.
- Recent searches show under the empty search box instead of in the navigation, so starting a search no longer shifts the navigation's items.
- The set of saved articles is called the library everywhere: **Add to Index** is now **Save to library**, **Remove from Index…** is **Remove from library…**, and **Indexed** is **Saved**. The search method **Hybrid** is now **All**. **Recently added** and the **Needs attention** filter say what they hold in a tooltip.
- The **Collections**, **Genres** and **Source** headings in the navigation all have **Manage** beside them. Collections and genres are created, renamed and deleted with their article counts on a new **Organize** screen; genre management moved there from Settings, and collections are created there instead of with **+ New**.
- Settings are regrouped by what you are doing: **AI**, **Collect**, **Read**, **Sorting**, **Learn**, **App** and **Data**. **About you** has its own section, apart from **Summaries & chat**. **Import filters** opens **Manage feeds**, where the per-feed filters are, and the settings list drops **Feeds →**. Type **Settings: Translation** or another section's name in the palette to open it directly.
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

[Unreleased]: https://github.com/Maru32768/lattice/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Maru32768/lattice/releases/tag/v0.3.0
[0.2.0]: https://github.com/Maru32768/lattice/releases/tag/v0.2.0
[0.1.0]: https://github.com/Maru32768/lattice/releases/tag/v0.1.0
