**English** | [日本語](guide.ja.md)

# Lattice user guide

This guide explains everything Lattice does, for people who use it. The [README](../README.md) has the short tour, installation and first steps. Bold labels are the names the app shows when its display language is English.

- [The screen](#the-screen)
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
- [Data, privacy and safety](#data-privacy-and-safety)
- [Troubleshooting](#troubleshooting)

## The screen

The main window has five areas, from left to right.

- **Title bar.** The ‹ › buttons move back and forward through the places you visited in the app. The box in the middle (**Search, commands, URLs**, `Ctrl+K`) opens the command palette.
- **Navigation.** The sidebar on the left. It holds the article lists (**Library**, **Collections**, **Genre**, **Source**), the **Tools** (**Chat**, **Today's review**, **Vocabulary**, **Jobs**, **Bulk import**) and **Settings** at the bottom.
- **Article list.** The articles in the list you picked, with filters and sorting at the top.
- **Document area.** Articles and web pages open here, in tabs. You can split it into several panes.
- **Chat pane.** Opens on the right when you click **Chat**.

Drag the borders between the areas to change their widths. Double-click a border to reset it. Lattice remembers the widths. The panel button at the top of the navigation hides it, and the article list has a button that closes it. A closed list leaves a thin rail with one button that opens it again.

The library, settings, jobs and the other screens take the place of the article list and the document area. Press `Esc` to go back to the library.

When the library is empty, the document area shows **Add your first article** with shortcuts to paste a URL, add a feed, run a bulk import and import Markdown. Until you set up an AI provider, a notice says which features need one. Saving, reading and full-text search work without one.

## Collect articles

Lattice stores each article's text, images and the HTML it was extracted from. It keeps working when the original page goes away.

### Save a URL

1. Press `Ctrl+K`.
2. Paste the URL.
3. Choose **Add to Index (import)**, or press `Ctrl+Enter`.

The palette also offers **Open in Page**, which opens the page without saving it, and **Find and add its feed**. If the URL is already saved, **Open in Reader** opens the saved article. While a collection is open in the list, the palette also offers to save the URL into that collection.

Lattice normalizes the URL first. Tracking parameters are removed, and saving a URL that is already in the library opens the existing article. Saving an article whose fetch failed tries the fetch again.

### Save the page you are browsing

The Page view is a built-in browser. To save the page it shows, click **Add to Index** in its toolbar. Lattice saves the page as your browser drew it, so pages built with JavaScript and pages behind your login come out complete. A saved page shows **Indexed** in the toolbar, and the Reader, tags, genres and favorites work for it.

### Subscribe to feeds

Lattice reads RSS and Atom feeds. Open **Manage feeds** from **Manage** next to **Source** in the navigation, or from the palette.

**Find a site's feed.** Paste a site or article URL into the field and click **Find**. If the URL is a feed, Lattice uses it. Otherwise it looks for the feed links in the page and then tries common paths such as `/feed` and `/rss.xml`. When there are several candidates, pick one and click **Add and import the latest 20**.

**Add many feeds at once.** Paste feed URLs one per line. Lattice subscribes to each of them without looking for links.

**How feeds update.** Lattice checks every feed at startup and every 30 minutes. A new subscription imports the latest 20 entries, and after that only new entries come in. **Refresh all** checks now. Each feed row shows its state, the time of the last update, and its unread and total counts. **View articles →** opens the feed's articles. Deleting a feed keeps its articles under **Added by hand**.

**Folders.** A folder groups feeds, for example the per-channel feeds of one news service. A feed is in at most one folder, and folders do not nest.

- To create a folder, type a name under **Folders** and click **Create**. You can rename, reorder and delete folders there.
- To move feeds, pick a folder in a feed's row. Or tick several feeds and choose **Move to folder…**.
- To subscribe straight into a folder, choose it in **Folder to add to** before you add the feed.
- In the navigation, a folder is a row you can expand and collapse. Its number is the unread total of its feeds. Clicking it lists the articles of all its feeds. Right-click it, or use its ⋯ button, to rename or delete it. Deleting a folder keeps its feeds.

**Feed order.** Feeds keep the order you give them, within their folder and among the feeds in no folder. Every list of feeds in the app (the navigation, the Feeds screen, the palette, the scope pickers, OPML export and the CLI) uses that order.

- Drag a feed in the navigation and drop it on another feed to take that place, in the same folder or another one.
- Drop a feed on a folder row to put it last in that folder, even when the folder is collapsed.
- To take a feed out of all folders, drop it among the feeds in no folder. If every feed is in a folder, a box reading **Drop here to take it out of its folder** appears at the end while you drag.
- Drag a folder row to reorder the folders; their feeds come along.
- With a feed or folder row focused, `Alt+↑` and `Alt+↓` move it one place. A feed moved past the first or last feed of its folder goes into the neighboring folder, which opens if it was collapsed.
- On the Feeds screen, the feeds are grouped under their folders in the same order, and each row has ↑ and ↓ buttons.

A short click on a feed or folder still opens it; only a drag moves it.

**Names and icons.** Click **Edit** in a feed's row to set a **Display name** and an **Icon** (PNG, JPEG, GIF, WebP, SVG or ICO, up to 1 MB). **Revert** restores the feed's own name, and **Use the site's icon** removes your icon. Without your icon, Lattice shows the site's own icon.

**Import filters.** A filter decides which new entries a feed imports. There is one global filter in **Settings › Import filters** and one per feed under **Edit**. An entry is imported only when it passes both.

- **Rules** match a keyword or a regular expression against the **Title**, **URL**, **Author**, **Category**, **Domain** or **Language**, ignoring case. An entry that matches any skip rule is left out. If there are only-if rules, an entry must match at least one of them.
- **Shortest text** leaves out entries whose text is shorter than you set. It applies only to feeds that carry the full text.
- **Let the LLM judge what passes the rules** sends the title, the excerpt, your **About you** profile and your instructions in **What to import** to the AI provider. **Lowest importance** makes the decision a score from 1 to 5 instead. If the LLM call fails, the entries are imported anyway, and the feed shows why.
- **Rejected entries** lists what a filter left out, with the reason. **Import** saves one of them, and **Remove this rule** deletes the rule that rejected it. Changed rules do not apply to past entries by themselves. **Judge rejected entries again** applies the current rules to them.

**OPML.** **Import OPML** subscribes to the feeds in an OPML file. Outlines that contain feeds become folders. **Export OPML** writes your feeds, with their folders, to the `exports` folder.

### Import files

Open **Bulk import** in **Tools**. The **Import** screen has three tabs. Each tab has a **Collections** field, so the imported articles go straight into collections.

- **URL list** reads any text that contains URLs: a plain list, browser bookmarks (HTML), CSV, JSON, or the export of another read-later service. Paste the text or choose a file, then click **Import**. Lattice fetches the pages in the background and reports how many were new, already saved or invalid. A page that fails does not stop the others.
- **Markdown** imports one Markdown file, or pasted text, as an article. The title is the first heading, else the file name or the first line. Images with web URLs are saved. Images with relative paths are read from the file's folder, and only when you import a file. HTML tags are dropped. An imported file has no web page, so Page is not available for it.
- **PDF** imports a paper as an article. Lattice reads the text and rebuilds the reading order of two-column pages, the headings, captions and references. A PDF that is only scanned images cannot be imported. A PDF URL, such as arXiv's `…/pdf/…`, can be saved like any other URL, and a feed can deliver PDFs too.

### Pages built with JavaScript

Some pages send almost no text until JavaScript draws them. When a saved article comes out empty or short, Lattice marks it **Little text** and, if **Render JS pages automatically** is on, loads the page in a hidden browser and imports it again. This takes up to about 20 seconds per article. A rendered import replaces the article only if it has more text.

To do it by hand, choose **Render and import again** in the article's ⋯ menu. In the Page view, choose **Import again from the page as shown** instead: it uses the page as you see it, including content behind a login.

Some sites refuse automated fetches. When a feed carries the full text of its entries, Lattice imports that text instead and says so in the Reader. The Reader then offers **Retry**, which fetches the original page again.

## Read an article

### Reader and Page

Every saved article has two views. Switch between them with **Reader** and **Page** at the left of the toolbar, or press `v`.

- **Reader** shows the extracted text with its headings, lists, code, tables and saved images. It never loads anything from the web.
- **Page** shows the live web page in the built-in browser, with the same translation and word tools.

The two toolbars match. The right end has the same buttons in both: **Favorite**, **Mark as read**, **Ask**, **Quiz**, focus mode and the ⋯ menu. The ⋯ menu holds **Re-extract (from the saved HTML)**, the import-again action, **Auto-classify**, **Translate again**, **Summarize**, **Copy URL** and **Remove from Index…**.

Re-extract builds the article again from the saved HTML, PDF or Markdown, without the network. Use it after a Lattice update improves extraction.

**The browser.** The Page toolbar has back, forward, reload and **Home (search engine)**. Click the URL to edit it. Press `Enter` to go, or `Esc` to cancel. Text that is not a URL is searched with the engine you choose in **Settings › Browser**. The browser keeps your logins between sessions.

Imported Markdown and PDF files have no Page view. A PDF saved from a URL opens in the browser's PDF viewer.

### Choose the language shown

The language switch next to **Reader** and **Page** has three settings.

- **Original** shows the text as written.
- **Translated** shows the translation.
- **Mixed** shows a mix. The percentage is the share of translated text. Press `[` and `]` to lower or raise it by 10 percent.

Japanese articles are translated into English, and all other articles into Japanese. The display language of the app does not change this. Lattice picks the parts to translate from the page address and the text, so the same article always mixes the same way.

The setting applies to every article and every page until you change it.

### Flip one block

Hover over a paragraph in **Mixed** or **Translated** for a moment. A small popup shows the other language. Click the popup to flip that paragraph. With the keyboard, focus the paragraph and press `Enter`. In the Page view the same popup works sentence by sentence.

### Translate an article

The Reader toolbar shows the translation state, for example **Translated 12/40**.

- If **Translate when I switch the view** is on (the default), switching to **Mixed** or **Translated** starts the translation.
- **Translate** starts it by hand. **Translate the rest** finishes a partly translated article. Hover the button to see which direction it translates.
- **Translate again** drops this article's translations and translates it again with the current providers and settings. It is in the ⋯ menu once anything is translated, and in the toolbar once everything is. Lattice asks first if the article has more than 50 translated blocks. You cannot use it while the article's translation is running.
- If a translation fails, the toolbar shows the error, the time of the next automatic retry, and **Retry**. Paragraphs already translated are kept, so a retry sends only the rest.

Translations are shared by text. A paragraph translated in the Page view is already translated in the Reader, and the other way round. **Translate again** therefore also updates other articles and pages that contain the same paragraphs.

In the Page view, **Mixed** and **Translated** translate the page as you read it. Paragraphs the page already has in the target language are left alone.

### Summaries

The **Summary** section at the top of the Reader has **Summarize**. The summary takes your **About you** profile into account. If the article or your summary settings change later, the summary says so, and **Regenerate the summary** applies the change. Lattice never rewrites a summary by itself.

In the Page view of a saved article, the **Summary** button shows the same summary above the page.

### Find matches in an article

When you open an article from search results, the Reader shows **Match 1 / 5**. **Previous match** and **Next match** move between the matching passages.

### Focus mode

Press `f`, or click the focus mode button, to hide the navigation and the article list together. Press `f` again to bring them back. While the list is hidden, `j` and `k` still move its cursor.

### Back and forward

Lattice records where you go: screens, settings sections, lists, filters and the document in the focused tab. Go back and forward with the ‹ › buttons in the title bar, `Alt+←` and `Alt+→`, or the back and forward buttons of your mouse. The history holds 50 steps.

While a web page has the keyboard focus, `Alt+←`, `Alt+→` and the mouse buttons move through that page's own history instead. The ‹ › buttons in the Page toolbar always move through the page's history.

### Print a page

In the Page view, press `Ctrl+P`. Lattice opens the Windows print dialog.

## Tabs, panes and windows

### Tabs

Each pane of the document area has a row of tabs. A tab holds a Reader article or a web page.

- Clicking an article in the list, the palette, search results or a chat citation replaces the active tab of the focused pane.
- `Ctrl`+click or middle-click opens it in a new tab.
- **New tab** (the ＋ at the end of the tabs) opens your search engine's home page in a new tab. `Ctrl+T` opens the palette, and what you pick there opens in a new tab.
- `Ctrl+W` closes the tab, and so do the × button and a middle-click on the tab. `Ctrl+Tab` and `Ctrl+Shift+Tab` switch tabs.
- Drag a tab to reorder it.

Lattice restores your tabs and panes when it starts. Web pages in hidden tabs stay loaded, up to three of them, so switching back is instant and keeps your scroll position. Older hidden pages load again when you return to them.

### Split the document area

- **Split right** and **Split down** in the tab row split the focused pane. The keys are `Ctrl+\` and `Ctrl+-`.
- Drag the line between panes to resize them. Focus the line and use the arrow keys, or double-click it to make the panes equal.
- **Close pane** closes the focused pane. A pane with no tabs left disappears.
- Drag a tab to another pane's tab row to move it there. Drop it on the middle of a pane to add it to that pane. Drop it near an edge to split that pane and put the tab in the new half.

The focused pane has an outline. Clicking in a pane focuses it, and new documents open there.

### Move between panes with the keyboard

Press `Ctrl+B`, then one of these keys, the way tmux works:

| Key after `Ctrl+B` | What it does |
|---|---|
| `←` `→` `↑` `↓` or `h` `j` `k` `l` | Move to the pane in that direction |
| `o` | Move to the next pane |
| `%` | Split right |
| `"` | Split down |
| `x` | Close the pane |
| `c` `n` `p` | New tab, next tab, previous tab |
| `z` | Focus mode |

A hint bar shows these keys while `Ctrl+B` waits for the next one.

### Open a tab in its own window

- **Open in a new window** in the tab row, or `Ctrl+Shift+N`, moves the active tab to a new window.
- Drag a tab away from the tab row. After about 30 pixels it becomes a new window that follows the pointer. Move it over another window's tab row to put it there. Press `Esc` during the drag to put it back.

A document window uses its tab row as its title bar. Drag the empty part of the row to move the window. Double-click it to maximize. Each window has its own panes, tabs and palette.

**Move back to the main window** (the same key) returns the tab to the main window. So does closing the document window. A document window closes when its last tab leaves.

A web page loads again when its tab moves to another window. It does not keep its back and forward history.

The chat pane has its own **Open in a new window** button. Its **Move back to the main window** button docks it again, and closing the chat window just closes it.

Lattice remembers the size and position of each window and opens your windows again at startup. Closing the main window quits Lattice.

## Organize your library

### Genres, tags and difficulty

When you save an article, the AI provider gives it a genre, up to three tags and a difficulty. Genres are broad (Database, Security, Web and so on). The provider reuses your existing genres and creates a new one only when none fits. Difficulty runs from **Introductory** through **Beginner**, **Intermediate** and **Advanced** to **Expert**, rated for a working software engineer outside the article's field.

Change them in the line under the Reader's title.

- Pick another genre or difficulty from the menus. A choice you make is kept: automatic classification will not change it. Set the difficulty back to **Not rated** to let it be estimated again.
- **+ Tag** adds a tag, and the × on a tag removes it. Automatic classification only adds tags. It never removes yours.
- **Auto-classify** in the ⋯ menu drops your genre and difficulty choices and classifies the article again.

To rename a genre, open **Edit** next to **Genre** in the navigation (**Settings › Genres**). Renaming a genre to the name of another merges the two. A genre with no articles can be deleted.

### Importance

If you describe yourself in **About you** (**Settings › Summaries & chat**), the AI provider rates each new article from 1 to 5 for how much it matters to you, with a one-line reason: **Unrelated**, **Marginal**, **Of interest**, **Important**, **Must read**.

- The article list marks articles rated 4 and 5. Hover the mark to read the reason. The Reader shows the score and the reason under the title.
- **Important** in the navigation lists articles rated at or above a minimum, 4 unless you change it.
- When you edit your profile, earlier ratings are marked as judged against an earlier profile. They still count until you rate again. **Rate again** in **Settings › Importance** rates every unrated and outdated article. **Rate again** above the list rates the articles shown.

### Collections

A collection is a set of articles you put together by hand, such as a project or a reading list. An article can be in several collections.

- Create one with **+ New** under **Collections** in the navigation. Its ⋯ menu renames or deletes it. Deleting a collection keeps its articles.
- Add the open article with **+ Collection** in the Reader, with **Add this article to a collection…** in the palette, or with **Add to collection…** in the right-click menu.
- Add several at once with **Select** above the list, then **Add to collection**.
- Imports, and URLs you save while a collection is open, can go straight into a collection.

A collection can also be the scope of a search, a chat or an export.

### Read and favorites

Opening an article marks it as read. It stays in the **Unread** list until you change the list or a filter, so the list does not shift while you work through it. `m` toggles read and unread, and `s` toggles the favorite star. **Favorites** in the navigation lists the starred articles.

### Lists, filters and sorting

What the article list shows is a list you pick in the navigation, narrowed by filters.

**Lists.** **Recently added** (saved in the last 7 days), **Unread**, **Favorites**, **All articles** and **Important**, then each collection, each genre, each feed folder, each feed and **Added by hand**. The navigation shows six genres at first, with a link to the rest.

**Filters.** The chips above the list filter by **Genre**, **Tag**, **Collection**, **Source**, **Difficulty**, **Importance** and **Status**. **Status** has **Unread**, **Read**, **Favorites** and **Needs attention** (fetch or extraction failed, or little text). Values in one filter combine with OR, and different filters combine with AND. Tags can require **All of them** or **Any of them**. The counts in a filter are counts within the current list. When nothing matches, the list suggests which filter to remove and how many articles that would bring back.

`Esc` clears the filters. The palette can add filters too.

**Sorting.** **Sort and group** above the list sorts by **Date added, newest first**, **Date added, oldest first**, **Date published, newest first**, **Difficulty, easiest first** or **Most important first**. It can also group the list by **Source** or **Genre**.

**Moving through the list.** `j` and `k` (or `↓` and `↑`) move the cursor. `Enter` opens the article, and `Shift+Enter` opens it in Page.

### The right-click menu

Right-click an article in the list, or a Reader or Page tab, for its menu. The menu key and `Shift+F10` open it from the keyboard.

The menu has **Favorite**, **Mark as read**, **Add to collection…**, **Open in a new tab**, **Open in a new window**, **Open in Page**, **Copy URL** and **Remove from Index…**. A tab with an unsaved page has only the items that make sense for it.

### Act on several articles

Click **Select** above the list, then click articles to pick them. `Shift`+click picks a range. `Shift`+click also starts picking without the button. Right-click a picked article for the actions that apply to all of them: favorite, read or unread, and **Add to collection…**. Click **Done** to stop.

### Remove an article from the Index

Choose **Remove from Index…** in the ⋯ menu or the right-click menu, and confirm. Lattice deletes the saved HTML, the text, the translations no other article uses, the summaries, tags, images and search entries. This cannot be undone. Chat answers keep their citations. If the article came from a feed, the feed does not import it again.

## Search and ask

### Search

Press `/` to search your saved articles. Search is hybrid. It combines full-text matching with semantic matching, so a Japanese query finds English passages and the other way round. It searches the original text and the translations.

- Results are passages grouped by article. `j` and `k` move between them, `Enter` opens the article in the Reader at that passage, and `Shift+Enter` opens it in Page. `Esc` goes back to the list.
- The scope menu limits the search to **Recently added**, **Unread**, **Favorites**, a collection, a genre or a feed. The filter chips narrow the results further.
- **Search method** filters the results by kind of match: **Hybrid**, **Full text**, **Meaning** or **Full text + meaning**. The search itself always runs both ways.
- Recent searches appear in the navigation while you search.

Semantic search runs on your computer with the multilingual-e5-small model (about 470 MB), which Lattice downloads the first time you search. Until it is ready, results are full text only, and the results say why.

### The command palette

`Ctrl+K`, or a click on the box in the title bar, opens the palette. Type to find articles by title, tags, sources, genres and commands at once.

| Start with | To find |
|---|---|
| `#` | Tags |
| `@` | Sources: feeds and folders |
| `g:` | Genres |
| `>` | Commands only |
| `?` | A search of your saved articles |

- `Enter` runs the highlighted item. `Ctrl`+click opens an article in a new tab.
- `Tab` adds the highlighted tag, source or genre as a filter and keeps the palette open, so you can stack several.
- `Ctrl+Enter` searches the text you typed.
- A pasted URL offers **Open in Page**, **Add to Index (import)** and **Find and add its feed**.
- Commands include the lists, **Language shown: mixed** (add a number such as `70` to set the percentage), **Translate this article (queues a job)**, **Open today's review**, **Open vocabulary**, **Open jobs**, **Retry all failed jobs**, **Open chat**, **Manage feeds**, **Bulk import**, **Import Markdown**, **Import a PDF (paper)** and **Open settings**.

### Chat with your articles

**Chat** in the navigation opens the chat pane. Ask a question, and the answer comes from your saved articles only. Numbers in the answer are citations. Click one to open the passage it rests on. If the scope has nothing related, the answer says so instead of guessing.

**Scope** chooses what the answer draws from.

- **This article** is the article in the focused tab.
- **All open articles (3)** covers the saved articles open in your tabs, in every window. Each open article is also listed on its own under **Open articles**.
- **All articles**, the current list, a collection, a genre, a feed, a folder or a tag.

When the scope's text fits, Lattice sends all of it. Otherwise it sends the passages that search finds most relevant, at most four per article, so the answer can draw on many articles. Each answer says which way it was made. **Context per question** in **Settings › Summaries & chat** sets how much text one question may send.

- Press `Ctrl+Enter` to send.
- Follow-up questions see the last three exchanges.
- Chats are saved. The chat title opens a menu of saved chats, **New chat** and **Delete this chat**.
- **Ask** in the Reader opens the chat about that article.
- **Open in a new window** in the chat pane moves the chat to its own window. See [Open a tab in its own window](#open-a-tab-in-its-own-window).
- To type with Vim keys, turn on **Vim key bindings in the question box**.

## Learn from what you read

### Quiz yourself

**Quiz** in the Reader or Page toolbar opens a panel next to the article. **Generate a quiz** writes 3 to 8 questions about the article's key points, some open and some multiple choice.

1. For a multiple-choice question, pick an option. For an open question, think of the answer (you can type it under **Your answer**; it is not saved) and click **Show answer**.
2. Read the answer, its explanation and the source links, which jump to the passage.
3. Grade yourself: **Again**, **Hard**, **Good** or **Easy**, or press `1` to `4`. A multiple-choice answer suggests a grade, which you can change.

At the end, **Add to review** sends the questions to [Today's review](#todays-review). The answers you gave count as their first review. **Try again** starts over. If the article or your profile changes, **Regenerate** writes new questions.

The panel keeps its place when you switch to another screen or tab and come back. It forgets it when Lattice restarts.

### Save words

When you meet an English word or phrase you do not know, select it in the Reader and click **Save word**, or press `w`. In the Page view, selecting text shows the same button on the page. Lattice saves the word with the sentence it came from and the article.

The AI provider then adds the dictionary form, part of speech, an English definition, an example sentence, the pronunciation (IPA) and the meaning in Japanese. Forms of one word come together: saving "ran" after "run" adds a sentence to "run".

Saved words are underlined in articles, with their meaning in a tooltip.

A selection must contain English letters, stay on one line and be at most 64 characters.

### Vocabulary

**Vocabulary** in **Tools** lists your words.

- **Search words and meanings** filters the list. Sort by **Recently added** or **Due soonest**.
- Each word's ⋯ menu has **Edit meaning**, **Regenerate meaning and example**, **Suspend** (or **Resume**) and **Delete**. A word whose lookup failed has **Look up again**.
- **Underline saved words in articles** turns the underlines off or on.
- **Export CSV** writes a CSV file that Anki can import (front, back, tags) to the `exports` folder.

### Today's review

**Today's review** in the navigation shows how many cards are due. It shows quiz questions and word cards one at a time, spaced out with SM-2, the scheme Anki uses.

- A word card shows the word, its IPA and part of speech, and reads the word aloud. The answer side has the English meaning, an example, the Japanese meaning, the sentence you saved and **Go to source**. **Hear the word** and **Hear the example** speak again, and so does `r`.
- Each grade button shows when the card comes back. Grade with the buttons or `1` to `4`.
- A card's ⋯ menu removes the card or its whole article from review. For a word, **Suspend this word (resume it in Vocabulary)** stops it.
- When you finish, Lattice shows what you reviewed and when the next card is due. The list of articles in review lets you remove an article.

Correct answers stretch the interval: 1 day, 6 days, then about 2.5 times longer each time. **Again** sends the card back to the shortest interval. Daily limits and intervals are in **Settings › Review**. The day changes at midnight on your computer.

Speech uses the English voices of Windows and works offline. If Windows has no English voice, the speaker buttons do not appear.

## Background jobs

Fetching, rendering, translating and the other slow work runs in the background as jobs. **Jobs** in **Tools** shows them, with a red count in the navigation when some failed.

| Job | What it does |
|---|---|
| **Fetch** | Fetches the page at the URL, extracts the article text and saves it. |
| **Render** | Loads pages whose text a plain fetch does not get in a hidden browser, and saves the rendered page. |
| **Images** | Downloads and stores the article's images. |
| **Site icons** | Fetches the site icons shown next to feeds and articles. |
| **Search index** | Turns the article's paragraphs into vectors for search, on your computer. |
| **Translation** | Translates the article's paragraphs with the AI provider. |
| **Summary** | Writes the article's summary. |
| **Quiz** | Writes comprehension questions about the article. |
| **Word meanings** | Adds the meaning, definition, pronunciation and example to saved words. |
| **Classification** | Gives articles a genre, tags and a difficulty, up to 20 per call. |
| **Importance** | Rates articles against your profile, up to 20 per call. |
| **Import filter** | Decides with the LLM which new feed entries to import, up to 20 per call. |

The ⓘ next to each type explains it in the app too.

A job is **Pending**, **Running**, **Waiting to retry** or **Failed**. A failed job retries by itself after 2, 4, 8 and 16 minutes and stops after 5 attempts. **Retry now** runs a waiting job at once, **Retry** runs a failed one again, and **Retry failed** or **Retry all failed** does it for a type or for everything. **Cancel** removes a pending or failed job. A running job cannot be cancelled.

Fetches to the same site run one at a time, so a bulk import does not flood a site.

## Settings

Open **Settings** at the bottom of the navigation. The sections are grouped under **AI**, **Library**, **Controls**, **Data** and **App**. **Feeds →** under **Library** opens **Manage feeds**.

### AI providers

Translation, summaries, classification, importance, quizzes, word meanings, the LLM import filter and chat need an AI provider. Lattice supports these:

| Provider | What it needs |
|---|---|
| Claude CLI | The `claude` command, installed and signed in |
| Codex CLI | The `codex` command, installed and signed in |
| OpenAI API | An API key |
| Gemini API | An API key |
| Anthropic API | An API key |

Set up to three steps. Lattice uses the first and moves to the next when a call fails, for example on a usage limit. A step that failed sits out for 5 minutes. Drag steps to reorder them, or use `Space`, the arrow keys and `Space` again.

For each step, pick the provider, the model and the effort (how hard the model thinks). **Custom model ID** lets you type any model ID. Higher effort can improve quality but is slower and costs more. For translating in bulk, a fast model at low effort works well. If a model does not support the effort you pick, that step fails and the next one takes over.

Under **API keys**, enter the keys for the API providers. Lattice stores them in its database, never shows them again, and leaves them out of backups and exports. Without a saved key, Lattice reads `OPENAI_API_KEY`, `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` from the environment.

### Translation

| Setting | What it does |
|---|---|
| **Translate when I switch the view** | Starts translating when you switch the Reader to **Mixed** or **Translated**. On by default. Stored on this computer only. |
| **Translate saved articles automatically** | Translates every article as soon as it is saved. Off by default, because it uses the provider for every article. Japanese articles are skipped. |
| **Keep technical terms in English** | Keeps terms such as MVCC or write skew in English when translating into Japanese. For translation into English, it prefers the established English terms. On by default. |
| **Extra instructions** | Text added to the end of the translation prompt, such as a preferred register or glossary. Up to 2,000 characters. **Show the built-in prompt (English to Japanese)** shows what it adds to. |

Both settings apply to the Reader and to translated pages. Lattice keeps translations separately for each setting. After a change, translate articles again to use it. Changing back shows the earlier translations.

### Summaries & chat

| Setting | What it does |
|---|---|
| **About you** | Your work, interests and what you already know. Summaries, chat answers, quizzes, importance and the LLM import filter take it into account. Up to 2,000 characters. |
| **Extra instructions for summaries** | Added to summaries only. Existing summaries then show that regenerating applies it. |
| **Extra instructions for chat** | Added to chat answers only, from the next question. |
| **Context per question** | How much article text one chat question sends: **Small (about 40,000 characters)**, **Standard (about 80,000 characters)** or **Large (about 150,000 characters)**. More text gives more thorough answers but costs more and takes longer. |
| **Vim key bindings in the question box** | Vim keys in the chat box. It starts in insert mode. `Esc` switches to normal mode. `Ctrl+Enter` sends in either mode. Stored on this computer only. |

### Auto-classification

**Sort saved articles into genres and tag them with the LLM** is on by default. **Classify all unclassified** queues every article that has no genre or difficulty.

### Importance

**Rate newly saved articles** rates new articles while **About you** is filled in. **Lowest importance in Important** sets the minimum for **Important** in the navigation. **Rate again** queues the articles that are unrated or rated against an earlier profile.

### Genres

Lists every genre with its article count. Rename, merge or delete genres here. See [Genres, tags and difficulty](#genres-tags-and-difficulty).

### Import & JS rendering

**Render JS pages automatically** renders articles that came out nearly empty. See [Pages built with JavaScript](#pages-built-with-javascript).

### Import filters

The global filter for all feeds. See [Subscribe to feeds](#subscribe-to-feeds).

### Images

**Save images** downloads article images (PNG, JPEG, GIF, WebP and AVIF) and stores them in the database. SVG images stay links. **Size limit per image** is 5 MB by default and can be 1 to 20 MB. An article can store up to 30 MB of images. Turning this off keeps the images already saved.

### Review

| Setting | Default |
|---|---|
| **New cards per day** | 20 |
| **Reviews per day** | 200 |
| **Shortest interval** | 1 day. Under a day, a card comes back the same day, like Anki's learning steps. |
| **Longest interval** | 365 days |
| **Say word cards aloud** | On. Stored on this computer only. |

The limits cover quiz cards and word cards together.

### Display language

The app's language: Japanese or English. Lattice starts in your system's language and switches at once, without a restart. The display language does not change which way articles are translated.

### Shortcuts

Lists every shortcut. **+ Add key** records the next key you press, with modifier keys if you hold them. An action can have several keys. When a key belongs to two actions, the one higher in the list wins, and the list warns you. **Reset to default** resets one action, and **Reset all to defaults** resets all of them. Shortcuts are stored on this computer only.

### Browser

**Search engine** is used for text typed in the URL bar and for the home button: DuckDuckGo (the default), Google, Bing, Brave Search, Kagi or **Custom**. For a custom engine, enter a **Search URL** with `%s` where the search terms go.

### Taskbar

**Show the unread count on the taskbar** puts the number of unread articles on Lattice's taskbar button. It shows 99+ from 100 up and nothing at zero.

### Backup

**Back up now** writes a copy of the database to the `backups` folder. **Backups to keep** sets how many copies to keep, 30 by default. Lattice deletes the oldest copies beyond that number and never deletes by age.

### Cloud backup (R2)

Uploads a gzip-compressed copy of the database, without API keys, to a Cloudflare R2 bucket on a schedule. Enter the Account ID, bucket, Access Key ID and Secret Access Key, turn on **Automatic backup**, and set **Interval (hours)** (24 by default) and **Backups to keep** (30 by default). **Back up to R2 now** runs one at once. Several computers can back up to the same bucket.

The [`infra/r2`](../infra/r2/README.md) folder has Terraform that creates the bucket, and explains how to create the access key and how to restore. Restoring is manual.

### Export

**What to export** chooses the whole library or one collection. **Export** writes gzip-compressed JSON Lines to the `exports` folder: articles, blocks, translations, summaries, tags, genres, feeds and folders, collections, quizzes and chats. An export of one collection leaves the chats out. API keys, other settings, the fetched HTML, images and search vectors are not exported. To keep those, use a backup.

### Logs & storage

Shows where the database, backups, exports, search model and logs are. **Change…** moves the data to another folder. See [Where your data is](#where-your-data-is).

### Updates

**Check for updates** looks for a new version on GitHub Releases. Lattice also checks at startup and shows a bar under the title bar when a new version is out, with **Release notes**, **Update and restart** and **Later**. The update is installed only after its signature checks out, and your data stays as it is. A portable copy is updated by replacing `Lattice.exe` with the one from the new zip.

## Keyboard shortcuts

These are the default keys. Change them in **Settings › Shortcuts**.

### Lists and navigation

| Action | Default keys |
|---|---|
| Command palette | `Ctrl+K` |
| Search | `/` |
| Next item | `j`, `↓` |
| Previous item | `k`, `↑` |
| Open the article under the cursor | `Enter` |
| Open the article under the cursor in Page | `Shift+Enter` |
| Back / clear filters | `Esc` |
| Back (in-app history) | `Alt+←` |
| Forward (in-app history) | `Alt+→` |

### Articles

| Action | Default keys |
|---|---|
| Switch between Reader and Page | `v` |
| Less translated text | `[` |
| More translated text | `]` |
| Favorite | `s` |
| Read / unread | `m` |
| Focus mode | `f` |
| Save the selected English word to Vocabulary | `w` |
| Hear the word card again | `r` |

### Tabs, panes and windows

| Action | Default keys |
|---|---|
| New tab | `Ctrl+T` |
| Close tab | `Ctrl+W` |
| Next tab | `Ctrl+Tab` |
| Previous tab | `Ctrl+Shift+Tab` |
| Split pane right | `Ctrl+\` |
| Split pane down | `Ctrl+-` |
| Open the tab in a new window / move it back to the main window | `Ctrl+Shift+N` |
| Pane prefix (then ← → ↑ ↓ / h j k l, o, z, " %, x, c n p) | `Ctrl+B` |

### Fixed keys

These keys cannot be changed.

| Key | Where | What it does |
|---|---|---|
| `Enter` | A focused paragraph in the Reader | Flips it between the original and the translation |
| `1` to `4` | A quiz or review card | Grades it |
| `Ctrl+Enter` | The chat box | Sends the question |
| `Tab` | The palette | Adds the highlighted item as a filter |
| `Ctrl+Enter` | The palette | Searches, or saves a pasted URL |
| Menu key, `Shift+F10` | A list row or a tab | Opens its right-click menu |
| `Ctrl+P` | A web page | Prints it |
| `Esc` | A dragged tab | Puts it back |
| Mouse back and forward buttons | Anywhere | In-app history, or the page's history over a page |

### Shortcuts while a web page has the focus

When you click into a web page, the page gets the keyboard. Lattice still catches its own shortcuts there.

- `Ctrl+K`, `Ctrl+B` and the other `Ctrl` shortcuts work everywhere, even in the page's text fields.
- Single-letter shortcuts such as `j`, `s` and `v` work outside the page's text fields, unless the page uses the key itself.
- `Enter`, `Esc`, the arrow keys and `Space` stay with the page, for scrolling and its own controls.
- `Alt+←`, `Alt+→` and the mouse buttons move through the page's history. `w` and `r` do nothing there: use the button on the page to save a word.

## CLI and MCP

`lattice-cli` reads and adds to your library from a terminal, and serves it to AI agents such as Claude Code over MCP. It is in the portable zip, next to `Lattice.exe`. It uses the same data as the app, including the portable data folder and a folder you chose in **Settings › Logs & storage**, and works while the app is running.

### Commands

```bash
lattice-cli search "MVCC write skew" --limit 5
```

```bash
lattice-cli --format text get 42
```

| Command | What it does |
|---|---|
| `search QUERY` | Hybrid search over the saved text. `--scope`, `--limit` (20 by default). |
| `get ID` | One article: metadata, summary and text. `--blocks` lists the blocks with their ids. `--translation` adds the stored translation. |
| `list` | Saved articles, newest first. `--scope`, `--limit` (50 by default). |
| `summary ID` | An article's stored summary |
| `tags` | Tags with their article counts |
| `genres` | Genres with their article counts |
| `feeds` | Subscribed feeds, with their folders |
| `jobs` | Queued, running and failed jobs |
| `ask QUESTION` | Answers from your saved articles with citations, through the app's AI providers. `--scope`. |
| `save URL` | Saves a URL. Needs write access. `--run` fetches it now instead of leaving it to the app. |
| `tag ID NAME` | Adds a tag. Needs write access. |
| `read ID` | Marks an article as read. Needs write access. |
| `favorite ID` | Stars an article. Needs write access. |
| `mcp` | Serves the commands to agents as an MCP server over stdio |

These options work with every command:

- `--format json` (the default) or `--format text`, which is easier to read.
- `--data-dir PATH` uses another data folder.
- `--allow-write` allows `save`, `tag`, `read` and `favorite`. Setting `LATTICE_ALLOW_WRITE=1` does the same.

`lattice-cli --help` lists everything.

### Scopes

`--scope` takes one of these:

| Scope | Articles |
|---|---|
| `all` | Every article (the default) |
| `unread` | Unread articles |
| `favorites` | Starred articles |
| `tag:NAME` | Articles with this tag |
| `genre:NAME` | Articles in this genre |
| `feed:ID` | Articles from this feed |
| `folder:ID` | Articles from the feeds in this folder |
| `group:ID` | Articles in this collection |
| `important` or `important:MIN` | Articles rated at least MIN (4 by default) |
| `article:ID` or `article:3,7` | These articles |

`feeds` shows the feed and folder ids.

### What the CLI does and does not do

- Search works like the app's. If the app has not downloaded the semantic search model, the CLI does not download it: results are full text only, and the JSON says so.
- A question from `ask` appears in the app's chat history.
- `save` queues the fetch, and the running app picks it up within 30 seconds. With `--run`, the CLI fetches the page, its images and, if the model is there, its search vectors itself. Classification and rendering still wait for the app.
- Changes from `tag`, `read` and `favorite` show in the app the next time it reloads the list.
- The CLI cannot unstar, mark as unread, remove tags or delete articles. Agents get only actions that are easy to undo.

### Use Lattice from Claude Code

```bash
claude mcp add lattice -- lattice-cli mcp
```

This gives the agent `search`, `get`, `list`, `summary`, `tags`, `genres`, `feeds`, `jobs` and `ask` as tools. To also give it `save`, `tag`, `read` and `favorite`, add `--allow-write` after `mcp`.

### Prompt injection

Your saved articles are web pages written by other people. An agent that reads them can be steered by instructions hidden in the text. Every tool result starts with a note that the content is untrusted and must not be followed, and results are capped at 25,000 characters. That lowers the risk but does not remove it.

- Keep write access off unless you need it.
- Do not give an agent session that reads your articles tools that can do damage, such as a shell, file writes or email.

## Data, privacy and safety

### Where your data is

Lattice keeps all its data in one SQLite file: articles, the fetched HTML, translations, summaries, images, the search index, chats, quizzes, words and settings.

| What | Where (installed version) |
|---|---|
| Database | `%APPDATA%\dev.lattice.app\lattice.db` |
| Backups | `%APPDATA%\dev.lattice.app\backups\` |
| Exports (JSON, CSV, OPML) | `%APPDATA%\dev.lattice.app\exports\` |
| Semantic search model | `%APPDATA%\dev.lattice.app\models\` |
| Logs | `%LOCALAPPDATA%\dev.lattice.app\logs\` |

**Settings › Logs & storage** shows the exact paths.

**Portable copy.** The portable zip keeps everything in a `data` folder next to `Lattice.exe`, including the logs and the built-in browser's cookies and cache.

**Move the data.** In **Settings › Logs & storage**, click **Change…** and choose a folder. Lattice copies the database, backups, exports and the search model there and uses the new folder after a restart. Restart right away: anything changed after the copy stays behind. The old copy is not deleted. Delete it yourself when you no longer need it. If the folder already holds Lattice data, Lattice switches to it without copying. If the chosen folder cannot be used at startup, Lattice opens the default folder and the settings page says why.

Some preferences are stored per computer instead of in the database: shortcuts, the search engine, **Translate when I switch the view**, the Vim setting, speech, underlines, folder expansion and the window layout. They are not in backups.

### What goes to AI providers

Lattice sends text to the AI provider you set up only for these features:

| Feature | What is sent |
|---|---|
| Translation | The paragraphs to translate, and your translation instructions |
| Translated pages | The paragraphs of the page you view, while **Mixed** or **Translated** is on |
| Summaries | The article text, **About you** and your summary instructions |
| Classification | The title, domain, and the summary or the start of the text |
| Importance | The title, domain, the summary or the start of the text, and **About you** |
| Quizzes | The article text and **About you** |
| Word meanings | The word and the sentence you saved it with |
| LLM import filter | Each entry's title and excerpt, **About you** and your instructions |
| Chat | Your question, the article text in the scope, the last three exchanges, **About you** and your chat instructions |

Semantic search, speech and extraction run on your computer. The CLI providers use your own sign-in to those tools.

### API keys

API keys and the R2 secret are stored in the local database. They are never shown again, and they are left out of backups, R2 uploads and exports. **Change…** in **Settings › Logs & storage** copies them to the new folder with the rest of the database.

### Article content is untrusted

Saved pages are written by other people, so Lattice treats their content as data, never as instructions.

- The app shows article text as plain text. Article HTML never runs inside Lattice's own window.
- Web pages run in a separate browser that can only open http and https addresses and can reach only a few narrow Lattice functions.
- AI providers never get tools. The CLI providers run with tools, MCP servers and user settings turned off, in an empty temporary folder. Every prompt tells the model to ignore instructions in the article.
- Translations that go back into a page are cleaned of scripts and unsafe links first.
- Lattice does not download images or site icons, or look for feeds, at private network addresses.

## Troubleshooting

### Translation seems stuck

- Open **Jobs**. A translation job that is **Running** is still working. With a CLI provider, one call can take several minutes for a long article. The log records how long each AI job took.
- A **Waiting to retry** job failed and will try again, for example after a usage limit. **Retry now** runs it at once.
- If the toolbar shows **Translate the rest**, part of the article is not translated yet. Click it.
- A Japanese article is translated into English. That is expected, not a wrong language guess.
- If nothing happens at all, check **Settings › AI providers**. Every feature that uses an AI provider needs at least one working step.

### Search shows only full-text results

The search results say that they show full-text matches only, and why. Usually the semantic search model is still downloading, or the computer was offline when it tried. **Retry** tries again. New articles join semantic search after their **Search index** job runs.

### A page will not save, or saves with little text

- An article marked **Fetch failed** could not be downloaded. Some sites refuse anything but a browser. Open it in Page and choose **Add to Index**, or **Import again from the page as shown** if it is already saved.
- An article marked **Little text** may be drawn by JavaScript. Choose **Render and import again** in the ⋯ menu, or use the Page view as above.
- If a site needs a login, sign in in the Page view first. The hidden browser that renders pages shares those logins.
- A PDF that is only scanned images has no text to import.

### A feed does not import what I expect

- **Manage feeds** shows each feed's errors. **Refresh all** checks every feed now.
- Check **Rejected entries** under **Edit** for entries a filter left out, with the reason.
- A new feed imports only its latest 20 entries.

### Shortcuts do nothing in a web page

The page has the keyboard. Single-letter shortcuts work only outside the page's text fields and only when the page does not use the key. `Ctrl+K` always works. Clicking anywhere outside the page gives the keyboard back to Lattice.

### A moved tab reloaded its page

A web page loads again when its tab moves to another window, and its back and forward history does not move with it. This is expected.

### A menu over a web page appears a moment late

Menus that open over a web page wait until the page is hidden behind a still image, then appear all at once. Hovering a ⋯ button before you click it makes this faster.

### Lattice opened an empty library

If the data folder you chose cannot be found or used, Lattice starts with the default folder. **Settings › Logs & storage** shows the reason. Fix the folder, or choose it again with **Change…**.

### Updates

If **Settings › Updates** says automatic updates are not set up, this build cannot check for updates. Download new versions from the [Releases page](https://github.com/Maru32768/lattice/releases). A portable copy never updates itself: replace `Lattice.exe` with the one from the new zip.

### Where are the logs?

In `%LOCALAPPDATA%\dev.lattice.app\logs\`, or in the `data` folder of a portable copy. Failed jobs, backups and the duration of each AI job are logged there.
