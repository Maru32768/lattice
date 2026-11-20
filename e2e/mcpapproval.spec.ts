// A deletion an agent asks for over MCP, put to the user in the main window (design-review §23).
import type { Locator, Page } from "@playwright/test";
import { test, expect, callsOf, openPage } from "./harness.ts";
import { NOW } from "./fixtures.ts";
import type { McpApproval } from "../src/api.ts";

async function ask(app: Page, waiting: McpApproval[]) {
  await app.evaluate((w) => {
    window.__e2e.mcpApprovals(w);
    void window.__e2e.emit("mcp-approval");
  }, waiting);
}

const article = (id: number, title: string | null, url: string, inMs = 90_000): McpApproval => ({
  id,
  registration: "Claude Code",
  deletion: { kind: "article", title, url },
  deadline_ms: NOW + inMs,
});

const dialogOf = (app: Page) => app.getByRole("alertdialog", { name: "AIエージェントに削除を許可しますか？" });

test("an agent's deletion waits for the user, oldest first, and a double-click allows only the first", async ({ app }) => {
  // Three, so the line saying how many more wait stays and the next request's Allow comes up where the first one was.
  await ask(app, [
    article(1, "Rust ‮gnp.exe", "https://example.com/a"),
    article(2, "Second", "https://example.com/b"),
    article(3, "Third", "https://example.com/c"),
  ]);
  const dialog = dialogOf(app);
  await expect(dialog).toContainText("登録「Claude Code」のエージェントが、MCPで次を削除しようとしています。");
  await expect(dialog.locator("bdi"), "each name apart from the text around it").toHaveText(["Rust ‮gnp.exe", "https://example.com/a"]);
  await expect(dialog).toContainText("元に戻せません");
  await expect(dialog).toContainText("答えなければ、90秒後に拒否します。");
  await expect(dialog).toContainText("ほかに2件が待っています。");
  await expect(dialog.getByRole("button", { name: "拒否" }), "a stray Enter denies").toBeFocused();

  const allow = dialog.getByRole("button", { name: "削除を許可" });
  await expect(allow).toBeEnabled();
  // A person's double-click, the pointer still: two clicks some 200 ms apart, the second on the next request's button.
  const box = (await allow.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await app.mouse.click(x, y);
  await expect(dialog.locator("bdi")).toHaveText(["Second", "https://example.com/b"]);
  const next = (await allow.boundingBox())!;
  expect(x > next.x && x < next.x + next.width && y > next.y && y < next.y + next.height, "the second click lands on the next request's Allow").toBe(true);
  await app.waitForTimeout(200);
  await app.mouse.click(x, y);
  await expect(allow, "armed a moment after it shows").toBeEnabled();
  expect(await callsOf(app, "mcp_answer"), "the second click fell on the next request before it could be allowed").toEqual([{ id: 1, allow: true }]);
  await expect(dialog).toContainText("ほかに1件が待っています。");
  await app.keyboard.press("Escape");
  await expect(dialog.locator("bdi")).toHaveText(["Third", "https://example.com/c"]);
  await expect(dialog).not.toContainText("ほかに");
  await app.keyboard.press("Escape");
  await expect
    .poll(() => callsOf(app, "mcp_answer"))
    .toEqual([
      { id: 1, allow: true },
      { id: 2, allow: false },
      { id: 3, allow: false },
    ]);
  await expect(dialog).toBeHidden();
});

test("a title of any length leaves the URL and both answers on screen", async ({ app }) => {
  await ask(app, [article(1, "A title an agent made long ".repeat(250), "https://example.com/long")]);
  const dialog = dialogOf(app);
  await expect(dialog.locator("bdi").last()).toHaveText("https://example.com/long");
  await expect(dialog.locator("bdi").last(), "what the title stands for").toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "拒否" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "削除を許可" })).toBeInViewport({ ratio: 1 });
});

test("every name keeps to lines of its own, which scroll, so a long second name leaves the answers on screen too", async ({ app }) => {
  const long = "A genre an agent named long ".repeat(250);
  await ask(app, [{ id: 1, registration: "Claude Code", deletion: { kind: "genre", from: long, into: long, articles: 2 }, deadline_ms: NOW + 90_000 }]);
  const dialog = dialogOf(app);
  await expect(dialog.locator("bdi")).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "拒否" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "削除を許可" })).toBeInViewport({ ratio: 1 });
  const from = dialog.locator("dd").first();
  await from.hover();
  await app.mouse.wheel(0, 300);
  await expect.poll(() => from.evaluate((e) => e.scrollTop), "the rest of the name is a scroll away").toBeGreaterThan(0);
});

test("Allow waits a moment each time a request shows", async ({ app }) => {
  const dialog = dialogOf(app);
  const allow = dialog.getByRole("button", { name: "削除を許可" });
  await ask(app, [article(1, null, "https://example.com/first")]);
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(dialog).toBeHidden();
  await ask(app, [article(2, null, "https://example.com/second")]);
  await expect(dialog).toContainText("https://example.com/second");
  expect(await allow.isDisabled(), "not armed yet").toBe(true);
  await expect(allow).toBeEnabled();
});

test("over a page view, Allow waits a moment from when the dialog shows, not from when it mounts", async ({ app }) => {
  await openPage(app);
  // Hold every browser_hide: the dialog stays invisible over the page webview until it is hidden.
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
  await ask(app, [article(1, null, "https://example.com/a")]);
  const opacity = (l: Locator) => l.evaluate((e) => getComputedStyle(e).opacity);
  const scrim = app.locator(".pal-scrim");
  await expect.poll(() => app.evaluate(() => (window as unknown as { hides: number }).hides)).toBeGreaterThan(0);
  await app.waitForTimeout(1_500);
  expect(await opacity(scrim), "invisible for longer than Allow waits").toBe("0");
  await app.evaluate(() => (window as unknown as { release: () => void }).release());
  await expect.poll(() => opacity(scrim)).toBe("1");
  const allow = dialogOf(app).getByRole("button", { name: "削除を許可" });
  expect(await allow.isDisabled(), "not armed the moment it shows").toBe(true);
  await expect(allow).toBeEnabled();
});

/** As when another app's window comes in front of Lattice's, or Lattice's comes back into focus. */
const setFocused = (app: Page, focused: boolean) =>
  app.evaluate((f) => {
    document.hasFocus = () => f;
    window.dispatchEvent(new Event(f ? "focus" : "blur"));
  }, focused);

test("Allow waits a moment again each time the window comes into focus, so the click that brings it forward allows nothing", async ({ app }) => {
  await ask(app, [article(1, null, "https://example.com/a")]);
  const allow = dialogOf(app).getByRole("button", { name: "削除を許可" });
  await expect(allow).toBeEnabled();
  await setFocused(app, false);
  await expect(allow, "the user went on in another app").toBeDisabled();
  // A later request raises the window, still out of focus, over the app the user is in; their next click brings it forward.
  await ask(app, [article(1, null, "https://example.com/a"), article(2, null, "https://example.com/b")]);
  const box = (await allow.boundingBox())!;
  await setFocused(app, true);
  await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await callsOf(app, "mcp_answer"), "a click meant for the other app").toEqual([]);
  await expect(allow).toBeEnabled();
});

test("the click that brings the window forward, outside the dialog, denies nothing either", async ({ app }) => {
  await ask(app, [article(1, null, "https://example.com/a")]);
  const dialog = dialogOf(app);
  await expect(dialog.getByRole("button", { name: "削除を許可" })).toBeEnabled();
  await setFocused(app, false);
  await setFocused(app, true);
  await app.mouse.click(5, 5);
  expect(await callsOf(app, "mcp_answer"), "a click on the title bar, under the scrim").toEqual([]);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "削除を許可" })).toBeEnabled();
  await app.mouse.click(5, 5);
  await expect.poll(() => callsOf(app, "mcp_answer")).toEqual([{ id: 1, allow: false }]);
});

test("each kind of deletion says what goes and what stays, and the time left counts down", async ({ app }) => {
  const by = (id: number, deletion: McpApproval["deletion"]): McpApproval => ({ id, registration: "Research", deletion, deadline_ms: NOW + 90_000 });
  await ask(app, [
    by(1, { kind: "collection", name: "Reading", articles: 2 }),
    by(2, { kind: "feed", title: "Example feed", url: "https://example.com/feed.xml", articles: 5 }),
    by(3, { kind: "folder", name: "Tech", feeds: 3 }),
    by(4, { kind: "genre", from: "Databases", into: "Storage", articles: 4 }),
  ]);
  const dialog = dialogOf(app);
  const deny = dialog.getByRole("button", { name: "拒否" });
  const expected = [
    [["Reading"], "中の記事2件はライブラリに残ります。"],
    [["Example feed", "https://example.com/feed.xml"], "記事5件は削除されず「手動追加」に移ります。"],
    [["Tech"], "中のフィード3件は残り、フォルダなしになります。"],
    [["Databases", "Storage"], "記事4件を統合先のジャンルに移し、このジャンルを削除します。"],
  ] as const;
  for (const [names, stays] of expected) {
    await expect(dialog.locator("bdi")).toHaveText([...names]);
    await expect(dialog).toContainText("登録「Research」のエージェント");
    await expect(dialog).toContainText(stays);
    await deny.click();
  }
  await expect(dialog).toBeHidden();
  expect((await callsOf(app, "mcp_answer")).map((c) => (c as { allow: boolean }).allow)).toEqual([false, false, false, false]);

  await ask(app, [article(5, "Soon", "https://example.com/soon", 2_500)]);
  await expect(dialog).toContainText("答えなければ、3秒後に拒否します。");
  await app.clock.setFixedTime(NOW + 1_600);
  await expect(dialog, "at the next tick of its own").toContainText("答えなければ、1秒後に拒否します。");
});

test("an answer does not keep a request on screen that a read on its way says has stopped waiting", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eLate = ["mcp_approvals"];
  });
  const app = shell;
  await app.goto("/");
  const reads = () => callsOf(app, "mcp_approvals").then((c) => c.length);
  await expect.poll(reads).toBeGreaterThan(0);
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  const mounted = await reads();
  await ask(app, [article(1, null, "https://example.com/a"), article(2, null, "https://example.com/b")]);
  await expect.poll(reads).toBeGreaterThan(mounted);
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  const dialog = dialogOf(app);
  await expect(dialog).toContainText("https://example.com/a");

  const before = await reads();
  await ask(app, []);
  await expect.poll(reads, "both refused unanswered, the read of that still on its way").toBeGreaterThan(before);
  await dialog.getByRole("button", { name: "拒否" }).click();
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  await expect(dialog, "the second no longer waits either").toBeHidden();
});

test("a read on its way when the user answers does not bring the answered request back", async ({ shell }) => {
  await shell.addInitScript(() => {
    window.__e2eLate = ["mcp_approvals"];
  });
  const app = shell;
  await app.goto("/");
  const reads = () => callsOf(app, "mcp_approvals").then((c) => c.length);
  await expect.poll(reads).toBeGreaterThan(0);
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  const mounted = await reads();
  await ask(app, [article(1, null, "https://example.com/a"), article(2, null, "https://example.com/b")]);
  await expect.poll(reads).toBeGreaterThan(mounted);
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  const dialog = dialogOf(app);
  await expect(dialog).toContainText("https://example.com/a");

  const before = await reads();
  await app.evaluate(() => void window.__e2e.emit("mcp-approval"));
  await expect.poll(reads, "a read that still lists the first, on its way").toBeGreaterThan(before);
  await dialog.getByRole("button", { name: "拒否" }).click();
  await expect(dialog).toContainText("https://example.com/b");
  await app.evaluate(() => window.__e2e.release("mcp_approvals"));
  await app.waitForTimeout(500);
  await expect(dialog).toContainText("https://example.com/b");
});

test("a request that stops waiting goes from the screen", async ({ app }) => {
  await ask(app, [article(1, null, "https://example.com/a")]);
  await expect(dialogOf(app).locator("bdi"), "by its URL while it has no title").toHaveText(["https://example.com/a"]);
  await ask(app, []);
  await expect(dialogOf(app), "answered elsewhere, refused unanswered, or the agent hung up").toBeHidden();
  expect(await callsOf(app, "mcp_answer")).toEqual([]);
});
