// The page overlay in a real page (no app around it): the reading place it reports, and scrolling back to one.
import { expect, test, type Page } from "@playwright/test";

const para = (i: number) => `Page paragraph ${i}.`;
/** The place in the overlay's last report. */
const reported = (page: Page) =>
  page.evaluate(
    () => (window.__pageCalls.filter((c) => c.cmd === "overlay_place").at(-1)?.args as { place: { text: string; at: number } | null } | undefined)?.place,
  );
/** How far down paragraph `i` the reading line (15% down the window) falls. */
const lineIn = (page: Page, i: number) =>
  page.evaluate((i) => {
    const r = document.querySelectorAll("p")[i].getBoundingClientRect();
    return (innerHeight * 0.15 - r.top) / r.height;
  }, i);

test.use({ viewport: { width: 800, height: 600 } });

test("the overlay reports the paragraph on its reading line, and scrolls a place back to that line", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const r = document.querySelectorAll("p")[20].getBoundingClientRect();
    scrollBy(0, r.top + 0.3 * r.height - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(new RegExp(`^${para(20)}`));
  expect((await reported(page))!.at).toBeCloseTo(0.3, 1);

  await page.evaluate(() => scrollTo(0, 0));
  expect(await page.evaluate((t) => window.__lattice!.scrollToText(t, 0.3), (await reported(page))!.text)).toBe(true);
  expect(await lineIn(page, 20)).toBeCloseTo(0.3, 1);
  expect(await page.evaluate(() => document.querySelector(".lattice-flash")), "a place is not flashed").toBeNull();

  // A search result's passage, anywhere in its block: centred and flashed, as before.
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 40. Some words"))).toBe(true);
  await expect(page.locator("p").nth(40)).toHaveClass(/lattice-flash/);
});

test("a box that scrolls (the PDF viewer's) is followed, and a translated sentence counts by its original", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const main = document.getElementById("main")!;
    Object.assign(main.style, { height: "100vh", overflow: "auto", boxSizing: "border-box" });
    // As the overlay leaves a sentence that shows its translation: the original kept aside.
    const p = document.querySelectorAll("p")[25];
    const span = Object.assign(document.createElement("span"), { className: "lattice-sentence", textContent: "訳された文。" });
    span.dataset.shown = "t";
    Object.assign(span, { latticeOriginal: document.createRange().createContextualFragment("The sentence as the page wrote it.") });
    p.replaceChildren(span);
    const r = p.getBoundingClientRect();
    main.scrollBy(0, r.top - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toBe("The sentence as the page wrote it.");

  await page.evaluate(() => document.getElementById("main")!.scrollTo(0, 0));
  expect(await page.evaluate(() => window.__lattice!.scrollToText("The sentence as the page wrote it.", 0.5))).toBe(true);
  expect(await lineIn(page, 25)).toBeCloseTo(0.5, 1);
  expect(await page.evaluate(() => scrollY), "the box moved, not the page").toBe(0);
});

test("a page that draws its text after loading is scrolled to the place once it settles", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  const drawn = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const html = main.innerHTML;
    main.replaceChildren();
    return html;
  });
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30.", 0))).toBe(false);
  await page.evaluate((html) => setTimeout(() => (document.getElementById("main")!.innerHTML = html), 200), drawn);
  await expect(page.locator("p")).toHaveCount(60);
  await expect.poll(() => lineIn(page, 30)).toBeCloseTo(0, 1);
});

test("the page at its top is no place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => scrollTo(0, 400));
  await expect.poll(async () => (await reported(page))?.text).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  const last = () => page.evaluate(() => window.__pageCalls.filter((c) => c.cmd === "overlay_place").at(-1)?.args);
  await expect.poll(last).toEqual({ place: null });
});
