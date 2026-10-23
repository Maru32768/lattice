// A feed's display name editor (Feeds screen): it starts with the name shown now.
import { test, expect, callsOf } from "./harness.ts";
import { FEEDS } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const [plain, , , custom] = FEEDS;

async function edit(app: Page, title: string) {
  await app.locator("nav").getByRole("button", { name: "管理", exact: true }).click();
  await app
    .getByRole("row", { name: new RegExp(title) })
    .getByRole("button", { name: "編集" })
    .click();
  return app.getByLabel("表示名");
}

test("the name field starts with the feed's own name, to edit rather than retype", async ({ app }) => {
  const input = await edit(app, plain.title!);
  await expect(input).toHaveValue(plain.title!);
  const save = app.getByRole("form", { name: /の名前とアイコン/ }).getByRole("button", { name: "保存" });
  await expect(save, "unchanged").toBeDisabled();
  await input.fill(`${plain.title} (weekly)`);
  await save.click();
  await expect.poll(async () => (await callsOf(app, "rename_feed")).at(-1)).toEqual({ id: plain.id, name: `${plain.title} (weekly)` });
});

test("a custom name starts the field; the feed's own name or an empty field saves as no custom name", async ({ app }) => {
  const input = await edit(app, custom.custom_title!);
  await expect(input).toHaveValue(custom.custom_title!);
  await input.fill(custom.title!);
  await app
    .getByRole("form", { name: /の名前とアイコン/ })
    .getByRole("button", { name: "保存" })
    .click();
  await expect.poll(async () => (await callsOf(app, "rename_feed")).at(-1)).toEqual({ id: custom.id, name: null });

  // Restore the custom name so the empty-input branch starts from the same overridden state.
  const save = app.getByRole("form", { name: /の名前とアイコン/ }).getByRole("button", { name: "保存" });
  await expect(save).toBeDisabled();
  await input.fill(custom.custom_title!);
  await save.click();
  await expect(save).toBeDisabled();
  await input.fill("");
  await save.click();
  await expect
    .poll(() => callsOf(app, "rename_feed"))
    .toEqual([
      { id: custom.id, name: null },
      { id: custom.id, name: custom.custom_title! },
      { id: custom.id, name: null },
    ]);
});
