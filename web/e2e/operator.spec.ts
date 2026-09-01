import { expect, test } from "@playwright/test";

import { prepareOwner, resetHarness, seedObservability } from "./helpers";

test("operator OAuth returns exactly to the requested users route", async ({ page }) => {
  await resetHarness(page);
  await page.goto("/ops/users");
  await expect(page.getByRole("heading", { name: "Sign in to AgentMesh" })).toBeVisible();
  await page.getByRole("link", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL("/ops/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
});

test("operator browser exposes safe metadata and archives a project", async ({ page }) => {
  const projectName = "Operator Browser E2E";
  const projectId = await prepareOwner(page, projectName);
  await seedObservability(page, projectId, 3);

  await page.goto("/ops/users");
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  const users = page.getByRole("list", { name: "Users" });
  await expect(users.getByText("AgentMesh E2E Owner")).toBeVisible();
  await users.getByRole("link", { name: "View AgentMesh E2E Owner" }).click();
  await expect(page.getByText("User metadata")).toBeVisible();
  await expect(page.getByText("4242", { exact: true })).toBeVisible();
  await expect(page.getByText("1 active of 1 total")).toBeVisible();

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  const projects = page.getByRole("list", { name: "Projects" });
  await expect(projects.getByText(projectName)).toBeVisible();
  await projects.getByRole("link", { name: `View ${projectName}` }).click();
  await expect(page.getByText("Project metadata")).toBeVisible();
  await expect(page.getByText(projectId, { exact: true })).toBeVisible();
  await expect(page.getByText("2 agents", { exact: true })).toBeVisible();
  await expect(page.getByText("3 messages", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Archive project" }).click();
  const dialog = page.getByRole("dialog", { name: `Archive ${projectName}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm archive" }).click();
  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  const projectResponse = await page.request.get(`/api/v1/projects/${projectId}`);
  expect(projectResponse.status()).toBe(200);
  const project = await projectResponse.json() as { project: { status: string } };
  expect(project.project.status).toBe("archived");
});
