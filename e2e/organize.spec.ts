import { test, expect, navItem, callsOf } from "./harness.ts";
import type { Page } from "@playwright/test";
import { GROUPS } from "./fixtures.ts";

const manage = (app: Page, section: string) => app.locator(".nav").getByRole("button", { name: `${section}を管理` });
const screen = (app: Page) => app.locator("main.organize");

test("each nav section's 管理 opens its tab of one screen; Settings no longer lists genres", async ({ app }) => {
  await expect(app.locator(".nav .sec .link")).toHaveText(["管理", "管理", "管理"]);
  for (const [i, name] of ["グループを管理", "ジャンルを管理", "ソースを管理"].entries()) {
    await expect(app.locator(".nav .sec .link").nth(i)).toHaveAccessibleName(name);
  }

  await manage(app, "グループ").click();
  await expect(screen(app).locator("h1")).toHaveText("分類の管理");
  const kind = screen(app).getByRole("group", { name: "分類の種類" });
  await expect(kind.getByRole("button", { name: "グループ" })).toHaveAttribute("aria-pressed", "true");
  for (const g of GROUPS) {
    await expect(screen(app).getByRole("textbox", { name: `${g.name} の新しい名前` })).toHaveValue(g.name);
  }

  await app.keyboard.press("Escape");
  await manage(app, "ジャンル").click();
  await expect(kind.getByRole("button", { name: "ジャンル" })).toHaveAttribute("aria-pressed", "true");
  await expect(screen(app).getByRole("textbox", { name: "追加するジャンルの名前" })).toBeVisible();
  await kind.getByRole("button", { name: "グループ" }).click();
  await expect(screen(app).getByRole("textbox", { name: "グループを作成" })).toBeVisible();

  await manage(app, "ソース").click();
  await expect(app.locator("main.manage h1")).toHaveText("フィードを管理");

  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await expect(app.getByRole("navigation", { name: "設定カテゴリ" }).getByText("ジャンル", { exact: true })).toHaveCount(0);
});

test("the groups tab creates, renames and deletes groups, like the genres tab", async ({ app }) => {
  const [mvcc, rust] = GROUPS;
  await manage(app, "グループ").click();
  const add = screen(app).getByRole("textbox", { name: "グループを作成" });
  await add.fill(rust.name.toUpperCase());
  await expect(screen(app)).toContainText(`「${rust.name}」はすでにあります`);
  await expect(screen(app).getByRole("button", { name: "追加" })).toBeDisabled();
  await add.fill("論文");
  await screen(app).getByRole("button", { name: "追加" }).click();
  await expect(navItem(app, "論文")).toBeVisible();

  const rename = screen(app).getByRole("textbox", { name: `${mvcc.name} の新しい名前` });
  await rename.fill(rust.name);
  await expect(screen(app)).toContainText(`「${rust.name}」はすでにあります`);
  await rename.fill("MVCC");
  await rename.press("Enter");
  await expect(screen(app).getByRole("status")).toHaveText(`「${mvcc.name}」を「MVCC」に変更しました`);
  await expect(navItem(app, "MVCC")).toBeVisible();
  expect(await callsOf(app, "rename_group")).toEqual([{ id: mvcc.id, name: "MVCC" }]);

  await screen(app).getByRole("button", { name: "MVCC を削除" }).click();
  await app.getByRole("alertdialog", { name: "グループ「MVCC」を削除しますか？" }).getByRole("button", { name: "削除", exact: true }).click();
  await expect(navItem(app, "MVCC")).toHaveCount(0);
  expect(await callsOf(app, "delete_group")).toEqual([{ id: mvcc.id }]);
});
