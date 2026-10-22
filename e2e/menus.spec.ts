// Menus and popovers on Radix (H22–H24): the webview gate, outside presses, Escape and placement.
import { test, expect, list, listCount, navItem, callsOf } from "./harness.ts";
import { ARTICLES, GROUPS } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const opacity = (l: Locator) => l.evaluate((e) => getComputedStyle(e).opacity);

/** Opens the first article's Page view and lets the page finish loading. */
async function openPage(app: Page) {
  await list(app).locator(".row").first().click();
  await app.locator(".docbar").getByRole("button", { name: "Page" }).click();
  await expect.poll(async () => (await callsOf(app, "browser_open")).length).toBeGreaterThan(0);
  const { tab, url } = (await callsOf(app, "browser_open")).at(-1) as { tab: string; url: string };
  await app.evaluate((p) => window.__e2e.emit("browser-page", p), { tab, url, loading: false, can_go_back: false, can_go_forward: false });
}

test("a menu over the page webview stays invisible until the webview is hidden, then shows whole (H22)", async ({ app }) => {
  await openPage(app);
  // Hold every browser_hide until the spec lets it go.
  await app.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke }; release: () => void; hides: number };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    const held = new Promise<void>((r) => (w.release = r));
    w.hides = 0;
    w.__TAURI_INTERNALS__.invoke = (cmd, args, options) => {
      if (cmd !== "browser_hide") {
        return invoke(cmd, args, options);
      }
      w.hides++;
      return held.then(() => invoke(cmd, args, options));
    };
  });
  await app.locator(".docbar [aria-haspopup=menu]").last().click();
  const menu = app.getByRole("menu");
  await expect(menu).toBeAttached();
  await expect.poll(() => app.evaluate(() => (window as unknown as { hides: number }).hides)).toBeGreaterThan(0);
  await app.waitForTimeout(200);
  expect(await opacity(menu), "hidden while the webview is still drawn over it").toBe("0");
  await expect(app.locator(".page-still")).toBeAttached();

  await app.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect.poll(() => opacity(menu)).toBe("1");
  await menu.getByRole("menuitem", { name: "URL をコピー" }).click();
  await expect(menu).toHaveCount(0);
});

test("a menu over no webview is drawn in the frame it first appears (H22)", async ({ app }) => {
  const first = app.evaluate(
    () =>
      new Promise<string>((done) => {
        const frame = () => {
          const m = document.querySelector(".menu");
          if (!m) {
            requestAnimationFrame(frame);
            return;
          }
          done(getComputedStyle(m).opacity);
        };
        requestAnimationFrame(frame);
      }),
  );
  await list(app).getByRole("button", { name: "並び順とまとめ方" }).click();
  expect(await first).toBe("1");
});

test("a press outside closes the group picker and a menu; so does a click in a page webview (H23)", async ({ app }) => {
  const a = ARTICLES.find((x) => x.groups.includes(GROUPS[0].id))!;
  await list(app).locator(".row", { hasText: a.title! }).click();
  const chip = app.locator(".art-chips").getByRole("button", { name: "＋ グループ" });
  const picker = app.getByRole("dialog", { name: "グループ" });
  await chip.click();
  await expect(picker.getByRole("textbox")).toBeFocused();
  await app.locator(".art-title").click();
  await expect(picker).toHaveCount(0);

  // The chip toggles the picker: a press on it is not an outside press that reopens it.
  await chip.click();
  await expect(picker).toBeVisible();
  await chip.click();
  await expect(picker).toHaveCount(0);

  const sort = list(app).getByRole("button", { name: "並び順とまとめ方" });
  await sort.click();
  await expect(app.getByRole("menu")).toBeVisible();
  await list(app).locator("h1").click();
  await expect(app.getByRole("menu")).toHaveCount(0);
});

test("a click in a page in another pane closes a popover; the focus a page gets when a menu hides it does not (H23)", async ({ app }) => {
  await openPage(app);
  const { tab } = (await callsOf(app, "browser_open")).at(-1) as { tab: string };
  const menu = app.getByRole("menu");
  await app.locator(".docbar [aria-haspopup=menu]").last().click();
  await expect.poll(() => opacity(menu)).toBe("1");
  // WebView2 reports GotFocus when the page is hidden behind its still for the menu.
  await app.evaluate((t) => window.__e2e.emit("browser-focus", { tab: t }), tab);
  await app.waitForTimeout(200);
  await expect(menu).toBeVisible();
  await app.keyboard.press("Escape");

  // A click in a page in another pane never reaches this document; the backend reports it as browser-focus.
  await app.getByRole("button", { name: "右に分割" }).click();
  await expect(app.locator(".dpane")).toHaveCount(2);
  await list(app).locator(".row").nth(1).click();
  const chip = app.locator(".dpane").nth(1).locator(".art-chips").getByRole("button", { name: "＋ グループ" });
  const picker = app.getByRole("dialog", { name: "グループ" });
  await chip.click();
  await expect(picker).toBeVisible();
  await app.evaluate((t) => window.__e2e.emit("browser-focus", { tab: t }), tab);
  await expect(picker).toHaveCount(0);
});

test("Esc closes a popover without also clearing the filters (H23)", async ({ app }) => {
  const [g] = GROUPS;
  await list(app).getByRole("button", { name: "グループ", exact: true }).click();
  await app
    .getByRole("dialog", { name: "グループで絞り込む" })
    .getByRole("button", { name: new RegExp(g.name) })
    .click();
  const filtered = await listCount(app).textContent();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("dialog")).toHaveCount(0);
  await expect(listCount(app)).toHaveText(filtered!);
  await app.keyboard.press("Escape");
  await expect(listCount(app)).not.toHaveText(filtered!);
});

test("a nav group's ⋯ menu opens beside its trigger, not at the window's left edge (H24)", async ({ app }) => {
  const item = navItem(app, GROUPS[0].name);
  await item.hover();
  const trigger = app.locator(".nav").getByRole("button", { name: `${GROUPS[0].name} の操作` });
  await trigger.click();
  const menu = app.getByRole("menu");
  await expect.poll(() => opacity(menu)).toBe("1");
  const t = (await trigger.boundingBox())!,
    m = (await menu.boundingBox())!;
  expect(Math.abs(m.x - t.x), "the menu's left edge lines up with the trigger's").toBeLessThanOrEqual(8);
  expect(m.y).toBeGreaterThanOrEqual(t.y + t.height);

  // A narrow nav: the menu still starts at its trigger.
  await app.keyboard.press("Escape");
  await app.evaluate(() => document.querySelector<HTMLElement>(".app")!.style.setProperty("--nav-w", "170px"));
  await item.hover();
  await trigger.click();
  const t2 = (await trigger.boundingBox())!,
    m2 = (await menu.boundingBox())!;
  expect(Math.abs(m2.x - t2.x)).toBeLessThanOrEqual(8);
});
