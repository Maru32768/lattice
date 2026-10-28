**English** | [日本語](guide.ja.md)

# Lattice user guide

This guide explains Lattice's features and how to use them, one feature at a time. The [README](../README.md) covers installation and an overview.

Names in **bold** are the buttons and menus you see when the display language is English. **Settings › Translation** means the **Translation** section of the **Settings** screen.

- [Getting started](#getting-started)
- [Collect articles](#collect-articles)
- [Read an article](#read-an-article)
- [Tabs, panes and windows](#tabs-panes-and-windows)
- [Organize your library](#organize-your-library)
- [Search and ask](#search-and-ask)
- [Learn from what you read](#learn-from-what-you-read)
- [Background jobs](#background-jobs)
- [Settings](#settings)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [CLI and MCP](#cli-and-mcp)
- [Data and backups](#data-and-backups)
- [Privacy and safety](#privacy-and-safety)
- [Troubleshooting](#troubleshooting)

## Getting started

### The screen

The main window has these areas, from left to right.

| Area | What it holds |
|---|---|
| Navigation (the left sidebar) | The article lists (**Library**, **Collections**, **Genres**, **Source**), **Tools** (**Chat**, **Today's review**, **Vocabulary**, **Jobs**, **Bulk import**), and **Settings** at the bottom |
| Article list | The articles of the list chosen in the navigation, with filters and sorting above them |
| Document area | Articles and web pages open here in tabs. You can split it into several panes |
| Chat pane | Opens at the right edge when you click **Chat** in the navigation |

The title bar at the top has back and forward buttons (‹ ›) for the places you visited in the app, and a box that opens the command palette (**Search, commands, URLs**, `Ctrl+K`).

- Drag the border between two areas to resize them. Double-click a border to restore its default width. Widths are kept for the next start.
- Close the navigation with the button at its top, and the article list with its own button. A closed article list becomes a thin strip, and the same button opens it again.
- **Manage feeds**, **Jobs**, **Bulk import**, **Vocabulary** and **Today's review** take the place of the article list and document area. **Settings** also takes the navigation's place. `Esc` returns to the library.

When the library is empty, the document area shows **Add your first article**. From there you can paste a URL, subscribe to a feed, run a bulk import or import Markdown.

### Set up an AI provider

Translation, summaries, classification, importance, quizzes, word meanings, the LLM feed filter and chat send text to an AI provider. To use them, set up at least one provider in **Settings › AI providers**. Saving, reading and full-text search work without one.

These providers are supported:

| Provider | What you need |
|---|---|
| Claude CLI | The `claude` command, installed and signed in |
| Codex CLI | The `codex` command, installed and signed in |
| OpenAI API | An API key |
| Gemini API | An API key |
| Anthropic API | An API key |

**Steps.** You can list up to three providers as steps. Lattice normally uses the first step. When a call fails (for example, because a usage limit was reached), it repeats the same work with the next step. A step that failed is skipped for the next 5 minutes. When a step fails while another answers, **Settings › AI providers** and **Jobs** show which step failed and why, for example a CLI that is not installed. Drag the steps to reorder them. With the keyboard, press `Space` to pick a step up, move it with the arrow keys, and press `Space` again to drop it.

**Model and effort.** Each step has a provider, a model and an effort. Effort sets how long the model thinks. Raising it can improve quality, but it is slower and costs more. For translating many articles, a fast model with low effort works well. To use a model that is not in the list, choose **Custom model ID** and enter its ID. If you choose an effort the model does not support, that step's calls fail and Lattice moves on to the next step.

**API keys.** For an API provider, enter its key under **API keys**. Keys are stored in Lattice's database and never shown again after you save them. They are not included in backups or exports. When no key is saved, Lattice reads the `OPENAI_API_KEY`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` environment variables.

[What goes to AI providers](#what-goes-to-ai-providers) lists what each feature sends.

### Write About you

Write your job, interests and the knowledge you can take for granted in **About you** under **Settings › Summaries & chat**, and the AI tailors its output to it. It holds up to 2,000 characters. These features use it:

- Summaries and chat answers
- Quiz questions
- Article [importance](#importance) (articles are not rated while **About you** is empty)
- The LLM feed filter

## Collect articles

For each article, Lattice saves its text, its images and the HTML it was extracted from. You can still read a saved article after the original page changes or disappears. In Lattice, the set of articles you have saved is called the Index.

### Save a URL

1. Press `Ctrl+K` to open the command palette.
2. Paste the URL.
3. Choose **Add to Index (import)**, or press `Ctrl+Enter`.

The page is fetched in the background.

With a URL pasted, the palette also offers:

- **Open in Page**: opens the page in the built-in browser without saving it.
- **Find and add its feed**: looks for the site's feed and subscribes to it.
- **Open in Reader**: opens the saved article when you have already saved the URL.
- When the list shows a collection, an item that saves the URL into that collection.

Lattice decides whether a URL is already saved after removing tracking parameters such as `utm_source`. A URL that differs only in those parameters opens the existing article instead of saving a new one. Saving the URL of an article whose fetch failed fetches it again.

### Save the page you are browsing

To save the page you are viewing in the Page view (the built-in browser), click **Add to Index** in the toolbar. Lattice saves the page as the browser shows it, so pages built with JavaScript and pages that need a login come in complete. Once saved, the toolbar shows **Indexed**, and the Reader, tags, genres and favorites become available.

### Import files

Open **Bulk import** under **Tools** in the navigation. The screen has three tabs: **URL list**, **Markdown** and **PDF**. Choose a collection in the **Collection** field above the tabs to put the imported articles in it.

**URL list.** Reads any text that contains URLs: a plain list of URLs, bookmarks exported from a browser (HTML), CSV, JSON, or an export from another read-later service. Paste the text or choose a file, then click **Import**. Fetching runs in the background, and the screen reports how many URLs were new, already saved or invalid. Pages that fail to fetch do not stop the rest of the import.

**Markdown.** Turns one Markdown file, or pasted text, into one article.

- The title is the first level-1 heading (`# `). Without one, Lattice uses the file name or the first line.
- Images with a web URL such as `https://` are downloaded and saved. Images with a relative path are read from the file's folder, only when you import from a file.
- HTML tags are not imported.
- There is no original web page, so the Page view is not available.

**PDF.** Turns a PDF, such as a paper, into one article. Lattice reads the text in the PDF and rebuilds the reading order of two-column layouts, headings, figure and table captions, and references. A PDF without text data (a scan made only of images) cannot be imported.

A PDF URL such as arXiv's `…/pdf/…` can be saved like any other URL, without this tab. PDFs in feeds are imported too.

### Subscribe to feeds

When you subscribe to an RSS or Atom feed, Lattice imports its new articles automatically. Open the feed manager with **Manage** next to **Source** in the navigation, or with **Manage feeds** in the palette.

#### Subscribe

Enter a site or article URL and click **Find**. Lattice looks for a feed:

1. If the URL is a feed itself, it becomes the candidate.
2. Otherwise, Lattice looks for links to feeds in the page.
3. If there are none, it tries common places such as `/feed` and `/rss.xml`.

Pick a candidate and click **Add and import the latest 20**.

If you already know the feed URLs, paste them one per line to subscribe to all of them without searching for links.

#### When feeds are checked

Lattice checks every feed for new entries when it starts and every 30 minutes after that. A newly added feed imports its latest 20 entries; after that, only new entries are imported. **Refresh all** checks all feeds now.

In the feed manager, each feed's row shows its status, last update, unread count and article count. **View articles →** opens the list of that feed's articles.

Removing a feed keeps the articles it imported. They move to **Added by hand** in the navigation.

#### Folders

A folder groups feeds. It helps when one site has many feeds, such as a service with an RSS feed for every channel. A feed can be in only one folder, and folders cannot contain folders.

- **Create.** Enter a name in the **Folders** field of the feed manager and click **Create**. You can rename, reorder and delete folders there too.
- **Put a feed in a folder.** Choose the folder in the feed's row. To move several feeds at once, check them and click **Move to folder…**.
- **File a feed as you add it.** Before adding it, choose the folder in the folder menu next to the input (it starts at **No folder**). This menu appears only when at least one folder exists.
- **In the navigation.** A folder is a row you can expand and collapse, and its number is the total unread count of its feeds. Clicking a folder lists the articles of all its feeds. Right-click it or use ⋯ to rename or delete it. Deleting a folder keeps its feeds.

#### Feed order

Feeds keep the order you give them, within each folder and among the feeds outside any folder. The navigation, the feed manager, the palette, the scope menus, OPML export and the CLI all use this order.

In the navigation, reorder by dragging:

- Drop a feed on another feed to put it there. That feed can be in another folder.
- Drop a feed on a folder's row to put it at the end of that folder, even when the folder is collapsed.
- To take a feed out of its folder, drop it between feeds that are outside any folder. When every feed is in a folder, a **Drop here to take it out of its folder** area appears at the bottom while you drag.
- Drag a folder's row to change the order of folders. Its feeds move with it.

Only dragging changes the order. A short click still opens the feed or folder.

With the keyboard, focus a feed or folder row and press `Alt+↑` or `Alt+↓` to move it one place. A feed moved past the start or end of its folder enters the neighboring folder, which opens if it was collapsed.

In the feed manager, drag the ⋮⋮ handle on a row of the feed table or the **Folders** list. Dropping a feed on a feed in another folder moves it there. With the keyboard, focus ⋮⋮, press `Space` to pick the row up, move it with the arrow keys, and press `Space` again to drop it.

The feed manager lists feeds by folder in the same order.

#### Name and icon

**Edit** in a feed's row lets you change its **Display name** and **Icon**. The icon can be a PNG, JPEG, GIF, WebP, SVG or ICO image of up to 1 MB. Without one, the site's icon is shown. **Revert** restores the feed's own name, and **Use the site's icon** restores the site's icon.

#### Import filters

Filters decide which new entries from a feed get imported. You can set them in two places:

- The global filter, in **Settings › Import filters**, applies to every feed.
- A feed's own filter is in **Edit** in its row.

An entry is imported only when it passes both. A filter can combine these conditions:

- **Rules.** Match a keyword or regular expression against **Title**, **URL**, **Author**, **Category**, **Domain** or **Language**. Case is ignored. There are rules that skip entries and rules that import only matching entries. An entry that matches any skip rule is not imported. When there is at least one import-only rule, only entries that match one of them are imported.
- **Shortest text.** Skips entries whose text is shorter than this many characters. It applies only to feeds that include the article text.
- **LLM judgment.** With **Let the LLM judge what passes the rules** on, the AI provider judges the entries that passed the rules. Lattice sends the entry's title, URL and excerpt, **About you**, and **What to import**. When you choose **Lowest importance**, entries are imported when the AI's 1–5 score is at least that value. If the AI call fails, the entry is imported so that nothing is lost, and the feed shows why the call failed.

Entries a filter skipped are kept under **Rejected entries**, with the reason.

- **Import** imports one entry.
- **Remove this rule** deletes the rule that skipped it.
- Changing the rules does not import earlier rejections by itself. To judge them with the current rules, click **Judge rejected entries again**.

#### OPML

Use OPML to move feeds between Lattice and other feed readers.

- **Import OPML** subscribes to the feeds in an OPML file. An outline element that contains feeds becomes a folder.
- **Export OPML** writes the feed list, with its folders, to the `exports` folder.

### Pages that don't extract well

Some pages have almost no text in the HTML that is first downloaded and show their text only after JavaScript runs. When such a page is saved, its text is empty or under 300 characters, and the article list shows **Extraction failed** or **Little text**.

**Render automatically.** With **Render JS pages automatically** on in **Settings › Import & JS rendering**, Lattice opens the page in a hidden browser, renders it and imports the text again. This takes up to about 20 seconds per article. Lattice tries the same when a site refuses the fetch with an error that a browser might get past, such as 403 or 429. The rendered result replaces the article only when it has more text than before.

**Import again by hand.** **Render and import again** in the article's ⋯ menu does the same on demand. In the Page view, **Import again from the page as shown** is also available. It imports from the page as it is on screen, so content you see after logging in is included.

**Use the feed's text.** Some sites refuse requests that don't come from a browser. When the site's feed includes the article text, Lattice builds the article from the feed and says so in the Reader. **Retry** in the Reader fetches the original page again.

## Read an article

### Reader and Page view

A saved article can be read in two views. Switch with **Reader** and **Page** at the left end of the toolbar, or press `v`.

- The **Reader** shows the text extracted from the page, with headings, lists, code, tables and saved images. It never loads anything from the web to show it.
- The **Page view** shows the original web page in the built-in browser. Translation and saving words work as in the Reader.

Imported Markdown and PDF files have no original web page, so they have no Page view. A PDF saved from a URL opens in the browser's PDF viewer in the Page view.

**The toolbar.** Both views have the same buttons at the right end of the toolbar: **Favorite**, **Mark as read**, **Ask**, **Quiz**, **Note**, focus mode and the ⋯ menu. The ⋯ menu has:

- **Re-extract**: rebuilds the article from the saved HTML, PDF or Markdown without going online. Use it after a Lattice update improves text extraction.
- The import-again actions (see [Pages that don't extract well](#pages-that-dont-extract-well))
- **Auto-classify**, **Translate again**, **Summarize**, **Copy URL** and **Remove from Index…**

**The built-in browser.** The Page view's toolbar has back, forward, reload and **Home (search engine)**. Click the URL to edit it, press `Enter` to open it, or `Esc` to stop editing. Text that is not a URL is searched with the search engine chosen in **Settings › Browser**. Your logins to sites are kept after you quit Lattice.

### Original, translated or mixed

The switch right of **Reader** and **Page** chooses the language of the text.

- **Original**: the text as written.
- **Translated**: the translation.
- **Mixed**: only some sentences are translated. The percentage next to it is the share shown in the app's display language (English): the original's share in an English article, the translation's in a Japanese one. Press `[` to lower it by 10% and `]` to raise it by 10%.

The article's language sets the direction: Japanese articles are translated into English, and articles in any other language into Japanese. Switching the app's display language does not change this.

**Mixed** picks the translated sentences the same way in the Reader and the Page view: within each paragraph, so that the two languages alternate. The choice follows the article's (page's) address and text, so the same article always mixes the same sentences. A paragraph of one sentence (a heading, say) is shown whole in whichever language its sentence gets.

The Reader and the Page view remember their choice of **Original**, **Mixed** or **Translated** separately, but share the **Mixed** percentage: changing it in one changes it in the other. A choice applies to every article (every page, in the Page view) until you change it. When Lattice starts, the Reader is at **Mixed** 70% and the Page view at **Original**.

### Switch one paragraph

Rest the pointer on a translated sentence and a bubble shows it in the other language. Click the bubble to switch only that sentence. In the Reader, the small mark at the paragraph's edge switches the whole paragraph to the other language. With the keyboard, focus the paragraph and press `Enter`.

### Translate an article

The Reader's toolbar shows how far translation has gone (for example, **Translated 12/40**). In the article list, an article being translated or waiting for it is labeled **Translating 12/40** or **Waiting to translate**, whether or not it is open. The label goes away once it is translated.

- **Starting automatically.** With **Translate when I switch the view** on (the default), switching to **Mixed** or **Translated** starts translating an article that is not translated yet.
- **The article on screen goes first.** Translation, the summary and the quiz of the articles you are looking at (the front tab of each pane) start right away in a slot of their own, instead of waiting behind queued jobs or the job already running.
- **Starting by hand.** Click **Translate**. On a partly translated article, **Translate the rest** translates the remaining paragraphs. Hold the pointer over the button to see which language it translates into.
- **Translating again.** **Translate again** drops this article's translations and translates it again with the current provider and settings. It is in the ⋯ menu once any paragraph is translated, and also in the toolbar once all of them are. Articles with more than 50 translated paragraphs ask you to confirm. It is unavailable while this article's translation is running.
- **When it fails.** The toolbar shows **Failed**, the time of the next automatic retry and a **Retry** button, and a note above the text gives the error. Paragraphs that were already translated are kept, so a retry sends only the rest.

**Shared translations.** Translations are stored per paragraph text. A paragraph translated in the Page view is translated in the Reader too, and the other way around. Other articles and pages that contain the same paragraph use that translation as well. So **Translate again** also renews the translation in other articles and pages that share the paragraph.

**Translating in the Page view.** Choosing **Mixed** or **Translated** in the Page view translates the page as you read it. Paragraphs already written in the target language are not sent to the AI provider. While it works, the page's tab shows **Translating** and how many paragraphs are done (for example, **Translating 3/10**), also for a tab in the background.

**Translation settings.** **Settings › Translation** has these options. Each applies to translation in both the Reader and the Page view.

| Setting | What it does |
|---|---|
| **Translate when I switch the view** | Starts translating when you switch to **Mixed** or **Translated**. On by default. Stored on this computer only. |
| **Translate saved articles automatically** | Starts translating each article as soon as it is saved. Off by default, because it uses the AI provider for every saved article. Articles written in the display language are skipped (with English as the display language, English and other non-Japanese articles). |
| **Also translate articles in the display language** | With **Translate saved articles automatically** on, articles written in the display language are translated into the other language too (with English as the display language, English articles into Japanese). Off by default. |
| **Parallel requests** | How many translation requests to the AI provider run at the same time (1–8, default 3). Long articles send their batches (up to 12 paragraphs each) in parallel, and several short articles are translated at once, so **Jobs** shows up to this many running. The article on screen is translated right away in a slot of its own, outside this number. More finishes sooner, but reaches usage and API rate limits sooner, and runs more Claude CLI or Codex CLI processes at once. |
| **Keep technical terms in English** | Keeps terms such as MVCC or write skew in English when translating into Japanese. When translating into English, uses the established English terms. On by default. |
| **Extra instructions** | Instructions added to the end of the translation prompt, such as a preferred style or terms. Up to 2,000 characters. **Show the built-in prompt (English to Japanese)** shows the prompt they are added to. |
| **Sites not to translate** | Pages listed here stay in the original even when the Page view is set to Mixed or Translated. Write one per line; `*` matches any text. A host name alone also covers its subdomains (e.g. `www.google.*`). With a `/`, it is matched against the whole URL, with or without `https://` (e.g. `https://example.com/docs/*`). As in `.gitignore`, a line starting with `!` translates the pages it matches, and when several lines match, the last one wins: `x.com/*` followed by `!x.com/*/status/*` leaves X untranslated except its posts. By default, the major search engines such as Google, Bing and DuckDuckGo. |

Translations are stored separately for each combination of **Keep technical terms in English** and **Extra instructions**. After changing them, translate again the articles you want to read with the new settings. Changing the settings back shows the earlier translations again.

### Summaries

Click **Summarize** under **Summary** at the top of the Reader, and the AI summarizes the article. The summary shows only its first line; click it to read all of it.

- Summaries reflect **About you**.
- **Extra instructions for summaries** in **Settings › Summaries & chat** adds instructions for summaries only.
- If the article's text or the summary settings change after a summary is made, the summary says so. To update it, click **Regenerate** in the open summary, or **Regenerate the summary** in the ⋯ menu. Summaries are never regenerated on their own.

In the Page view of a saved article, **Summary** in the toolbar shows the same summary above the page.

### See search matches in an article

When you open an article from search results, the Reader shows a counter such as **Match 1 / 5**. The ↑ and ↓ buttons next to it move between the matches.

### Focus mode

`f` or the focus mode button hides the navigation and the article list together, giving the text more room. Press `f` again to bring them back. With the article list hidden, `j` and `k` still move to the next and previous article.

### Back and forward

Lattice keeps a history of the places you visit in the app: the screen, the settings section, the list, the filters and the document in the focused tab. Move through it with ‹ › in the title bar, `Alt+←` and `Alt+→`, or the mouse's back and forward buttons. The history keeps the last 50 entries.

When a web page has the keyboard focus, `Alt+←`, `Alt+→` and the mouse buttons move through that page's history instead of Lattice's. ‹ › in the Page view's toolbar always move through the page's history.

### Print a page

Press `Ctrl+P` in the Page view to open the Windows print dialog.

## Tabs, panes and windows

### Tabs

Each pane in the document area has a row of tabs. A tab holds an article in the Reader or a web page.

- Opening an article from the list, the palette, search results or a chat citation replaces the contents of the shown tab in the focused pane.
- To open it in a new tab instead, `Ctrl`+click or middle-click.
- **New tab** (+) at the end of the tab row opens the search engine's home page in a new tab, with its address selected in the address bar so you can paste or type another right away. `Ctrl+T` opens the palette, and what you choose there opens in a new tab.
- Close a tab with `Ctrl+W`, its ×, or a middle-click on it.
- `Ctrl+Tab` and `Ctrl+Shift+Tab` switch to the next and previous tab.
- Drag tabs to reorder them. A dragged tab moves along the tab row with the pointer, and swaps with the next tab once its edge passes that tab's middle.

Tabs and panes come back the next time Lattice starts. The web pages of the 3 most recent hidden tabs stay loaded, so switching to them is instant and keeps the scroll position. Older pages reload when you return to their tab.

### Split the document area

- **Split right** and **Split down** in the tab row split the focused pane in two. The keys are `Ctrl+\` (right) and `Ctrl+-` (down).
- Drag the line between panes to resize them. You can also focus the line and use the arrow keys. Double-click the line to make the panes equal.
- **Close pane** closes the focused pane. A pane with no tabs left closes too.
- Drag a tab to another pane's tab row to move it there. Within the same window, dropping it in the middle of a pane puts it in that pane, and dropping it near an edge splits that pane and puts the tab in the new side.

The focused pane has a frame. Clicking inside a pane focuses it, and the next document you open goes there.

### Control panes with the keyboard

As in tmux, press `Ctrl+B` and then one of these keys. After `Ctrl+B`, the screen shows a guide to the keys.

| Key after `Ctrl+B` | Action |
|---|---|
| `←` `→` `↑` `↓` or `h` `j` `k` `l` | Move to the pane in that direction |
| `o` | Move to the next pane |
| `%` | Split right |
| `"` | Split down |
| `x` | Close the pane |
| `c` `n` `p` | New tab, next tab, previous tab |
| `z` | Focus mode |

### Open a tab in its own window

A tab can leave the main window and open in its own window (a document window).

- **Open in a new window** in the tab row, or `Ctrl+Shift+N`, moves the shown tab to a new window.
- Drag a tab about 30 pixels up or down out of the tab row and it becomes a new window that follows the pointer. In a window split into panes, the tab becomes a new window once you drag it outside the window.
- Drag a tab over another window's tab row and it moves into that window before you let go, showing its content there. Let go to leave it there, or drag it off the row again to make it a new window. Press `Esc` while dragging to put it back.

In a document window, the tab row is also the title bar. Drag an empty part of it to move the window, and double-click to maximize it. Each window has its own panes, tabs and palette.

To return a tab to the main window, use **Move back to the main window** or `Ctrl+Shift+N`. Closing a document window closes its tabs too; they do not return to the main window. A document window closes when its last tab leaves.

When a tab moves to another window, its web page moves with it: it does not reload, and keeps its back and forward history and scroll position.

The chat pane also has **Open in a new window**. **Move back to the main window** returns it to its place. Closing the chat window closes the chat without returning it to the main window.

Window positions and sizes are saved, and the windows that were open when you quit open again at the next start. Closing the main window quits Lattice.

## Organize your library

### Genres, tags and difficulty

When you save an article, the AI provider assigns it a genre, tags (up to three) and a difficulty.

- A **genre** is a broad category such as Database, Security or Web. Lattice prefers existing genres and creates a new one only when none fits.
- **Difficulty** has five levels: **Introductory**, **Beginner**, **Intermediate**, **Advanced** and **Expert**. It describes how hard the article is for a working software engineer who is not a specialist in its field.

Classification groups up to 20 unclassified articles into one call. To stop it, turn off **Sort saved articles into genres and tag them with the LLM** in **Settings › Auto-classification** (it is on by default). **Classify all unclassified** on the same screen queues every article that has no genre or no difficulty.

**Change them by hand** in the line under the title in the Reader.

- For the genre, type in the field or pick a suggestion. Typing a new name creates that genre. Pick the difficulty from its menu.
- A genre or difficulty you chose yourself is pinned, and auto-classification does not overwrite it. Setting the difficulty back to **Not rated** has it estimated again.
- **+ Tag** adds a tag, and a tag's × removes it. Auto-classification only adds tags; it never removes tags you added.
- **Auto-classify** in the ⋯ menu unpins the genre and difficulty and classifies the article again.

**Edit genres.** **Edit** next to **Genres** in the navigation opens **Settings › Genres**, which lists every genre with its article count. You can rename a genre; giving it the name of another genre merges the two. A genre with no articles can be deleted. Add a genre in the field at the top, and auto classification can choose it from then on.

### Importance

Once you have written [About you](#write-about-you), the AI provider rates each newly saved article from 1 to 5 for how important it is to you, with a one-line reason. It weighs both how close the article is to your interests and what you would gain from reading it, judged by what About you says you value, so a basic article on one of your topics can rate lower than an insightful one from a neighboring field. The five levels are **Not for you**, **Low priority**, **Read if interested**, **Worth reading soon** and **Must read**.

- In the article list, articles rated 4 or 5 have a mark. Hold the pointer over it to see the reason. The Reader shows the rating and reason under the title.
- **Important** in the navigation lists articles rated at least **Lowest importance in Important** in **Settings › Importance** (4 by default).
- To stop rating, turn off **Rate newly saved articles** in **Settings › Importance**.

**After you change About you**, or when an update changes how articles are rated, earlier ratings are marked **(rated by earlier criteria)**. They are not rated again on their own. Until they are rated again, their scores are still used. There are two ways to rate again:

- **Rate again** in **Settings › Importance** rates every unrated article and every article rated by earlier criteria.
- **Rate again** above the article list rates the articles shown in the list.

### Collections

A collection is a set of articles you pick yourself, such as material for a project or a reading list. An article can be in several collections.

- Create one with **+ New** under **Collections** in the navigation. A collection's ⋯ menu renames or deletes it. Deleting a collection keeps its articles.
- Add the open article with **+ Collection** in the Reader, **Add this article to a collection…** in the palette, or **Add to collection…** in the right-click menu.
- To add several articles, choose them with **Select** above the list and click **Add to collection**.
- Articles from a bulk import, and URLs saved while the list shows a collection, can go into that collection as they are saved.

Collections can also be chosen as the scope for search, chat and export.

### Read and favorites

Opening an article marks it as read. While you are looking at the **Unread** list, though, opened articles stay in it until you change the list or the filters. That keeps the list from shifting while you work through it.

`m` toggles read and unread, and `s` toggles the favorite star. Starred articles appear under **Favorites** in the navigation.

### Lists, filters and sorting

The article list shows the list chosen in the navigation, narrowed by the filters.

**Lists in the navigation.** From the top: **Recently added** (saved in the last 7 days), **Unread**, **Favorites**, **All articles** and **Important**, then collections, genres, feed folders, feeds and **Added by hand** (articles not from a feed). Only the first six genres are shown; a link shows the rest.

**Filters.** The chips above the list add conditions on **Genres**, **Tags**, **Collections**, **Source**, **Difficulty**, **Importance** and **Status**.

- **Status** has the values **Unread**, **Read**, **Favorites** and **Needs attention**. **Needs attention** covers articles whose fetch or text extraction failed and articles with little text.
- Choosing several values in one filter shows articles that match any of them (OR). Different filters show articles that match all of them (AND).
- Only for tags can you choose **All of them** (AND) or **Any of them** (OR).
- The counts next to the values are counts within the current list.
- When nothing matches, the list shows which filter to remove to get how many articles.

`Esc` clears the filters. You can also add filters from the palette (see [The command palette](#the-command-palette)).

**Sorting and grouping.** **Sort and group** above the list sorts by **Date added, newest first**, **Date added, oldest first**, **Date published, newest first**, **Difficulty, easiest first** or **Most important first**. The same menu can divide the list into sections by source or by genre.

**Keyboard.** `j` and `k` (or `↓` and `↑`) move the cursor. `Enter` opens the article in the Reader, and `Shift+Enter` in the Page view.

### The right-click menu

Right-click an article in the list, or a Reader or Page tab, to open a menu of actions for that article. With the keyboard, press the menu key or `Shift+F10`.

The menu has **Favorite**, **Mark as read**, **Add to collection…**, **Open in a new tab**, **Open in a new window**, **Open in Page**, **Copy URL** and **Remove from Index…**. For the tab of a page you have not saved, only the items that apply to it appear.

### Act on several articles

1. Click **Select** above the list.
2. Click articles to select them. `Shift`+click selects a range. `Shift`+click also starts selecting without clicking **Select** first.
3. Right-click the selection to get actions that apply to all of it: favorite, read and unread, and **Add to collection…**.

**Done** or `Esc` ends the selection.

### Remove an article from the Index

Choose **Remove from Index…** in the ⋯ menu or the right-click menu, and confirm. This cannot be undone.

- Removed: the saved HTML, text, summary, tags, images, search data, and translations no other article uses
- Kept: citations in chat answers

An article that came from a feed is not imported again from that feed.

## Search and ask

### Search

Press `/` to search your saved articles. Lattice's search is a hybrid of full-text search, which finds passages that contain your keywords, and semantic search, which finds passages close in meaning. Semantic search lets a Japanese query find the matching passage in an English article, and the other way around. Both the original text and translations are searched.

- Results list the matching passages, grouped by article. Move with `j` and `k`. `Enter` opens the passage in the Reader, and `Shift+Enter` in the Page view. `Esc` returns to the article list.
- The scope menu narrows the search to **Recently added**, **Unread**, **Favorites**, **Important**, a collection, a genre, a feed or a folder. The filter chips narrow it further.
- Every search uses both methods. Each result shows whether it matched by **Full text**, **Meaning** or **Full text + meaning**. **Search method** (**Hybrid**, **Full text**, **Meaning**) filters the results shown by how they matched.
- While you search, the navigation shows your recent searches.

**The semantic search model.** Semantic search runs the multilingual-e5-small model (about 470 MB) on your computer. Lattice downloads it the first time it is needed, usually when the first article is prepared for search. Until the model is ready, search shows only full-text results and says why in the results.

### The command palette

Press `Ctrl+K` or click the box in the title bar to open the palette. Type to search article titles, tags, sources, genres and commands together. Start with one of these to search only one kind:

| Prefix | Searches |
|---|---|
| `#` | Tags |
| `@` | Sources (feeds and folders) |
| `g:` | Genres |
| `>` | Commands only |
| `?` | The text of your saved articles (search) |

- `Enter` runs the selected item. `Ctrl`+click an article to open it in a new tab.
- `Tab` adds the selected tag, source or genre to the list's filters. The palette stays open, so you can add several in a row.
- `Ctrl+Enter` searches for what you typed.
- Pasting a URL offers **Open in Page**, **Add to Index (import)** and **Find and add its feed** (see [Save a URL](#save-a-url)).

Besides switching lists, the commands include:

- **Language shown: mixed** (add a number such as `70` to set the share too), **Language shown: original** and **Language shown: translated**
- **Translate this article (queues a job)**
- **Open today's review**, **Open vocabulary**, **Open jobs**, **Open chat**, **Manage feeds** and **Open settings**
- **Bulk import**, **Import Markdown** and **Import a PDF (paper)**
- **Retry all failed jobs**

### Chat with your articles

Open the chat pane with **Chat** in the navigation, type a question and send it with `Ctrl+Enter`. The AI answers only from your saved articles. The numbers in the answer are citations; click one to open the passage it relies on. If the articles in scope say nothing about the question, the AI says it found nothing instead of guessing.

**Scope.** **Scope** chooses which articles the answer is based on.

- **This article**: the article in the focused tab
- **All open articles**: the saved articles open in tabs in every window (you can also pick them one by one under it)
- **All articles**, the current list, a collection, a genre, a feed, a folder or a tag

**How much is sent.** When the full text of the articles in scope fits, all of it goes to the AI. When it does not fit, Lattice uses search to pick the passages most related to the question. It first takes up to 4 passages per article, from as many articles as possible, and then adds more passages from the same articles while there is room. The answer shows whether it was based on the full text or on excerpts.

Choose the limit per question in **Context per question** in **Settings › Summaries & chat**: **Small (about 40,000 characters)**, **Standard (about 80,000 characters)** or **Large (about 150,000 characters)**. More context lets the answer draw on more articles, but each question costs more and takes longer.

**Conversations.**

- Follow-up questions are answered with the last three exchanges in mind.
- Chats are saved. The menu on the chat's title opens a saved chat, starts a **New chat** or runs **Delete this chat**.
- **Ask** in the Reader starts a chat about that article.
- **Open in a new window** in the chat pane moves the chat to its own window (see [Open a tab in its own window](#open-a-tab-in-its-own-window)).

**Chat settings** are in **Settings › Summaries & chat**.

| Setting | What it does |
|---|---|
| **Extra instructions for chat** | Instructions added only for chat answers. They apply from the next question. |
| **Context per question** | The limit on how much is sent per question. See "How much is sent" above. |
| **Vim key bindings in the question box** | Use Vim keys in the question box. It starts in insert mode, and `Esc` switches to normal mode. `Ctrl+Enter` sends in either mode. Stored on this computer only. |

## Learn from what you read

### Quiz yourself

Click **Quiz** in the Reader or Page view toolbar to open a panel next to the article. **Generate a quiz** has the AI write 3 to 8 questions that check the article's main points. Questions are either short-answer or multiple choice.

1. For multiple choice, pick an option. For short answer, think of your answer and click **Show answer**. You can type it in **Your answer** if you like (it is not saved).
2. Read the answer, the explanation and the source. Click the source to jump to that place in the text.
3. Rate yourself: **Again**, **Hard**, **Good** or **Easy**. The `1`–`4` keys work too. For multiple choice, the rating that matches your answer is preselected, and you can change it.

When you have answered every question, **Add to review** puts them in [Today's review](#todays-review). Your ratings from this round count as the first review.

- **Try again** starts over.
- When the article's text or **About you** has changed, **Regenerate** writes new questions.
- The panel keeps its state when you move to another screen or tab and come back. It is cleared when you quit Lattice.

### Notes

Click **Note** on the Reader or Page toolbar to open a note beside the article. Each article has one note in plain text. Lattice saves it when you stop typing and shows **Saved** above it.

- An article with a note has **Note** highlighted on its toolbar.
- The note and the quiz open in the same place. Opening one closes the other.
- Notes are in the JSON export and in backups. Clearing a note deletes it.

### Save words

To save an unknown English word or phrase, select it in the Reader and click **Save word**, or press `w`. In the Page view, selecting text shows the same button above the page. The word is saved together with the sentence and article it came from.

After you save it, the AI provider adds the headword, part of speech, English definition, example sentence, pronunciation (IPA) and Japanese meaning. Forms of the same word share one entry. For example, saving ran after run adds the sentence with ran to the run entry instead of creating a new one.

Saved words are underlined in the Reader's text. Hold the pointer over one to see its meaning.

You can save up to 64 characters that contain a Latin letter and do not span a line break.

### Vocabulary

**Vocabulary** under **Tools** lists your saved words.

- **Search words and meanings** narrows the list. Sort by **Recently added** or **Due soonest**.
- Each word's ⋯ menu has **Edit meaning**, **Go to source**, **Regenerate meaning and example**, **Suspend** (**Resume** when suspended) and **Delete**. A word whose lookup failed shows **Look up again**.
- **Underline saved words in articles** turns the underlines in the text on or off. Stored on this computer only.
- **Export CSV** writes a CSV that Anki can import (front, back and tags) to the `exports` folder.

### Today's review

Quiz questions and saved words are asked one card at a time. The intervals follow SM-2, the same method as Anki. Each correct answer makes the interval longer (1 day, then 6 days, then about 2.5 times the previous interval), and **Again** sends the card back to the shortest interval.

**Today's review** in the navigation shows how many cards are due today. Opening it first shows today's count, split into questions and words, with the number of new cards. Click **Start review** to see the first card.

- **Word cards.** The front shows the headword, IPA and part of speech, and the headword is read aloud. The back has the English meaning, example, Japanese meaning, the sentence you saved and **Go to source**. **Hear the word**, **Hear the example** or `r` play them again. Reading aloud starts only after you click **Start review**; opening the screen alone plays no sound.
- **Rating.** Each rating button shows when the card would come back if you chose it. Rate with the buttons or `1`–`4`.
- **Taking cards out.** A card's ⋯ menu takes that card, or all cards from its article, out of review. A word card can be stopped with **Suspend this word (resume it in Vocabulary)**.
- **When you finish**, Lattice shows how many cards you reviewed and when the next card is due. You can also take articles out of review there, from the list of articles under review.

The day changes at midnight by your computer's clock.

Words are read aloud with the English voices installed in Windows, so it works offline. On a computer without an English voice, the speaker buttons do not appear.

**Review settings** are in **Settings › Review**.

| Setting | Default |
|---|---|
| **New cards per day** | 20 |
| **Reviews per day** | 200 |
| **Shortest interval** | 1 day. Below 1 day, a card comes back again the same day (like Anki's learning steps). |
| **Longest interval** | 365 days |
| **Say word cards aloud** | On. Stored on this computer only. |

The daily limits count quiz cards and word cards together.

## Background jobs

Slow work such as fetching, rendering and translating runs as background jobs. Check them in **Jobs** under **Tools**. When a job has failed, the navigation shows the count in red.

These are the kinds of jobs. The **Jobs** screen shows each kind by name; hold the pointer over the name to see the ID in parentheses. The ⓘ next to each kind explains it too.

| Job | What it does |
|---|---|
| **Fetch** (`ingest`) | Downloads a URL's page, extracts the text and saves it as an article. |
| **Render** (`render`) | Renders a page whose text a plain download misses in a hidden browser, then saves it again. |
| **Images** (`images`) | Downloads and saves an article's images. |
| **Site icons** (`favicon`) | Fetches the site icons shown next to feeds and articles. |
| **Search index** (`embed`) | Turns an article's paragraphs into vectors for semantic search. Runs on your computer. |
| **Translation** (`translate`) | Translates an article's paragraphs with the AI provider. |
| **Summary** (`summarize`) | Writes an article's summary. |
| **Quiz** (`quiz`) | Writes quiz questions. |
| **Word meanings** (`vocab`) | Adds meanings, definitions, pronunciation and examples to saved words. |
| **Classification** (`classify`) | Assigns a genre, tags and a difficulty. Handles up to 20 articles per call. |
| **Importance** (`relevance`) | Rates articles against **About you**. Handles up to 20 articles per call. |
| **Import filter** (`feed_filter`) | Has the AI decide whether to import new feed entries. Handles up to 20 entries per call. |

Jobs that use the AI provider, jobs that run on your computer (the search index) and jobs that use the network each wait in their own queue. A long queue of translations therefore never holds up importing. Fetches from the same site run one at a time, so a bulk import does not pile load onto one site.

**Job states and retries.** A job is **Pending**, **Running**, **Waiting to retry** or **Failed**.

- A job that fails goes to **Waiting to retry** and is retried automatically after 2, 4, 8 and 16 minutes. After 5 tries without success, it becomes **Failed** and stops.
- **Retry now** runs a waiting job without waiting. **Retry** runs a failed job again.
- **Retry failed** reruns the failed jobs of one kind, and **Retry all failed** the failed jobs of every kind.
- **Cancel** deletes a waiting or failed job. A running job cannot be canceled.

## Settings

Open **Settings** at the bottom of the navigation. Settings are grouped into **AI**, **Library**, **Controls**, **Data** and **App**. Settings that belong to a feature are explained with that feature.

| Group | Section | Explained in |
|---|---|---|
| AI | **AI providers** | [Set up an AI provider](#set-up-an-ai-provider) |
| | **Translation** | [Translate an article](#translate-an-article) |
| | **Summaries & chat** | [Write About you](#write-about-you), [Summaries](#summaries), [Chat with your articles](#chat-with-your-articles) |
| | **Auto-classification** | [Genres, tags and difficulty](#genres-tags-and-difficulty) |
| | **Importance** | [Importance](#importance) |
| Library | **Genres** | [Genres, tags and difficulty](#genres-tags-and-difficulty) |
| | **Import & JS rendering** | [Pages that don't extract well](#pages-that-dont-extract-well) |
| | **Import filters** | [Import filters](#import-filters) |
| | **Images** | [Images](#images) |
| | **Review** | [Today's review](#todays-review) |
| Controls | **Display language** | [Display language](#display-language) |
| | **Shortcuts** | [Keyboard shortcuts](#keyboard-shortcuts) |
| | **Browser** | [Browser](#browser) |
| | **Startup & taskbar** | [Startup and taskbar](#startup-and-taskbar) |
| Data | **Backup**, **Cloud backup (R2)**, **Export**, **Logs & storage** | [Data and backups](#data-and-backups) |
| App | **Updates** | [Updates](#updates) |

**Feeds →** in the **Library** group opens the feed manager.

### Images

With **Save images** on, Lattice downloads an article's images (PNG, JPEG, GIF, WebP, AVIF) and stores them in the database. SVG images are not saved; they stay links to their original location.

- **Size limit per image** is 5 MB by default and can be set from 1 to 20 MB.
- The images saved for one article total at most 30 MB.
- Turning it off does not delete images already saved.

### Display language

Choose Japanese or English for menus, buttons and messages. At first, Lattice follows the Windows language. The change takes effect at once, without a restart. The direction of article translation (Japanese articles into English, others into Japanese) does not change.

### Shortcuts

Lists every shortcut.

- **+ Add key** records the next key you press and assigns it. Keys combined with modifiers such as `Ctrl` work too. An action can have several keys.
- When a key is assigned to two actions, the one higher in the list wins, and a warning appears.
- **Reset to default** resets one action, and **Reset all to defaults** resets every action, to the default keys.

Shortcuts are stored on this computer only.

### Browser

**Search engine** is used when you type something other than a URL in the Page view's URL field, and for the home button. Choose DuckDuckGo (the default), Google, Bing, Brave Search, Kagi or **Custom**. For **Custom**, enter a **Search URL** with `%s` where the search terms go. Stored on this computer only.

### Startup and taskbar

- **Start Lattice when Windows starts**: opens Lattice when you sign in to Windows. Off by default. Turning Lattice off in Task Manager's Startup apps also turns this setting off.
- **Show the unread count on the taskbar**: shows the number of unread articles on Lattice's taskbar button. It shows 99+ from 100 up, and nothing at zero.

### Updates

**Check for updates** looks for a new version on GitHub's Releases page. Lattice also checks when it starts, and shows a bar below the title bar when a new version is available.

- **Installed copy.** **Update and restart** in the bar downloads the new version, verifies its signature, installs it and restarts. Your data stays as it is. **Release notes** shows what changed, and **Later** closes the bar.
- **Portable copy.** It does not update itself. Use **Download page** in the bar to download the new zip, and replace your `Lattice.exe` with the one in it.

## Keyboard shortcuts

These are the default keys. Change them in **Settings › Shortcuts**.

### Lists and navigation

| Action | Default key |
|---|---|
| Command palette | `Ctrl+K` |
| Search | `/` |
| Next item | `j`, `↓` |
| Previous item | `k`, `↑` |
| Open the article at the cursor | `Enter` |
| Open the article at the cursor in Page | `Shift+Enter` |
| Back, clear filters | `Esc` |
| Back (app history) | `Alt+←` |
| Forward (app history) | `Alt+→` |
| Move a feed or folder up (sidebar) | `Alt+↑` |
| Move a feed or folder down (sidebar) | `Alt+↓` |

### Articles

| Action | Default key |
|---|---|
| Switch Reader / Page | `v` |
| Less English text | `[` |
| More English text | `]` |
| Favorite | `s` |
| Read / unread | `m` |
| Focus mode | `f` |
| Save the selected English word to Vocabulary | `w` |
| Hear a word card again | `r` |

`[` and `]` change the share shown in the display language (English). The same share gives as much English in a Japanese article as in an English one.

### Tabs, panes and windows

| Action | Default key |
|---|---|
| New tab | `Ctrl+T` |
| Close tab | `Ctrl+W` |
| Next tab | `Ctrl+Tab` |
| Previous tab | `Ctrl+Shift+Tab` |
| Split pane right | `Ctrl+\` |
| Split pane down | `Ctrl+-` |
| Open the tab in a new window / move it back to the main window | `Ctrl+Shift+N` |
| Pane prefix ([keys that follow](#control-panes-with-the-keyboard)) | `Ctrl+B` |

### Fixed keys

These keys cannot be changed in **Settings › Shortcuts**.

| Key | Where | Action |
|---|---|---|
| `Enter` | A focused paragraph in the Reader | Switch between original and translation |
| `1`–`4` | Quiz and review cards | Rate |
| `Ctrl+Enter` | The chat box | Send the question |
| `Tab` | The palette | Add the selected item to the filters |
| `Ctrl+Enter` | The palette | Search for what you typed, or save a pasted URL |
| Menu key, `Shift+F10` | A list row, a tab, a feed folder in the navigation | Open the right-click menu |
| `Ctrl+P` | A web page in the Page view | Print |
| `Esc` | A tab being dragged | Cancel the drag and put it back |
| Mouse back and forward buttons | Anywhere | Move through the app history (the page's history over a web page) |

### When a web page has the focus

When you click a web page in the Page view, the keyboard goes to that page. Lattice's shortcuts still work under these conditions:

- Shortcuts with `Ctrl`, such as `Ctrl+K` and `Ctrl+B`, work even inside the page's text fields.
- Single-key shortcuts such as `j`, `s` and `v` work outside the page's text fields, and only when the page does not use that key itself.
- `Enter`, `Esc`, the arrow keys and `Space` belong to the page for scrolling and its own controls; they do not act as Lattice shortcuts.
- `Alt+←`, `Alt+→` and the mouse's back and forward buttons move through the page's history.
- `w` and `r` do not work on a page. Save words with the button that appears above the page.

## CLI and MCP

`lattice-cli.exe` searches and reads your saved articles from a terminal. Run as an MCP server, it serves them to AI agents such as Claude Code.

- Both the installer and the portable zip put it in the same folder as `Lattice.exe`. The installer's default location is `%LOCALAPPDATA%\Lattice`. It is not added to PATH, so run it by its full path.
- It uses the same data as the app, including a portable copy's `data` folder or a folder chosen in **Settings › Logs & storage**. It works while the app is running.
- In a portable copy, run `.\lattice-cli.exe` from the unzipped folder. It uses the `data` folder next to it. Pass `--data-dir PATH` to use another library.
- The examples below assume the default installation. If you installed elsewhere, change the path to the executable.
- Before you update or uninstall Lattice, quit your MCP clients so that no CLI process is running.

### Commands

```powershell
& "$env:LOCALAPPDATA\Lattice\lattice-cli.exe" search "MVCC write skew" --limit 5
```

```powershell
& "$env:LOCALAPPDATA\Lattice\lattice-cli.exe" --format text get 42
```

| Command | What it does |
|---|---|
| `search QUERY` | Hybrid search over your saved articles. `--scope`, `--limit` (default 20). |
| `get ID` | One article's metadata, summary and text. `--blocks` adds paragraphs with their IDs, and `--translation` adds saved translations. |
| `list` | Saved articles, newest first. `--scope`, `--limit` (default 50). |
| `summary ID` | An article's saved summary. |
| `tags` | Tags with article counts. |
| `genres` | Genres with article counts. |
| `feeds` | Your feeds and their folders. |
| `collections` | Collections with their IDs and article counts. |
| `jobs` | Pending, running and failed jobs. |
| `ask QUESTION` | Answers from your saved articles, with citations, using the AI provider set up in the app. `--scope`. |
| `save URL` | Saves a URL. Needs write permission. With `--run`, the CLI fetches it on the spot instead of leaving it to the app. |
| `tag ID NAME` | Adds a tag to an article. Needs write permission. |
| `read ID` | Marks an article as read. Needs write permission. |
| `favorite ID` | Marks an article as a favorite. Needs write permission. |
| `mcp` | Serves these commands to agents as an MCP server over stdio. |

Options for every command:

- `--format json` (the default) or `--format text` (easier for people to read)
- `--data-dir PATH`: use another data folder.
- `--allow-write`: allow `save`, `tag`, `read` and `favorite`. Setting the environment variable `LATTICE_ALLOW_WRITE=1` does the same.

`lattice-cli --help` also lists the commands.

### Scopes

`--scope` takes one of these:

| Scope | Articles |
|---|---|
| `all` | Every article (the default) |
| `unread` | Unread articles |
| `favorites` | Favorite articles |
| `tag:NAME` | Articles with that tag |
| `genre:NAME` | Articles in that genre (`genre:none` for unclassified articles) |
| `feed:ID` | Articles from that feed (`feed:none` for articles added by hand) |
| `folder:ID` | Articles from the feeds in that folder |
| `collection:ID` | Articles in that collection (`group:ID` also works) |
| `important` or `important:MIN` | Articles rated at least MIN (by default, the value chosen in **Settings › Importance**) |
| `article:ID` or `article:3,7` | The given articles |

`feeds` shows feed IDs and `collections` shows collection IDs. Folder IDs appear with `--format json`.

### What the CLI does and does not do

- Search gives the same results as the app. If the app has not downloaded the semantic search model yet, the CLI does not download it and answers with full-text search only. The JSON output says so.
- Questions asked with `ask` also appear in the app's chat history.
- `save` only queues the fetch; a running app fetches it within 30 seconds. With `--run`, the CLI itself fetches the page, its images and, if the model is present, the search vectors. In both cases, classification, importance, automatic translation and rendering are left to the app.
- Changes made with `tag`, `read` and `favorite` show in the app the next time it reloads the list.
- The CLI cannot remove favorites, mark articles unread, remove tags or delete articles. Agents are limited to actions that are easy to undo.

### Use Lattice from Claude Code

```powershell
claude mcp add lattice -- "$env:LOCALAPPDATA\Lattice\lattice-cli.exe" mcp
```

With this, the agent can use `search`, `get`, `list`, `summary`, `tags`, `genres`, `feeds`, `collections`, `jobs` and `ask` as tools. To also give it `save`, `tag`, `read` and `favorite`, add `--allow-write` after `mcp`.

### Watch out for prompt injection

Saved articles are web pages written by other people. An agent that reads them can follow instructions planted in the text (prompt injection).

Lattice starts every tool result with a notice that the content is untrusted outside text and that instructions in it must not be followed. It also cuts each result at 25,000 characters. The risk remains, so:

- Don't allow writes (`--allow-write`) unless you need them.
- Don't give an agent session that reads your articles risky tools at the same time, such as running shell commands, writing files or sending email.

## Data and backups

### Where your data is

All of Lattice's data is in one SQLite database file: articles, the fetched HTML, translations, summaries, images, search data, chats, quizzes, words and settings. For an installed copy, the default locations are:

| What | Where |
|---|---|
| Database | `%APPDATA%\Lattice\lattice.db` |
| Backups | `%APPDATA%\Lattice\backups\` |
| Exports (JSON, CSV, OPML) | `%APPDATA%\Lattice\exports\` |
| Semantic search model | `%APPDATA%\Lattice\models\` |
| Logs | `%LOCALAPPDATA%\Lattice\logs\` |

**Settings › Logs & storage** shows the locations actually in use. **Open folder** opens the data folder in use.

- A **portable copy** keeps everything in the `data` folder next to `Lattice.exe`, including the logs and the built-in browser's cookies and cache.
- **Logs** stay in `%LOCALAPPDATA%\Lattice\logs` even when you move the data folder (a portable copy uses `data\logs`).
- **Development builds** (built from source) use a separate `Lattice Dev` folder. Their data, logs and built-in browser logins are not shared with release builds. Data in folders used by older test builds is not moved automatically.

**Settings stored on this computer only.** These settings are stored on the computer instead of in the database, so they are not in backups and do not carry over to another computer: shortcuts, the search engine, **Translate when I switch the view**, Vim key bindings, reading words aloud, underlines for saved words, recent searches, the Page view's summary button, which folders are expanded, and the window layout.

### Move the data folder

Click **Change…** in **Settings › Logs & storage** and choose a new folder (a portable copy has no such button).

1. Lattice copies the database, backups, exports and search model to the new folder. API keys are copied with the database.
2. After a restart, Lattice uses the new folder. Anything added or changed after the copy stays behind, so restart as soon as the copy finishes.
3. The data in the old folder is not deleted. Delete it yourself when you no longer need it.

If the chosen folder already holds Lattice data, Lattice switches to that data without copying. If the chosen folder is missing or unusable at startup, Lattice starts with the default location and the settings screen says why.

### Backup

**Back up now** in **Settings › Backup** writes a copy of the database to the `backups` folder. Beyond **Backups to keep** (30 by default), the oldest copies are deleted. Copies are never deleted because of their age.

A backup contains articles, images, translations, words, review history and the settings in the database. It does not contain API keys or the R2 Secret Access Key, nor the [settings stored on this computer only](#where-your-data-is).

### Cloud backup (R2)

**Settings › Cloud backup (R2)** uploads a copy of the database to a Cloudflare R2 bucket on a schedule. The copy is compressed with gzip and leaves out API keys.

1. Enter the Account ID, bucket, Access Key ID and Secret Access Key.
2. Turn on **Automatic backup**.
3. Set **Interval (hours)** (24 by default) and **Backups to keep** (30 by default).

**Back up to R2 now** uploads one right away. Several computers can back up to the same bucket.

[`infra/r2`](../infra/r2/README.md) has Terraform that creates the bucket and explains how to create the access key and how to restore.

### Restore a backup

Restoring is done by hand. It replaces the database file, so keep every process that uses the library (Lattice, `lattice-cli`, MCP servers) stopped while you work. Do not replace the database while any of them is running.

A local backup is a SQLite file named `backups/lattice-<Unix seconds>.db`, a database that can be used as it is.

1. In **Settings › Logs & storage**, note the full path of the database. Use the path shown there even if you moved the data folder or use a portable copy.
2. Copy the backup you want to restore to a separate folder. Leave the original backup untouched. If its name ends in `.db.gz`, extract it first. To download a backup from R2, see [R2 restore steps](../infra/r2/README.md#3-復元).
3. Close every Lattice window, CLI command and MCP server that uses this database.
4. Move the current `lattice.db` to a recovery folder. If `lattice.db-wal` and `lattice.db-shm` exist, move them with it. Don't leave an old WAL or SHM file in the original folder.
5. Copy the backup database into the original folder and name it `lattice.db`.
6. Start Lattice and check that the articles, images, translations, words and review history are there.
7. Enter the API keys and the R2 Secret Access Key again in Settings. Keep the files in the recovery folder until you have confirmed that backups work again.

To go back to the database from before the restore, first close every process that uses the library again. Then move the restored database and its WAL and SHM files aside together, and put back the complete set of original files from the recovery folder.

### Export

**Settings › Export** writes the library's contents as gzip-compressed JSON Lines to the `exports` folder, for using your data in other tools. **What to export** chooses the whole library or one collection.

- **Included:** articles, paragraphs, translations, summaries, notes, tags, genres, feeds and folders, collections, quizzes and chats (an export of one collection leaves the chats out)
- **Not included:** API keys and other settings, saved words, the fetched HTML, images and search vectors

To keep what is not included, use a [backup](#backup). Saved words can also be exported with **Export CSV** in Vocabulary.

## Privacy and safety

### Network connections

Lattice has no telemetry, analytics or account. It connects only to these places:

| Where | When |
|---|---|
| Sites you save articles from, and the sites of their images and icons | When you save an article, and when a subscribed feed brings a new one |
| Feeds you subscribe to | When you subscribe, then periodically while Lattice runs |
| The AI providers you set up | When you use the features listed in [What goes to AI providers](#what-goes-to-ai-providers) |
| Pages you open in the built-in browser, and the search engine you choose | When you open them |
| Hugging Face | Once, to download the semantic search model |
| Your Cloudflare R2 bucket | Only when you set up cloud backup |
| GitHub (`github.com`) | At startup and from **Settings › Updates**, to check for a new version (installed copies only). The request carries no library data. |

### What goes to AI providers

Lattice sends text to the AI provider you set up only when you use these features:

| Feature | What is sent |
|---|---|
| Translation | The paragraphs to translate, and your translation **Extra instructions** |
| Translation in the Page view | The paragraphs of the page you are viewing (only while **Mixed** or **Translated** is chosen) |
| Summaries | The article text, **About you** and your summary instructions |
| Classification | The title, the domain, and the summary or the start of the text |
| Importance | The title, the domain, the summary, the headings, excerpts from the beginning, middle and end of the text, and **About you** |
| Quizzes | The article text and **About you** |
| Word meanings | The word and the sentence you saved it with |
| LLM feed filter | The new entry's title, URL and excerpt, **About you**, and **What to import** |
| Chat | Your question, the text of the articles in scope, the last three exchanges, **About you** and your chat instructions |

Semantic search, reading aloud and text extraction run only on your computer. The Claude CLI and Codex CLI providers use the accounts you signed in to those CLIs with.

### API keys

API keys and the R2 Secret Access Key are stored in the local database. They are never shown after you save them, and are left out of backups, R2 uploads and exports. When you move the data folder with **Change…** in **Settings › Logs & storage**, they are copied to the new folder with the database.

### Article content is untrusted

Saved pages are written by other people. Lattice treats their content as data, never as instructions.

- Article text is shown as text. An article's HTML or scripts never run inside Lattice's own window.
- Web pages are shown in a browser kept apart from Lattice itself. That browser can open only http and https addresses and can call only a few Lattice functions.
- AI providers never get tools such as file access or running commands. The Claude CLI and Codex CLI run with tools, MCP servers and user settings turned off, in an empty temporary folder. Every prompt tells the AI not to follow instructions in the article.
- Translations put back into a page in the Page view have scripts and unsafe links removed first.

### Article download restrictions

For what Lattice downloads directly over HTTP (articles, PDFs, feeds, images and site icons), it refuses private network addresses such as `localhost` and `192.168.x.x` by default. It also checks the address a redirect leads to.

- This restriction does not apply to the built-in browser, JavaScript rendering, AI providers, backups or the semantic search model download.
- Version 0.1.0 has no screen for setting which destinations are allowed (rules saved by an earlier version still apply). Settings for allowing internal sites and similar exceptions are planned as [advanced article download settings](roadmap.md#記事取得の詳細設定).
- OS and environment proxy settings, including addresses that bypass the proxy, are used as they are. Through a proxy, the proxy decides the final IP address, so Lattice cannot check it. To restrict where proxied connections go, set rules on the proxy.

## Troubleshooting

### Translation seems stuck

- Open **Jobs**. If the translation job is **Running**, it is still working. With a CLI provider, one call for a long article can take several minutes. The time each AI job took is written to the log.
- A job **Waiting to retry** has failed once and is waiting, for example for a usage limit to reset. **Retry now** runs it without waiting.
- If the toolbar shows **Translate the rest**, some paragraphs are not translated yet. Click it to continue.
- Japanese articles are translated into English. That is not a language detection mistake.
- If nothing happens, check **Settings › AI providers**. At least one working provider step is needed.

### Search shows only full-text results

The results say why only full-text results are shown. Usually the semantic search model is still downloading, or you were offline when Lattice tried to download it. **Retry** tries the download again. A newly saved article becomes findable by semantic search once its **Search index** job finishes.

### A page will not save, or saves with little text

- An article marked **Fetch failed** could not be downloaded. Some sites refuse requests that don't come from a browser. Open it in the Page view and click **Add to Index**, or, for a saved article, choose **Import again from the page as shown**.
- An article marked **Little text** may be a page built with JavaScript. Use **Render and import again** in the ⋯ menu, or the Page view method above.
- For sites that need a login, log in in the Page view first. The hidden browser that renders pages uses the same login.
- A PDF made only of scanned images has no text data, so there is no text to import.

See [Pages that don't extract well](#pages-that-dont-extract-well) for details.

### A feed does not import what I expect

- Check each feed's errors in the feed manager. **Refresh all** checks every feed now.
- Look in **Rejected entries** under the feed's **Edit** for entries an import filter skipped, with the reason.
- A newly added feed imports only its latest 20 entries. Older entries are not imported.

### Shortcuts do nothing on a web page

The keyboard is going to the web page. Single-key shortcuts work only outside the page's text fields, and only when the page does not use that key itself. `Ctrl+K` always works. Click outside the page (the article list, for example) to give the keyboard back to Lattice.

### A menu over a web page appears a moment late

A menu that overlaps a web page appears after the page is replaced by a still image and moved behind it, which takes a moment. Resting the pointer on the ⋯ button before clicking it makes the menu appear faster.

### Lattice opened an empty library

If the chosen data folder is missing or unusable, Lattice starts with the default location. **Settings › Logs & storage** shows why. Fix the folder, or choose another one with **Change…**.

### Updates cannot be checked

If **Settings › Updates** says automatic updates are not configured, that build cannot check for updates. Get new versions from the [Releases page](https://github.com/Maru32768/lattice/releases). A portable copy never updates itself; replace its `Lattice.exe` with the one from the new zip.

### Where are the logs?

Logs are in `%LOCALAPPDATA%\Lattice\logs\` (`data\logs` in a portable copy). **Settings › Logs & storage** shows the actual location. The logs record failed jobs, backup results and the time each AI job took.
