import { expect, test } from "@playwright/test";

import { controlHarness, issueConnection, mcpStatus, prepareOwner } from "./helpers";

test("archive stops MCP use and restore returns the project", async ({ page }) => {
  const projectId = await prepareOwner(page, "Lifecycle E2E");
  const secret = await issueConnection(page, "Lifecycle Mac");
  await page.getByRole("dialog", { name: "Connection created" }).getByRole("button", { name: "Done" }).click();
  expect(await mcpStatus(page, secret)).toBe(200);

  await page.goto(`/app/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Archive project" }).click();
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(page.getByText("This project is archived.")).toBeVisible();
  expect(await mcpStatus(page, secret)).toBe(401);

  await page.getByRole("button", { name: "Restore project" }).click();
  await expect(page.getByText("This project is archived.")).toHaveCount(0);
  expect(await mcpStatus(page, secret)).toBe(200);
});

test("permanent delete requires the exact name and removes project access", async ({ page }) => {
  const projectName = "Permanent Delete E2E";
  const projectId = await prepareOwner(page, projectName);
  await page.goto(`/app/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Delete permanently" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${projectName} permanently` });
  const confirm = dialog.getByRole("button", { name: "Delete project permanently" });
  await dialog.getByLabel(`Type ${projectName} to confirm`).fill(`${projectName} `);
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${projectName} to confirm`).fill(projectName);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();
  expect((await page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(404);
});

test("stale authentication re-runs GitHub OAuth before a destructive retry", async ({ page }) => {
  const projectName = "Stale Auth E2E";
  const projectId = await prepareOwner(page, projectName);
  await controlHarness(page, "age-session");
  const agedSessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/session");
  await page.goto(`/app/projects/${projectId}/settings`);
  const agedSession = await agedSessionResponse.then((response) => response.json() as Promise<{ authenticated_at: string }>);
  await page.getByRole("button", { name: "Delete permanently" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${projectName} permanently` });
  await dialog.getByLabel(`Type ${projectName} to confirm`).fill(projectName);
  const reauth = page.waitForRequest((request) => request.url().includes("/auth/github/start"));
  const authorize = page.waitForRequest((request) => new URL(request.url()).pathname === "/e2e/github/authorize");
  const callback = page.waitForResponse((response) => new URL(response.url()).pathname === "/auth/github/callback");
  const refreshedSessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/session");
  await dialog.getByRole("button", { name: "Delete project permanently" }).click();
  const request = await reauth;
  expect(request.url()).toContain(`return_to=%2Fapp%2Fprojects%2F${projectId}%2Fsettings`);
  await authorize;
  await callback;
  const refreshedSession = await refreshedSessionResponse.then((response) => response.json() as Promise<{ authenticated_at: string }>);
  expect(new Date(refreshedSession.authenticated_at).getTime()).toBeGreaterThan(new Date(agedSession.authenticated_at).getTime());
  await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}(?:/settings)?$`));
  expect((await page.request.get(`/api/v1/projects/${projectId}`)).status()).toBe(200);
});
