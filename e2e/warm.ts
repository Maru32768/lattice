import { chromium, type FullConfig } from "@playwright/test";

/** Loads the app once before the workers start: a cold dev server transforms every module through React Compiler first. */
export default async function warm(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.locator(".row").first().waitFor({ timeout: 120_000 });
  await browser.close();
}
