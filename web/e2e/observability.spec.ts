import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, prepareOwner, seedObservability } from "./helpers";

test("agents and activity render deterministic project data", async ({ page }) => {
  const projectId = await prepareOwner(page, "Observability E2E");
  await seedObservability(page, projectId);
  await page.goto(`/app/projects/${projectId}`);
  const presenceList = page.getByRole("list", { name: "Agent presence" });
  await expect(presenceList.getByRole("listitem")).toHaveCount(2);
  const statusStarts = await presenceList.locator(".presence").evaluateAll((statuses) => (
    statuses.map((status) => Math.round(status.getBoundingClientRect().left))
  ));
  expect(new Set(statusStarts).size).toBe(1);

  await page.setViewportSize({ width: 620, height: 900 });
  const firstAgent = presenceList.getByRole("listitem").first();
  const mobileTextStarts = await firstAgent.locator(":scope > div").evaluateAll((columns) => (
    columns.map((column) => Math.round(column.getBoundingClientRect().left))
  ));
  expect(new Set(mobileTextStarts).size).toBe(1);
  await expect(firstAgent.locator(":scope > span").last()).toBeHidden();
  await expectNoHorizontalOverflow(page);

  await page.goto(`/app/projects/${projectId}/agents`);
  await expect(page.getByRole("list", { name: "Project agents" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("browser-agent-a")).toBeVisible();
  await page.goto(`/app/projects/${projectId}/activity`);
  await expect(page.getByRole("list", { name: "Project activity" }).getByRole("listitem")).toHaveCount(50);
  await expect(page.getByText("Message Sent").first()).toBeVisible();
});

test("message detail escapes peer text and load more never duplicates rows", async ({ page }) => {
  const projectId = await prepareOwner(page, "Messages E2E");
  await seedObservability(page, projectId);
  await page.goto(`/app/projects/${projectId}/messages`);
  const list = page.getByRole("list", { name: "Project messages" });
  await expect(list.getByRole("listitem")).toHaveCount(50);
  const unsafeText = '<img src=x onerror="window.agentmeshPeerExecuted=true"> peer-message-055';
  await expect(list.getByText(unsafeText, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { agentmeshPeerExecuted?: boolean }).agentmeshPeerExecuted)).toBeUndefined();

  await list.getByRole("button", { name: "View message from browser-agent-a" }).first().click();
  const detail = page.getByRole("dialog", { name: "Message detail" });
  await expect(detail.locator("pre")).toHaveText(unsafeText);
  expect(await detail.locator("img").count()).toBe(0);
  await detail.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(55);
  const previews = await list.locator(".data-row > p").allTextContents();
  expect(new Set(previews).size).toBe(55);
});
