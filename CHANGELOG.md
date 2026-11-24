# Changelog

All notable changes to Lattice are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). See [docs/release.md](docs/release.md) for how a release is cut.

## [Unreleased]

### Added

- **Sources for summaries.** The sentences and key points of a summary end with numbers that point to the passages they come from. Click a number to go to its passage in the Reader.
- **A check of the numbers in summaries.** Numbers in a summary that are not in the article get a wavy underline and are listed below the summary.
- **The app serves AI agents over MCP.** AI agents such as Claude Code can use your library through an MCP server in Lattice. Turn the server on in **Settings › AI agents (MCP)**. For each agent, make a registration with the role **Read**, **Edit** or **Delete**, then copy its Claude Code command and run it. The same screen lists each agent's sessions and recent calls. Lattice asks you before each deletion that an agent requests. Changes that an agent makes show in the app at once.
- **More ways to change the library from `lattice-cli`.** With `--allow-write`, the CLI can remove a tag, a read mark or a favorite; rename articles and put them in genres; add and rename genres and delete empty ones; create and rename collections and add or remove their articles; subscribe to feeds, rename them and move them; and rename folders. With `--allow-delete`, it can also delete articles, collections and folders, unsubscribe from feeds, and merge genres. Agents get the same tools, depending on their role.
- **Choose the style of Japanese translations.** In **Settings › Translation**, **Japanese style** sets translations into Japanese to **Plain (da, de aru)** or **Polite (desu, masu)**. It works with the AI providers and with the local translation server. Translations are stored per style, so translate an article again to read it in the style you chose.
- **See a PDF's bordered tables in the Reader.** When a table in a PDF has borders around every cell, or around each column with a border under the header row, the Reader shows it as a table, right after its caption. Before, each cell became a separate paragraph, and the captions of the tables on a page could all come before the tables. As with tables on web pages, these tables are not translated. A page of vertical Japanese is now read down its columns, even when it has such a table. To apply this to a saved PDF, use **Re-extract**.

### Changed

- **Summaries are written differently.** The first sentence of a summary states the article's main claim or conclusion. Before, many summaries started by describing the article. The key points keep the article's specific names, numbers and results. Lattice sends the AI a whole article of up to 100,000 characters, and the start and the end of a longer one (before, articles were cut at 40,000). It sends tables and code too, up to 2,000 characters each. A long article in English or Korean sometimes got its summary in that language; Lattice now asks for Japanese after the article as well.
- Summaries no longer use **About you**. Your extra instructions for summaries still apply.
- Summaries made before this change show a note that regenerating them applies the change. Lattice does not regenerate them automatically.
- **Find a chat scope by typing.** **Scope** in the chat pane opens a list with a search field, so you can type part of a name to narrow it. The list has every scope, even in a library with thousands of tags, and the chat pane no longer slows down to show them.
- **The Tag filter lists every tag in the current list.** Before, it showed only the eight most common when nothing was typed. A tag you choose is checked; no row moves, and only the counts change. The order changes when you search again or reopen the filter. **Edit tags…** draws only the rows in view, so thousands of tags no longer slow it down.
- **Open a collection on a phone.** On a phone, **Filter** lists the collections under **Show**, alongside **Unread** and **All articles**. Choosing a collection shows all its articles, read or not, as in the PC's sidebar. Before, choosing a collection only narrowed the list you had chosen (**Unread** by default), so under **Unread** a collection whose articles were all read did not appear in **Filter**.
- **The chat's AI sits beside Send.** The button left of **Send** shows the AI that answers the chat. Click it to choose the provider, model and effort from a menu. The send-key hint below the question box is gone. **Send key** in **Settings › Summaries & chat** still sets the key.

### Removed

- **`lattice-cli mcp`.** Agents now use the MCP server in Lattice. If you added Lattice to Claude Code with `lattice-cli.exe mcp`, run `claude mcp remove lattice` in the folder where you added it, then make a registration in **Settings › AI agents (MCP)**.

### Fixed

- A focused drop-down in a chip, such as **Search scope** in the search pane, showed two focus rings, one inside the other. It now shows one.
- A footnote number or an exponent set in superscript ran into the number before it, so a year with footnote 1 read as `2019.1` and `10⁶` as `106` in the Reader, search and translations. It is now written in superscript digits (`2019.¹`, `10⁶`), and saved articles are read again from their stored pages, with no network and no LLM. Where this changes an article's text, its summary and quiz say that the article has changed, and Lattice does not regenerate them. In a translated article, the changed paragraphs are translated again if automatic translation is on.
- Deleting an article, importing it again or re-extracting it took about a second for each paragraph that went away, and other actions waited meanwhile, so a long article could hold up Lattice for minutes. It now takes a moment.
- **Some PDFs failed to import or lost their text.** Some PDFs whose fonts were written by PDF::API2, such as books, failed to import with an error that the PDF could not be parsed. The text of lines set with the PDF operators `'` and `"` was lost, and so was text in Japanese fonts that do not say which characters they draw. Lattice now imports these PDFs and reads their text. Vertical Japanese is now read column by column from the right. Japanese set with gaps between its characters, as in headings, no longer comes out with spaces. To apply this to a saved PDF, use **Re-extract**.

## [0.5.0] - 2026-11-18

### Added

- **Choose the AI for each chat.** **AI** in the chat pane picks the provider, model and effort for the chat. Only the chosen AI answers, and the chat keeps the choice. By default, a chat uses the fallback chain in **Settings › AI providers**.

### Changed

- **Each list keeps its filters.** Choosing a list in the navigation brings back the filters you last used in that list, even after a restart. Before, choosing a list cleared them. Back and forward no longer step through filter changes. `Esc` still clears the filters.

### Fixed

- Updating Lattice installed the Microsoft Visual C++ runtime again whenever Microsoft had released a newer one, which could take several minutes while other apps were open. It is now installed only when the one on the computer is older than Lattice needs.
- Sound, such as a video's, could come from pages you could not see: a page Lattice rendered in its hidden browser during an import, a page you had switched to the Reader, and a page in a hidden tab. These pages are now silent.
- A page could play sound, such as a video's, as soon as it opened. A page now plays sound only after you click it or press a key in it. But after that, another page on the same site that the page takes you to in the same tab, such as through a link, can play sound right away. On some sites, such as GitHub and MDN, a page can still play sound as soon as it opens. So can a page that another page on the same site sends you to while it loads. A muted video still starts by itself.
- When the computer ran out of memory, Lattice could close without leaving a reason anywhere. `out-of-memory.log` in the log folder now records the size of the memory request that failed.
- Preparing articles for search could keep more than 3 GB of memory in use until you closed Lattice. It now keeps about 1 GB and is faster.

## [0.4.0] - 2026-11-17

### Added

- **Read on a phone.** While the PC is on, a phone's browser can read the article list and each article's original, mixed or translated text, mark articles read, add favorites, save URLs and send words to the word book, with the same list filters as the PC. Turn it on and scan the QR code in **Settings › Read on a phone**. Away from home, it works behind a tunnel such as Tailscale, and a snapshot in Cloudflare R2 lets the phone read while the PC is off. `lattice-cli serve` runs the same server without the app.
- **Read with the keyboard.** In the Reader and the Page view (web pages and PDFs), `f` opens a link by its label, `gw` picks a word, `v` gives a caret and visual mode (`y` copies, `s` saves to Vocabulary, `a` quotes in the chat), `/` finds in the document, `]]` and `[[` go to headings, `gi` goes to an input field, and `yy` copies the URL. Counts work too, as in `5j`.
- `Ctrl+F` and `Ctrl+B` move a screen down and up in documents and lists, as in Vim.
- **tmux pane actions.** After `Ctrl+A`, `;` goes to the previous pane, `q` goes to a numbered pane, `Shift+H` and its neighbors resize the pane (within 500 ms, they work again without the prefix), `{` and `}` swap panes, `Shift+E` evens them out, `1` to `9` and `0` go to a numbered tab, and `w` lists the tabs.
- **Vim editing and the vimrc.** Vim key bindings now work in both the chat box and notes, with the rest of Vim's editing. `:w`, `:q`, `:wincmd`, `:split` and others work too. Paste or load the text of a `.vimrc` in **Settings › Vim**: mappings and some `set` options take effect, and each line left out is listed with its reason.
- `?` opens the key list. `:` or `;` opens the palette with `>` already typed. In the palette, `t:` searches the open tabs.
- **Lists and articles keep their place.** Each list, for each set of filters, opens where you left it, also after the settings and a restart. An article opens where you last read it, and switching between the Reader and the Page view keeps the paragraph you were reading. On a phone, the list keeps its filters and place when the page loads again, and articles open where you left them.
- **Delete unused translations.** **Settings › Logs & storage** shows how many translations no article uses, such as what you translated in the Page view on pages not in your library, and deletes them. Removing an article now also deletes the translations of its Page view.
- **Undo, export and load shortcuts.** In **Settings › Shortcuts**, after you press **Reset all to defaults** or load a file, **Undo** brings back the keys you had before. **Export** saves your changed keys to a file, and **Load from file** takes them to another computer.
- **Choose the chat's send key.** In **Settings › Summaries & chat**, **Send key** makes `Enter` send a question, with `Shift+Enter` for a new line, or makes `Enter` send while the question is one line. `Ctrl+Enter` always sends. With Vim key bindings, `Enter` in normal mode follows this setting, and `Enter` in insert mode stays a new line.
- **Import several PDFs at once.** On the import screen's PDF tab, choose or drop several PDFs, such as the chapters of a book, to import them together in file-name order. The **Don't translate automatically** checkbox keeps its setting for the next import, and the Markdown and PDF tabs share it.
- **Rename articles.** **Rename…** in the right-click menu changes the title of an article, such as a PDF imported in parts. The new title stays when the article is imported again, and **Reset** brings back the title Lattice gave it.
- **See a PDF's figures in the Reader.** Most figures stored in a PDF as images, such as a book's diagrams, appear in the Reader before their captions and are saved with the article. For figures drawn with lines and shapes, use the Page view. Re-extract a PDF imported earlier to add its figures.
- **A local translation engine.** In **Settings › Translation**, set **Translation engine** to **Local translation server** to translate with PLaMo 3 Translate on an OpenAI-compatible server that you run yourself, such as llama-server. Local translation uses no AI provider credits. Articles, PDFs and pages in the Page view are all translated with this engine.

### Changed

- **The default keys are now Vim first.** The command palette is `Ctrl+P` (it was `Ctrl+K`), moving between panes is `Ctrl+H` `Ctrl+J` `Ctrl+K` `Ctrl+L`, and printing is `Ctrl+Shift+P`. On a document, `j` and `k` scroll, and the next and previous article are `Shift+J` and `Shift+K`. `v` moved to `g v`, `y` to `g y`, `[` and `]` to `-` and `=`, and `f` to `Ctrl+A z`.
- **The tmux prefix is now `Ctrl+A`, and you can change it.** Version 0.3.0 used `Ctrl+B`, which now moves a screen up, as in Vim. Set another prefix under **Settings › Shortcuts › Prefix**. The default keys that start with the prefix move to the new one, and so do the keys you assigned with the prefix as their first key. Press the prefix twice (`Ctrl+A Ctrl+A` by default), and Lattice passes the second press on to the focused field or page, as tmux's send-prefix does. When the prefix is `Ctrl+A`, the second press selects all.
- `Ctrl+T` opens the search engine's home page in a new tab, as **New tab** (+) in the tab row does. It used to open the palette.
- If you bind `Space` in **Settings › Shortcuts**, including as the first key of a two-step key, the shortcut now works in web pages too. In a text field, `Space` types a space even when it is bound.
- **Focus mode shows only the focused pane.** The navigation, the article list, the chat and the other panes hide. Press it again to bring them back.
- The Vim key bindings setting moved from **Settings › Summaries & chat** to the new **Settings › Vim**. Your setting stays as it was.
- **Settings › Shortcuts** now puts the actions in six tabs by what they are for. The box above finds an action in every tab by its name or key, and **Press a key to find** finds the actions a key you press is assigned to. The key list on `?` is grouped the same way.
- `Esc` in a web page's text field leaves the field, unless the page uses it itself.
- Windows 10 is no longer a supported platform, and releases are no longer tested on it. The app is not blocked from running there.
- **The log keeps two weeks.** It used to keep only the last 40 KB. It is now one file a day (`lattice.YYYY-MM-DD.log`, named by the UTC date; the lines carry local time), and it also records errors the UI did not catch, crashes outside a job, and which job and article each line came from.
- **Seven settings are now saved in the database.** Shortcuts, the search engine, **Translate when I switch the view**, Vim key bindings, the vimrc, **Say word cards aloud** and **Underline saved words in articles** used to be stored on this computer only. They are in backups and move with the data folder. On the first start after the update, a setting the database does not have yet is copied from this computer, and one it already has is taken from the database.
- An empty article list no longer shows how many articles removing one filter would leave.
- The key hints under the article list and the search results are gone. `?` lists the keys, and `j` and `k` scroll that list.

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
- With Codex CLI 0.164, the AI could still see a tool that starts other agents and a tool that waits, although Lattice turns Codex's tools off. Both are off now, and Lattice's tests check which tools the installed Codex shows the AI.
- Some PDFs with images, such as the chapters of a book, failed to import with an error that the PDF could not be read. Lattice read the data of some images as if it were page content. Images are now skipped when the text is read.
- In a book's PDF, a list item was cut after its first line and a bullet was left on its own. The footer on every second page was mixed into the body text and split paragraphs that continued onto the next page. The smallest headings were read as paragraphs. As a result, the Page view left these parts untranslated. It also drew the translation of a heading at the top of a boxed note over the box's frame. Lists, footers and headings are now read as printed, and a one-line translation uses the space left on its line before it grows up or down.
- In a PDF's Page view, a paragraph that a page or column break left with only part of one sentence on one side showed no saved translation on either side, though the Reader had one. That sentence now goes whole to the other side when its box can hold it.
- Importing some malformed PDFs never finished and kept a processor core busy, and a PDF saved from a URL did the same again after every start. Such a PDF now fails to import with an error.
- Importing some other malformed PDFs closed the app, and a PDF saved from a URL closed it again on the next few starts. Others took hours to import. Such a PDF now imports without its broken part, or fails to import with an error.
- A PDF made to use up memory, or to take hours to read, could still close the app or keep it busy. Lattice now reads each PDF in a separate process limited to 2 GB of memory and 5 minutes, so such a PDF imports without the part over the limit, or fails to import with an error, and the app keeps running.
- In some PDFs that give their fonts for a group of pages rather than for each page, the Page view did not recognize formulas and translated them. They are now shown as printed.
- Each time you switched a tab from the Reader to the Page view, Lattice opened the page anew and loaded it again from the network, so the page took a while to show. Switching back to the Page view now shows the page you opened before, without loading it again, at the paragraph you were reading in the Reader.

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

[Unreleased]: https://github.com/Maru32768/lattice/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Maru32768/lattice/releases/tag/v0.5.0
[0.4.0]: https://github.com/Maru32768/lattice/releases/tag/v0.4.0
[0.3.0]: https://github.com/Maru32768/lattice/releases/tag/v0.3.0
[0.2.0]: https://github.com/Maru32768/lattice/releases/tag/v0.2.0
[0.1.0]: https://github.com/Maru32768/lattice/releases/tag/v0.1.0
