// Pop-out windows (G52) over the mock: each window is one page started as `?window=<label>`; what
// crosses windows (the window commands, `emit_to` requests, storage keys) is read from the calls.
import { test, expect, list, callsOf } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const [a, b] = ARTICLES;
const DOC = "lattice.window.doc-1";
const CHAT = "lattice.window.chat";
const row = (page: Page, title: string) => list(page).locator(".row", { hasText: title });
const titles = (page: Page) => page.locator(".dpane").first().getByRole("tab").locator(".tab-t");
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const seed = (page: Page, entries: Record<string, string>) =>
  page.addInitScript((e) => {
    for (const [k, v] of Object.entries(e)) {
      localStorage.setItem(k, v);
    }
  }, entries);
/** The payloads of the `main-request` events this window sent to the main window. */
const requests = async (page: Page) =>
  ((await callsOf(page, "plugin:event|emit_to")) as { target: { label: string }; event: string; payload: unknown }[])
    .filter((c) => c.event === "main-request" && c.target.label === "main")
    .map((c) => c.payload);

test("別ウィンドウで開く moves the tab to a new document window whose layout waits in storage", async ({ app }) => {
  await row(app, a.title!).click();
  await row(app, b.title!).click({ modifiers: ["Control"] });
  await app.getByRole("button", { name: "別ウィンドウで開く" }).click();
  await expect(titles(app)).toHaveText([a.title!]);
  expect(await callsOf(app, "open_window")).toEqual([{ label: "doc-1" }]);
  expect(JSON.parse((await stored(app, DOC))!)).toMatchObject({ root: { kind: "pane", tabs: [{ kind: "reader", articleId: b.id }] } });

  await app.keyboard.press("Control+Shift+N");
  await expect(app.locator(".dpane").first().getByRole("tab")).toHaveCount(0);
  expect((await callsOf(app, "open_window")).map((c) => (c as { label: string }).label)).toEqual(["doc-1", "doc-2"]);
});

test("a document window shows only its tabs, hands one back to the main window, and closes when empty", async ({ shell }) => {
  const layout = {
    root: {
      kind: "pane",
      id: 1,
      tabs: [
        { kind: "reader", id: 2, articleId: a.id },
        { kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" },
      ],
      active: 2,
    },
    focused: 1,
  };
  await seed(shell, { [DOC]: JSON.stringify(layout) });
  await shell.goto("/?window=doc-1");
  await expect(shell.locator(".art-title")).toHaveText(a.title!);
  await expect(shell.locator(".nav, [data-pane='list'], .chat")).toHaveCount(0);
  await expect(shell.getByRole("button", { name: "別ウィンドウで開く" })).toHaveCount(0);
  const reported = async () => (await requests(shell)).filter((r) => (r as { kind: string }).kind === "openDocs").at(-1);
  await expect
    .poll(reported, "its saved articles, for the chat; the page not in the Index is left out")
    .toEqual({ kind: "openDocs", label: "doc-1", docs: [{ id: a.id, title: a.title }] });

  await shell.getByRole("button", { name: "メインウィンドウに戻す" }).click();
  expect((await requests(shell)).filter((r) => !["pageLang", "openDocs"].includes((r as { kind: string }).kind))).toEqual([
    { kind: "open", docs: [{ kind: "reader", articleId: a.id }] },
  ]);
  await expect(titles(shell)).toHaveText(["P"]);
  // The page's webview is attached here, not reloaded: the window asked to open it by its key.
  expect(await callsOf(shell, "browser_open")).toEqual([expect.objectContaining({ tab: "k1", url: "https://example.com/p" })]);

  await shell.keyboard.press("Control+w");
  await expect.poll(() => callsOf(shell, "close_window")).toHaveLength(1);
  expect(await stored(shell, DOC), "not restored at the next start").toBeNull();
  expect(await callsOf(shell, "browser_close"), "a closed tab's webview goes with it").toEqual([{ tab: "k1" }]);
  expect(await reported()).toEqual({ kind: "openDocs", label: "doc-1", docs: [] });
});

test("the main window restores pop-outs at startup, keeps the chat in its window, and opens what comes back", async ({ shell }) => {
  await seed(shell, { [DOC]: JSON.stringify({ root: { kind: "pane", id: 1, tabs: [], active: null }, focused: 1 }), [CHAT]: "1" });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  expect(await callsOf(shell, "open_window")).toEqual(expect.arrayContaining([{ label: "doc-1" }, { label: "chat" }]));

  const chatButton = shell.locator(".nav").getByRole("button", { name: "対話" });
  await expect(chatButton).toHaveAttribute("aria-pressed", "true");
  const chatOpens = async () => (await callsOf(shell, "open_window")).filter((c) => (c as { label: string }).label === "chat").length;
  const before = await chatOpens();
  await chatButton.click();
  await expect(shell.locator(".chat")).toHaveCount(0);
  expect(await chatOpens(), "brought to the front, not docked").toBe(before + 1);

  await shell.evaluate((id) => window.__e2e.emit("main-request", { kind: "open", docs: [{ kind: "reader", articleId: id }] }), b.id);
  await expect(titles(shell)).toHaveText([b.title!]);
  await shell.evaluate(() => window.__e2e.emit("main-request", { kind: "chatDocked" }));
  await expect(shell.locator(".chat")).toBeVisible();
  await expect(shell.getByRole("button", { name: "別ウィンドウで開く" }).last()).toBeVisible();
});

test("the chat dock pops out from its header; the chat window docks back through the main window", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await app.locator(".chat").getByRole("button", { name: "別ウィンドウで開く" }).click();
  await expect(app.locator(".chat")).toHaveCount(0);
  expect(await callsOf(app, "open_window")).toEqual([{ label: "chat" }]);
  expect(await stored(app, CHAT)).toBe("1");
});

test("the chat window is the pane alone; its citations and its close go to the main window", async ({ shell }) => {
  await seed(shell, { [CHAT]: "1" });
  await shell.goto("/?window=chat");
  const q = shell.getByLabel("質問", { exact: true });
  await expect(q).toBeVisible();
  await expect(shell.locator(".dpane, .nav, [data-pane='list']")).toHaveCount(0);
  await shell.evaluate(() => window.__e2e.emit("doc-current", { id: 1, title: "From main" }));
  await expect(shell.getByLabel("質問の範囲").locator("option", { hasText: "From main" })).toHaveCount(1);
  await shell.evaluate(() =>
    window.__e2e.emit("open-docs", [
      { id: 1, title: "From main" },
      { id: 2, title: "From doc-1" },
    ]),
  );
  await expect(shell.getByLabel("質問の範囲").locator("optgroup[label='開いている記事'] option")).toHaveText(["From main", "From doc-1"]);

  await shell.getByRole("button", { name: "メインウィンドウに戻す" }).click();
  const sent = await requests(shell);
  expect(sent[0], "asked for the current article when it started listening").toEqual({ kind: "chatReady" });
  expect(sent.at(-1)).toEqual({ kind: "chatDocked" });
  await expect.poll(() => callsOf(shell, "close_window")).toHaveLength(1);
  expect(await stored(shell, CHAT)).toBeNull();
});

test("closing the chat window only closes it: main does not dock it, and 対話 then opens the dock", async ({ shell }) => {
  await seed(shell, { [CHAT]: "1" });
  await shell.goto("/?window=chat");
  await shell.getByRole("button", { name: "対話ペインを閉じる" }).click();
  await expect.poll(async () => (await requests(shell)).at(-1)).toEqual({ kind: "chatClosed" });
  await expect.poll(() => callsOf(shell, "close_window")).toHaveLength(1);
  expect(await stored(shell, CHAT), "not restored at the next start").toBeNull();

  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await shell.evaluate(() => window.__e2e.emit("main-request", { kind: "chatClosed" }));
  await expect(shell.locator(".chat")).toHaveCount(0);
  const chatButton = shell.locator(".nav").getByRole("button", { name: "対話" });
  await expect(chatButton).toHaveAttribute("aria-pressed", "false");
  await chatButton.click();
  await expect(shell.locator(".chat")).toBeVisible();
});

test("only the main window sends the Page language to the pages; a pop-out takes main's choice instead of resetting it", async ({ shell }) => {
  const layout = { root: { kind: "pane", id: 1, tabs: [{ kind: "page", id: 3, key: "k1", url: "https://example.com/p", title: "P" }], active: 3 }, focused: 1 };
  await seed(shell, { [DOC]: JSON.stringify(layout) });
  await shell.goto("/?window=doc-1");
  const lang = shell.getByRole("group", { name: "このページを翻訳" });
  await expect(lang).toBeVisible();
  expect(
    new Set((await requests(shell)).filter((r) => (r as { kind: string }).kind !== "openDocs").map((r) => JSON.stringify(r))),
    "asked main for its choice on start",
  ).toEqual(new Set(['{"kind":"pageLang"}']));
  // Main answers with its choice (訳文): the pop-out shows it and never turns the shared overlay off.
  await shell.evaluate(() => window.__e2e.emit("page-lang", { mode: "translated", percent: 70 }));
  await expect(lang.getByRole("button", { name: "訳文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await lang.getByRole("button", { name: /混在/ }).click();
  expect(await callsOf(shell, "browser_set_translation"), "the pop-out leaves the overlay config to main").toEqual([]);

  const chat = await shell.context().newPage();
  await chat.goto("/?window=chat");
  await expect(chat.getByLabel("質問", { exact: true })).toBeVisible();
  expect(await callsOf(chat, "browser_set_translation")).toEqual([]);
  await chat.close();
});

test("the main window sends the Page language to the pages, and a choice made in a pop-out", async ({ app }) => {
  await expect.poll(() => callsOf(app, "browser_set_translation")).toContainEqual(expect.objectContaining({ enabled: false }));
  await app.evaluate(() => window.__e2e.emit("page-lang", { mode: "translated", percent: 70 }));
  await expect.poll(async () => (await callsOf(app, "browser_set_translation")).at(-1)).toMatchObject({ enabled: true, percent: 100 });
});
