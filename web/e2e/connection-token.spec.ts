import { expect, test } from "@playwright/test";

import { issueConnection, mcpStatus, prepareOwner } from "./helpers";

test("connection secret is one-time browser state and revoke is safely idempotent", async ({ page }) => {
  await prepareOwner(page, "Connection lifecycle E2E");
  const issueRequest = page.waitForRequest((request) => request.url().endsWith("/connections") && request.method() === "POST");
  const secret = await issueConnection(page, "Main Mac");
  const capturedIssue = await issueRequest;
  const tokenDialog = page.getByRole("dialog", { name: "Connection created" });
  await expect(tokenDialog.getByText("Copy this token now. It cannot be shown again.")).toBeVisible();
  expect(await tokenDialog.locator(".secret-box code").count()).toBe(1);
  const replay = await page.request.post(capturedIssue.url(), {
    headers: {
      origin: new URL(page.url()).origin,
      "idempotency-key": capturedIssue.headers()["idempotency-key"]!,
      "x-csrf-token": capturedIssue.headers()["x-csrf-token"]!,
    },
    data: { label: "Main Mac" },
  });
  expect(replay.status()).toBe(201);
  expect(await replay.json()).toMatchObject({ secret: null, secret_recoverable: false });
  expect(await mcpStatus(page, secret)).toBe(200);

  await tokenDialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("listitem", { name: "Main Mac connection" })).toBeVisible();
  const browserState = await page.evaluate(() => ({
    url: window.location.href,
    local: Object.values(window.localStorage),
    session: Object.values(window.sessionStorage),
    html: document.documentElement.innerHTML,
  }));
  expect(JSON.stringify(browserState)).not.toContain(secret);
  await page.reload();
  await expect(page.getByRole("listitem", { name: "Main Mac connection" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);

  const revokeRequest = page.waitForRequest((request) => request.url().endsWith("/revoke") && request.method() === "POST");
  await page.getByRole("button", { name: "Revoke Main Mac" }).click();
  const captured = await revokeRequest;
  const csrf = captured.headers()["x-csrf-token"];
  expect(csrf).toBeTruthy();
  await expect(page.getByRole("button", { name: "Revoke Main Mac" })).toBeDisabled();
  expect(await mcpStatus(page, secret)).toBe(401);

  const repeated = await page.request.post(captured.url(), {
    headers: {
      origin: new URL(page.url()).origin,
      "x-csrf-token": csrf!,
    },
  });
  expect(repeated.status()).toBe(409);
  await expect(page.getByRole("button", { name: "Revoke Main Mac" })).toBeDisabled();
});
