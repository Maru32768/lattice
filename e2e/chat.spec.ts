import { test, expect, callsOf, chatScope, list, navItem, pickScope, scopeDialog } from "./harness.ts";
import { ARTICLES } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const section = (app: Page, title: string) =>
  app
    .getByRole("navigation", { name: "設定カテゴリ" })
    .locator(".ni")
    .filter({ has: app.locator(".label").getByText(title, { exact: true }) });
const askedScopes = async (app: Page) => (await callsOf(app, "chat_ask")).map((x) => (x as { scope: unknown }).scope);
/** Opens the chat scope again until `check` passes: an open list holds the scopes it opened with. */
const openScopeUntil = (app: Page, check: () => Promise<void>) =>
  expect(async () => {
    if (await scopeDialog(app).isVisible()) {
      await app.keyboard.press("Escape");
    }
    await chatScope(app).click();
    await check();
  }).toPass();
const setSize = async (app: Page) => Number(await scopeDialog(app).getByRole("option").first().getAttribute("aria-setsize"));

test("the chat budget sends the setting and keeps it when the section is reopened", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  const budget = app.getByLabel("対話で使う範囲");
  await expect(budget).toHaveValue("standard");
  await budget.selectOption({ label: "多め(約15万字)" });
  expect(await callsOf(app, "set_chat_budget")).toEqual([{ budget: "large" }]);

  await section(app, "翻訳").click();
  await section(app, "要約・対話").click();
  await expect(app.getByLabel("対話で使う範囲")).toHaveValue("large");
});

test("with 1行ならEnter, Enter sends a one-line question; once it has two lines Enter is a newline and Ctrl+Enter sends", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "要約・対話").click();
  const sendKey = app.getByLabel("送信キー");
  await expect(sendKey).toHaveValue("ctrlEnter");
  await sendKey.selectOption({ label: "1行ならEnter、2行以上ならCtrl+Enterで送信" });
  await app.keyboard.press("Escape");

  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = app.getByLabel("質問", { exact: true });
  const asked = async () => (await callsOf(app, "chat_ask")).map((a) => (a as { question: string }).question);
  await q.fill("one line");
  await q.press("Enter");
  await expect.poll(asked).toEqual(["one line"]);
  await expect(q).toHaveValue("");

  await q.pressSequentially("first");
  await q.press("Shift+Enter");
  await q.pressSequentially("second");
  await q.press("Enter");
  await expect(q).toHaveValue("first\nsecond\n");
  expect(await asked()).toEqual(["one line"]);
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual(["one line", "first\nsecond"]);
});

test("Vim with Enter as the send key: insert-mode Enter is a new line, normal-mode Enter sends, a count keeps it Vim's", async ({ shell }) => {
  await shell.addInitScript(() => {
    localStorage.setItem("lattice.chatVim", "on");
    localStorage.setItem("lattice.chatSendKey", "enter");
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = shell.getByRole("textbox", { name: "質問", exact: true });
  await q.click();
  const asked = async () => (await callsOf(shell, "chat_ask")).map((a) => (a as { question: string }).question);
  await shell.keyboard.type("first");
  await shell.keyboard.press("Enter");
  await shell.keyboard.type("second");
  await expect(q).toHaveText("firstsecond");
  expect(await asked()).toEqual([]);
  await shell.keyboard.press("Escape");
  await shell.keyboard.press("2");
  await shell.keyboard.press("Enter");
  expect(await asked(), "a count makes Enter Vim's <CR>").toEqual([]);
  await shell.keyboard.press("Enter");
  await expect.poll(asked).toEqual(["first\nsecond"]);
});

test("Vim keys in the chat input: off by default, modes, motions, edits, undo, Ctrl+Enter sends", async ({ app }) => {
  const chatButton = app.locator(".nav").getByRole("button", { name: "対話" });
  await chatButton.click();
  const plain = app.getByLabel("質問", { exact: true });
  await plain.fill("plain");
  await plain.press("Escape");
  await expect(app.locator(".vim-mode")).toHaveCount(0);

  await app.locator(".nav").getByRole("button", { name: "設定" }).click();
  await section(app, "Vim").click();
  await app.getByLabel("対話の入力欄とメモでVimキーバインドを使う").check();
  await app.keyboard.press("Escape");

  // What the textarea held goes on in the editor.
  const q = app.getByRole("textbox", { name: "質問", exact: true });
  await expect(q).toHaveText("plain");
  await q.focus();
  const mode = app.locator(".chat-f-row .vim-mode");
  await expect(mode).toHaveText("INSERT");
  await app.keyboard.press("Control+a");
  await app.keyboard.press("Control+a");
  await app.keyboard.press("Backspace");
  await app.keyboard.type("hello big world");
  await expect(q).toHaveText("hello big world");
  await app.keyboard.press("Escape");
  await expect(mode).toHaveText("NORMAL");
  await expect(app.locator(".cm-fat-cursor"), "block cursor").toHaveCount(1);
  await app.keyboard.type("zq");
  await expect(q, "normal mode does not type").toHaveText("hello big world");
  await expect(mode).toHaveText("NORMAL");

  await app.keyboard.type("bb");
  await app.keyboard.press("d");
  await expect(mode).toHaveText("NORMAL d");
  await app.keyboard.press("w");
  await expect(q).toHaveText("hello world");
  await app.keyboard.press("u");
  await expect(q).toHaveText("hello big world");
  await app.keyboard.type("0cwhi");
  await expect(mode).toHaveText("INSERT");
  await app.keyboard.press("Escape");
  await app.keyboard.type("A!");
  await expect(q).toHaveText("hi big world!");
  await app.keyboard.press("Escape");

  await app.keyboard.press("Control+Enter");
  await expect.poll(async () => (await callsOf(app, "chat_ask")).map((a) => (a as { question: string }).question)).toEqual(["hi big world!"]);
  await expect(app.locator(".chat-f .cm-placeholder"), "the sent question is gone").toBeVisible();
  await expect(mode, "a sent question starts the next one in insert mode").toHaveText("INSERT");
  await expect(q, "the next question can be typed right away").toBeFocused();
});

test("the chat scope offers each open article and all of them, and follows the tabs", async ({ app }) => {
  const [a, b, c] = ARTICLES;
  await list(app).locator(".row", { hasText: a.title! }).click();
  await list(app)
    .locator(".row", { hasText: b.title! })
    .click({ modifiers: ["Control"] });
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const options = picker.getByRole("option");
  const named = (title: string) => picker.getByRole("option", { name: title, exact: true });
  await scope.click();
  await expect(options).toContainText(["この記事(", "開いている記事すべて(2件)", "全記事", a.title!, b.title!]);
  await expect(named("開いている記事すべて(2件)")).toBeEnabled();

  // A document window reports its tabs to the main window.
  await app.evaluate((d) => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [d] }), { id: c.id, title: c.title! });
  await openScopeUntil(app, () => expect(options).toContainText(["開いている記事すべて(3件)", "全記事", a.title!, b.title!, c.title!], { timeout: 1000 }));
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("すべて(3");
  await app.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(scope).toHaveText("開いている記事すべて(3件)");
  await expect(scope, "the keyboard is back on the chip").toBeFocused();
  const q = app.locator("#chat-q");
  await q.fill("共通点は？");
  await q.press("Control+Enter");
  await expect.poll(() => askedScopes(app)).toEqual([{ kind: "articles", ids: [a.id, b.id, c.id] }]);

  // One of them, until its tab closes: then the scope widens to what is still open.
  await pickScope(app, b.title!);
  await expect(scope).toHaveText(b.title!);
  await app.getByRole("button", { name: `${b.title}を閉じる` }).click();
  await expect(scope).toHaveText("開いている記事すべて(2件)");
  await scope.click();
  await expect(options).toContainText(["全記事", a.title!, c.title!]);
  await expect(named(b.title!)).toHaveCount(0);
  await app.evaluate(() => window.__e2e.emit("main-request", { kind: "openDocs", label: "doc-1", docs: [] }));
  await openScopeUntil(app, async () => {
    await expect(named(a.title!)).toHaveCount(1, { timeout: 1000 });
    await expect(named(c.title!)).toHaveCount(0, { timeout: 1000 });
  });
});

test("in the chat scope the arrows pass over headings and disabled options, a search narrows and marks, and Esc closes", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const search = picker.getByRole("combobox", { name: "範囲を検索" });
  const options = picker.getByRole("option");
  const active = picker.locator("[role=option].act");
  await scope.focus();
  await app.keyboard.press("ArrowDown");
  await expect(search, "the search takes the keyboard").toBeFocused();
  await expect(picker.getByRole("option", { name: "この記事(記事を開いていません)" }), "listed, as the select did").toBeDisabled();
  await expect(picker.getByRole("option", { name: "開いている記事すべて(0件)" })).toBeDisabled();
  await expect(active, "it opens on the scope in use").toHaveAccessibleName("全記事");
  await expect(search).toHaveAttribute("aria-activedescendant", (await active.getAttribute("id"))!);

  await app.keyboard.press("ArrowUp");
  await expect(active, "nothing above it can be picked").toHaveAccessibleName("全記事");
  await app.keyboard.press("ArrowDown");
  await expect(active, "past the グループ heading").toHaveAccessibleName(/^MVCC調査\(/);
  await app.keyboard.press("ArrowUp");
  await expect(active).toHaveAccessibleName("全記事");
  await picker.getByRole("option", { name: "この記事(記事を開いていません)" }).click({ force: true });
  await expect(search, "a click on an option leaves the keyboard in the search").toBeFocused();
  await expect(active, "the pointer on a disabled option leaves the highlight where it was").toHaveAccessibleName("全記事");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(picker, "neither a disabled option nor the Enter that ends a conversion picks").toBeVisible();

  await picker.getByText("グループ", { exact: true }).click();
  await expect(search, "a click on a heading leaves the keyboard in the search").toBeFocused();

  await search.fill("KAF");
  await expect(options).toHaveText([`#kafka(${ARTICLES.filter((x) => x.tags.includes("kafka")).length}件)`]);
  await expect(picker.locator("mark")).toHaveText("kaf");
  await expect(picker.getByText("タグ", { exact: true })).toBeVisible();
  await expect(picker.getByText("グループ", { exact: true }), "a section with no match goes").toHaveCount(0);
  const box = (await search.boundingBox())!;
  await search.click({ position: { x: 1, y: box.height / 2 } });
  await app.keyboard.type("#");
  await expect(search, "a click in the search puts the caret where it lands").toHaveValue("#KAF");
  await search.dblclick();
  expect(await search.evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd]), "a double click selects a word").toEqual([1, 4]);
  await search.fill("no such scope");
  await expect(options).toHaveCount(0);
  await expect(picker.getByText("該当なし")).toBeVisible();
  await picker.getByText("該当なし").click();
  await picker.locator(".pv-head").click({ position: { x: 3, y: 3 } });
  await app.keyboard.type("!");
  await expect(search, "a click on the popover itself leaves the keyboard in the search").toHaveValue("no such scope!");

  await app.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(scope).toBeFocused();
  await expect(scope).toHaveText("全記事");
  await app.keyboard.press("Enter");
  await expect(search, "each opening starts a new search").toHaveValue("");
});

test("in the chat scope the mouse moves the highlight but never the list, nor takes it from the keys", async ({ app }) => {
  const id = ARTICLES.at(-1)!.id;
  await app.evaluate(async (id) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await Promise.all(Array.from({ length: 200 }, (_, i) => invoke("add_tag", { id, name: `zz-${String(i).padStart(4, "0")}` })));
    await window.__e2e.emit("article-changed", id);
  }, id);
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await openScopeUntil(app, async () => expect(await setSize(app)).toBeGreaterThan(200));
  const picker = scopeDialog(app);
  const listbox = picker.getByRole("listbox", { name: "質問の範囲" });
  const active = picker.locator("[role=option].act");

  // A row cut by the top edge: scrolling it into view would move the list.
  const box = (await listbox.boundingBox())!;
  await app.mouse.move(box.x + 60, box.y + 200);
  await app.mouse.wheel(0, 135);
  await expect.poll(() => listbox.evaluate((e) => e.scrollTop)).toBe(135);
  const cut = await app.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=option]:not([aria-disabled])")?.textContent ?? null, {
    x: box.x + 60,
    y: box.y + 3,
  });
  expect(cut, "an enabled option cut by the top edge").not.toBeNull();
  await app.mouse.move(box.x + 60, box.y + 3, { steps: 3 });
  await expect(active).toHaveText(cut!);
  await app.waitForTimeout(300);
  expect(await listbox.evaluate((e) => e.scrollTop)).toBe(135);

  // Rows the keys scroll under a still pointer do not take the highlight back.
  await listbox.evaluate((e) => (e.scrollTop = 0));
  await picker.getByRole("option", { name: "全記事", exact: true }).hover();
  await expect(active).toHaveAccessibleName("全記事");
  for (let i = 0; i < 20; i++) {
    await app.keyboard.press("ArrowDown");
    await app.waitForTimeout(50);
  }
  await app.waitForTimeout(300);
  expect(await active.getAttribute("aria-posinset"), "20 options on from 全記事, the 3rd").toBe("23");
});

test("an open scope list holds still while the library changes, and lists the change from its next opening", async ({ app }) => {
  const tag = (ids: number[], name: string) =>
    app.evaluate(
      async ({ ids, name }) => {
        const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
        for (const id of ids) {
          await invoke("add_tag", { id, name });
        }
        await window.__e2e.emit("article-changed", ids[0]);
      },
      { ids, name },
    );
  await tag([ARTICLES[0].id], "solo");
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const picker = scopeDialog(app);
  await openScopeUntil(app, async () => {
    await picker.getByRole("combobox", { name: "範囲を検索" }).fill("solo");
    await expect(picker.getByRole("option", { name: "#solo(1件)" })).toHaveCount(1, { timeout: 1000 });
  });
  await app.keyboard.press("Escape");
  await pickScope(app, "#solo(1件)");
  const active = picker.locator("[role=option].act");
  await chatScope(app).click();
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("#");
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("ArrowDown");
  const chosen = (await active.textContent())!;
  const at = await active.getAttribute("aria-posinset");
  const size = await setSize(app);

  // A tag on every article would list first (the mock sorts tags by count), and #solo gains an article.
  await tag(
    ARTICLES.map((a) => a.id),
    "everywhere",
  );
  await tag([ARTICLES[1].id], "solo");
  await expect(chatScope(app), "the chip shows the change").toHaveText("#solo(2件)");
  await expect(picker.getByRole("option", { name: /^#everywhere/ })).toHaveCount(0);
  expect(await setSize(app)).toBe(size);
  await expect(active).toHaveText(chosen);
  await expect(active).toHaveAttribute("aria-posinset", at!);
  await app.keyboard.press("Enter");
  await expect(chatScope(app)).toHaveText(chosen);

  await chatScope(app).click();
  await expect(picker.getByRole("option", { name: /^#everywhere/ })).toHaveCount(1);
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("solo");
  await expect(picker.getByRole("option", { name: "#solo(2件)" })).toHaveCount(1);
});

test("a failed library read leaves the chat scope loading until the other reads are in", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eHold = ["list_tags"];
    window.__e2eFail = ["list_genres"];
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await expect(shell.getByRole("alert"), "the failed read is reported").toContainText("list_genres failed");
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  await chatScope(shell).click();
  const picker = scopeDialog(shell);
  await expect(picker.getByText("読み込み中…")).toBeVisible();
  await shell.evaluate(() => window.__e2e.release("list_tags"));
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("kafka");
  await expect(picker.getByRole("option", { name: /^#kafka/ }), "the tags that came in after the failure").toHaveCount(1);
});

test("a scope picked from the open list after it left the library is the one the chip names and the question asks over", async ({ app }) => {
  const id = ARTICLES[0].id;
  const solo = (cmd: "add_tag" | "remove_tag") =>
    app.evaluate(
      async ({ cmd, id }) => {
        const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
        await invoke(cmd, { id, name: "solo" });
        await window.__e2e.emit("article-changed", id);
      },
      { cmd, id },
    );
  await solo("add_tag");
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const picker = scopeDialog(app);
  const option = picker.getByRole("option", { name: "#solo(1件)" });
  await openScopeUntil(app, async () => {
    await picker.getByRole("combobox", { name: "範囲を検索" }).fill("solo");
    await expect(option).toHaveCount(1, { timeout: 1000 });
  });
  const reads = (await callsOf(app, "list_tags")).length;
  await solo("remove_tag");
  await expect.poll(async () => (await callsOf(app, "list_tags")).length).toBeGreaterThan(reads);
  await app.waitForTimeout(300);
  await expect(option, "still listed while open").toHaveCount(1);
  await app.keyboard.press("Enter");
  await expect(chatScope(app)).toHaveText("#solo(1件)");
  const q = app.locator("#chat-q");
  await q.fill("これは？");
  await q.press("Control+Enter");
  await expect.poll(() => askedScopes(app)).toEqual([{ kind: "filter", filter: { kind: "tag", name: "solo" } }]);
});

test("the chat scope says it is loading until the library has, with the search taking what is typed", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eHold = ["list_tags"];
  });
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  await expect(chatScope(shell), "the chip names the scope meanwhile").toHaveText("全記事");
  await chatScope(shell).click();
  const picker = scopeDialog(shell);
  const search = picker.getByRole("combobox", { name: "範囲を検索" });
  await expect(picker.getByText("読み込み中…")).toBeVisible();
  await expect(picker.getByRole("option")).toHaveCount(0);
  await expect(search).toBeFocused();
  await shell.keyboard.type("kaf");
  await shell.evaluate(() => window.__e2e.release("list_tags"));
  const active = picker.locator("[role=option].act");
  await expect(active).toHaveAccessibleName(/kafka/i);
  await shell.keyboard.press("Enter");
  await expect(chatScope(shell)).toHaveText(/kafka/i);
});

test("a scope the user picked stays when an article opens", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  await pickScope(app, "全記事");
  await list(app).locator(".row", { hasText: ARTICLES[0].title! }).click();
  await expect(app.getByRole("button", { name: `${ARTICLES[0].title}を閉じる` })).toBeVisible();
  await expect(chatScope(app)).toHaveText("全記事");
});

test("a scope chosen from outside shows on the chip, and one the list no longer offers keeps its name", async ({ app }) => {
  await app.keyboard.press("Control+p");
  await app.keyboard.type("kafka");
  await app.getByRole("dialog", { name: "コマンドパレット" }).getByRole("option", { name: "タグkafkaを範囲に対話を始める" }).click();
  const scope = chatScope(app);
  await expect(scope).toHaveText(`#kafka(${ARTICLES.filter((x) => x.tags.includes("kafka")).length}件)`);

  await navItem(app, "未読").click();
  await pickScope(app, "現在の一覧: 未読");
  await navItem(app, "すべての記事").click();
  await expect(scope).toHaveText("現在の一覧: 未読");
  await scope.click();
  await expect(scopeDialog(app).getByRole("option", { name: "全記事", exact: true })).toBeVisible();
  await expect(scopeDialog(app).getByRole("option", { name: "現在の一覧: 未読" }), "no longer offered").toHaveCount(0);
  await app.keyboard.press("Escape");
  const q = app.locator("#chat-q");
  await q.fill("未読の要点は？");
  await q.press("Control+Enter");
  await expect.poll(() => askedScopes(app)).toEqual([{ kind: "filter", filter: { kind: "unread" } }]);
});

test("the chat scope lists thousands of tags while drawing only the ones in view, and reaches the last by search", async ({ app }) => {
  const id = ARTICLES.at(-1)!.id;
  const last = await app.evaluate(async (id) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    await Promise.all(Array.from({ length: 2000 }, (_, i) => invoke("add_tag", { id, name: `zz-${String(i).padStart(4, "0")}` })));
    await window.__e2e.emit("article-changed", id);
    return ((await invoke("list_tags")) as { name: string }[]).at(-1)!.name;
  }, id);
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const scope = chatScope(app);
  const picker = scopeDialog(app);
  const options = picker.getByRole("option");
  const active = picker.locator("[role=option].act");
  await openScopeUntil(app, async () => expect(await setSize(app), "every tag is an option").toBeGreaterThan(2000));
  expect(await options.count()).toBeLessThan(60);

  for (let i = 0; i < 15; i++) {
    await app.keyboard.press("ArrowDown");
  }
  await expect(active).toBeInViewport();
  for (let i = 0; i < 20; i++) {
    await app.keyboard.press("PageDown");
  }
  await expect(active).toBeInViewport();
  expect(Number(await active.getAttribute("aria-posinset"))).toBeGreaterThan(200);
  expect(await options.count()).toBeLessThan(60);
  const down = Number(await active.getAttribute("aria-posinset"));
  await app.keyboard.press("PageUp");
  await expect.poll(async () => Number(await active.getAttribute("aria-posinset")), "PageUp goes back a page").toBeLessThan(down - 6);

  // A new search, many matches, from far down the list: its first match is in view, and Enter would pick what is shown.
  await picker.getByRole("combobox", { name: "範囲を検索" }).fill("zz-");
  await expect(active).toHaveAccessibleName("#zz-0000(1件)");
  await expect(active).toBeInViewport();

  await picker.getByRole("combobox", { name: "範囲を検索" }).fill(last);
  await app.keyboard.press("Enter");
  await expect(scope).toHaveText(`#${last}(1件)`);
  await scope.click();
  await expect(active, "it opens on the scope in use, far down the list").toHaveAccessibleName(`#${last}(1件)`);
  await expect(active).toBeInViewport();
  await app.keyboard.press("Escape");
  const q = app.locator("#chat-q");
  await q.fill("これは？");
  await q.press("Control+Enter");
  await expect.poll(() => askedScopes(app)).toEqual([{ kind: "filter", filter: { kind: "tag", name: last } }]);
});

/** Opens the chat's AI menu and picks `pick`, from the submenus `path` names. */
async function chooseAI(app: Page, path: (string | RegExp)[], pick: string) {
  await app.getByRole("button", { name: "回答するAI" }).click();
  for (const name of path) {
    await app.getByRole("menuitem", { name, exact: true }).click();
  }
  const radio = app.getByRole("menuitemradio", { name: pick, exact: true });
  // The submenus open to the left, over the parent's items: a pointer that jumps there in one step closes them, one moved by hand does not.
  const b = (await radio.boundingBox())!;
  await app.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await radio.click();
}

test("at the pane's narrowest, the send row fits Vim's mode, a long model ID and the AI with its effort", async ({ shell }) => {
  await shell.addInitScript(() => localStorage.setItem("lattice.chatVim", "on"));
  await shell.goto("/");
  await expect(list(shell).locator(".row").first()).toBeVisible({ timeout: 30_000 });
  await shell.locator(".nav").getByRole("button", { name: "対話" }).click();
  await shell.locator(".chat").evaluate((e) => (e.style.width = "320px"));
  await chooseAI(shell, ["Anthropic API"], "その他(モデルIDを入力)");
  await shell.getByLabel("回答するモデルのID").fill("claude-a-very-long-model-id-that-does-not-fit");
  await chooseAI(shell, [/^effort/], "max");
  const row = shell.locator(".chat-f-row");
  expect(await row.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0);
  const send = (await row.getByRole("button", { name: "送信" }).boundingBox())!;
  const box = (await row.boundingBox())!;
  expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width);
});

test("Enter in the model ID box keeps the drafted question", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = app.locator("#chat-q");
  await q.fill("draft question");
  await chooseAI(app, ["Claude CLI"], "その他(モデルIDを入力)");
  const modelId = app.getByLabel("回答するモデルのID");
  await modelId.fill("my-model");
  await modelId.press("Enter");
  await expect(q).toHaveValue("draft question");
  expect(await callsOf(app, "chat_ask")).toEqual([]);
});

test("opening a conversation on a custom model leaves the keyboard where it was", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const q = app.locator("#chat-q");
  await chooseAI(app, ["Claude CLI"], "その他(モデルIDを入力)");
  await app.getByLabel("回答するモデルのID").fill("my-model");
  await q.fill("WALとは？");
  await q.press("Control+Enter");
  await expect.poll(async () => (await callsOf(app, "chat_ask")).length).toBe(1);
  await app.getByRole("button", { name: "新しい会話" }).click();
  const pick = app.getByRole("button", { name: "会話を選ぶ" });
  await pick.click();
  await app.getByRole("menuitemradio", { name: "WALとは？" }).click();
  await expect(app.getByLabel("回答するモデルのID")).toHaveValue("my-model");
  await expect(pick, "focus goes back to the menu's button").toBeFocused();
});

test("each conversation asks the AI chosen for it, and opening it again brings the choice back", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "対話" }).click();
  const ai = app.getByRole("button", { name: "回答するAI" });
  const modelId = app.getByLabel("回答するモデルのID");
  const radio = (name: string) => app.getByRole("menuitemradio", { name, exact: true });
  const choose = (path: (string | RegExp)[], pick: string) => chooseAI(app, path, pick);
  const asked = async () => (await callsOf(app, "chat_ask")).map((x) => (x as { llm: unknown }).llm);
  const q = app.locator("#chat-q");
  const pickThread = async (title: string) => {
    await app.getByRole("button", { name: "会話を選ぶ" }).click();
    await app.getByRole("menuitemradio", { name: title }).click();
  };
  await expect(ai, "it sits beside 送信").toHaveText("既定のAI");
  await ai.click();
  await expect(app.getByRole("menuitem", { name: /^effort/ }), "the providers in Settings set their own efforts").toHaveCount(0);
  await app.keyboard.press("Escape");

  await choose(["Claude CLI"], "その他(モデルIDを入力)");
  await expect(modelId, "the ID can be typed right away").toBeFocused();
  await modelId.fill(" claude-opus-5-5 ");
  await choose([/^effort/], "max");
  await q.fill("WALとは？");
  await q.press("Control+Enter");
  const opus = { kind: "claude_cli", model: "claude-opus-5-5", effort: "max" };
  await expect.poll(asked).toEqual([opus]);
  await expect(app.locator(".chat .answer-meta")).toContainText("claude-opus-5-5");

  // A new conversation starts on the default; a saved one brings back what it chose.
  await app.getByRole("button", { name: "新しい会話" }).click();
  await expect(ai).toHaveText("既定のAI");
  await expect(modelId).toHaveCount(0);
  await pickThread("Kafkaのexactly-once");
  await expect(ai).toHaveText("Anthropic API · claude-haiku-5-5 · low");
  await ai.click();
  await app.getByRole("menuitem", { name: "Anthropic API", exact: true }).click();
  await expect(radio("claude-haiku-5-5(速い・安い)"), "the menu marks the model").toHaveAttribute("aria-checked", "true");
  await expect(radio("既定(claude-opus-5-5)")).toHaveAttribute("aria-checked", "false");
  await expect(radio("その他(モデルIDを入力)")).toHaveAttribute("aria-checked", "false");
  await app.keyboard.press("Escape");
  await ai.click();
  await app.getByRole("menuitem", { name: /^effort/ }).click();
  await expect(radio("low"), "and the effort").toHaveAttribute("aria-checked", "true");
  await expect(radio("モデルの既定")).toHaveAttribute("aria-checked", "false");
  await app.keyboard.press("Escape");
  await pickThread("WALとは？");
  await expect(modelId).toHaveValue("claude-opus-5-5");
  await expect(ai).toHaveText("Claude CLI · claude-opus-5-5 · max");
  await ai.click();
  await app.getByRole("menuitem", { name: "Claude CLI", exact: true }).click();
  await expect(radio("その他(モデルIDを入力)"), "the menu marks the choice").toHaveAttribute("aria-checked", "true");
  await app.keyboard.press("Escape");
  await app.keyboard.press("Escape");

  // Another provider starts on its own defaults and offers only the efforts it takes.
  await choose(["Gemini API"], "その他(モデルIDを入力)");
  await expect(modelId, "the ID typed for Claude CLI stays with it").toHaveValue("");
  await expect(ai).toHaveText("Gemini API");
  await ai.click();
  await app.getByRole("menuitem", { name: "Gemini API", exact: true }).click();
  await expect(radio("その他(モデルIDを入力)")).toHaveAttribute("aria-checked", "true");
  await expect(radio("既定(gemini-flash-latest)"), "an empty ID is not the default model").toHaveAttribute("aria-checked", "false");
  await app.keyboard.press("Escape");
  await choose(["Gemini API"], "既定(gemini-flash-latest)");
  await expect(ai).toHaveText("Gemini API");
  await expect(modelId).toHaveCount(0);
  await ai.click();
  await app.getByRole("menuitem", { name: /^effort/ }).click();
  await expect(app.getByRole("menu", { name: /^effort/ }).getByRole("menuitemradio")).toHaveCount(4);
  await app.keyboard.press("Escape");
  await app.keyboard.press("Escape");
  // A conversation saved on the default opens on it; a change that was never sent is gone.
  await pickThread("MVCCとVACUUMの関係");
  await expect(ai).toHaveText("既定のAI");
  await pickThread("WALとは？");
  await expect(ai).toHaveText("Claude CLI · claude-opus-5-5 · max");

  await choose([], "既定(設定のAIプロバイダ)");
  await expect(modelId).toHaveCount(0);
  await q.fill("続き");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null]);

  // A provider left on its defaults is asked with them, and a follow-up asks it again without touching the menu.
  await app.getByRole("button", { name: "新しい会話" }).click();
  await choose(["Gemini API"], "既定(gemini-flash-latest)");
  await q.fill("MVCCとは？");
  await q.press("Control+Enter");
  const gemini = { kind: "gemini", model: null, effort: null };
  await expect.poll(asked).toEqual([opus, null, gemini]);
  await expect(ai).toHaveText("Gemini API");
  await q.fill("VACUUMは？");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null, gemini, gemini]);
  // Picking a model keeps the effort picked before it, and a follow-up asks that pair again, not the defaults.
  await choose([/^effort/], "high");
  await choose(["Gemini API"], "gemini-pro-latest");
  await expect(ai).toHaveText("Gemini API · gemini-pro-latest · high");
  await q.fill("続き");
  await q.press("Control+Enter");
  const pro = { kind: "gemini", model: "gemini-pro-latest", effort: "high" };
  await expect.poll(asked).toEqual([opus, null, gemini, gemini, pro]);
  await q.fill("もう一度");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null, gemini, gemini, pro, pro]);
  await choose([/^effort/], "モデルの既定");
  await expect(ai).toHaveText("Gemini API · gemini-pro-latest");
  await q.fill("既定で");
  await q.press("Control+Enter");
  await expect.poll(asked).toEqual([opus, null, gemini, gemini, pro, pro, { ...pro, effort: null }]);
});

/** `chat_ask` waits for `failSend()`, so what the user does while a send is under way can be tried. */
const holdSends = (page: Page) =>
  page.evaluate(() => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke }; failSend: () => void };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args, options) =>
      cmd === "chat_ask" ? new Promise((_, reject) => (w.failSend = () => reject(new Error("no provider")))) : invoke(cmd, args, options);
  });
const failSend = (page: Page) => page.evaluate(() => (window as unknown as { failSend: () => void }).failSend());

for (const vim of [false, true]) {
  const editor = vim ? "Vim" : "textarea";
  const openChat = async (page: Page) => {
    await page.addInitScript((on) => {
      if (on) {
        localStorage.setItem("lattice.chatVim", "on");
      }
    }, vim);
    await page.goto("/");
    await expect(list(page).locator(".row").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".nav").getByRole("button", { name: "対話" }).click();
    const input = page.getByRole("textbox", { name: "質問", exact: true });
    await input.click();
    await holdSends(page);
    return input;
  };
  const hasText = (input: Locator, text: string) => (vim ? expect(input).toHaveText(text) : expect(input).toHaveValue(text));
  const send = (page: Page) => page.keyboard.press("Control+Enter");

  test(`${editor}: a failed send puts its question back in an empty input, with the keyboard where it is`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.keyboard.press("Control+h");
    await expect(input).not.toBeFocused();
    const elsewhere = () => shell.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane"));
    const before = await elsewhere();

    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "will fail");
    await expect(input, "a late failure takes no keyboard").not.toBeFocused();
    expect(await elsewhere()).toBe(before);
  });

  test(`${editor}: a failed send with the keyboard in the input keeps it there`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "will fail");
    await expect(input).toBeFocused();
    await shell.keyboard.type(" again");
    await hasText(input, "will fail again");
  });

  test(`${editor}: a failed send leaves a draft typed since, and its question stays readable in the log`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.keyboard.type("next thought");
    await hasText(input, "next thought");

    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, "next thought");
    await expect(shell.locator(".chat-log .question")).toHaveText("will fail");
    await expect(input).toBeFocused();
    await shell.keyboard.type("!");
    await hasText(input, "next thought!");

    await holdSends(shell);
    await send(shell);
    await expect(shell.locator(".chat-log .question"), "the next send clears it").toHaveText("next thought!");
    await failSend(shell);
  });

  test(`${editor}: a failed send leaves a quote received since`, async ({ shell }) => {
    const input = await openChat(shell);
    await shell.keyboard.type("will fail");
    await send(shell);
    await expect(shell.locator(".pending")).toBeVisible();
    await shell.evaluate(() => window.__e2e.emit("main-request", { kind: "chat", scopeKey: "all", quote: "quoted" }));
    await hasText(input, vim ? "> quoted" : "> quoted\n");
    await failSend(shell);
    await expect(shell.getByRole("alert")).toBeVisible();
    await hasText(input, vim ? "> quoted" : "> quoted\n");
  });
}
