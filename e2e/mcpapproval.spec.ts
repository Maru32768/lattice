// A deletion an agent asks for over MCP, put to the user in the main window (design-review §23).
import type { Page } from "@playwright/test";
import { test, expect, callsOf } from "./harness.ts";
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
  await ask(app, [article(1, "Rust ‮gnp.exe", "https://example.com/a"), article(2, "Second", "https://example.com/b")]);
  const dialog = dialogOf(app);
  await expect(dialog).toContainText("登録「Claude Code」のエージェントが、MCPで次を削除しようとしています。");
  await expect(dialog.locator("bdi"), "each name apart from the text around it").toHaveText(["Rust ‮gnp.exe", "https://example.com/a"]);
  await expect(dialog).toContainText("元に戻せません");
  await expect(dialog).toContainText("答えなければ、90秒後に拒否します。");
  await expect(dialog).toContainText("ほかに1件が待っています。");
  await expect(dialog.getByRole("button", { name: "拒否" }), "a stray Enter denies").toBeFocused();

  const allow = dialog.getByRole("button", { name: "削除を許可" });
  await expect(allow).toBeEnabled();
  // A person's double-click, the pointer still: two clicks some 200 ms apart, the second on the next request's button.
  const box = (await allow.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await app.mouse.click(x, y);
  await expect(dialog.locator("bdi")).toHaveText(["Second", "https://example.com/b"]);
  await app.waitForTimeout(200);
  await app.mouse.click(x, y);
  await expect(allow, "armed a moment after it shows").toBeEnabled();
  expect(await callsOf(app, "mcp_answer"), "the second click fell on the next request before it could be allowed").toEqual([{ id: 1, allow: true }]);
  await expect(dialog).not.toContainText("ほかに");
  await app.keyboard.press("Escape");
  await expect
    .poll(() => callsOf(app, "mcp_answer"))
    .toEqual([
      { id: 1, allow: true },
      { id: 2, allow: false },
    ]);
  await expect(dialog).toBeHidden();
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
  await ask(app, [article(1, null, "https://example.com/a"), article(2, null, "https://example.com/b")]);
  await expect.poll(reads).toBeGreaterThan(1);
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

test("a request that stops waiting goes from the screen", async ({ app }) => {
  await ask(app, [article(1, null, "https://example.com/a")]);
  await expect(dialogOf(app).locator("bdi"), "by its URL while it has no title").toHaveText(["https://example.com/a"]);
  await ask(app, []);
  await expect(dialogOf(app), "answered elsewhere, refused unanswered, or the agent hung up").toBeHidden();
  expect(await callsOf(app, "mcp_answer")).toEqual([]);
});
