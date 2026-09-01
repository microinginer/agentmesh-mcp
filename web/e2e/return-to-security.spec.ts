import { expect, test } from "@playwright/test";

import { resetHarness } from "./helpers";

const hostileReturnTargets = [
  "https%3A%2F%2Fevil.example%2Fsteal",
  "%2F%2Fevil.example%2Fsteal",
  "%252F%252Fevil.example%252Fsteal",
  "%2Fapp%2F..%2F..%2Fevil",
  "%2Fops%255C%2540evil.example",
] as const;

for (const [index, target] of hostileReturnTargets.entries()) {
  test(`hostile return_to case ${index + 1} stays on AgentMesh`, async ({ page }) => {
    await resetHarness(page);
    await page.goto(`/auth/github/start?return_to=${target}`);
    await expect(page).toHaveURL("/app");
    expect(new URL(page.url()).origin).toBe("http://127.0.0.1:43123");
  });
}
