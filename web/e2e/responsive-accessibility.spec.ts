import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, prepareOwner } from "./helpers";

test("desktop and mobile dialogs avoid overflow, trap keyboard focus, and restore it", async ({ page }) => {
  const projectId = await prepareOwner(page, "Responsive E2E");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/projects/${projectId}/connections`);
  await expectNoHorizontalOverflow(page);
  const trigger = page.getByRole("button", { name: "New connection" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const connectionDialog = page.getByRole("dialog", { name: "New connection" });
  await expect(connectionDialog).toBeVisible();
  const desktopBox = await connectionDialog.boundingBox();
  expect(desktopBox).not.toBeNull();
  expect(Math.abs(desktopBox!.x + desktopBox!.width / 2 - 720)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopBox!.y + desktopBox!.height / 2 - 450)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Shift+Tab");
  expect(await connectionDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(connectionDialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/projects/${projectId}/settings`);
  await expectNoHorizontalOverflow(page);
  const deleteTrigger = page.getByRole("button", { name: "Delete permanently" });
  await deleteTrigger.focus();
  await page.keyboard.press("Enter");
  const deleteDialog = page.getByRole("dialog", { name: "Delete Responsive E2E permanently" });
  await expect(deleteDialog).toBeVisible();
  const mobileBox = await deleteDialog.boundingBox();
  expect(mobileBox).not.toBeNull();
  expect(mobileBox!.x).toBeGreaterThanOrEqual(15);
  expect(Math.abs(mobileBox!.x + mobileBox!.width / 2 - 195)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();
});
