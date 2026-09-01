import { expect, type Page } from "@playwright/test";

export const providerCredentials = [
  "agentmesh-browser-e2e-code",
  "agentmesh-browser-e2e-provider-token",
  "browser-e2e-client-secret",
];

export async function resetHarness(page: Page): Promise<void> {
  await page.context().clearCookies();
  const response = await page.request.post("/e2e/reset");
  expect(response.status()).toBe(204);
}

export async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

export async function createProject(page: Page, name: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Create your first project" })).toBeVisible();
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("Description").fill("Browser acceptance workspace");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/app\/projects\/[^/]+$/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1);
  if (projectId === undefined || projectId.length === 0) throw new Error("Missing project id");
  return projectId;
}

export async function prepareOwner(page: Page, projectName: string): Promise<string> {
  await resetHarness(page);
  await login(page);
  return createProject(page, projectName);
}

export async function issueConnection(page: Page, label: string): Promise<string> {
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "New connection" }).click();
  await page.getByLabel("Connection label").fill(label);
  await page.getByRole("button", { name: "Create connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection created" });
  await expect(dialog).toBeVisible();
  const secret = (await dialog.locator(".secret-box code").textContent()) ?? "";
  expect(secret).toMatch(/^am_proj_[A-Za-z0-9_.-]+$/);
  return secret;
}

export async function mcpStatus(page: Page, secret: string): Promise<number> {
  const response = await page.request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  return response.status();
}

export async function controlHarness(page: Page, action: string, data: Record<string, unknown> = {}): Promise<void> {
  const response = await page.request.post("/e2e/control", { data: { action, ...data } });
  expect(response.status()).toBe(204);
}

export async function seedObservability(page: Page, projectId: string, count = 55): Promise<void> {
  const response = await page.request.post("/e2e/seed-observability", { data: { project_id: projectId, count } });
  expect(response.status()).toBe(204);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}
