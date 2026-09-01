import { expect, test } from "@playwright/test";

import { controlHarness, prepareOwner, providerCredentials, resetHarness } from "./helpers";

test("logout revokes the server session", async ({ page }) => {
  await prepareOwner(page, "Logout E2E");
  await page.getByRole("button", { name: /AgentMesh E2E Owner/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.request.get("/api/v1/session")).status()).toBe(401);
});

for (const state of ["expired", "revoked"] as const) {
  test(`${state} session returns the owner to a safe sign-in state`, async ({ page }) => {
    await prepareOwner(page, `${state} Session E2E`);
    await controlHarness(page, `${state === "expired" ? "expire" : "revoke"}-session`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to AgentMesh" })).toBeVisible();
    await expect(page.getByText("Your session has ended.")).toBeVisible();
    expect((await page.request.get("/api/v1/session")).status()).toBe(401);
  });
}

for (const mode of ["denial", "exchange-failure"] as const) {
  test(`OAuth ${mode} is understandable and credential-safe`, async ({ page }) => {
    await resetHarness(page);
    await controlHarness(page, "oauth-mode", { mode });
    await page.goto("/");
    await page.getByRole("link", { name: "Continue with GitHub" }).click();
    await expect(page).toHaveURL(/\/?auth_error=github$/);
    await expect(page.getByText("GitHub sign-in was not completed")).toBeVisible();
    const exposed = await page.evaluate(() => `${window.location.href}\n${document.documentElement.innerText}\n${document.documentElement.innerHTML}`);
    for (const credential of providerCredentials) expect(exposed).not.toContain(credential);
  });
}
