**English** | [日本語](README.ja.md)

# Lattice

Lattice is a Windows app for collecting technical articles, reading them with translation, and searching them later. It keeps each article's text and images on your computer, so you can still read an article after the original page is gone. Translations, summaries and answers to your questions come from the AI you choose: the Claude or Codex CLI, or the OpenAI, Gemini or Anthropic API.

![Lattice showing a Rust Blog post in the Page view, with about 40% of the text in Japanese and the rest in English](docs/images/main_image.png)

<sub>The page shown is [Announcing Rust 1.99.0](https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/) from the Rust Blog.</sub>

## Read with partial translation

Lattice's main feature is partial translation: you translate part of an article and read the rest in the original.

Choose **Mixed** in the toolbar and set how much to translate, for example 70%. That share of the sentences is shown in Japanese and the other sentences stay in English. The share moves in steps of 10%; the lower it is, the more you read in English. When an English paragraph is hard to follow, switch just that paragraph to the translation. The other way round, hold the pointer over a translated sentence to check the original.

This works both in the Reader, which shows the saved text, and in the Page view, which shows the original web page. Japanese articles work the other way: Lattice translates them into English and mixes them the same way. You can also read a whole article in the original or entirely translated.

This way of reading is inspired by [Mazelingo](https://github.com/Yeq6X/mazelingo). The code that decides which units to translate and the code that shows translations on top of web pages are adapted from Mazelingo.

## What it does

- **Collect.** Add articles in any of these ways: paste a URL, save the page you are viewing in the built-in browser, subscribe to RSS / Atom feeds, or import bookmarks, URL lists, Markdown and PDF papers. Pages that build their text with JavaScript are rendered before Lattice extracts it. Feeds can have filters that choose which entries get imported.
- **Read.** The Reader shows the extracted text and the Page view opens the original page; both support the partial translation above. The AI also writes summaries. Articles open in tabs, which you can split into panes or move to their own windows.
- **Organize.** The AI assigns a genre, tags and a difficulty (you can change them later). It also rates how important each article is to you, given your interests. You can also gather articles into your own collections, and narrow the list by stacking conditions such as genre, tag and unread.
- **Search and ask.** Search matches both keywords and meaning, so a Japanese query finds the matching passage in an English article. Ask a question in the chat pane and the AI answers only from your saved articles. Click a citation in the answer to jump to the paragraph it relied on.
- **Learn.** The AI writes quizzes that check what you read. Save unknown English words together with the sentence they came from. Review quizzes and words with the same kind of spaced repetition as Anki.
- **Keep your data.** All data is in one SQLite file. Lattice can back it up on your computer, back it up automatically to Cloudflare R2, and export it as JSON.

## Install

Lattice runs on Windows 10 and 11. Download one of these from the [Releases page](https://github.com/Maru32768/lattice/releases):

- **Installer** (`Lattice_x.y.z_x64-setup.exe`): the usual choice. Lattice can update itself when a new version comes out. The installer also installs the Microsoft Visual C++ runtime if it is missing, which may ask for administrator approval.
- **Portable zip**: unzip it anywhere and run `Lattice.exe`. All data is stored in a `data` folder next to it. It does not update itself.

Lattice needs WebView2, which comes with Windows 11. With the portable zip, install WebView2 and the Microsoft Visual C++ x64 runtime yourself if they are missing (the bundled CLI needs the same runtime). Microsoft's [latest supported Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#latest-supported-redistributable-version) page has the runtime.

To build from source, see the [developer guide](docs/development.md).

## Getting started

1. Open **Settings** with the gear at the bottom left, and set up at least one provider under **AI providers**. Translation, summaries, classification, chat and quizzes need one. Saving, reading and full-text search work without one.
2. Press `Ctrl+K`, paste an article's URL and choose **Save to library (import)**. In Lattice, the library is the set of articles you have saved.
3. Open the article from the list and switch between **Original**, **Mixed** and **Translated** in the toolbar. Switching to **Mixed** or **Translated** starts translating an article that is not translated yet.

To subscribe to a feed, use **Manage** next to **Source** in the sidebar. To import files, use the ＋ at the top of the navigation (**Add articles**).

## Learn more

The [user guide](docs/guide.md) explains every feature. Places you may want first:

- [Set up an AI provider](docs/guide.md#set-up-an-ai-provider)
- [Keyboard shortcuts](docs/guide.md#keyboard-shortcuts) (`Ctrl+K` opens the command palette; change keys in **Settings › Shortcuts**)
- [Data and backups](docs/guide.md#data-and-backups)
- [Privacy and safety](docs/guide.md#privacy-and-safety) (what is sent to AI providers)

## CLI and MCP

The bundled `lattice-cli.exe` searches and reads your saved articles from a terminal. It can also serve them to AI agents such as Claude Code as an MCP server. Both the installer and the portable zip put it in the same folder as `Lattice.exe`. For the default installation, run this in PowerShell to add it to Claude Code:

```powershell
claude mcp add lattice -- "$env:LOCALAPPDATA\Lattice\lattice-cli.exe" mcp
```

Saved articles are web pages written by other people. An agent that reads them can follow instructions planted in the text. Before you connect an agent, read [CLI and MCP](docs/guide.md#cli-and-mcp) in the user guide for the list of commands and for how to keep writes and risky tools away from that agent.

## Development

To build, test or release Lattice, see the [developer guide](docs/development.md).

## License

MIT. See [LICENSE](LICENSE). Lattice includes code adapted from [Mazelingo](https://github.com/Yeq6X/mazelingo) and fonts under the SIL Open Font License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
