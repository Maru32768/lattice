import type { Messages } from "./index.ts";

const numbers = new Intl.NumberFormat("en-US");
/** "1 article", "2 articles". */
const plural = (n: string | number, one: string, other: string) => `${numbers.format(Number(n))} ${Number(n) === 1 ? one : other}`;

export const en = {
  "language.title": "Display language",
  "language.desc": "The language of menus, buttons and messages. Article translation is unaffected: Japanese articles are translated into English, others into Japanese.",
  "settingsView.groupLibrary": "Library",
  "settingsView.groupControls": "Controls",
  "settingsView.groupData": "Data",
  "settingsView.groupApp": "App",
  "settingsView.provider": "AI providers",
  "settingsView.providerLead": "The models used for translation, summaries, classification and chat. They are tried top to bottom: when one fails (a usage limit or an error), the next one takes over, and the one that failed sits out for 5 minutes.",
  "settingsView.translation": "Translation",
  "settingsView.translationLead": "Applies both to article translation and to translated pages.",
  "settingsView.instructions": "Summaries & chat",
  "settingsView.instructionsLead": "Shapes summaries and chat answers around your interests and background. Article text is treated as untrusted input: instructions inside it are never followed.",
  "settingsView.classify": "Auto-classification",
  "settingsView.genres": "Genres",
  "settingsView.genresLead": "Renaming a genre to an existing genre's name merges the two (its articles move over; genres picked by hand in the Reader stay as they are). Genres without articles can be deleted. Auto-classification uses the new name from then on.",
  "settingsView.render": "Import & JS rendering",
  "settingsView.images": "Images",
  "settingsView.review": "Review",
  "settingsView.reviewLead": "Questions you add to review from a quiz come back in Today's review, spaced out with SM-2, the scheme Anki uses. Each correct answer stretches the interval (1 day, 6 days, then about 2.5× each time); Again sends it back to the shortest interval.",
  "settingsView.shortcuts": "Shortcuts",
  "settingsView.shortcutsLead": "Keyboard controls. Adding a key records the next key you press (combinations with modifier keys work too).",
  "settingsView.browser": "Browser",
  "settingsView.browserLead": "The URL bar and home button of the Page view (the in-app browser).",
  "settingsView.taskbar": "Taskbar",
  "settingsView.backup": "Backup",
  "settingsView.backupLead": "All data (articles, translations, summaries, images, the search index) lives in one SQLite file, and a backup is a copy of that file (see Logs & storage for where it is).",
  "settingsView.r2": "Cloud backup (R2)",
  "settingsView.r2Lead": "Uploads a gzip-compressed copy of the database (without API keys) to Cloudflare R2. After each successful upload, the backups on this device are pruned to the number of newest generations you set (nothing is deleted by age, so a break from the app loses nothing). The bucket is managed with the Terraform in {code}.",
  "settingsView.export": "Export",
  "settingsView.storage": "Logs & storage",
  "settingsView.update": "Updates",
  "settingsView.updateLead": "New versions come from GitHub Releases. An update is installed only after its signature checks out, and your data stays as it is.",
  "settingsView.models": (p) => plural(p.length, "model", "models"),
  "common.error": "Error",
  "settingsView.categories": "Settings categories",
  "settingsView.backToLibrary": "Back to library",
  "settingsView.feeds": "Feeds →",
  "settingsView.groupAi": "AI",
  // @i18n-append
} satisfies Messages;
