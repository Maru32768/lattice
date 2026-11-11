// Moving around a document by keys: the Reader's host of the controller the page overlay also runs.
import { test as base, expect, callsOf, list, listRow } from "./harness.ts";
import { ARTICLES, SNAPSHOT_ID } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const order = [...ARTICLES].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
const label = (i: number) => order[i].title ?? order[i].original_url;
const palette = (page: Page) => page.getByRole("dialog", { name: "コマンドパレット" });

const PARAGRAPHS = [
  "Alpha beta gamma delta epsilon.",
  "Second line about the needle and more.",
  "Third paragraph with another Needle here.",
  "日本語の文章を単語に分ける。",
];

/** Keeps a handle on the closed shadow root the document keys draw in, which nothing else can reach. */
const test = base.extend<{ reader: Page }>({
  reader: async ({ shell }, provide) => {
    await shell.addInitScript(() => {
      // oxlint-disable-next-line typescript/unbound-method -- called on each element below
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        (window as unknown as { __roots: ShadowRoot[] }).__roots = [...((window as unknown as { __roots?: ShadowRoot[] }).__roots ?? []), root];
        return root;
      };
      window.print = () => void ((window as unknown as { __printed: number }).__printed = 1);
      navigator.clipboard.writeText = (text) => {
        (window as unknown as { __clip: string }).__clip = text;
        return Promise.resolve();
      };
      document.addEventListener("copy", () => {
        (window as unknown as { __clip: string }).__clip = window.getSelection()!.toString();
      });
    });
    await shell.goto("/");
    await (await listRow(shell, label(0))).click();
    await expect(shell.locator(".art-title")).toHaveText(label(0));
    // The fixture's articles are short and have no links: a document long enough to move around in.
    await shell.locator(".reader").evaluate((el, texts) => {
      const box = document.createElement("section");
      box.id = "extra";
      box.innerHTML = `
        <h2 id="h-one">One</h2><p id="p0"></p><p id="p1"></p>
        <a id="plain" href="#plain">a plain link</a>
        <div style="height:1500px"></div>
        <h3 id="h-two">Two</h3><p id="p2"></p><p id="p3"></p>
        <div style="height:1500px"></div>
        <h2 id="h-three">Three</h2>`;
      texts.forEach((t, i) => (box.querySelector(`#p${i}`)!.textContent = t));
      el.append(box);
    }, PARAGRAPHS);
    await shell.keyboard.press("Control+l");
    await expect(shell.locator(".doc-scroll")).toBeFocused();
    await provide(shell);
  },
});

/** What the document keys draw: each label with its place, and the find bar's parts. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>("[data-lattice-ui]")].at(-1);
    const root = (window as unknown as { __roots?: ShadowRoot[] }).__roots?.find((r) => r.host === host);
    const all = root ? [...root.querySelectorAll<HTMLElement>("div")] : [];
    return {
      open: !!host,
      labels: all
        .filter((d) => /^[A-Z]+$/.test(d.textContent) && !d.children.length)
        .map((d) => ({ text: d.textContent, x: d.getBoundingClientRect().left, y: d.getBoundingClientRect().top })),
      text: root?.textContent ?? "",
      query: root?.querySelector("input")?.value ?? null,
    };
  });

async function press(page: Page, ...keys: string[]) {
  for (const k of keys) {
    await page.keyboard.press(k);
  }
}

const selected = (page: Page) => page.evaluate(() => window.getSelection()!.toString());
const scrollTop = (page: Page) => page.locator(".doc-scroll").evaluate((el) => el.scrollTop);

/** Types the label nearest the element's top left, as a reader would read it off the screen. */
async function typeLabelOf(page: Page, selector: string) {
  const at = await page.locator(selector).evaluate((el) => {
    const r = el.getClientRects()[0];
    return { x: r.left, y: r.top };
  });
  await expect.poll(async () => (await drawn(page)).labels.length).toBeGreaterThan(0);
  const { labels } = await drawn(page);
  const near = labels.toSorted((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y))[0];
  await page.keyboard.type(near.text.toLowerCase());
}

const clicks = (page: Page) =>
  page.locator("#plain").evaluate((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      (window as unknown as { __click: { ctrl: boolean } }).__click = { ctrl: (e as MouseEvent).ctrlKey };
    });
  });
const clicked = (page: Page) => page.evaluate(() => (window as unknown as { __click?: { ctrl: boolean } }).__click ?? null);

test("f puts labels on the links on screen and typing one clicks it; while they show, the keys go nowhere else", async ({ reader }) => {
  await clicks(reader);
  await reader.keyboard.press("f");
  await typeLabelOf(reader, "#plain");
  await expect.poll(() => clicked(reader)).toEqual({ ctrl: false });
  await expect.poll(async () => (await drawn(reader)).open, "the labels went").toBe(false);
});

test("Esc and a pointer press end the labels, and a letter no label starts with does nothing", async ({ reader }) => {
  const cur = list(reader).locator(".row.cur .t");
  const before = await cur.textContent();
  await reader.keyboard.press("f");
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  await reader.keyboard.press("q");
  await reader.keyboard.press("x");
  expect((await drawn(reader)).open, "still there").toBe(true);
  await reader.keyboard.press("Escape");
  expect((await drawn(reader)).open).toBe(false);
  await expect(cur).toHaveText(before!);

  await reader.keyboard.press("f");
  await expect.poll(async () => (await drawn(reader)).open).toBe(true);
  await reader.mouse.click(700, 400);
  expect((await drawn(reader)).open).toBe(false);
});

test("F clicks with Ctrl held, which opens a link behind", async ({ reader }) => {
  await clicks(reader);
  await reader.keyboard.press("Shift+F");
  await typeLabelOf(reader, "#plain");
  await expect.poll(() => clicked(reader)).toEqual({ ctrl: true });
});

test("gw selects the word whose label is typed, in visual mode, and y copies it and leaves", async ({ reader }) => {
  await press(reader, "g", "w");
  await reader.locator("#p0").evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.firstChild!, 6);
    r.setEnd(el.firstChild!, 10);
    (window as unknown as { __word: DOMRect }).__word = r.getClientRects()[0];
  });
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  const { labels } = await drawn(reader);
  const word = await reader.evaluate(() => {
    const w = (window as unknown as { __word: DOMRect }).__word;
    return { x: w.left, y: w.top };
  });
  const near = labels.toSorted((a, b) => Math.hypot(a.x - word.x, a.y - word.y) - Math.hypot(b.x - word.x, b.y - word.y))[0];
  await reader.keyboard.type(near.text.toLowerCase());
  await expect.poll(() => selected(reader)).toBe("beta");
  await expect.poll(async () => (await drawn(reader)).text).toContain("VISUAL");
  await reader.keyboard.press("y");
  await expect.poll(() => reader.evaluate(() => (window as unknown as { __clip?: string }).__clip)).toBe("beta");
  expect((await drawn(reader)).open).toBe(false);
  expect(await selected(reader), "the selection went with the mode").toBe("");
});

test("Japanese text has words to hint", async ({ reader }) => {
  await reader.locator("#h-two").evaluate((el) => el.scrollIntoView());
  await press(reader, "g", "w");
  await reader.locator("#p3").evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.firstChild!, 0);
    r.setEnd(el.firstChild!, 3);
    (window as unknown as { __word: DOMRect }).__word = r.getClientRects()[0];
  });
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  const on = await reader.evaluate(() => {
    const w = (window as unknown as { __word: DOMRect }).__word;
    return { x: w.left, right: w.right, y: w.top };
  });
  const inLine = (await drawn(reader)).labels.filter((l) => Math.abs(l.y - on.y) < 8);
  expect(inLine.length, "not one word for the whole line").toBeGreaterThan(1);
  await reader.keyboard.press("Escape");
});

test("gw takes the labels off the words scrolled out of the view", async ({ reader }) => {
  await press(reader, "g", "w");
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  await reader.locator(".doc-scroll").evaluate((el) => (el.scrollTop = 1000));
  await expect.poll(async () => (await drawn(reader)).labels.length).toBe(0);
});

test("a quote cut at its limit does not end in half a character, which the backend would refuse", async ({ reader }) => {
  await reader.locator("#p0").evaluate((el) => {
    el.textContent = `${"x".repeat(3999)}😀 tail`;
    window.getSelection()!.selectAllChildren(el);
  });
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("VISUAL");
  await reader.keyboard.press("a");
  await expect(reader.locator("#chat-q")).toBeFocused();
  expect(await reader.locator("#chat-q").evaluate((el) => (el as HTMLTextAreaElement).value.isWellFormed())).toBe(true);
});

test("gw puts labels on what is on screen of a long text node, from its first visible line to its last", async ({ reader }) => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line${i} word${i} more${i}`);
  await reader.locator("#extra").evaluate((el, text) => {
    const pre = document.createElement("pre");
    pre.id = "long";
    pre.textContent = text;
    el.prepend(pre);
    pre.scrollIntoView();
    const scroller = pre.closest(".doc-scroll")!;
    scroller.scrollTop += pre.getBoundingClientRect().height / 2;
  }, lines.join("\n"));
  await press(reader, "g", "w");
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  const { labels } = await drawn(reader);
  const onScreen = await reader.locator("#long").evaluate((el) => {
    const pane = el.closest(".doc-scroll")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { top: Math.max(pane.top, box.top), bottom: Math.min(pane.bottom, box.bottom) };
  });
  const ys = labels.map((l) => l.y).filter((y) => y >= onScreen.top - 1);
  expect(Math.min(...ys), "the first line on screen has labels").toBeLessThan(onScreen.top + 30);
  expect(Math.max(...ys), "and so does the last").toBeGreaterThan(onScreen.bottom - 30);
  await reader.keyboard.press("Escape");
});

test("v shows a block at the first text on screen; v again selects, motions extend, Esc collapses and leaves", async ({ reader }) => {
  await reader.locator("#p0").evaluate((el) => el.scrollIntoView());
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("CARET");
  expect(await selected(reader), "one character shows where it is").toBe("A");

  await reader.keyboard.press("l");
  expect(await selected(reader), "the caret moves, nothing is selected yet").toBe("l");

  await reader.keyboard.press("0");
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("VISUAL");
  await reader.keyboard.press("e");
  expect(await selected(reader)).toBe("Alpha");
  await reader.keyboard.press("w");
  expect(await selected(reader)).toBe("Alpha ");
  await reader.keyboard.press("w");
  expect(await selected(reader)).toBe("Alpha beta ");
  await reader.keyboard.press("b");
  expect(await selected(reader)).toBe("Alpha ");
  await reader.keyboard.press("Shift+L");
  expect(await selected(reader), "L goes to the line's end").toBe(PARAGRAPHS[0]);
  await reader.keyboard.press("Shift+H");
  expect(await selected(reader), "H back to its start").toBe("A");
  await reader.keyboard.press("$");
  expect(await selected(reader)).toBe(PARAGRAPHS[0]);
  await reader.keyboard.press("j");
  expect(await selected(reader)).toContain("Second");

  await reader.keyboard.press("Escape");
  expect(await selected(reader)).toBe("");
  expect((await drawn(reader)).open).toBe(false);
  await reader.keyboard.press("j");
  await expect.poll(() => scrollTop(reader), "j scrolls again").toBeGreaterThan(0);
});

test("V selects whole lines, also as they go up from where it began", async ({ reader }) => {
  await reader.locator("#p1").evaluate((el) => el.scrollIntoView());
  await reader.keyboard.press("v");
  await press(reader, "Shift+V");
  await expect.poll(async () => (await drawn(reader)).text).toContain("V-LINE");
  expect(await selected(reader)).toBe(PARAGRAPHS[1]);
  await reader.keyboard.press("k");
  const up = await selected(reader);
  expect(up).toContain(PARAGRAPHS[0]);
  expect(up, "the line it began on stays whole").toContain(PARAGRAPHS[1]);
});

test("gg and G in visual mode stop at the document's ends, not the page's", async ({ reader }) => {
  await reader.locator("#p0").evaluate((el) => el.scrollIntoView());
  await reader.keyboard.press("v");
  await reader.keyboard.press("v");
  await reader.keyboard.press("Shift+G");
  const down = await selected(reader);
  expect(down).toContain("Three");
  expect(down, "the panes beside the Reader are no part of it").not.toContain("対話");
  await expect.poll(() => reader.locator(".doc-scroll").evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 100)).toBe(true);
  await press(reader, "g", "g");
  expect(await selected(reader)).toContain(label(0));
});

test("G in caret mode reaches the document's end, with the panes beside the Reader left out", async ({ reader }) => {
  await reader.locator(".doc-scroll").evaluate((el) => {
    const next = document.createElement("div");
    next.textContent = "the next pane";
    el.after(next);
  });
  await reader.locator("#p0").evaluate((el) => el.scrollIntoView());
  await reader.keyboard.press("v");
  await reader.keyboard.press("Shift+G");
  await expect.poll(async () => (await drawn(reader)).text).toContain("CARET");
  const end = await reader.locator(".doc-scroll").evaluate((root) => {
    const s = window.getSelection()!;
    return { inside: root.contains(s.focusNode), text: s.toString(), last: root.textContent.trimEnd().at(-1) };
  });
  expect(end).toEqual({ inside: true, text: end.last, last: end.last });
});

test("j on the document's last line leaves the caret where it was, not at the end of the line", async ({ reader }) => {
  await reader.locator(".doc-scroll").evaluate((el) => {
    const box = document.createElement("div");
    box.id = "last-line";
    box.textContent = "the last line of all";
    el.append(box);
    const next = document.createElement("div");
    next.textContent = "the next pane";
    el.after(next);
  });
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("CARET");
  const place = () =>
    reader.evaluate(() => {
      const s = window.getSelection()!;
      return [s.focusNode?.parentElement?.id, s.anchorOffset];
    });
  await reader.evaluate(() => {
    const s = window.getSelection()!;
    s.collapse(document.getElementById("last-line")!.firstChild, 4);
    s.modify("extend", "forward", "character");
  });
  const before = await place();
  await reader.keyboard.press("j");
  await reader.waitForTimeout(50);
  expect(await place()).toEqual(before);
});

test("in visual mode s saves the selected word and a puts the quote in the chat's input without sending it", async ({ reader }) => {
  // A word in one of the article's own blocks: only those have a sentence to save it with.
  await (await listRow(reader, ARTICLES.find((a) => a.id === SNAPSHOT_ID)!.title!)).click();
  await reader.keyboard.press("Control+l");
  const selectWord = () =>
    reader
      .locator(".reader .blk.paragraph")
      .first()
      .evaluate((el) => {
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Text;
        window.getSelection()!.setBaseAndExtent(node, 0, node, node.data.search(/\s|$/));
      });
  await selectWord();
  const word = await selected(reader);
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("VISUAL");
  await reader.keyboard.press("s");
  await expect.poll(async () => ((await callsOf(reader, "vocab_add")) as { capture: { surface: string } }[]).map((c) => c.capture.surface)).toEqual([word]);
  expect((await drawn(reader)).open).toBe(false);

  // The saved word is marked now: its block was drawn anew.
  await selectWord();
  await reader.keyboard.press("v");
  await reader.keyboard.press("a");
  await expect(reader.locator("#chat-q")).toHaveValue(`> ${word}\n`);
  await expect(reader.locator("#chat-q")).toBeFocused();
  expect(await callsOf(reader, "chat_ask"), "never sent").toEqual([]);
});

test("/ finds as it is typed, Enter keeps the match, n and N go on and round", async ({ reader }) => {
  await reader.keyboard.press("/");
  await expect.poll(async () => (await drawn(reader)).query).toBe("");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/2");
  await expect(reader.locator(".row.cur"), "what is typed stays in the bar").toHaveCount(1);
  const barScroll = await scrollTop(reader);
  await reader.keyboard.press("Enter");
  expect(await selected(reader)).toBe("needle");
  expect((await drawn(reader)).open).toBe(false);
  await expect(reader.locator(".doc-scroll"), "the keyboard goes back to the document").toBeFocused();
  expect(await scrollTop(reader)).toBe(barScroll);

  await reader.keyboard.press("n");
  expect(await selected(reader), "the other one").toBe("Needle");
  await expect.poll(() => scrollTop(reader), "and it is on screen").toBeGreaterThan(barScroll);
  await reader.keyboard.press("n");
  expect(await selected(reader), "round to the first").toBe("needle");
  await reader.keyboard.press("Shift+N");
  expect(await selected(reader), "back round to the last").toBe("Needle");
});

test("a capital in the query minds case", async ({ reader }) => {
  await reader.keyboard.press("/");
  await reader.keyboard.type("Needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  await reader.keyboard.press("Enter");
  expect(await selected(reader)).toBe("Needle");
});

test("Esc in the find bar goes back to where it began, the selection too; the find leaves nothing for n", async ({ reader }) => {
  await reader.locator("#p0").evaluate((el) => {
    window.getSelection()!.setBaseAndExtent(el.firstChild!, 0, el.firstChild!, 5);
  });
  const top = await scrollTop(reader);
  await reader.keyboard.press("/");
  await reader.keyboard.type("Three");
  await expect.poll(() => scrollTop(reader), "it went to the match").toBeGreaterThan(top);
  await reader.keyboard.press("Escape");
  expect(await scrollTop(reader)).toBe(top);
  expect(await selected(reader)).toBe("Alpha");
  expect((await drawn(reader)).open).toBe(false);
  await reader.keyboard.press("n");
  expect(await selected(reader)).toBe("Alpha");
});

test("a click in the document ends a find as Enter does: n goes on from it", async ({ reader }) => {
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/2");
  await reader.locator("#p0").click();
  await expect.poll(async () => (await drawn(reader)).open).toBe(false);
  await reader.keyboard.press("n");
  await expect.poll(() => selected(reader)).toBe("needle");
});

test("a click in the document with no match kept leaves the view where it is: only Esc goes back", async ({ reader }) => {
  await reader.keyboard.press("/");
  await reader.keyboard.type("no such text");
  await expect.poll(async () => (await drawn(reader)).text).toContain("0/0");
  await reader.locator("#p2").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const top = await scrollTop(reader);
  expect(top).toBeGreaterThan(0);
  await reader.locator("#p2").click();
  await expect.poll(async () => (await drawn(reader)).open).toBe(false);
  expect(await scrollTop(reader)).toBe(top);
});

test("a match whose text changes under the find is looked for again, and Enter still selects it", async ({ reader }) => {
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/2");
  await reader.locator("#p1").evaluate((el) => (el.textContent = "A new needle, as a translation draws its node anew."));
  await reader.keyboard.press("Enter");
  expect(await selected(reader)).toBe("needle");
  expect(await reader.evaluate(() => window.getSelection()!.anchorNode!.isConnected)).toBe(true);
});

test("a match whose node shrinks under the find does not lose the selection to an error", async ({ reader }) => {
  const errors: string[] = [];
  reader.on("pageerror", (e) => errors.push(e.message));
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/2");
  await reader.locator("#p1").evaluate((el) => ((el.firstChild as Text).data = "S"));
  await reader.keyboard.press("Enter");
  expect(errors).toEqual([]);
  expect(await selected(reader)).toBe("Needle");
});

test("a match under a box that scrolls with it stays where it is: a PDF's translated regions lie over its text", async ({ reader }) => {
  const top = await reader.locator("#p0").evaluate((p) => {
    const box = p.parentElement!;
    box.style.position = "relative";
    const over = document.createElement("div");
    over.style.cssText = `position:absolute;left:0;right:0;top:${(p as HTMLElement).offsetTop}px;height:${(p as HTMLElement).offsetHeight}px;z-index:5`;
    box.append(over);
    const view = box.closest(".doc-scroll")!;
    view.scrollTop += p.getBoundingClientRect().top - view.getBoundingClientRect().top - 100;
    return view.scrollTop;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("Alpha");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/");
  expect(await scrollTop(reader)).toBe(top);
});

test("a match under a bar outside the box that scrolls is brought out from under it", async ({ reader }) => {
  await reader.locator("#p0").evaluate((p) => {
    const view = p.closest(".doc-scroll")!;
    const top = view.getBoundingClientRect().top;
    view.scrollTop += p.getBoundingClientRect().top - top - 50;
    const bar = document.createElement("div");
    bar.id = "bar";
    bar.style.cssText = `position:absolute;left:0;right:0;top:${top}px;height:200px;background:#fff;z-index:50`;
    document.body.append(bar);
  });
  const hidden = () =>
    reader.locator("#p0").evaluate((p) => {
      const r = document.createRange();
      r.selectNodeContents(p);
      const box = r.getBoundingClientRect();
      return !document.elementFromPoint(box.left + 10, box.top + box.height / 2)?.contains(p);
    });
  expect(await hidden(), "the bar is over it").toBe(true);
  await reader.keyboard.press("/");
  await reader.keyboard.type("Alpha");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/");
  await expect.poll(hidden, "where a reader can see it").toBe(false);
});

test("a match under a sticky header is brought out from under it", async ({ reader }) => {
  await reader.locator("#extra").evaluate((box) => {
    const header = document.createElement("div");
    header.id = "stuck";
    header.style.cssText = "position:sticky;top:0;height:200px;background:#fff;z-index:5";
    header.textContent = "A header";
    box.prepend(header);
    const p = box.querySelector("#p0")!;
    const view = box.closest(".doc-scroll")!;
    view.scrollTop += p.getBoundingClientRect().top - view.getBoundingClientRect().top - 50;
  });
  const hidden = () =>
    reader.locator("#p0").evaluate((p) => {
      const r = document.createRange();
      r.selectNodeContents(p);
      const box = r.getBoundingClientRect();
      return !document.elementFromPoint(box.left + 10, box.top + box.height / 2)?.contains(p);
    });
  expect(await hidden(), "the header is over it").toBe(true);
  await reader.keyboard.press("/");
  await reader.keyboard.type("epsilon");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  await expect.poll(hidden, "where a reader can see it").toBe(false);
});

test("a match under a sticky header in the same parent is brought out from under it", async ({ reader }) => {
  const scrolled = await reader.locator("#extra").evaluate((box) => {
    box.insertAdjacentHTML(
      "afterbegin",
      `<div id="both"><div style="position:sticky;top:0;height:200px;background:#fff;z-index:5">A header</div>zymurgy</div>`,
    );
    const view = box.closest(".doc-scroll")!;
    const both = box.querySelector("#both")!;
    view.scrollTop += both.getBoundingClientRect().top - view.getBoundingClientRect().top + 150;
    return view.scrollTop;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  expect(await scrollTop(reader)).not.toBe(scrolled);
  const covered = await reader.locator("#both").evaluate((both) => {
    const r = document.createRange();
    r.selectNode(both.lastChild!);
    const box = r.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) !== both;
  });
  expect(covered, "where a reader can see it").toBe(false);
});

test("a match in view that wraps inside a long inline element leaves the view where it is", async ({ reader }) => {
  const top = await reader.locator("#p0").evaluate((p) => {
    const view = p.closest(".doc-scroll")!;
    const line = `${"a".repeat(19)} `;
    p.insertAdjacentHTML(
      "beforebegin",
      `<p style="width:20ch;font:16px/1.8 monospace;margin:0"><span id="sent">${line.repeat(4)}${"a".repeat(12)} zymurgy zythum ${line.repeat(2)}</span></p>`,
    );
    const sent = p.parentElement!.querySelector("#sent")!;
    // Its first lines above the view, and the match on the two lines after them.
    view.scrollTop += sent.getBoundingClientRect().top - view.getBoundingClientRect().top + 60;
    return view.scrollTop;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy zythum");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  expect(await scrollTop(reader)).toBe(top);
});

test("a match past the edge of a long line in a code block comes into the block", async ({ reader }) => {
  await reader.locator("#p0").evaluate((p) => {
    const view = p.closest(".doc-scroll")!;
    p.insertAdjacentHTML(
      "beforebegin",
      `<pre id="wide" style="overflow-x:auto;width:200px;white-space:pre;font:16px monospace"><code>${"a".repeat(40)} zymurgyzythumzz ${"a".repeat(10)}</code></pre>`,
    );
    view.scrollTop += p.getBoundingClientRect().top - view.getBoundingClientRect().top - 200;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgyzythumzz");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  await expect
    .poll(() =>
      reader.locator("#wide").evaluate((pre) => {
        const text = pre.querySelector("code")!.firstChild!;
        const r = document.createRange();
        r.setStart(text, 41);
        r.setEnd(text, 56);
        const match = r.getBoundingClientRect();
        const box = pre.getBoundingClientRect();
        return match.left >= box.left && match.right <= box.right;
      }),
    )
    .toBe(true);
});

test("a match in view at the end of a line in a scrolled code block leaves it where it is, though it runs on to the next line", async ({ reader }) => {
  const left = await reader.locator("#p0").evaluate((p) => {
    p.insertAdjacentHTML(
      "beforebegin",
      `<pre id="wide" style="overflow-x:auto;width:200px;white-space:pre;font:16px monospace"><code>${"a".repeat(40)} zymurgy
zythum</code></pre>`,
    );
    const pre = p.parentElement!.querySelector("#wide")!;
    pre.scrollLeft = pre.scrollWidth;
    return pre.scrollLeft;
  });
  expect(left).toBeGreaterThan(0);
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy zythum");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  expect(await reader.locator("#wide").evaluate((el) => el.scrollLeft)).toBe(left);
});

test("a match past an ellipsis leaves the line as it was: a reader could not scroll it back", async ({ reader }) => {
  await reader.locator("#p0").evaluate((p) => {
    p.insertAdjacentHTML(
      "beforebegin",
      `<div id="cut" style="overflow:hidden;width:200px;white-space:nowrap;text-overflow:ellipsis">${"a".repeat(60)} zymurgy</div>`,
    );
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  expect(await reader.locator("#cut").evaluate((el) => el.scrollLeft)).toBe(0);
});

test("a match in view inside text the pointer passes through leaves the view where it is", async ({ reader }) => {
  const top = await reader.locator("#p0").evaluate((p) => {
    const view = p.closest(".doc-scroll")!;
    p.insertAdjacentHTML(
      "beforebegin",
      `<div><span id="through" style="display:block;pointer-events:none;height:${view.clientHeight * 2}px">zymurgy</span></div>`,
    );
    const span = p.parentElement!.querySelector("#through")!;
    view.scrollTop += span.getBoundingClientRect().top - view.getBoundingClientRect().top - 40;
    return view.scrollTop;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  expect(await scrollTop(reader)).toBe(top);
});

test("a match off to the side of a narrow pane stops inside it, not past its other edge", async ({ reader }) => {
  await reader.locator("#p0").evaluate((p) => {
    const view = p.closest<HTMLElement>(".doc-scroll")!;
    view.style.width = "300px";
    view.style.flex = "none";
    view.style.overflowX = "auto";
    p.insertAdjacentHTML(
      "beforebegin",
      `<pre id="long" style="overflow:visible;white-space:pre;font:16px monospace;width:max-content">${"a".repeat(40)} zymurgy ${"a".repeat(100)}</pre>`,
    );
    view.scrollTop += p.getBoundingClientRect().top - view.getBoundingClientRect().top - 200;
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("zymurgy");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  const inView = await reader.locator("#long").evaluate((pre) => {
    const r = document.createRange();
    r.setStart(pre.firstChild!, 41);
    r.setEnd(pre.firstChild!, 48);
    const match = r.getBoundingClientRect();
    const view = pre.closest(".doc-scroll")!.getBoundingClientRect();
    return match.left >= view.left && match.right <= view.right;
  });
  expect(inView).toBe(true);
});

test("find counts what a reader can open to only once it is open", async ({ reader }) => {
  await reader.locator("#p1").evaluate((el) => {
    el.insertAdjacentHTML(
      "afterend",
      `<details><summary>label</summary><p>needle</p>needle</details><div hidden="until-found">needle</div><details open><p>needle</p></details>`,
    );
  });
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/3");
});

test("a match is not left under the find bar", async ({ reader }) => {
  const clearance = () => reader.locator("#p2").evaluate((el) => el.closest(".doc-scroll")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
  await reader.locator("#p2").evaluate((el) => el.scrollIntoView({ block: "end" }));
  expect(await clearance()).toBeLessThan(5);
  await reader.keyboard.press("/");
  await reader.keyboard.type("another");
  await expect.poll(async () => (await drawn(reader)).text).toContain("1/1");
  await expect.poll(clearance).toBeGreaterThan(48);
  await reader.keyboard.press("Escape");
});

test("a query with no match shows no match and stays where it began", async ({ reader }) => {
  const top = await scrollTop(reader);
  await reader.keyboard.press("/");
  await reader.keyboard.type("Thre");
  await expect.poll(() => scrollTop(reader)).toBeGreaterThan(top);
  await reader.keyboard.type("xx");
  await expect.poll(async () => (await drawn(reader)).text).toContain("0/0");
  await expect.poll(() => scrollTop(reader)).toBe(top);
  await reader.keyboard.press("Enter");
  expect((await drawn(reader)).open).toBe(false);
});

test("]] and [[ go to the next and the previous heading", async ({ reader }) => {
  const at = (id: string) => reader.locator(id).evaluate((el) => el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top);
  await reader.locator("#h-one").evaluate((el) => el.scrollIntoView());
  await press(reader, "]", "]");
  await expect.poll(() => at("#h-two").then((t) => Math.abs(t) < 2)).toBe(true);
  await press(reader, "]", "]");
  await press(reader, "[", "[");
  await expect.poll(() => at("#h-two").then((t) => Math.abs(t) < 2)).toBe(true);
  await press(reader, "[", "[");
  await expect.poll(() => at("#h-one").then((t) => Math.abs(t) < 2)).toBe(true);
});

test("]] and [[ go to a heading again once the view has moved off it, and past one that cannot reach the top", async ({ reader }) => {
  const at = (id: string) => reader.locator(id).evaluate((el) => el.getBoundingClientRect().top - el.closest(".doc-scroll")!.getBoundingClientRect().top);
  const onTop = (id: string) => expect.poll(() => at(id).then((t) => Math.abs(t) < 2), `${id} at the top`).toBe(true);
  await reader.locator("#h-one").evaluate((el) => el.scrollIntoView());
  await press(reader, "]", "]");
  await onTop("#h-two");
  await reader.keyboard.press("k");
  await expect.poll(() => at("#h-two"), "k moved the view").toBeGreaterThan(2);
  await press(reader, "]", "]");
  await onTop("#h-two");

  await press(reader, "[", "[");
  await onTop("#h-one");
  await reader.keyboard.press("j");
  await expect.poll(() => at("#h-one"), "j moved the view").toBeLessThan(-2);
  await press(reader, "[", "[");
  await onTop("#h-one");

  // A scroll margin stops a heading short of the top, and the document's end can too: the next one must still be next.
  await reader.locator(".doc-scroll").evaluate((el) => void ((el as HTMLElement).style.scrollPaddingTop = "60px"));
  await press(reader, "]", "]");
  await expect.poll(() => at("#h-two").then((t) => Math.abs(t - 60) < 2), "#h-two under the margin").toBe(true);
  await press(reader, "]", "]");
  await expect.poll(() => at("#h-two"), "and on past it").toBeLessThan(0);
});

test("H and L step through the app's history in the Reader", async ({ reader }) => {
  await reader.keyboard.press("Shift+J");
  await expect(reader.locator(".art-title")).toHaveText(label(1));
  await reader.keyboard.press("Shift+H");
  await expect(reader.locator(".art-title")).toHaveText(label(0));
  await reader.keyboard.press("Shift+L");
  await expect(reader.locator(".art-title")).toHaveText(label(1));
});

test("yy copies the article's URL, and Ctrl+Shift+P prints", async ({ reader }) => {
  await press(reader, "y", "y");
  await expect.poll(() => reader.evaluate(() => (window as unknown as { __clip?: string }).__clip)).toBe(order[0].original_url);
  await reader.keyboard.press("Control+Shift+P");
  await expect.poll(() => reader.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBe(1);

  await reader.emulateMedia({ media: "print" });
  await expect(list(reader), "only the document goes on paper").toBeHidden();
  const { height, of } = await reader.locator(".doc-scroll").evaluate((el) => ({ height: el.clientHeight, of: el.scrollHeight }));
  expect(height, "at its full length").toBe(of);
  expect(height).toBeGreaterThan(3000);
  await reader.emulateMedia({ media: "screen" });
});

test("the print key prints only a Reader: anywhere else the print styles leave a blank sheet", async ({ reader }) => {
  await reader.locator(".nav").getByRole("button", { name: "設定", exact: true }).click();
  await reader.locator("main[data-pane='doc']").click({ position: { x: 5, y: 5 } });
  await reader.keyboard.press("Control+Shift+P");
  expect(await reader.evaluate(() => (window as unknown as { __printed?: number }).__printed)).toBeUndefined();
});

test("gi goes to the first text field on screen; in the chat that is its input", async ({ app }) => {
  await app.getByRole("button", { name: "対話" }).click();
  await app.locator(".chat-log").click({ position: { x: 5, y: 5 } });
  await press(app, "g", "i");
  await expect(app.locator("#chat-q")).toBeFocused();
  await expect(app.locator("#chat-q"), "the i is not typed").toHaveValue("");
});

test("a mode ends for a key of the app's, whose own keys then work", async ({ reader }) => {
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).open).toBe(true);
  await reader.keyboard.press("Control+p");
  await expect(palette(reader)).toBeVisible();
  expect((await drawn(reader)).open).toBe(false);
  await reader.keyboard.type("x");
  await expect(palette(reader).getByRole("combobox"), "the palette types").toHaveValue("x");
  await reader.keyboard.press("Escape");
});

test("an app key from the find bar ends the find, and the keyboard stays where the key sent it", async ({ reader }) => {
  const find = async () => {
    await reader.keyboard.press("/");
    await reader.keyboard.type("needle");
    await expect.poll(async () => (await drawn(reader)).text).toContain("1/2");
  };
  await find();
  await reader.keyboard.press("Control+p");
  await expect(palette(reader)).toBeVisible();
  await expect.poll(async () => (await drawn(reader)).open, "the find ended").toBe(false);
  await expect(palette(reader).getByRole("combobox")).toBeFocused();
  await reader.keyboard.type("x");
  await expect(palette(reader).getByRole("combobox"), "the palette types").toHaveValue("x");
  await reader.keyboard.press("Escape");
  await expect(reader.locator(".doc-scroll"), "and the palette gives it back").toBeFocused();

  await find();
  await reader.keyboard.press("Control+h");
  await expect.poll(async () => (await drawn(reader)).open).toBe(false);
  await expect(reader.locator("[data-pane='list']").locator(":focus"), "a pane move is not undone").toHaveCount(1);
  await reader.keyboard.press("Control+l");
  await expect(reader.locator(".doc-scroll")).toBeFocused();

  await find();
  await press(reader, "Control+a", "w");
  await expect(palette(reader)).toBeVisible();
  await expect.poll(async () => (await drawn(reader)).open).toBe(false);
  await reader.keyboard.type("x");
  await expect(palette(reader).getByRole("combobox"), "the chord's second key was not typed in the bar").toHaveValue(/x$/);
});

test("a Ctrl key that is no app key stays in the find bar", async ({ reader }) => {
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await reader.keyboard.press("Control+Backspace");
  await reader.keyboard.type("Three");
  await expect.poll(async () => (await drawn(reader)).query, "Ctrl+Backspace deleted what was typed").toBe("Three");
  await reader.keyboard.press("Escape");
});

test("a click into a frame ends the labels and the mode, which that window never hears of", async ({ reader }) => {
  await reader.locator("#extra").evaluate((el) => {
    const frame = document.createElement("iframe");
    frame.id = "frame";
    frame.srcdoc = "<p>inside</p>";
    el.prepend(frame);
  });
  const clickIn = () => reader.frameLocator("#frame").locator("p").click();
  await reader.locator("#frame").evaluate((el) => el.scrollIntoView());

  await reader.keyboard.press("f");
  await expect.poll(async () => (await drawn(reader)).labels.length).toBeGreaterThan(0);
  await clickIn();
  await expect.poll(async () => (await drawn(reader)).open, "the labels went").toBe(false);

  await reader.locator(".doc-scroll").focus();
  await reader.keyboard.press("v");
  await expect.poll(async () => (await drawn(reader)).text).toContain("CARET");
  await clickIn();
  await expect.poll(async () => (await drawn(reader)).open, "the badge went").toBe(false);

  await reader.locator(".doc-scroll").focus();
  await reader.keyboard.press("/");
  await reader.keyboard.type("needle");
  await clickIn();
  await expect.poll(async () => (await drawn(reader)).open, "the bar went").toBe(false);
  expect(await reader.evaluate(() => document.activeElement?.id), "the frame keeps the keyboard").toBe("frame");
});

test("the palette lists the document's actions but not the small steps, and running one leaves the keyboard with it", async ({ reader }) => {
  await reader.keyboard.press(":");
  await reader.keyboard.type("本文を検索");
  await expect(palette(reader).getByRole("option")).toHaveText([/本文を検索/]);
  await reader.keyboard.press("Enter");
  await expect(palette(reader)).toBeHidden();
  await expect.poll(async () => (await drawn(reader)).query).toBe("");
  await reader.keyboard.type("needle");
  await expect.poll(async () => (await drawn(reader)).query).toBe("needle");
  await reader.keyboard.press("Escape");

  await reader.keyboard.press(":");
  await reader.keyboard.type("下へスクロール");
  await expect(palette(reader).getByRole("option")).toHaveCount(0);
});

const PAGE_LAYOUT = {
  root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 },
  focused: 1,
};

base("the second key of a chord that reached the app runs in the page, and the page gets the keyboard back", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.fromPage("browser-key", { tab: "k1", key: "G", count: 1 }));
  await expect(shell.locator(".prefix-hint")).toBeVisible();
  const focused = (await callsOf(shell, "browser_focus")).length;
  await shell.keyboard.press("g");
  await expect.poll(() => callsOf(shell, "browser_run_doc")).toEqual([{ key: "k1", action: "docTop", count: 1 }]);
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).length).toBeGreaterThan(focused);
  await expect(shell.locator(".prefix-hint")).toBeHidden();
});

base("a page's keys scroll its viewport only if a reader could, else its largest scrolling box", async ({ shell }) => {
  await shell.goto("/");
  const module = `/@fs/${process.cwd().replaceAll("\\", "/")}/src/docnav/scroll.ts`;
  const scrollers = await shell.evaluate(async (src) => {
    const { pageScroller } = (await import(src)) as typeof import("../src/docnav/scroll.ts");
    const box = document.createElement("div");
    box.id = "inner";
    box.style.cssText = "position:fixed;inset:0;overflow:auto";
    box.innerHTML = "<div style='height:5000px'></div>";
    const tall = document.createElement("div");
    tall.style.height = "200vh";
    document.body.append(box, tall);
    const pick = (root: string, body: string) => {
      document.documentElement.style.overflowY = root;
      document.body.style.overflowY = body;
      return pageScroller()?.id || pageScroller()?.tagName;
    };
    return [pick("visible", "visible"), pick("visible", "hidden"), pick("hidden", "hidden"), pick("clip", "visible"), pick("auto", "hidden")];
  }, module);
  expect(scrollers).toEqual(["HTML", "inner", "inner", "inner", "HTML"]);
});

base("from the palette a local action runs in the page", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.keyboard.press("Control+p");
  await palette(shell).getByRole("combobox").fill(">リンクをキーで開く");
  await expect(palette(shell).getByRole("option")).toHaveCount(1);
  await shell.keyboard.press("Enter");
  await expect.poll(() => callsOf(shell, "browser_run_doc")).toEqual([{ key: "k1", action: "hints", count: 1 }]);
});

base("a page's quote goes to the chat, unsent", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.fromPage("browser-ask", { tab: "k1", quote: "a quoted line" }));
  await expect(shell.locator("#chat-q")).toHaveValue("> a quoted line\n");
  await expect(shell.locator("#chat-q")).toBeFocused();
  expect(await callsOf(shell, "chat_ask")).toEqual([]);
});

base("a quote from a page that does not hold the keyboard is ignored", async ({ shell }) => {
  const twoPages = {
    root: {
      kind: "split",
      id: 90,
      dir: "row",
      sizes: [0.5, 0.5],
      children: [PAGE_LAYOUT.root, { kind: "pane", id: 4, tabs: [{ kind: "page", id: 5, key: "k2", url: "https://example.com/q", title: "Q" }], active: 5 }],
    },
    focused: 1,
  };
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(twoPages));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toHaveCount(2);
  await shell.evaluate(() => window.__e2e.fromPage("browser-ask", { tab: "k2", quote: "from the side" }));
  await shell.evaluate(() => window.__e2e.emit("browser-ask", { tab: "k1", quote: "while the app has the keyboard" }));
  await shell.evaluate(() => window.__e2e.fromPage("browser-ask", { tab: "k1", quote: "the real one" }));
  await expect(shell.locator("#chat-q")).toHaveValue("> the real one\n");
});

base("yy under the hint keeps the keyboard in the app until the URL is copied, then gives it back", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.addInitScript(() => {
    navigator.clipboard.writeText = () => {
      (window as unknown as { __focusesAtWrite: number }).__focusesAtWrite = window.__e2e.calls.filter((c) => c.cmd === "browser_focus").length;
      return Promise.resolve();
    };
  });
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.fromPage("browser-key", { tab: "k1", key: "Y", count: 1 }));
  await expect(shell.locator(".prefix-hint")).toBeVisible();
  const focused = (await callsOf(shell, "browser_focus")).length;
  await shell.keyboard.press("y");
  await expect.poll(() => shell.evaluate(() => (window as unknown as { __focusesAtWrite?: number }).__focusesAtWrite)).toBe(focused);
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).length).toBeGreaterThan(focused);
});

test("yy in the chat log leaves the Reader beside it alone", async ({ reader }) => {
  await reader.locator(".nav").getByRole("button", { name: "対話", exact: true }).click();
  await reader.locator(".chat-log").click({ position: { x: 5, y: 5 } });
  await press(reader, "y", "y");
  expect(await reader.evaluate(() => (window as unknown as { __clip?: string }).__clip)).toBeUndefined();
});

base("yy in the chat log or on Settings leaves the Page tab beside it alone", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.addInitScript(() => {
    navigator.clipboard.writeText = (text) => {
      (window as unknown as { __clip: string }).__clip = text;
      return Promise.resolve();
    };
  });
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  const clip = () => shell.evaluate(() => (window as unknown as { __clip?: string }).__clip);

  await shell.locator(".nav").getByRole("button", { name: "対話", exact: true }).click();
  await shell.locator(".chat-log").click({ position: { x: 5, y: 5 } });
  await press(shell, "y", "y");
  expect(await clip(), "from the chat log").toBeUndefined();

  await shell.locator(".nav").getByRole("button", { name: "設定", exact: true }).click();
  await shell.locator("main[data-pane='doc']").click({ position: { x: 5, y: 5 } });
  await press(shell, "y", "y");
  expect(await clip(), "from Settings").toBeUndefined();
});

base("a quote from a document window goes to the main window, for the chat there", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.window.doc-1", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/?window=doc-1");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.fromPage("browser-ask", { tab: "k1", quote: "from a pop-out" }));
  const requests = async () =>
    ((await callsOf(shell, "plugin:event|emit_to")) as { event: string; payload: { kind: string; quote?: string } }[])
      .filter((c) => c.event === "main-request" && c.payload.kind === "chat")
      .map((c) => c.payload.quote);
  await expect.poll(requests).toEqual(["from a pop-out"]);
});

base("the main window's quote fills the chat dock once: closed and opened again, it starts empty", async ({ app }) => {
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "chat", scopeKey: "all", quote: "first" }));
  await expect(app.locator("#chat-q")).toHaveValue("> first\n");
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "chat", scopeKey: "all", quote: "second" }));
  await expect(app.locator("#chat-q"), "a draft is kept").toHaveValue("> first\n> second\n");
  await app.getByRole("button", { name: "対話ペインを閉じる" }).click();
  await expect(app.locator(".chat")).toHaveCount(0);
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await expect(app.locator("#chat-q")).toHaveValue("");
});
