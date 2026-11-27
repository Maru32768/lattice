import { test as base, expect, type Page } from "@playwright/test";
import { NOW } from "./fixtures.ts";
import type { ArticleView } from "../src/api.ts";

/**
 * `shell`: a page not yet navigated (a spec opens it as the main window or a pop-out). `app`: the
 * main window with the library loaded. Both fail the test when the app called a command the mock
 * does not answer, threw, or logged an error.
 */
export const test = base.extend<{ shell: Page; app: Page }>({
  shell: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") {
        errors.push(m.text());
      }
    });
    await page.clock.setFixedTime(NOW);
    await provide(page);
    expect(await page.evaluate(() => window.__e2e.unmocked), "commands the mock does not answer").toEqual([]);
    expect(errors, "page errors").toEqual([]);
  },
  app: async ({ shell }, provide) => {
    await shell.goto("/");
    // The first pages after the dev server starts wait for it to transform the app.
    await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await provide(shell);
  },
});

export { expect };

/** As another window would: nothing in this one asked. */
export const invoke = (page: Page, cmd: string, args: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke(cmd, args),
    [cmd, args] as const,
  );

/** The memo of article `id` as stored. */
export const storedNote = async (page: Page, id: number) => ((await invoke(page, "get_article", { id })) as ArticleView).note;

/** Holds the events named `name` as those from another window still on their way would be; resolves to what lets them go. */
export async function holdEvents(page: Page, name: string) {
  await page.evaluate((name) => {
    type Invoke = (cmd: string, args?: { event?: string }, options?: unknown) => Promise<unknown>;
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke }; __letEventsGo: () => void };
    const held = new Promise<void>((go) => (w.__letEventsGo = go));
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args, options) =>
      cmd === "plugin:event|emit" && args?.event === name ? held.then(() => invoke(cmd, args, options)) : invoke(cmd, args, options);
  }, name);
  return () => page.evaluate(() => (window as unknown as { __letEventsGo: () => void }).__letEventsGo());
}

/** The arguments of every call of `cmd` so far. */
export const callsOf = (page: Page, cmd: string) => page.evaluate((c) => window.__e2e.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

/** A sidebar entry by its exact label; its count is `.n`. */
export const navItem = (page: Page, label: string) => page.locator(".nav .ni").filter({ has: page.locator(".label").getByText(label, { exact: true }) });

/** The article list, in either display language. */
export const list = (page: Page) => page.getByRole("region", { name: /^(記事一覧|Articles)$/ });
export const listCount = (page: Page) => list(page).locator(".count");
export const listTitle = (page: Page) => list(page).locator(".list-title h1");
export const chips = (page: Page) => list(page).locator(".chip.on .chip-body");

/** Opens an article (the one titled `title`, else the first), then its Page view, and lets the page finish loading. */
export async function openPage(app: Page, title?: string) {
  await (title ? list(app).locator(".row", { hasText: title }) : list(app).locator(".row").first()).click();
  await app.locator(".docbar").getByRole("button", { name: "Page" }).click();
  await expect.poll(async () => (await callsOf(app, "browser_open")).length).toBeGreaterThan(0);
  const { tab, url } = (await callsOf(app, "browser_open")).at(-1) as { tab: string; url: string };
  await app.evaluate((p) => window.__e2e.emit("browser-page", p), { tab, url, loading: false, can_go_back: false, can_go_forward: false });
}

/** Selects `word` inside block `block` as a mouse would, ending with mouseup. */
export async function selectWord(page: Page, block: number, word: string) {
  await page.evaluate(
    ({ block, word }) => {
      const root = document.getElementById(`b-${block}`)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(word);
        if (i < 0) {
          continue;
        }
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + word.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
        root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      throw new Error(`${word} not in block ${block}`);
    },
    { block, word },
  );
}

/** The chat's 範囲: the button that shows the scope, and the dialog it opens. */
export const chatScope = (page: Page) => page.getByRole("combobox", { name: "質問の範囲", exact: true });
export const scopeDialog = (page: Page) => page.getByRole("dialog", { name: "質問の範囲" });

/** Picks the chat scope named `name`, searching for it: the list draws only the options in view. */
export async function pickScope(page: Page, name: string) {
  await chatScope(page).click();
  await scopeDialog(page).getByRole("combobox", { name: "範囲を検索" }).fill(name);
  await scopeDialog(page).getByRole("option", { name, exact: true }).click();
  await expect(scopeDialog(page)).toBeHidden();
}

export async function filterByTag(page: Page, tag: string) {
  await list(page).getByRole("button", { name: "タグ", exact: true }).click();
  const pv = page.getByRole("dialog", { name: "タグで絞り込む" });
  await pv.getByRole("combobox").fill(tag);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(pv).toBeHidden();
  await expect(chips(page)).toHaveText(`タグ${tag}`);
}

/**
 * The list row of the article titled `title`, scrolled into view first: the list is virtualized, so a row
 * out of view is not in the DOM until the list scrolls to it.
 */
export async function listRow(page: Page, title: string) {
  const row = list(page).locator(".row", { hasText: title });
  const body = list(page).locator(".list-body");
  await expect(list(page).locator(".row").first()).toBeVisible();
  // The list draws the range it scrolled to a frame or more later: a row counted before then can be unmounted after,
  // which left scrollIntoViewIfNeeded waiting for good. Such a scan starts over.
  await expect(async () => {
    await body.evaluate((el) => el.scrollTo(0, 0));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    for (let i = 0; i < 100 && (await row.count()) === 0; i++) {
      const end = await body.evaluate((el) => {
        el.scrollBy(0, el.clientHeight / 2);
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      });
      // Let the list draw what it scrolled to before looking again.
      await page.evaluate(() => new Promise(requestAnimationFrame));
      if (end && i > 0 && (await row.count()) === 0) {
        break;
      }
    }
    await row.first().scrollIntoViewIfNeeded({ timeout: 2000 });
  }).toPass();
  return row;
}
