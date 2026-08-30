import { randomBytes } from "node:crypto";

export interface AdminPage {
  contentSecurityPolicy: string;
  body: string;
}

export function renderAdminPage(authenticated: boolean): AdminPage {
  const nonce = randomBytes(16).toString("base64");
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const content = authenticated
    ? '<header><h1>AgentMesh administration</h1></header><main id="app"></main>'
    : '<main><h1>AgentMesh administration</h1><form method="post" action="/admin/session"><label>Token <input name="token" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form></main>';

  return {
    contentSecurityPolicy,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AgentMesh administration</title></head><body>${content}<script nonce="${nonce}"></script></body></html>`,
  };
}
