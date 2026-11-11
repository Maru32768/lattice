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

const keysOf = (page: Page, label: string) =>
  page
    .locator(".stg .set")
    .filter({ has: page.locator(".h").getByText(label, { exact: true }) })
    .locator(".kbd.key");

const lastSaved = async (page: Page) => (await callsOf(page, "set_ui_prefs")).at(-1);

test("the library's settings win over the ones cached on this PC", async ({ shell }) => {
  await start(
    shell,
    { "lattice.shortcuts": JSON.stringify({ read: ["Q"], version: 2 }), "lattice.chatVim": "on" },
    { "lattice.shortcuts": JSON.stringify({ favorite: ["X"], version: 2 }), "lattice.chatVim": "", "lattice.vocabMarks": "off" },
  );
  await navItem(shell, "単語帳").click();
  await expect(shell.getByRole("switch", { name: "記事中の登録語に下線を引く" })).not.toBeChecked();

  await openSettings(shell);
  await section(shell, "ショートカット");
  await shell.getByRole("tab", { name: /^記事 \d+/ }).click();
  await expect(keysOf(shell, "お気に入り")).toHaveText(["x×"]);
  await expect(keysOf(shell, "既読 / 未読"), "the cached change gives way to the library's set").toHaveText(["m×"]);

  await shell.keyboard.press("Escape");
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  await expect(shell.getByLabel("質問", { exact: true }), "an empty row turns Vim off").toHaveJSProperty("tagName", "TEXTAREA");
  expect(await shell.evaluate(() => localStorage.getItem("lattice.chatVim")), "pop-outs see it off too").toBeNull();
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

test("an open Settings screen follows a change the start-up sync or another window makes", async ({ app }) => {
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
