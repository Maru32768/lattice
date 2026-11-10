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

/** As the PDF viewer's: a layer marked not to translate over the page, one absolutely placed span per line of text. */
const textLayer = () => {
  const layer = Object.assign(document.createElement("div"), { translate: false });
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2", color: "transparent" });
  for (let y = 0; y < innerHeight; y += 10) {
    const line = Object.assign(document.createElement("span"), { textContent: `text layer line ${y}` });
    Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: `${y}px`, height: "10px" });
    layer.append(line);
  }
  document.body.append(layer);
};

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
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0))).toBe(false);
  await page.evaluate((html) => setTimeout(() => (document.getElementById("main")!.innerHTML = html), 200), drawn);
  await expect(page.locator("p")).toHaveCount(60);
  await expect.poll(() => lineIn(page, 30)).toBeCloseTo(0, 1);
});

test("the place stays on the reading line while the page above it still grows", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  // Chromium's scroll anchoring would keep it there alone; the PDF viewer's pages defeat it.
  await page.evaluate(() => (document.documentElement.style.overflowAnchor = "none"));
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(true);
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
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(true);
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
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(true);
  await page.waitForTimeout(600);
  expect(await page.evaluate((n) => window.__pageCalls.slice(n).filter((c) => c.cmd === "overlay_place"), before)).toEqual([]);
});

test("the PDF viewer's late try leaves the place alone once the reader has scrolled", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  const drawn = await page.evaluate(() => {
    const main = document.getElementById("main")!;
    const html = main.innerHTML;
    main.replaceChildren(Object.assign(document.createElement("div"), { style: "height: 3000px" }));
    return html;
  });
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 40. Some words", 0))).toBe(false);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const y = await page.evaluate(() => scrollY);
  await page.evaluate((html) => {
    document.getElementById("main")!.innerHTML = html;
    window.__lattice!.scrollToUnfoundText();
  }, drawn);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => scrollY), "where the reader scrolled to").toBe(y);
});

test("the same place is not reported twice, as a box of the page's own keeps scrolling", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const box = Object.assign(document.createElement("div"), { id: "carousel", style: "height: 40px; overflow: auto" });
    box.append(Object.assign(document.createElement("div"), { style: "height: 400px" }));
    document.body.append(box);
    scrollTo(0, 800);
  });
  await expect.poll(async () => (await reported(page))?.text).toBeTruthy();
  const count = () => page.evaluate(() => window.__pageCalls.filter((c) => c.cmd === "overlay_place").length);
  const before = await count();
  for (const top of [100, 200]) {
    await page.evaluate((t) => document.getElementById("carousel")!.scrollTo(0, t), top);
    await page.waitForTimeout(400);
  }
  expect(await count()).toBe(before);
});

test("in a PDF translated only lower down, the paragraph on the line is the place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(textLayer);
  await page.evaluate(() => {
    const ps = document.querySelectorAll("p");
    // As the PDF viewer's: regions take the pointer, above the text layer, once translated; only paragraph 14 below the line is.
    ps.forEach((p, i) => (p.style.pointerEvents = i === 14 ? "auto" : "none"));
    Object.assign(ps[14].style, { position: "relative", zIndex: "3" });
    const r = ps[12].getBoundingClientRect();
    scrollBy(0, r.top + 0.5 * r.height - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 12\./);
});

test("of two columns on the line, the left one, read first, is the place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(textLayer);
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
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(false);
  await page.evaluate(() => setTimeout(() => (document.getElementById("main")!.style.display = ""), 200));
  await expect.poll(() => lineIn(page, 30)).toBeCloseTo(0.5, 1);
});

test("a place never found is looked for again for a few seconds, not without end", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const style = window.getComputedStyle.bind(window);
    Object.assign(window, { __styles: 0, getComputedStyle: (el: Element) => ((window as unknown as { __styles: number }).__styles++, style(el)) });
  });
  // A quiet page settles at once: a try every 400 ms, for 5 s; it once went on for as long as the page was open.
  expect(await page.evaluate(() => window.__lattice!.scrollToText("A paragraph this page does not have.", 0))).toBe(false);
  await page.waitForTimeout(6000);
  const styles = () => page.evaluate(() => (window as unknown as { __styles: number }).__styles);
  const after = await styles();
  await page.waitForTimeout(1500);
  expect(await styles(), "no more walks of the page").toBe(after);
});

test("a page that says translate=no on html still reports its place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    document.documentElement.translate = false;
    const r = document.querySelectorAll("p")[15].getBoundingClientRect();
    scrollBy(0, r.top + 0.5 * r.height - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 15\./);
});

test("a place goes to the shown block that is its start, not a hidden copy or one that only begins so", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const ps = document.querySelectorAll("p");
    const hidden = Object.assign(ps[40].cloneNode(true) as HTMLElement, { hidden: true });
    ps[2].before(hidden);
    ps[5].textContent = "Usage of the API is metered by the minute.";
    ps[45].textContent = "Usage";
  });
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 40. Some words", 0))).toBe(true);
  await expect.poll(() => lineIn(page, 41), "the shown paragraph 40, after the hidden copy").toBeCloseTo(0, 1);
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Usage", 0))).toBe(true);
  await expect.poll(() => lineIn(page, 46), "the heading, not paragraph 5").toBeCloseTo(0, 1);
});

test("a place is put back when the page shows its text a while after loading", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  // As a page that fetches its article first: quiet for longer than one settling, then shown by an attribute.
  await page.evaluate(() => (document.getElementById("main")!.hidden = true));
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(false);
  await page.evaluate(() => setTimeout(() => (document.getElementById("main")!.hidden = false), 1200));
  await expect.poll(() => lineIn(page, 30), { timeout: 5000 }).toBeCloseTo(0.5, 1);
});

test("under the PDF viewer's text layer, the paragraph on the line beats one translated just below it", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const ps = document.querySelectorAll("p");
    ps.forEach((p, i) => Object.assign(p.style, { margin: "0", pointerEvents: i === 13 ? "auto" : "none" }));
    // Translated, it takes the pointer above the text layer, as the viewer's regions do.
    Object.assign(ps[13].style, { position: "relative", zIndex: "3" });
    const layer = Object.assign(document.createElement("div"), { translate: false });
    Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2", color: "transparent" });
    for (let y = 0; y < innerHeight; y += 10) {
      const line = Object.assign(document.createElement("span"), { textContent: `text layer line ${y}` });
      Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: `${y}px`, height: "10px" });
      layer.append(line);
    }
    document.body.append(layer);
    // Paragraph 12's last lines on the line; paragraph 13 starts a few pixels below.
    const r = ps[12].getBoundingClientRect();
    scrollBy(0, r.bottom - 6 - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 12\./);
});

test("a short place begins a block only when no word follows: a cell's No is not Note nor No such", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const ps = document.querySelectorAll("p");
    ps[20].textContent = "Note that this paragraph is not the cell.";
    ps[25].textContent = "No such file or directory, the shell said.";
    ps[30].textContent = "Installation is quick: one command.";
    ps[45].textContent = "Installation¶";
  });
  expect(await page.evaluate(() => window.__lattice!.scrollToText("No", 0))).toBe(false);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Installation", 0))).toBe(true);
  await expect.poll(() => lineIn(page, 45), "the heading drawn with its mark, not the paragraph").toBeCloseTo(0, 1);
});

test("under the text layer, the gap just above an untranslated paragraph names it, not a translated one further down", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    const ps = document.querySelectorAll("p");
    ps.forEach((p, i) => Object.assign(p.style, { margin: "0 0 12px", pointerEvents: i === 15 ? "auto" : "none" }));
    Object.assign(ps[15].style, { position: "relative", zIndex: "3" });
    const layer = Object.assign(document.createElement("div"), { translate: false });
    Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2", color: "transparent" });
    for (let y = 0; y < innerHeight; y += 10) {
      const line = Object.assign(document.createElement("span"), { textContent: `text layer line ${y}` });
      Object.assign(line.style, { position: "absolute", left: "0", right: "0", top: `${y}px`, height: "10px" });
      layer.append(line);
    }
    document.body.append(layer);
    // The line 4 px above paragraph 13, in the gap; paragraph 15, translated, further down.
    scrollBy(0, ps[13].getBoundingClientRect().top - 4 - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 13\./);
});

test("while a place is still waited for, a box scrolling by itself reports nothing", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    // Over the reading line, with text of its own.
    const box = Object.assign(document.createElement("div"), { id: "carousel", style: "height: 200px; margin-top: 60px; overflow: auto" });
    box.append(Object.assign(document.createElement("p"), { textContent: "A carousel of related posts.", style: "height: 600px; margin: 0" }));
    document.body.prepend(box);
    document.getElementById("main")!.hidden = true;
  });
  expect(await page.evaluate(() => window.__lattice!.scrollToText("Page paragraph 30. Some words", 0.5))).toBe(false);
  await page.evaluate(() => document.getElementById("carousel")!.scrollTo(0, 100));
  await page.waitForTimeout(600);
  expect(await reported(page)).toBeUndefined();
});

test("with no text layer on the line, nothing is looked for by position, as a hidden drawer's paragraph", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(() => {
    // A closed drawer: invisible, taking no pointer, its paragraph across the reading line.
    const drawer = Object.assign(document.createElement("p"), { textContent: "Search the documentation" });
    Object.assign(drawer.style, { position: "fixed", top: "0", left: "0", width: "40%", height: "100%", margin: "0", opacity: "0", pointerEvents: "none" });
    document.body.prepend(drawer);
    const code = Object.assign(document.createElement("pre"), { textContent: "let x = 1;\n".repeat(200) });
    document.querySelectorAll("p")[20].after(code);
    scrollBy(0, code.getBoundingClientRect().top + 200);
  });
  await page.waitForTimeout(600);
  expect(await reported(page)).toBeUndefined();
});

test("under a text layer, an invisible drawer's paragraph is not the place", async ({ page }) => {
  await page.goto("/page.html");
  await expect.poll(() => page.evaluate(() => window.__lattice != null)).toBe(true);
  await page.evaluate(textLayer);
  await page.evaluate(() => {
    document.querySelectorAll("p").forEach((p) => (p.style.pointerEvents = "none"));
    const drawer = Object.assign(document.createElement("p"), { textContent: "Search the documentation" });
    Object.assign(drawer.style, { position: "fixed", top: "0", left: "0", width: "40%", height: "100%", margin: "0", opacity: "0", pointerEvents: "none" });
    document.getElementById("main")!.prepend(drawer);
    const r = document.querySelectorAll("p")[13].getBoundingClientRect();
    scrollBy(0, r.top + 0.5 * r.height - innerHeight * 0.15);
  });
  await expect.poll(async () => (await reported(page))?.text).toMatch(/^Page paragraph 12\./);
});
