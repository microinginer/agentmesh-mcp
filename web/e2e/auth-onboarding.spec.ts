import { expect, test } from "@playwright/test";

import { createProject, login, resetHarness } from "./helpers";

test("GitHub OAuth reaches deterministic owner onboarding", async ({ page }) => {
  await resetHarness(page);
  await page.goto("/");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");
  for (const asset of ["/favicon.svg", "/favicon-32x32.png", "/apple-touch-icon.png", "/site.webmanifest"]) {
    expect((await page.request.get(asset)).ok(), `${asset} should be public`).toBe(true);
  }
  await login(page);
  await createProject(page, "Owner onboarding E2E");
  await expect(page.getByText("Coordinate agents without stepping on each other.")).toBeVisible();
});
