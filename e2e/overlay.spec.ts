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

test("a page that scrolls a box of its own is followed, and a translated sentence counts by its original", async ({ page }) => {
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

test("the place stays on the reading line while the page above it still grows", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  // Chromium's scroll anchoring would keep it there alone; the PDF viewer's pages defeat it.
  await page.evaluate(() => (document.documentElement.style.overflowAnchor = "none"));
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30.", 0.5))).toBe(true);
  // A picture that arrives late, above the place.
  await page.evaluate(() => {
    const late = Object.assign(document.createElement("div"), { style: "height: 900px" });
    document.getElementById("main")!.prepend(late);
  });
  await expect.poll(() => lineIn(page, 30)).toBeCloseTo(0.5, 1);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => lineIn(page, 30), "the reader's own scroll is left alone").not.toBeCloseTo(0.5, 1);
});

test("a place whose paragraph the page draws again is let go, not chased", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30.", 0.5))).toBe(true);
  const y = await page.evaluate(() => {
    // The page drawing its text again: new nodes, the same text.
    const main = document.getElementById("main")!;
    main.replaceChildren(...[...main.children].map((c) => c.cloneNode(true)));
    return scrollY;
  });
  await page.evaluate(() => document.getElementById("main")!.append(Object.assign(document.createElement("div"), { style: "height: 300px" })));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => scrollY), "the page was not pulled up by the line").toBe(y);
});

test("a block missed on the line is not looked for elsewhere on screen, as a cookie bar", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const code = Object.assign(document.createElement("pre"), { textContent: "let x = 1;\n".repeat(200) });
    document.querySelectorAll("p")[20].after(code);
    const bar = Object.assign(document.createElement("p"), { textContent: "We use cookies." });
    Object.assign(bar.style, { position: "fixed", bottom: "0", left: "0", right: "0", margin: "0", background: "#fff" });
    document.body.append(bar);
    scrollBy(0, code.getBoundingClientRect().top + 200);
  });
  await page.waitForTimeout(600);
  expect(await reported(page), "nothing, so the place kept stays").toBeUndefined();
});

test("paragraphs the pointer passes through (the PDF viewer's, under its text layer) are found by where they are", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    document.querySelectorAll("p").forEach((p) => (p.style.pointerEvents = "none"));
    // As pdf.js draws it: one absolutely placed span per line, which lays out as a block.
    const cover = Object.assign(document.createElement("div"), { translate: false });
    Object.assign(cover.style, { position: "fixed", inset: "0", color: "transparent" });
    for (let y = 0; y < innerHeight; y += 20) {
      const line = Object.assign(document.createElement("span"), { textContent: `a line of the text layer at ${y}` });
      Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: `${y}px`, height: "20px" });
      cover.append(line);
    }
    document.body.append(cover);
    const r = document.querySelectorAll("p")[12].getBoundingClientRect();
    scrollBy(0, r.top + 0.5 * r.height - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 12\./);
});

test("the page at its top is no place, and a place just put back is not reported again", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => scrollTo(0, 400));
  await expect.poll(async () => (await reported(page))?.text).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  const last = () => page.evaluate(() => window.__pageCalls.filter((c) => c.cmd === "overlay_place").at(-1)?.args);
  await expect.poll(last).toEqual({ place: null });
  const before = await page.evaluate(() => window.__pageCalls.length);
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30.", 0.5))).toBe(true);
  await page.waitForTimeout(600);
  expect(await page.evaluate((n) => window.__pageCalls.slice(n).filter((c) => c.cmd === "overlay_place"), before)).toEqual([]);
});

test("of two columns on the line, the left one, read first, is the place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const column = (text: string, left: string, top: number) => {
      const p = Object.assign(document.createElement("p"), { textContent: text });
      Object.assign(p.style, { position: "fixed", left, width: "40%", top: `${top}px`, height: "300px", margin: "0", pointerEvents: "none" });
      return p;
    };
    // Higher on screen, the right column's paragraph started earlier: still, the left one is read first.
    const room = Object.assign(document.createElement("div"), { style: "height: 3000px" });
    document
      .getElementById("main")!
      .replaceChildren(column("The left column's paragraph.", "5%", 60), column("The right column's paragraph.", "55%", 20), room);
    scrollTo(0, 500);
  });
  await expect.poll(async () => (await reported(page))?.text).toBe("The left column's paragraph.");
});

test("a place whose paragraph the page shows only later is put back once it shows", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => (document.getElementById("main")!.style.display = "none"));
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30.", 0.5))).toBe(false);
  await page.evaluate(() => setTimeout(() => (document.getElementById("main")!.style.display = ""), 200));
  await expect.poll(() => lineIn(page, 30)).toBeCloseTo(0.5, 1);
});
