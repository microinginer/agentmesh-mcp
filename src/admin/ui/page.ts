import { ADMIN_BROWSER_SOURCE } from "./browser.js";
import { ADMIN_STYLES } from "./styles.js";

export interface AdminPage {
  contentSecurityPolicy: string;
  body: string;
}

export interface RenderAdminPageOptions {
  authenticated: boolean;
  nonce: string;
}

const loginContent = `<main class="login"><h1>AgentMesh administration</h1><form id="login-form" method="post" action="/admin/session"><label class="field">Token <input id="login-token" name="token" type="password" autocomplete="current-password" required></label><p id="login-error" class="form-error" aria-live="polite"></p><button type="submit">Sign in</button></form></main>`;

const dashboardContent = `<main id="app" class="shell"><header class="topbar"><h1>AgentMesh administration</h1><button id="logout-button" type="button">Log out</button></header><section class="context-row" aria-label="Dashboard context"><label class="field">Project <select id="project-selector" aria-label="Project"></select></label><p id="connection-status" class="status" data-state="connecting" aria-live="polite">Connecting…</p></section><section id="summary" class="summary-grid" aria-label="Project summary"><article class="metric"><span class="metric-label">Project</span><strong id="summary-project" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Online agents</span><strong id="summary-agents-online" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Idle agents</span><strong id="summary-agents-idle" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Offline agents</span><strong id="summary-agents-offline" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Total agents</span><strong id="summary-agents-total" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Total messages</span><strong id="summary-messages-total" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Unacknowledged messages</span><strong id="summary-messages-unacknowledged" class="metric-value">—</strong></article><article class="metric"><span class="metric-label">Failures, 24h</span><strong id="summary-failures" class="metric-value">—</strong></article></section><nav class="tabs" aria-label="Dashboard views" role="tablist"><button type="button" role="tab" data-tab="activity" aria-selected="true">Activity</button><button type="button" role="tab" data-tab="messages" aria-selected="false">Messages</button><button type="button" role="tab" data-tab="agents" aria-selected="false">Agents</button></nav><section id="filters" class="filters" aria-label="Filters"></section><section id="data-view" class="data-surface" aria-live="polite"></section><button id="new-activity" class="new-activity" type="button" hidden>New activity</button></main><aside id="detail-drawer" class="drawer" aria-labelledby="drawer-title" hidden><div class="drawer-head"><h2 id="drawer-title">Details</h2><button id="drawer-close" type="button">Close</button></div><pre id="drawer-text" class="drawer-text"></pre></aside>`;

export function renderAdminPage({ authenticated, nonce }: RenderAdminPageOptions): AdminPage {
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
  const content = authenticated ? dashboardContent : loginContent;

  return {
    contentSecurityPolicy,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AgentMesh administration</title><style nonce="${nonce}">${ADMIN_STYLES}</style></head><body>${content}<script nonce="${nonce}">${ADMIN_BROWSER_SOURCE}</script></body></html>`,
  };
}
