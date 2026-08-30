# AgentMesh Hosted Control Plane Design

**Status:** Approved in chat; awaiting review of this written specification

**Date:** 2026-08-31

**License:** Apache License 2.0

## 1. Purpose

This document defines the first user-facing AgentMesh hosted control plane: GitHub sign-in, single-owner projects, named MCP connection tokens, a modern web application, operator controls, and deployment at `https://agentmesh.uzmedical.org`.

It extends the existing AgentMesh MCP implementation and the protocol design in `2026-08-30-agentmesh-alpha-design.md`. The MCP tools, agent-session model, message semantics, delivery guarantees, and project isolation defined there remain authoritative unless this document explicitly changes hosted provisioning or project lifecycle behavior.

The immediate acceptance scenario is one human owner using two Codex installations on different computers. The owner signs in once, creates a project, issues a separate named connection token for each computer, watches both agents exchange messages, and can revoke either connection independently.

## 2. Product Decisions

The hosted alpha uses these approved rules:

- Anyone with a GitHub account may sign in. There is no invitation or approval queue.
- GitHub is used only to establish human identity. AgentMesh requests no repository access and does not store the GitHub access token.
- One human owns each project. Human collaborators and organizations are out of scope.
- One hosted account may have at most five active projects.
- Archived projects do not count toward the limit. Self-hosted deployments have no limit by default.
- Projects are created explicitly after sign-in; the first project is not created automatically.
- The owner creates a separate named connection token for each computer or MCP client configuration.
- AgentMesh remains an agent coordination service, not a task tracker, repository host, agent runtime, or job scheduler.

## 3. Approaches Considered

### 3.1 Selected: React application served by the existing Fastify service

A React and Vite application uses Tailwind CSS and a small shadcn/ui-based component set. Fastify serves the compiled assets and the same origin exposes the control-plane API, OAuth endpoints, and MCP endpoint.

This gives AgentMesh a modern interactive interface without introducing a second production application server, cross-origin cookies, or a separate deployment lifecycle.

### 3.2 Rejected: extend the current server-rendered administration page

Adding Tailwind to the current generated HTML would reduce initial work, but interactive onboarding, token handling, project navigation, and responsive behavior would quickly become difficult to maintain. The existing page remains an internal compatibility surface until the new operator view reaches parity; it is not the product design foundation.

### 3.3 Rejected: separate Next.js service

A separate Next.js application would provide a capable frontend platform, but it would add another server process, duplicated configuration, proxy boundaries, and more complicated session handling without a current product requirement that justifies those costs.

## 4. System Architecture

AgentMesh remains a modular monolith:

```text
Browser --------------------+
                            |
Codex / MCP clients --------+--> Caddy :443 --> Fastify --> PostgreSQL
                                                    |
                                                    +-- React assets
                                                    +-- OAuth and web API
                                                    +-- MCP /mcp
                                                    +-- health and readiness
```

Production routes are separated by purpose:

- `/` contains the public landing and GitHub sign-in entry point.
- `/app/*` contains the authenticated owner application.
- `/api/v1/*` contains the owner-facing JSON API.
- `/auth/github/*` contains OAuth initiation, callback, and logout.
- `/mcp` remains the project-token-authenticated MCP endpoint.
- `/ops/*` contains operator views protected by a user session plus an operator allowlist.
- `/health` and `/ready` retain their existing operational meanings.

React assets and API routes share one origin. Caddy is the only public listener. PostgreSQL is reachable only on the private Compose network and through an explicitly configured SSH tunnel for local pgAdmin observation.

The repository adds a `web/` application without relocating the working server code. Root scripts build and test both parts, and Vite emits versioned assets into the server distribution. Fastify's SPA fallback applies only to browser routes and never intercepts `/api`, `/auth`, `/mcp`, health, or operator API routes.

## 5. GitHub Authentication

### 5.1 OAuth application

The hosted deployment uses a confidential GitHub OAuth App with this exact production callback:

```text
https://agentmesh.uzmedical.org/auth/github/callback
```

The client ID, client secret, callback URL, cookie encryption key, and allowed public origin are supplied through protected deployment secrets. They are never committed, included in images, returned by APIs, or logged.

AgentMesh requests no OAuth scopes. It uses the resulting token only to call GitHub's authenticated user endpoint, then discards the token. It stores no repository permissions, email address, access token, or refresh token.

### 5.2 Authorization flow

1. `GET /auth/github/start` creates cryptographically random `state` and a PKCE verifier and challenge using `S256`.
2. The server places the state and verifier in a five-minute authenticated-encrypted, `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookie with path `/` and no `Domain` attribute.
3. GitHub redirects to the exact callback with a short-lived authorization code.
4. The callback validates the state in constant time, consumes and deletes the OAuth-attempt cookie, and exchanges the code with the verifier and client secret.
5. The server fetches the authenticated GitHub profile, validates the durable numeric GitHub user ID, and creates or updates the local identity in one database transaction.
6. The GitHub token is discarded before the response is sent.
7. AgentMesh creates an opaque local session and redirects to `/app`.

Cancelled, expired, replayed, malformed, or mismatched attempts create neither an identity nor a session. They return to the sign-in page with a safe retry message.

### 5.3 Stored identity

The data model separates the local user from the external provider:

- `users`: local ID, display name snapshot, avatar URL snapshot, created time, updated time, and blocked time.
- `oauth_identities`: local user ID, provider name, immutable provider user ID, current login snapshot, created time, updated time, and last login time.
- A unique constraint on `(provider, provider_user_id)` prevents duplicate accounts during concurrent callbacks.

Authorization always uses the provider's immutable numeric ID. Login, display name, and avatar are display-only snapshots that may change.

### 5.4 Web sessions

The browser receives a random opaque session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. PostgreSQL stores only a keyed digest of the complete token plus user ID, created time, last-seen time, idle expiry, absolute expiry, and revocation time.

- The idle lifetime is seven days.
- Activity may extend the idle expiry, but never beyond the 30-day absolute lifetime.
- Session rotation occurs after authentication and other privilege-sensitive transitions.
- Logout revokes the database row before clearing the cookie.
- Blocking a user revokes all of that user's web sessions and makes all owned hosted projects unavailable.

State-changing web API requests require an in-memory CSRF token obtained from the authenticated session endpoint and sent in a custom header. The server also validates `Origin` against the configured public origin. No mutation is accepted through `GET`.

## 6. Ownership and Project Lifecycle

`projects` gains an `owner_user_id`, optional description, lifecycle status, archived time, and updated time. Every owner API query includes both authenticated owner ID and project ID in its predicate. UUIDs are identifiers, never authorization credentials.

New projects created through the web application always have a non-null owner. Migration keeps `owner_user_id` nullable only for projects that already exist or are deliberately created through the headless operator CLI. Such operator-managed projects are not exposed through an owner's API until an operator assigns them to a local user. Assignment is an explicit audited CLI or operator action and is allowed only when the destination owner will remain within the active-project limit. This preserves current self-hosted and test projects without weakening ownership of newly created web projects.

Hosted project creation and unarchiving lock the owner's user row, count active projects, enforce the configured limit of five, and then mutate in the same transaction. This prevents concurrent requests from exceeding the limit. A self-hosted limit of `0` means unlimited.

Project states behave as follows:

- `active`: web reads, web mutations, and MCP access are allowed according to credentials.
- `archived`: retained and visible to the owner, excluded from the active-project limit, and rejected by MCP authentication. Unarchiving is allowed only when the owner is below the active limit.
- deleted: a confirmed hard deletion removes the project and its dependent tokens, agents, messages, deliveries, cursors, and activity rows through database cascades.

The delete action requires a GitHub authentication performed within the previous 15 minutes, an active CSRF token, and an exact project-name confirmation. An older session must complete GitHub reauthentication before deletion. The confirmation clearly states that application-level recovery is unavailable; backup recovery remains an operator process.

## 7. Named Connection Tokens

The existing project bearer-token format and digest validation remain in use. The `project_tokens` model is extended with:

- a required owner-visible label;
- creator user ID;
- created time and optional expiry, with a 90-day hosted default;
- last-used time;
- revoked time;
- non-secret lookup identifier and token digest.

The hosted owner creates a token from a specific project. The complete secret is returned exactly once with `Cache-Control: no-store`; it is never available through a later list or detail request. Listing returns only the non-secret identifier, label, timestamps, status, and associated agent summary.

A connection token is intended for one computer or client configuration. Agents registered while using it record the non-secret token ID as provenance so the dashboard can group agents by connection. Every MCP call still requires both a currently valid project bearer token and the agent-session proof required by the existing protocol.

Revocation is transactional and immediately makes subsequent requests with that bearer token return the same generic `401` response used for unknown or invalid tokens. It does not affect other project tokens. Existing project-row and token-row lock ordering remains unchanged, preserving the concurrent-revocation guarantees in the alpha protocol design.

Token values must be passed to MCP clients through environment-backed configuration. Product instructions explicitly warn against placing them in repositories, prompts, `AGENTS.md`, `.mcp.json`, screenshots, issue reports, or ordinary chat messages.

## 8. Web Product

### 8.1 Technology and visual language

The web application uses React, Vite, Tailwind CSS 4, selected shadcn/ui components, and Lucide icons. Tailwind theme variables define the product palette, typography, spacing, radii, shadows, and semantic status colors. Components consume semantic tokens rather than one-off color utilities.

The visual direction is a restrained developer tool rather than a generic CRUD admin panel:

- system-aware light and dark themes;
- neutral graphite surfaces with a restrained violet-blue accent;
- green, amber, and red reserved for operational status;
- clear typography, compact information density, subtle borders, and limited shadow;
- no decorative gradient overload, oversized empty panels, or excessive rounding;
- responsive behavior for desktop, tablet, and mobile;
- keyboard-visible focus, semantic markup, accessible dialogs, and reduced-motion support.

Untrusted agent names and message text render as text, never raw HTML. The application enforces a restrictive Content Security Policy and does not use inline executable scripts.

### 8.2 User flows

The first-login flow is:

1. Sign in with GitHub.
2. See an empty-project state with a clear `Create project` action.
3. Enter a project name and optional description.
4. Create the first named connection token.
5. See the secret once with copy and setup instructions for Codex.
6. Return to the project overview and observe the first agent connect.

Primary screens are:

- sign-in and authentication error;
- project list with active count such as `3 of 5`;
- project creation;
- project overview;
- agents and presence;
- named connections and token creation/revocation;
- activity and message delivery status;
- settings, archive, restore, and deletion;
- operator users, projects, load, and blocking.

Activity views use bounded pagination and modest polling while visible. The alpha adds no WebSocket or background queue.

### 8.3 API behavior

Owner APIs return a consistent error envelope with a stable code, safe message, and request ID. Expected statuses are:

- `400` for invalid input;
- `401` for missing or expired web authentication;
- `403` for an authenticated user lacking permission;
- `404` for unavailable resources without revealing whether another owner has them;
- `409` for lifecycle conflicts and active-project limit violations;
- `429` for rate limiting.

All authenticated and secret-bearing responses use `Cache-Control: no-store`. Mutation idempotency is required for project creation and connection-token creation so browser retries cannot create duplicate resources or multiple unseen secrets. A repeated project-creation key returns the original project. A connection-token secret is returned only by the first successful response; replaying its idempotency key returns the created connection metadata with `secret_recoverable: false` and never returns the secret again. If the first response was lost, the UI directs the owner to revoke that visible connection and create a replacement.

## 9. Operator and Observer Access

Operator access uses the ordinary GitHub-backed web session plus an environment-configured allowlist of immutable GitHub numeric IDs. Operator status is not granted by mutable login and is not editable through the public API.

The owner can view full message text only inside a project they own. The operator can inspect safe account and project metadata, block or unblock a user, archive a project, view aggregate load, and correlate safe activity by request ID, but the normal operator API does not return message bodies. The legacy server admin token remains an emergency and automation credential; it is not placed in a browser cookie or used as the ordinary operator login.

The local pgAdmin workflow continues through an SSH tunnel and a PostgreSQL observer role. Observer views may expose safe identifiers, lifecycle timestamps, agent presence, connection labels, activity outcomes, and the existing bounded project-message inspection surfaces. They never expose token digests, session digests, OAuth material, cookies, database credentials, raw request headers, or other secrets. Self-hosted operators who grant the observer role therefore intentionally grant message-observation access; the hosted `/ops` UI remains metadata-only by default.

The existing administration page remains private during migration. It is removed only after `/ops` provides the required observability and the replacement passes regression checks.

## 10. Security and Abuse Controls

The hosted alpha is open to GitHub sign-in but is not unbounded:

- OAuth initiation and callback, session endpoints, project mutations, token creation, and MCP have separate rate limits.
- Blocking a user closes web access and makes owned projects unavailable without deleting evidence.
- Token creation, revocation, project lifecycle changes, login results, and operator actions emit secret-free activity records.
- Logs omit authorization headers, cookies, OAuth codes, state, PKCE values, GitHub tokens, connection tokens, agent-session tokens, message text, and metadata.
- Error responses do not distinguish unknown from revoked project tokens.
- Cookies use the `__Host-` prefix in production, an exact host, path `/`, `Secure`, and no `Domain` attribute.
- Caddy terminates TLS and adds HSTS only after the domain and certificate path have passed deployment validation.
- PostgreSQL has no public port in hosted deployment.
- Production secrets live only in protected server configuration or a secret store and are not baked into the image.

The single-instance hosted defaults are 20 OAuth starts per ten minutes per source IP, 300 owner API reads per minute per session, 60 owner mutations per minute per session, 10 connection-token creations per hour per user, and 600 MCP requests per minute per project token. Limits are configurable for self-hosting. In-memory bounded token buckets are acceptable for the single hosted application process because rate limiting is an abuse control rather than correctness state; limits may reset on a process restart.

The alpha deliberately excludes CAPTCHA, billing, email verification, organization membership, repository authorization, GitHub webhooks, password login, and additional identity providers. These are added only in response to observed need.

## 11. Deployment and Self-Hosting

### 11.1 Hosted deployment

Docker Compose runs:

- `caddy`, the only service publishing ports 80 and 443;
- `app`, the immutable AgentMesh application image;
- `postgres`, accessible only on the private network;
- a bounded backup job or equivalent host timer.

The production origin is `https://agentmesh.uzmedical.org`. Caddy obtains and renews its certificate. Deployment verifies DNS, certificate identity, HTTPS, `/health`, `/ready`, OAuth start and callback behavior, browser assets, and a real MCP request before declaring success.

GitHub Actions runs lint, type checking, unit tests, integration tests, web build, server build, and Docker smoke tests before publishing a content-addressed image to GHCR. Deployment records the previous image digest, applies migrations once, replaces the app, waits for readiness, runs smoke checks, and restores the previous image when readiness or smoke validation fails. Database migrations used by a deploy must remain compatible with the previous image for rollback.

Daily PostgreSQL dumps are written outside the live database volume with restrictive permissions. The alpha retains seven daily and four weekly copies and exercises a restore into an isolated database. Before describing the service as generally available, backups must also be copied to an encrypted off-host destination.

### 11.2 Self-hosted deployment

The public repository ships the same image and schema with Compose documentation. A self-hosted operator supplies:

- domain and public origin;
- PostgreSQL and signing secrets;
- their own GitHub OAuth App credentials and callback;
- immutable operator GitHub IDs;
- project limit, where `0` means unlimited;
- backup location and retention.

The CLI provisioning and emergency administration path remain available for headless or recovery use. Alternative human identity providers are outside this alpha but the local user and external identity tables avoid coupling project ownership directly to a GitHub login.

## 12. Verification Strategy

### 12.1 Automated verification

The implementation must add:

- unit tests for OAuth state, PKCE, callback validation, cookie protection, session rotation, expiry, logout, CSRF, token hashing, and safe error mapping;
- integration tests with a fake GitHub server for first login, repeat login, mutable profile refresh, concurrent callback handling, blocking, project limit serialization, ownership isolation, archive behavior, token one-time return, revocation, and observer secrecy;
- regression and contract tests proving the existing MCP tool surface and message semantics remain compatible;
- browser tests for sign-in outcomes, empty onboarding, project creation, responsive navigation, theme selection, token copy flow, secret non-retrievability, revocation, and destructive confirmations;
- abuse and security tests for rate limits, callback replay, CSRF, unsafe origins, XSS strings, cache headers, cookie attributes, and log redaction;
- Docker smoke tests for migrations, assets, health, readiness, private database networking, and restart persistence;
- a backup restore test against an isolated database.

Tests never record real OAuth credentials or project secrets in fixtures, snapshots, reports, or command output.

### 12.2 Hosted acceptance

The hosted milestone is complete only when all of the following pass at `agentmesh.uzmedical.org`:

1. A real GitHub account signs in over valid HTTPS and reaches the empty onboarding state.
2. The owner creates one project and two separately named connection tokens.
3. Two Codex installations on different computers use their own token and register distinct agents.
4. Both agents discover one another, send one message in each direction, and acknowledge both deliveries.
5. The owner sees agents, activity, delivery state, and connection provenance in the web application and safe observer views.
6. Revoking the first computer's token causes its next MCP request to fail while the second computer continues to work.
7. A restart preserves sessions and project data, while health and readiness return to healthy state.
8. Application and access logs contain no OAuth, session, connection, agent-session, or message secrets.
9. A fresh backup restores into an isolated database and reproduces safe project and delivery counts.

Passing only a browser login, an open TCP port, or an agent marked active is not sufficient evidence of end-to-end coordination.

## 13. Implementation Boundaries

This design is one implementation program delivered in dependency order:

1. schema and owner-domain changes;
2. GitHub OAuth and web sessions;
3. owner API and named token lifecycle;
4. React application and operator replacement;
5. production packaging, CI, Caddy, backup, and deployment;
6. real two-computer acceptance.

It does not authorize unrelated MCP protocol redesign, task-board features, agent execution, repository access, billing, multi-human teams, additional social login providers, Redis, queues, Kubernetes, or mobile applications.

## 14. Success Definition

AgentMesh succeeds at this stage when a new GitHub user can understand the product without operator help, create a project, securely connect two coding agents, observe their coordination, and revoke one connection independently, while the same repository remains safe and practical to self-host.
