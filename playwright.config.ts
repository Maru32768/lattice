import { defineConfig, devices } from "@playwright/test";

// E2E_PORT keeps parallel checkouts from reusing each other's dev server (reuseExistingServer matches by URL only).
const port = Number(process.env.E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium" }],
  webServer: { command: "npx vite -c e2e/vite.config.ts", url: `http://localhost:${port}`, reuseExistingServer: !process.env.CI },
});
