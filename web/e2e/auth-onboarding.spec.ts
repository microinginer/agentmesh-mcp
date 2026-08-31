import { expect, test } from "@playwright/test";

test("GitHub OAuth creates a real owner session and first project connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");
  for (const asset of ["/favicon.svg", "/favicon-32x32.png", "/apple-touch-icon.png", "/site.webmanifest"]) {
    const response = await page.request.get(asset);
    expect(response.ok(), `${asset} should be publicly available`).toBe(true);
  }
  await page.getByRole("link", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();

  await page.getByLabel("Project name").fill("AgentMesh E2E");
  await page.getByLabel("Description").fill("Browser acceptance workspace");
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("dialog", { name: "New connection" })).toBeVisible();
  await page.getByLabel("Connection label").fill("Main Mac");
  await page.getByRole("button", { name: "Create connection" }).click();
  const tokenDialog = page.getByRole("dialog", { name: "Connection created" });
  await expect(tokenDialog).toBeVisible();
  await expect(tokenDialog.locator(".secret-box code")).toHaveText(/^am_proj_[A-Za-z0-9_.-]+$/);
  await tokenDialog.getByRole("button", { name: "Done" }).click();

  await expect(page.getByRole("listitem", { name: "Main Mac connection" })).toBeVisible();
  const browserState = await page.evaluate(() => ({
    url: window.location.href,
    local: Object.values(window.localStorage),
    session: Object.values(window.sessionStorage),
    body: document.body.innerText,
  }));
  expect(JSON.stringify({ ...browserState, body: undefined })).not.toContain("am_proj_");
  expect(browserState.body).not.toContain("am_proj_");

  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("link", { name: "Messages" }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();

  await page.getByRole("button", { name: /AgentMesh E2E Owner/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Your agents, working as one." })).toBeVisible();
  const sessionStatus = await page.evaluate(async () => (await fetch("/api/v1/session")).status);
  expect(sessionStatus).toBe(401);
});
