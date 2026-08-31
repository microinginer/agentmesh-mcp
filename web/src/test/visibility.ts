import { vi } from "vitest";

export function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

export async function advancePollingClock(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}
