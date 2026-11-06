import { test, expect, list } from "./harness.ts";

async function openShortcuts(page: import("@playwright/test").Page) {
  await page.locator(".nav").getByRole("button", { name: "設定" }).click();
  await page.getByRole("navigation", { name: "設定カテゴリ" }).getByRole("button", { name: "ショートカット" }).click();
  await expect(page.locator(".stg main h1")).toHaveText("ショートカット");
}

const row = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".stg .set").filter({ has: page.locator(".h").getByText(label, { exact: true }) });

test("a recorded key runs the action, survives a reload, and can be removed", async ({ app }) => {
  await openShortcuts(app);
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
  await row(app, "次の項目へ").getByRole("button", { name: "次の項目へからnを外す" }).click();
  await expect(row(app, "次の項目へ").locator(".kbd.key")).toHaveText(["j×", "↓×"]);
  await expect(row(app, "次の項目へ").getByRole("button", { name: "既定に戻す" })).toBeDisabled();
});

test("a two-key binding starts from any key and runs only after both", async ({ app }) => {
  await openShortcuts(app);
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
  const down = row(app, "ペインを下に分割");
  await expect(down.locator(".kbd.key")).toHaveText(["Ctrl -×", 'Ctrl B › "×']);
  await down.getByRole("button", { name: 'ペインを下に分割からCtrl B › "を外す' }).click();
  await expect(down.locator(".kbd.key")).toHaveText(["Ctrl -×"]);

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

test("actions are grouped by where they run, and the same key in two groups is no conflict", async ({ app }) => {
  await openShortcuts(app);
  await expect(app.locator(".stg main h2")).toHaveText(["Vim", "どこでも", "一覧", "本文"]);
  const group = (i: number) => app.locator(".stg main .grp").nth(i + 1);
  await expect(group(0).locator(".set .h").getByText("コマンドパレット", { exact: true })).toBeVisible();
  await expect(group(1).locator(".set .h").getByText("次の項目へ", { exact: true })).toBeVisible();
  await expect(group(2).locator(".set .h").getByText("下へスクロール", { exact: true })).toBeVisible();
  await expect(row(app, "次の項目へ").locator(".kbd.key").first()).toHaveText("j×");
  await expect(row(app, "下へスクロール").locator(".kbd.key").first()).toHaveText("j×");
  await expect(row(app, "下へスクロール").getByRole("note")).toHaveCount(0);
  await expect(app.locator(".stg main .kbd.key.clash")).toHaveCount(0);
});

test("a key bound to two actions is flagged, and Esc cancels recording", async ({ app }) => {
  await openShortcuts(app);
  const fav = row(app, "お気に入り");
  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("Escape");
  await expect(fav.getByRole("button", { name: "+ キーを追加" })).toBeVisible();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);

  await fav.getByRole("button", { name: "+ キーを追加" }).click();
  await app.keyboard.press("j");
  await app.keyboard.press("Enter");
  await expect(fav.getByRole("note")).toHaveText("jは「次の項目へ」にも割り当てられています。jは「下へスクロール」にも割り当てられています");
  await app.getByRole("button", { name: "すべて既定に戻す" }).click();
  await expect(fav.locator(".kbd.key")).toHaveText(["s×"]);
});
