// Moving around a document by keys: the Reader's host of the controller the page overlay also runs.
import { test as base, expect, callsOf, list, listRow } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const order = [...ARTICLES].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id);
const label = (i: number) => order[i].title ?? order[i].original_url;

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

const PAGE_LAYOUT = {
  root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 },
  focused: 1,
};

base("the second key of a chord that reached the app runs in the page, and the page gets the keyboard back", async ({ shell }) => {
  await shell.addInitScript((l) => localStorage.setItem("lattice.layout", l), JSON.stringify(PAGE_LAYOUT));
  await shell.goto("/");
  await expect(shell.locator(".page-host")).toBeVisible();
  await shell.evaluate(() => window.__e2e.emit("browser-key", { tab: "k1", key: "G", count: 1 }));
  await expect(shell.locator(".prefix-hint")).toBeVisible();
  const focused = (await callsOf(shell, "browser_focus")).length;
  await shell.keyboard.press("g");
  await expect.poll(() => callsOf(shell, "browser_run_doc")).toEqual([{ key: "k1", action: "docTop", count: 1 }]);
  await expect.poll(async () => (await callsOf(shell, "browser_focus")).length).toBeGreaterThan(focused);
  await expect(shell.locator(".prefix-hint")).toBeHidden();
});
