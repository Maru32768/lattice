import { test, expect, list } from "./harness.ts";

test("a pane keeps the width it was dragged to across a reload", async ({ app }) => {
  const handle = app.getByRole("separator", { name: "記事一覧の幅" });
  await expect(handle).toHaveAttribute("aria-valuenow", "396");
  const box = (await handle.boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
  await app.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "496");
  expect(Math.round((await list(app).boundingBox())!.width)).toBe(496);

  await app.reload();
  await expect(app.getByRole("separator", { name: "記事一覧の幅" })).toHaveAttribute("aria-valuenow", "496");
  expect(Math.round((await list(app).boundingBox())!.width)).toBe(496);
});

test("the keyboard resizes within limits, and a double-click restores the default", async ({ app }) => {
  const handle = app.getByRole("separator", { name: "ナビゲーションの幅" });
  await handle.focus();
  await app.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "244");
  await app.keyboard.press("Shift+ArrowRight");
  await app.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  await app.keyboard.press("Shift+ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "296");
  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "228");
});
