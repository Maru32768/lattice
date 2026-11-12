// The settings kept in the library (src/lib/prefs.ts): its rows win over the copies cached on this PC at start, the
// first start copies the cached ones in, and a change in Settings goes to the library. The mock's rows start empty on
// every load, so a spec puts rows there with `window.__uiPrefs`.
import { test, expect, list, callsOf, navItem } from "./harness.ts";
import type { Page } from "@playwright/test";

/** The main window started with `cached` in localStorage and `rows` in the library. */
async function start(page: Page, cached: Record<string, string>, rows: Record<string, string> = {}) {
  await page.addInitScript(
    ({ cached, rows }) => {
      for (const [k, v] of Object.entries(cached)) {
        localStorage.setItem(k, v);
      }
      Object.assign(window, { __uiPrefs: rows });
    },
    { cached, rows },
  );
  await page.goto("/");
  await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
}

async function openSettings(page: Page) {
  await page.locator(".nav").getByRole("button", { name: "設定" }).click();
}

const section = (page: Page, title: string) =>
  page
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: page.locator(".label").getByText(title, { exact: true }) })
    .click();

const row = (page: Page, label: string) => page.locator(".stg .set").filter({ has: page.locator(".h").getByText(label, { exact: true }) });
const keysOf = (page: Page, label: string) => row(page, label).locator(".kbd.key");

const lastSaved = async (page: Page) => (await callsOf(page, "set_ui_prefs")).at(-1);

test("the library's settings win over the ones cached on this PC", async ({ shell }) => {
  await start(
    shell,
    { "lattice.shortcuts": JSON.stringify({ read: ["Q"], version: 3 }), "lattice.chatVim": "on" },
    {
      "lattice.shortcuts": JSON.stringify({ favorite: ["X"], version: 3 }),
      "lattice.chatVim": "",
      "lattice.vocabMarks": "off",
      "lattice.searchEngine": JSON.stringify({ id: "google", custom: "" }),
      "lattice.vocabAutoplay": "off",
      "lattice.chatSendKey": "enter",
    },
  );
  await navItem(shell, "単語帳").click();
  await expect(shell.getByRole("switch", { name: "記事中の登録語に下線を引く" })).not.toBeChecked();

  await openSettings(shell);
  await section(shell, "ショートカット");
  await shell.getByRole("tab", { name: /^記事 \d+/ }).click();
  await expect(keysOf(shell, "お気に入り")).toHaveText(["x×"]);
  await expect(keysOf(shell, "既読 / 未読"), "the cached change gives way to the library's set").toHaveText(["m×"]);
  await section(shell, "ブラウザ");
  await expect(shell.getByLabel("検索エンジン"), "the URL bar searches with the library's engine").toHaveValue("google");
  await section(shell, "復習");
  await expect(shell.getByRole("switch", { name: "単語カードの発音を自動で再生" })).not.toBeChecked();
  await section(shell, "要約・対話");
  await expect(shell.getByLabel("送信キー")).toHaveValue("enter");

  await shell.keyboard.press("Escape");
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  await expect(shell.getByLabel("質問", { exact: true }), "an empty row turns Vim off").toHaveJSProperty("tagName", "TEXTAREA");
  expect(await shell.evaluate(() => localStorage.getItem("lattice.chatVim")), "pop-outs see it off too").toBeNull();
  await expect(shell.locator(".chat-f-row .kbd"), "the chat box sends on the library's key").toHaveText(["Enter"]);
});

test("the first start copies the settings cached on this PC into the library", async ({ shell }) => {
  const engine = JSON.stringify({ id: "google", custom: "" });
  await start(shell, { "lattice.searchEngine": engine, "lattice.vocabMarks": "off" });
  await expect.poll(() => lastSaved(shell)).toEqual({ prefs: { "lattice.searchEngine": engine, "lattice.vocabMarks": "off" } });
});

test("a change in Settings goes to the library, and Vim off goes as an empty value", async ({ app }) => {
  await openSettings(app);
  await section(app, "Vim");
  const vim = app.getByRole("switch", { name: "対話の入力欄とメモでVimキーバインドを使う" });
  await vim.check();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.chatVim": "on" } });
  await vim.uncheck();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.chatVim": "" } });

  await section(app, "ブラウザ");
  await app.getByLabel("検索エンジン").selectOption("google");
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.searchEngine": JSON.stringify({ id: "google", custom: "" }) } });
});

test("each of the other settings goes to the library when it changes", async ({ app }) => {
  await openSettings(app);
  await section(app, "翻訳");
  await app.getByRole("switch", { name: "表示を切り替えたら自動で翻訳" }).uncheck();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.translateOnSwitch": "off" } });

  await section(app, "復習");
  await app.getByRole("switch", { name: "単語カードの発音を自動で再生" }).uncheck();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.vocabAutoplay": "off" } });

  await section(app, "要約・対話");
  await app.getByLabel("送信キー").selectOption("enter");
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.chatSendKey": "enter" } });
  await app.getByLabel("送信キー").selectOption("ctrlEnter");
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.chatSendKey": "" } });

  await section(app, "Vim");
  const vimrc = app.getByLabel("vimrc", { exact: true });
  await vimrc.fill("nnoremap j gj");
  await vimrc.blur();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.vimrc": "nnoremap j gj" } });

  await section(app, "ショートカット");
  await app.getByRole("tab", { name: /^記事 \d+/ }).click();
  await row(app, "お気に入り").getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("x");
  await app.keyboard.press("Enter");
  const shortcuts = async () => {
    const saved = (await lastSaved(app)) as { prefs: Record<string, string> } | undefined;
    return JSON.parse(saved?.prefs["lattice.shortcuts"] ?? "null") as unknown;
  };
  await expect.poll(shortcuts).toEqual({ favorite: ["S", "X"], version: 3 });

  await app.keyboard.press("Escape");
  await navItem(app, "単語帳").click();
  await app.getByRole("switch", { name: "記事中の登録語に下線を引く" }).uncheck();
  await expect.poll(() => lastSaved(app)).toEqual({ prefs: { "lattice.vocabMarks": "off" } });
});

test("an open Settings screen follows a storage event for its setting, as the start-up sync and other windows send", async ({ app }) => {
  await openSettings(app);
  await section(app, "翻訳");
  const onSwitch = app.getByRole("switch", { name: "表示を切り替えたら自動で翻訳" });
  await expect(onSwitch).toBeChecked();
  await app.evaluate(() => {
    localStorage.setItem("lattice.translateOnSwitch", "off");
    window.dispatchEvent(new StorageEvent("storage", { key: "lattice.translateOnSwitch" }));
  });
  await expect(onSwitch).not.toBeChecked();
});
