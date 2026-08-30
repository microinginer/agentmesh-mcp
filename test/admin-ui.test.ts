import { describe, expect, it } from "vitest";

import { ADMIN_BROWSER_SOURCE, nextPollDelay, newestSequence, type PollState } from "../src/admin/ui/browser.js";
import { ADMIN_STYLES } from "../src/admin/ui/styles.js";
import { renderAdminPage } from "../src/admin/ui/page.js";

describe("local admin dashboard page", () => {
  it("renders the authenticated dashboard shell with nonce-bound assets and no credential", () => {
    const nonce = "test-nonce";
    const adminToken = "admin-token-must-never-appear";
    const page = renderAdminPage({ authenticated: true, nonce });

    expect(page.body).toContain(`nonce="${nonce}"`);
    expect(page.body).toContain('id="project-selector"');
    expect(page.body).toContain('aria-live="polite"');
    expect(page.body).toContain('data-tab="activity"');
    expect(page.body).toContain('data-tab="messages"');
    expect(page.body).toContain('data-tab="agents"');
    expect(page.body).toContain('id="summary"');
    expect(page.body).toContain('id="filters"');
    expect(page.body).toContain('id="data-view"');
    expect(page.body).toContain('id="detail-drawer"');
    expect(page.body).toContain('id="logout-button"');
    expect(page.body).not.toContain(adminToken);
    expect(page.contentSecurityPolicy).toBe(
      "default-src 'none'; script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(ADMIN_STYLES).toContain(":focus-visible");
    expect(ADMIN_STYLES).toContain("prefers-color-scheme");
  });

  it("renders a credential-only login page with JSON interception and no app data mounts", () => {
    const page = renderAdminPage({ authenticated: false, nonce: "test-nonce" });

    expect(page.body).toContain('id="login-form"');
    expect(page.body).toContain('type="password"');
    expect(page.body).not.toContain('id="project-selector"');
    expect(page.body).not.toContain('id="summary"');
    expect(page.body).not.toContain('id="data-view"');
    expect(ADMIN_BROWSER_SOURCE).toContain("application/json");
  });
});

describe("dashboard polling helpers", () => {
  it("uses one-second visible polling, slower hidden polling, bounded failure backoff, and resets after success", () => {
    const ready: PollState = { visible: true, failures: 0 };

    expect(nextPollDelay(ready)).toBe(1_000);
    expect(nextPollDelay({ visible: false, failures: 0 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 1 })).toBe(1_000);
    expect(nextPollDelay({ visible: true, failures: 2 })).toBe(2_000);
    expect(nextPollDelay({ visible: true, failures: 3 })).toBe(4_000);
    expect(nextPollDelay({ visible: true, failures: 4 })).toBe(8_000);
    expect(nextPollDelay({ visible: true, failures: 5 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 99 })).toBe(15_000);
    expect(nextPollDelay({ visible: true, failures: 0 })).toBe(1_000);
  });

  it("keeps the newest accepted sequence while incremental pages are drained", () => {
    expect(newestSequence(12, [{ sequence: 13 }, { sequence: 18 }])).toBe(18);
    expect(newestSequence(18, [])).toBe(18);
  });
});

describe("dashboard browser safety", () => {
  it("renders remote values as text without persistent browser storage", () => {
    expect(ADMIN_BROWSER_SOURCE).toContain("document.createElement");
    expect(ADMIN_BROWSER_SOURCE).toContain("textContent");
    expect(ADMIN_BROWSER_SOURCE).not.toMatch(/innerHTML\s*=/);
    expect(ADMIN_BROWSER_SOURCE).not.toContain("localStorage");
    expect(ADMIN_BROWSER_SOURCE).not.toContain("sessionStorage");
  });
});
