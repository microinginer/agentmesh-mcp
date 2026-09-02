import { expect, test } from "@playwright/test";

import { controlHarness, createProject, login, resetHarness } from "./helpers";

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

test("a GitHub recipient accepts a viewer link and remains read-only", async ({ page }) => {
  await resetHarness(page);
  await login(page);
  const projectId = await createProject(page, "Shared project E2E");

  await page.getByRole("link", { name: "Settings" }).click();
  const invitationResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/api/v1/projects/${projectId}/invitations`
  ));
  await page.getByRole("button", { name: "Create viewer link" }).click();
  const invitationResponse = await invitationResponsePromise;
  expect(invitationResponse.status(), await invitationResponse.text()).toBe(201);
  const invitationUrl = await page.getByRole("textbox", { name: "Viewer invitation link" }).inputValue();
  expect(invitationUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

  await page.context().clearCookies();
  await controlHarness(page, "oauth-profile", { profile: "viewer" });
  await page.goto(invitationUrl);
  await expect(page).toHaveURL(/\/app\/invitations\/accept$/);
  await page.getByRole("link", { name: "Continue with GitHub" }).click();

  await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}$`));
  await expect(page.getByRole("button", { name: "Current project: Shared project E2E" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

  const sessionResponse = await page.request.get("/api/v1/session");
  const viewerSession = await sessionResponse.json() as { csrf_token: string };
  const archiveStatus = await page.evaluate(async ({ id, csrfToken }) => {
    const response = await fetch(`/api/v1/projects/${id}/archive`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrfToken },
    });
    return response.status;
  }, { id: projectId, csrfToken: viewerSession.csrf_token });
  expect(archiveStatus).toBe(404);
});
