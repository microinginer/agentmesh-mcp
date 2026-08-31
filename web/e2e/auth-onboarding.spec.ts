import { expect, test } from "@playwright/test";

test("GitHub OAuth creates projects and centered connection dialogs through the project switcher", async ({ page }) => {
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

  await expect(page).toHaveURL(/\/app\/projects\/[^/]+$/);
  await expect(page.getByText("Coordinate agents without stepping on each other.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New connection" })).toHaveCount(0);

  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "New connection" })).toHaveCount(0);
  await page.getByRole("button", { name: "New connection" }).click();
  const createConnectionDialog = page.getByRole("dialog", { name: "New connection" });
  await expect(createConnectionDialog).toBeVisible();
  const dialogBox = await createConnectionDialog.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewport!.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox!.y + dialogBox!.height / 2 - viewport!.height / 2)).toBeLessThanOrEqual(1);
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

  await page.getByRole("button", { name: "Current project: AgentMesh E2E" }).click();
  const projectMenuItems = page.getByRole("menuitem");
  await expect(projectMenuItems.first()).toContainText("New project");
  await projectMenuItems.first().click();
  const newProjectDialog = page.getByRole("dialog", { name: "New project" });
  await expect(newProjectDialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileProjectDialogBox = await newProjectDialog.boundingBox();
  expect(mobileProjectDialogBox).not.toBeNull();
  expect(mobileProjectDialogBox!.x).toBeGreaterThanOrEqual(15);
  expect(Math.abs(mobileProjectDialogBox!.x + mobileProjectDialogBox!.width / 2 - 195)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await newProjectDialog.getByLabel("Project name").fill("Second E2E project");
  await newProjectDialog.getByLabel("Description").fill("Created from the sidebar switcher");
  await newProjectDialog.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/app\/projects\/[^/]+$/);
  await expect(page.getByRole("dialog", { name: "New connection" })).toHaveCount(0);

  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("link", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible();

  await page.getByRole("button", { name: /AgentMesh E2E Owner/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Your agents, working as one." })).toBeVisible();
  const sessionStatus = await page.evaluate(async () => (await fetch("/api/v1/session")).status);
  expect(sessionStatus).toBe(401);
});
