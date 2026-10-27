import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";

test("the article in front is reported for the reserved job slot", async ({ app }) => {
  const title = ARTICLES.find((a) => a.id === SNAPSHOT_ID)!.title!;
  await list(app).locator(".row", { hasText: title }).click();
  await expect(app.locator(".art-title")).toHaveText(title);
  await expect.poll(async () => (await callsOf(app, "set_articles_on_screen")).at(-1)).toEqual({ ids: [SNAPSHOT_ID] });

  await app.keyboard.press("Control+w");
  await expect.poll(async () => (await callsOf(app, "set_articles_on_screen")).at(-1)).toEqual({ ids: [] });
});
