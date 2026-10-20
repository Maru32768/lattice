// Runs in the "english" project (locale en-US): the display language follows the WebView's.
import { test, expect, callsOf, list, navItem } from "./harness.ts";

const JAPANESE = /[぀-ヿ一-鿿]/;

test("an English WebView starts in English and stores the choice", async ({ app }) => {
  expect(await callsOf(app, "set_ui_language")).toContainEqual({ lang: "en" });
  await expect(app.locator("html")).toHaveAttribute("lang", "en");
  for (const label of ["Recently added", "Unread", "Favorites", "All articles", "Added by hand"]) await expect(navItem(app, label)).toBeVisible();
  await expect(app.getByRole("button", { name: "Sort and group" })).toContainText("Date added, newest first");
  await expect(list(app).locator(".count")).toBeVisible();
});

test("the Reader, jobs, feeds and review screens read in English", async ({ app }) => {
  await list(app).locator(".row").first().click();
  await expect(app.getByRole("button", { name: "Ask", exact: true })).toHaveAttribute("title", "Chat about this article");
  await expect(app.getByRole("region", { name: "Summary" })).toBeVisible();
  await expect(app.getByRole("group", { name: "Language shown" })).toContainText("Original");

  await app.locator(".nav").getByRole("button", { name: "Jobs" }).click();
  await expect(app.locator("main.manage h1")).toHaveText("Jobs");
  await expect(app.locator("main.manage")).toContainText("usage limit reached", { useInnerText: true });
  await expect(app.getByRole("button", { name: "Retry all failed" })).toBeVisible();

  await app.locator(".nav").getByRole("button", { name: "Manage", exact: true }).click();
  await expect(app.locator("main.manage h1")).toHaveText("Manage feeds");
  await expect(app.locator("main.manage .sub")).toContainText(/6 feeds · last checked .* ago/);
  await expect(app.locator("main.manage")).toContainText("HTTP 503 Service Unavailable", { useInnerText: true });

  await app.locator(".nav").getByRole("button", { name: "Today's review" }).click();
  await expect(app.locator("main.manage h1")).toHaveText("Today's review");
});

test("every settings section has an English title, and a backend error is shown in English", async ({ app }) => {
  await app.locator(".nav").getByRole("button", { name: "Settings" }).click();
  const nav = app.getByRole("navigation", { name: "Settings categories" });
  expect(await nav.innerText(), "no Japanese left in the settings navigation").not.toMatch(JAPANESE);
  for (const title of ["AI providers", "Translation", "Summaries & chat", "Auto-classification", "Importance", "Genres", "Import & JS rendering", "Images", "Review",
    "Display language", "Shortcuts", "Browser", "Taskbar", "Backup", "Cloud backup (R2)", "Export", "Logs & storage", "Updates"]) {
    await nav.locator(".ni").filter({ has: app.locator(".label").getByText(title, { exact: true }) }).click();
    await expect(app.locator(".stg main h1")).toHaveText(title);
  }
  await nav.getByRole("button", { name: "Review" }).click();
  await app.getByLabel("Shortest interval", { exact: true }).fill("0");
  await expect(app.getByRole("alert")).toHaveText("The shortest interval is 1 minute to 30 days", { useInnerText: true });
});

test("the command palette matches English commands", async ({ app }) => {
  await app.keyboard.press("Control+k");
  const input = app.getByPlaceholder("Type a search, a command or a URL");
  await expect(input).toBeFocused();
  await input.fill(">unread");
  await expect(app.getByRole("option", { name: "Show unread" })).toBeVisible();
});
