import { test, expect, callsOf, list } from "./harness.ts";

async function openShortcuts(page: import("@playwright/test").Page) {
  await page.locator(".nav").getByRole("button", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "ショートカット" }).click();
  await expect(page.locator(".stg main h1")).toHaveText("ショートカット");
}

const row = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".stg .set").filter({ has: page.locator(".h").getByText(label, { exact: true }) });

const tab = (page: import("@playwright/test").Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name} \\d+`) });

test("a recorded key runs the action, survives a reload, and can be removed", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "一覧").click();
  const next = row(app, "次の項目へ");
  await next.getByRole("button", { name: "+ キーを追加" }).click();
  await expect(next.getByRole("button", { name: /キーを押してください/ })).toBeVisible();
  await app.keyboard.press("n");
  await expect(next.getByRole("button", { name: "n › 次のキー(Enterで確定 / Escで取消)" })).toBeVisible();
  await app.keyboard.press("Enter");
  await expect(next.locator(".kbd.key")).toHaveText(["j×", "↓×", "n×"]);

  await app.keyboard.press("Escape");
  await expect(list(app)).toBeVisible();
  await app.keyboard.press("n");
  await expect(list(app).locator(".row.cur")).toHaveCount(1);

  await app.reload();
  await expect(list(app).locator(".row").first()).toBeVisible();
  await app.keyboard.press("n");
  await expect(list(app).locator(".row.cur")).toHaveCount(1);

  await openShortcuts(app);
  await tab(app, "一覧").click();
  await row(app, "次の項目へ").getByRole("button", { name: "次の項目へからnを外す" }).click();
  await expect(row(app, "次の項目へ").locator(".kbd.key")).toHaveText(["j×", "↓×"]);
  await expect(row(app, "次の項目へ").getByRole("button", { name: "既定に戻す" }), "nothing left to reset").toBeHidden();
});

test("a two-key binding starts from any key and runs only after both", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "一覧").click();
  const next = row(app, "次の項目へ");
  await next.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("g");
  await app.keyboard.press("q");
  await expect(next.locator(".kbd.key")).toHaveText(["j×", "↓×", "g › q×"]);

  await app.keyboard.press("Escape");
  await expect(list(app)).toBeVisible();
  const cursor = list(app).locator(".row.cur");
  await app.keyboard.press("q");
  await expect(cursor).toHaveCount(0);
  await app.keyboard.press("g");
  await expect(app.locator(".prefix-hint")).toContainText("次の項目へ");
  await expect(app.locator(".prefix-hint")).not.toContainText("ペイン");
  await app.keyboard.press("q");
  await expect(app.locator(".prefix-hint")).toBeHidden();
  await expect(cursor).toHaveCount(1);
});

test("keys forwarded from a focused page start and complete a two-key binding", async ({ app }) => {
  const fromPage = (key: string) => app.evaluate((k) => window.__e2e.fromPage("browser-key", { tab: "none", key: k, count: 1 }), key);
  await expect(list(app)).toBeVisible();
  const panes = app.locator("[data-pane-id]");
  await expect(panes).toHaveCount(1);
  await fromPage("Ctrl+B");
  await expect(app.locator(".prefix-hint")).toBeVisible();
  await fromPage('Ctrl+B "');
  await expect(app.locator(".prefix-hint")).toBeHidden();
  await expect(panes).toHaveCount(2);
});

test("the default keys after Ctrl+B can be removed, and a single key under a first key is flagged", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "ペイン").click();
  const down = row(app, "ペインを下に分割");
  await expect(down.locator(".kbd.key")).toHaveText(["Ctrl -×", 'Ctrl B › "×']);
  await down.getByRole("button", { name: 'ペインを下に分割からCtrl B › "を外す' }).click();
  await expect(down.locator(".kbd.key")).toHaveText(["Ctrl -×"]);

  await tab(app, "記事").click();
  const fav = row(app, "お気に入り");
  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("Control+b");
  await app.keyboard.press("Enter");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×", "Ctrl B×"]);
  await expect(fav.getByRole("note")).toHaveText("Ctrl Bは「コマンドを実行」の2段階キーの1打目なので、単独では働きません");

  await app.keyboard.press("Escape");
  await expect(list(app)).toBeVisible();
  await app.keyboard.press("Control+b");
  await expect(app.locator(".prefix-hint")).toBeVisible();
  await expect(app.locator(".prefix-hint")).not.toContainText("ペインを下に分割");
  await expect(app.locator(".prefix-hint")).toContainText("ペインを右に分割");
});

test("actions are in a tab each by what they are for, the row names where it runs, and the same key in two places is no conflict", async ({ app }) => {
  await openShortcuts(app);
  await expect(app.getByRole("tab")).toHaveText(["全般 6", "一覧 11", "記事 12", "本文 20", "タブ 7", "ペイン 18"]);
  await expect(tab(app, "全般")).toHaveAttribute("aria-selected", "true");
  const panel = app.getByRole("tabpanel");
  await expect(panel).toHaveAccessibleName("全般 6");
  await expect(panel.locator(".set .h > span:first-child")).toHaveText([
    "コマンドパレット",
    "コマンドを実行",
    "キー一覧",
    "戻る・絞り込みを解除",
    "戻る(アプリ内の履歴)",
    "進む(アプリ内の履歴)",
  ]);
  await expect(app.locator(".stg main h2"), "Vim has its own section").toHaveCount(0);

  await tab(app, "一覧").click();
  await expect(tab(app, "一覧")).toHaveAttribute("aria-selected", "true");
  await expect(row(app, "次の項目へ").locator(".scope")).toHaveText("一覧で");
  await expect(row(app, "フィードやフォルダを上へ移動(サイドバー)").locator(".scope"), "it runs everywhere").toHaveCount(0);
  await expect(row(app, "次の項目へ").locator(".kbd.key").first()).toHaveText("j×");
  await tab(app, "記事").click();
  await expect(row(app, "次の記事を開く").locator(".scope")).toHaveText("本文で");
  await tab(app, "本文").click();
  await expect(row(app, "下へスクロール").locator(".kbd.key").first()).toHaveText("j×");
  await expect(row(app, "下へスクロール").getByRole("note")).toHaveCount(0);
  await expect(app.locator(".stg main .kbd.key.clash")).toHaveCount(0);
  await expect(app.getByRole("tab").locator(".mark"), "nothing changed, nothing overlaps").toHaveCount(0);
  await expect(row(app, "下へスクロール").getByRole("button", { name: "既定に戻す" }), "nothing to reset").toBeHidden();
});

test("the arrow keys, Home and End move between the tabs, and Tab goes on into the one shown", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "全般").focus();
  await app.keyboard.press("ArrowRight");
  await expect(tab(app, "一覧")).toBeFocused();
  await expect(tab(app, "一覧")).toHaveAttribute("aria-selected", "true");
  await expect(row(app, "次の項目へ")).toBeVisible();
  await app.keyboard.press("ArrowLeft");
  await app.keyboard.press("ArrowLeft");
  await expect(tab(app, "ペイン"), "from the first it wraps to the last").toBeFocused();
  await expect(row(app, "ペインを下に分割")).toBeVisible();
  await app.keyboard.press("Home");
  await expect(tab(app, "全般")).toBeFocused();
  await app.keyboard.press("End");
  await expect(tab(app, "ペイン")).toBeFocused();
  await expect(app.getByRole("tab").and(app.locator('[tabindex="0"]')), "one tab in the Tab order").toHaveCount(1);
  await app.keyboard.press("Tab");
  await expect.poll(() => app.evaluate(() => !!document.activeElement?.closest("[role='tabpanel']"))).toBe(true);
});

test("the search finds actions in every tab by name or key, under their tab's name, and Esc empties it", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "ペイン").click();
  const find = app.getByRole("textbox", { name: "操作の名前かキーで探す" });
  const names = app.locator(".stg main .set .h > span:first-child");
  await find.fill("先頭");
  await expect(app.getByRole("tablist"), "whatever the tab").toHaveCount(0);
  await expect(app.locator(".stg main h2")).toHaveText(["一覧", "本文"]);
  await expect(names).toHaveText(["一覧の先頭へ", "本文の先頭へ"]);
  await find.fill("shift g");
  await expect(names).toHaveText(["一覧の末尾へ", "本文の末尾へ"]);
  await find.fill("Ctrl+Shift+");
  await expect(names, "the key as it is stored also matches").toHaveText(["印刷", "前のタブ", "タブを別ウィンドウで開く / メインウィンドウに戻す"]);
  await find.fill("みつからない");
  await expect(app.getByRole("status")).toHaveText("一致する操作はありません");

  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(find).toBeFocused();
  await expect(tab(app, "ペイン")).toHaveAttribute("aria-selected", "true");
});

test("pressing a key finds the actions it runs; its keys do not run them", async ({ app }) => {
  await openShortcuts(app);
  await app.getByRole("button", { name: "キーを押して探す" }).click();
  const field = app.getByRole("textbox", { name: "キーを押して探す" });
  const names = app.locator(".stg main .set .h > span:first-child");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("placeholder", "探すキーを押してください(Escで終了)");

  await app.keyboard.press("j");
  await expect(field, "a second key may follow").toHaveValue("j › 次のキー(Enterで確定 / Escで取消)");
  await expect(names).toHaveText(["次の項目へ", "下へスクロール"]);
  await app.keyboard.press("Enter");
  await expect(field).toHaveValue("j");
  await expect(names).toHaveText(["次の項目へ", "下へスクロール"]);

  await app.keyboard.press("Control+Tab");
  await expect(field, "Ctrl+Tab is a key to find, not a move to the next tab").toHaveValue("Ctrl Tab › 次のキー(Enterで確定 / Escで取消)");
  await app.keyboard.press("Enter");
  await expect(names).toHaveText(["次のタブ"]);
  await app.keyboard.press("Control+p");
  await expect(app.getByRole("dialog", { name: "コマンドパレット" }), "the key is looked up, not run").toHaveCount(0);
  await app.keyboard.press("Enter");
  await expect(field, "the field kept the keyboard for both keys").toHaveValue("Ctrl P");
  await expect(names).toHaveText(["コマンドパレット"]);

  await app.keyboard.press("Control+b");
  await expect(app.locator(".stg main h2"), "what starts with it").toHaveText(["全般", "本文", "タブ", "ペイン"]);
  await app.keyboard.press("z");
  await expect(field).toHaveValue("Ctrl B › z");
  await expect(names).toHaveText(["フォーカスモード"]);

  await app.keyboard.press("q");
  await app.keyboard.press("Enter");
  await expect(app.getByRole("status")).toHaveText("qを割り当てた操作はありません");

  await app.keyboard.press("j");
  await row(app, "次の項目へ").getByRole("button", { name: "+ キーを追加" }).click();
  await expect(
    row(app, "次の項目へ").getByRole("button", { name: /キーを押してください/ }),
    "what a waiting first key found stays to be clicked",
  ).toBeVisible();
  await app.keyboard.press("Escape");
  await field.focus();
  await expect(field, "coming back drops the first key left waiting, so the field shows what the next key does").toHaveValue("");
  await app.keyboard.press("g");
  await app.keyboard.press("t");
  await expect(field).toHaveValue("g › t");
  await expect(names).toHaveText(["次のタブ"]);

  await app.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(app.getByRole("tablist")).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("textbox", { name: "操作の名前かキーで探す" }), "back to finding by name").toBeFocused();
  await expect(app.getByRole("button", { name: "キーを押して探す" })).toHaveAttribute("aria-pressed", "false");
});

test("a key bound to two actions is flagged on the rows and their tabs, and Esc cancels recording", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  const fav = row(app, "お気に入り");
  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("Escape");
  await expect(fav.getByRole("button", { name: "+ キーを追加" })).toBeVisible();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);

  const add = fav.getByRole("button", { name: "+ キーを追加" });
  const before = await add.boundingBox();
  await add.click();
  await app.keyboard.press("j");
  await app.keyboard.press("Enter");
  await expect(fav.getByRole("note")).toHaveText("jは「次の項目へ」にも割り当てられています。jは「下へスクロール」にも割り当てられています");
  await expect(fav.getByRole("button", { name: "既定に戻す" })).toBeVisible();
  expect((await add.boundingBox())?.x, "the reset that shows up does not move the add button").toBe(before?.x);
  await tab(app, "一覧").click();
  await expect(row(app, "次の項目へ").getByRole("note"), "the row that loses the key says which action runs").toHaveText(
    "jは「お気に入り」にも割り当てられていて、そちらが働きます",
  );
  await tab(app, "記事").click();
  await expect(tab(app, "記事")).toHaveAccessibleName("記事 12 変更あり 重なりあり");
  await expect(tab(app, "一覧")).toHaveAccessibleName("一覧 11 重なりあり");
  await expect(tab(app, "本文")).toHaveAccessibleName("本文 20 重なりあり");
  await expect(tab(app, "全般")).toHaveAccessibleName("全般 6");
  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
  await expect(app.getByRole("tab").locator(".mark")).toHaveCount(0);
});

test("a key two list actions share is no conflict for the document's action with the same key", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lattice.shortcuts", JSON.stringify({ search: ["/", "J"], version: 2 })));
  await page.goto("/");
  await openShortcuts(page);
  await expect(tab(page, "一覧")).toHaveAccessibleName("一覧 11 変更あり 重なりあり");
  await expect(tab(page, "本文")).toHaveAccessibleName("本文 20");
  await tab(page, "本文").click();
  await expect(row(page, "下へスクロール").locator(".kbd.key.clash")).toHaveCount(0);
  await tab(page, "一覧").click();
  await expect(row(page, "次の項目へ").locator(".kbd.key.clash")).toHaveText(["j×"]);
});

test("the keyboard stays in the row when the × or reset it pressed goes away, and in the search field when the row goes", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  const fav = row(app, "お気に入り");
  const add = fav.getByRole("button", { name: "+ キーを追加" });
  const recordJ = async () => {
    await add.click();
    await app.keyboard.press("j");
    await app.keyboard.press("Enter");
    await expect(fav.locator(".kbd.key")).toHaveText(["s×", "j×"]);
  };
  await recordJ();
  await fav.getByRole("button", { name: "お気に入りからjを外す" }).focus();
  await app.keyboard.press("Enter");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
  await expect(add).toBeFocused();
  await recordJ();
  await fav.getByRole("button", { name: "既定に戻す" }).focus();
  await app.keyboard.press("Enter");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
  await expect(add).toBeFocused();

  await app.getByRole("button", { name: "キーを押して探す" }).click();
  await app.keyboard.press("s");
  await app.keyboard.press("Enter");
  await fav.getByRole("button", { name: "お気に入りからsを外す" }).focus();
  await app.keyboard.press("Enter");
  await expect(app.getByRole("status")).toHaveText("sを割り当てた操作はありません");
  const field = app.getByRole("textbox", { name: "キーを押して探す" });
  await expect(field).toBeFocused();

  await app.keyboard.press("g");
  await app.getByRole("button", { name: "要約を開く / 閉じるからg › yを外す" }).click();
  await expect(field).toBeFocused();
  await expect(field, "the app moving the keyboard back keeps the first key waiting").toHaveValue("g › 次のキー(Enterで確定 / Escで取消)");
  await expect(row(app, "次のタブ"), "and what it found").toBeVisible();
});

test("a note names the action that runs instead only when the key runs it, as the keyboard reads keys", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "lattice.shortcuts",
      JSON.stringify({ favorite: ["S", "G"], read: ["M", "G"], search: ["/", "J"], prev: ["K", "ArrowUp", "J"], version: 2 }),
    ),
  );
  await page.goto("/");
  await openShortcuts(page);
  await tab(page, "記事").click();
  await expect(row(page, "既読 / 未読").getByRole("note"), "g waits for a second key, so neither runs").toHaveText(
    "gは「お気に入り」にも割り当てられています。gは「次のタブ」の2段階キーの1打目なので、単独では働きません",
  );
  await tab(page, "一覧").click();
  await expect(row(page, "前の項目へ").getByRole("note"), "of three on j only the first runs").toHaveText(
    "jは「検索」にも割り当てられていて、そちらが働きます。jは「次の項目へ」にも割り当てられています",
  );
});

test("the Reader's buttons name the key as it is bound now", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lattice.shortcuts", JSON.stringify({ less: ["["], favorite: [], version: 2 })));
  await page.goto("/");
  await list(page).locator(".row").first().click();
  await expect(page.getByRole("button", { name: "日本語の割合を下げる([)" })).toHaveAttribute("title", "日本語の割合を下げる([)");
  await expect(page.getByRole("button", { name: "お気に入り", exact: true }), "with no key it names none").toBeVisible();
});

async function addKey(page: import("@playwright/test").Page, label: string, key: string) {
  await row(page, label).getByRole("button", { name: "+ キーを追加" }).click();
  await page.keyboard.press(key);
  await page.keyboard.press("Enter");
}

const loadFile = (page: import("@playwright/test").Page, value: unknown) =>
  page
    .getByLabel("ファイルから読み込む")
    .setInputFiles({ name: "lattice-shortcuts.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });

test("resetting every key can be undone from the same button, until a key changes", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  const fav = row(app, "お気に入り");
  await addKey(app, "お気に入り", "x");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×", "x×"]);

  const reset = app.getByRole("button", { name: "すべて既定に戻す" });
  const undo = app.getByRole("button", { name: "元に戻す", exact: true });
  const box = await reset.boundingBox();
  await reset.focus();
  await app.keyboard.press("Enter");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
  await expect(app.getByRole("status")).toHaveText("すべて既定に戻しました");
  await expect(undo, "the keyboard is on the undo").toBeFocused();
  expect(await undo.boundingBox(), "and so is the pointer").toEqual(box);
  await app.keyboard.press("Enter");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×", "x×"]);
  await expect(reset).toBeFocused();
  await expect(app.getByRole("status")).toBeHidden();

  await reset.click();
  await expect(undo).toBeVisible();
  await addKey(app, "お気に入り", "y");
  await expect(fav.locator(".kbd.key")).toHaveText(["s×", "y×"]);
  await expect(undo, "undoing would throw away the key just added").toBeHidden();
  await expect(reset).toBeEnabled();
});

test("a change from another window hides the undo, and a later undo keeps that change", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  await addKey(app, "お気に入り", "x");
  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  const undo = app.getByRole("button", { name: "元に戻す", exact: true });
  await expect(undo).toBeVisible();
  // A change another window made, as the storage event brings it here. Only the main window edits shortcuts today.
  await app.evaluate(() => {
    localStorage.setItem("lattice.shortcuts", JSON.stringify({ read: ["Q"], version: 2 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "lattice.shortcuts" }));
  });
  await expect(row(app, "既読 / 未読").locator(".kbd.key")).toHaveText(["q×"]);
  await expect(undo, "undoing would throw away the other window's change").toBeHidden();
  await expect(app.getByRole("status")).toBeHidden();
  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await undo.click();
  await expect(row(app, "既読 / 未読").locator(".kbd.key"), "the undo brings back the other window's keys").toHaveText(["q×"]);
});

test("loading a file replaces the keys, and undo brings back the earlier ones", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  const [fav, read] = [row(app, "お気に入り"), row(app, "既読 / 未読")];
  await addKey(app, "お気に入り", "x");
  await loadFile(app, { format: "lattice.shortcuts", version: 2, read: ["Q", "Q", ""] });
  await expect(app.getByRole("status")).toHaveText("読み込みました");
  await expect(fav.locator(".kbd.key"), "what the file leaves out is at its default").toHaveText(["s×"]);
  await expect(read.locator(".kbd.key")).toHaveText(["q×"]);
  await app.getByRole("button", { name: "書き出す", exact: true }).click();
  await expect(app.getByRole("status"), "an export while undo shows still says where").toContainText("書き出しました");
  const undo = app.getByRole("button", { name: "元に戻す", exact: true });
  await undo.click();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×", "x×"]);
  await expect(read.locator(".kbd.key")).toHaveText(["m×"]);

  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await loadFile(app, { format: "lattice.shortcuts", version: 2, read: ["Q"] });
  await expect(app.getByRole("status"), "the undo is now the load's, not the reset's").toHaveText("読み込みました");
  await undo.focus();
  await app.keyboard.press("Enter");
  await expect(read.locator(".kbd.key")).toHaveText(["m×"]);
  await expect(app.getByRole("button", { name: "すべて既定に戻す" })).toBeDisabled();
  await expect(app.getByLabel("ファイルから読み込む"), "with nothing left to reset, the keyboard goes on to the load button").toBeFocused();
});

test("a JSON file that is not a shortcuts file is refused and changes nothing", async ({ app }) => {
  await openShortcuts(app);
  await tab(app, "記事").click();
  await addKey(app, "お気に入り", "x");
  await loadFile(app, { read: ["Q"], version: 2 });
  await expect(app.getByRole("alert")).toHaveText("このファイルは使えません");
  await app.getByLabel("ファイルから読み込む").setInputFiles({ name: "binary", mimeType: "", buffer: Buffer.from([0xff, 0xfe, 0x00]) });
  await expect(app.getByRole("alert")).toHaveText("UTF-8のテキストファイルではありません");
  await expect(row(app, "お気に入り").locator(".kbd.key")).toHaveText(["s×", "x×"]);
  await expect(row(app, "既読 / 未読").locator(".kbd.key")).toHaveText(["m×"]);
  await expect(app.getByRole("button", { name: "元に戻す", exact: true })).toBeHidden();
});

test("export writes the changed keys, shows where, and the file loads them back", async ({ app }) => {
  await openShortcuts(app);
  const exportButton = app.getByRole("button", { name: "書き出す", exact: true });
  await expect(exportButton, "nothing changed to export").toBeDisabled();
  await tab(app, "記事").click();
  await addKey(app, "お気に入り", "x");
  await exportButton.click();
  await expect(app.getByRole("status")).toHaveText(
    "書き出しました: C:\\Users\\e2e\\AppData\\Roaming\\Lattice\\exports\\lattice-shortcuts-20261020T030000Z.json",
  );
  const calls = (await callsOf(app, "export_shortcuts")) as { json: string }[];
  expect(calls.map((c) => JSON.parse(c.json) as unknown)).toEqual([{ format: "lattice.shortcuts", version: 2, favorite: ["S", "X"] }]);

  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await expect(row(app, "お気に入り").locator(".kbd.key")).toHaveText(["s×"]);
  await expect(app.getByRole("status"), "the reset replaces the export's message").toHaveText("すべて既定に戻しました");
  await app
    .getByLabel("ファイルから読み込む")
    .setInputFiles({ name: "lattice-shortcuts.json", mimeType: "application/json", buffer: Buffer.from(calls[0].json) });
  await expect(row(app, "お気に入り").locator(".kbd.key")).toHaveText(["s×", "x×"]);
});
