# AgentMesh Web Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the responsive AgentMesh sign-in, onboarding, owner dashboard, connection management, activity views, settings, and operator interface as a polished React product served by the existing Fastify process.

**Architecture:** Add a Vite-built React application under `web/` and serve its immutable assets from Fastify on the same origin as OAuth, the owner API, and MCP. A small typed API client and session store coordinate screens; server state is fetched explicitly and activity polling pauses when the page is hidden. Tailwind theme variables and selected shadcn/ui components form one reusable accessible design system.

**Tech Stack:** React, Vite, TypeScript, Tailwind CSS 4.3, shadcn/ui component source, Radix UI primitives, Lucide icons, React Router, Zod, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-08-31-agentmesh-hosted-control-plane-design.md`

**Prerequisite Plan:** `docs/superpowers/plans/2026-08-31-agentmesh-hosted-backend-implementation.md`

## Global Constraints

- Do not begin until the backend completion evidence is green.
- Use one Fastify process and same-origin cookies; do not add a Next.js or separate production frontend server.
- Support system-aware light and dark themes; persist only the theme preference, never credentials or project data.
- Use neutral graphite surfaces, restrained violet-blue accent, and semantic green/amber/red status tokens.
- Render agent names and message content as text, never with raw HTML insertion.
- Keep connection-token secrets only in component memory, show them once, clear them on close/unmount, and never store them in URL, browser storage, analytics, or error reports.
- Every authenticated request uses `credentials: "same-origin"`; every mutation sends the in-memory CSRF header and an exact UUID idempotency key when required.
- Preserve keyboard focus, semantic labels, reduced motion, responsive behavior, and readable contrast.
- `/ops` must remain metadata-only; it must not display message bodies.
- Keep the legacy `/admin` page available until the new `/ops` regression and observability checks pass.
- Use TDD and one focused commit per independently reviewable task.

---

## File Structure

- `web/src/app/router.tsx`: public, owner, project, settings, and operator route tree.
- `web/src/app/providers.tsx`: session and theme providers only.
- `web/src/api/client.ts`: same-origin fetch, safe error parsing, CSRF, and idempotency headers.
- `web/src/api/schemas.ts`: browser-side Zod validation of the shared API contract.
- `web/src/auth/*`: sign-in, auth error, session bootstrap, and authenticated gate.
- `web/src/projects/*`: project list, create flow, overview, and project layout.
- `web/src/connections/*`: named token issue, one-time secret, list, and revoke.
- `web/src/activity/*`: agents, messages, events, presence, paging, and polling.
- `web/src/settings/*`: archive, restore, recent-auth reauthentication, and delete.
- `web/src/ops/*`: metadata-only users/projects, blocking, and project archive.
- `web/src/components/ui/*`: selected shadcn/ui source and AgentMesh wrappers.
- `web/src/styles.css`: Tailwind import, theme tokens, base styles, and reduced motion.
- `web/src/test/render.tsx`: provider-aware `TestApp` and authenticated session/API fixtures.
- `web/src/test/fixtures.tsx`: project overview, messages, and operator component fixtures.
- `web/src/test/visibility.ts`: deterministic page-visibility and polling-clock helpers.
- `web/e2e/*`: browser acceptance with a deterministic fake OAuth mode.
- `shared/control-api.ts`: response schemas and types shared by Fastify and React.

### Test Harness Conventions

Task 1 creates these exact exports so later test snippets have no implicit globals:

```ts
// web/src/test/render.tsx
export function TestApp(props: TestAppProps): React.ReactElement;
export const session: SessionResponse;
export const api: MockedApiClient;

// web/src/test/fixtures.tsx
export function ProjectOverviewFixture(props: ProjectOverviewFixtureProps): React.ReactElement;
export function MessagesPageFixture(props: { text: string }): React.ReactElement;

// web/src/test/visibility.ts
export function setDocumentVisibility(state: DocumentVisibilityState): void;
export async function advancePollingClock(milliseconds: number): Promise<void>;
```

Every interaction test declares `const user = userEvent.setup()` inside `beforeEach`. `web/src/test/setup.ts` installs jest-dom and resets `api`, storage, timers, visibility, and a restorable `window.location.assign` spy after every test.

### Task 1: Scaffold the Vite application and serve it from Fastify

**Files:**
- Create: `web/package.json`
- Create: `web/index.html`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/vitest.config.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/app/router.tsx`
- Create: `web/src/app/providers.tsx`
- Create: `web/src/styles.css`
- Create: `web/src/test/setup.ts`
- Create: `web/src/test/render.tsx`
- Create: `web/src/test/fixtures.tsx`
- Create: `web/src/test/visibility.ts`
- Create: `web/src/app/router.test.tsx`
- Create: `web/components.json`
- Create: `test/web-static.integration.test.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `src/http.ts`
- Modify: `src/server.ts`
- Modify: `tsconfig.json`
- Modify: `Dockerfile`
- Modify: `test/admin-http.integration.test.ts`

**Interfaces:**
- Consumes: completed same-origin backend and session endpoints.
- Produces: production `dist/web` assets, `createAppRouter()`, and Fastify SPA/static serving that excludes API and MCP routes.

- [ ] **Step 1: Add a failing static-asset and route-fallback integration test**

```ts
it("serves the product shell without intercepting protected server routes", async () => {
  const landing = await app.inject({ method: "GET", url: "/" });
  const projectRoute = await app.inject({ method: "GET", url: "/app/projects/example" });
  const unknownApi = await app.inject({ method: "GET", url: "/api/v1/not-real" });
  const mcpGet = await app.inject({ method: "GET", url: "/mcp" });

  expect(landing.statusCode).toBe(200);
  expect(landing.headers["content-type"]).toContain("text/html");
  expect(projectRoute.body).toBe(landing.body);
  expect(unknownApi.statusCode).toBe(404);
  expect(mcpGet.statusCode).not.toBe(200);
});
```

- [ ] **Step 2: Run the focused server test and verify it fails**

Run: `pnpm vitest run test/web-static.integration.test.ts`

Expected: FAIL because no compiled web shell or browser fallback exists.

- [ ] **Step 3: Add the web workspace dependencies and scripts**

Create `web/package.json` with scripts `dev`, `build`, `typecheck`, `test`, and `test:e2e`. At the root rename the current server build to `build:server`, add `build:web` as `pnpm --dir web build`, and make `build` run both in that order. Vite writes directly to `../dist/web` with `emptyOutDir: false` and `build.sourcemap: false`. Install React, React DOM, React Router, Zod, Lucide, Vite React plugin, Tailwind and its Vite plugin, Vitest, jsdom, Testing Library, user-event, and Playwright inside the web workspace. Add `@fastify/static` at the root.

Preserve the existing pnpm security settings and add the workspace explicitly:

```yaml
packages:
  - web

allowBuilds:
  esbuild: true
```

Run:

```bash
pnpm --dir web add react react-dom react-router-dom zod lucide-react clsx tailwind-merge class-variance-authority
pnpm --dir web add -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test typescript @types/react @types/react-dom
pnpm add @fastify/static
```

- [ ] **Step 4: Create the minimal router and Tailwind entry**

```tsx
// web/src/app/router.tsx
import { createBrowserRouter } from "react-router-dom";

export function createAppRouter() {
  return createBrowserRouter([
    { path: "/", element: <main><h1>AgentMesh</h1></main> },
    { path: "/app/*", element: <main aria-label="AgentMesh application" /> },
    { path: "/ops/*", element: <main aria-label="AgentMesh operations" /> },
  ]);
}
```

```css
/* web/src/styles.css */
@import "tailwindcss";

@theme {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --color-accent-500: oklch(0.62 0.19 276);
  --radius-panel: 0.75rem;
}
```

- [ ] **Step 5: Configure Vite output and Fastify static serving**

Vite must emit hashed assets to `dist/web` during the root build. Register `@fastify/static` with immutable caching for hashed `/assets/*`, `no-cache` for `index.html`, and a not-found fallback only for `/`, `/app/*`, and `/ops/*`. Apply the approved CSP with scripts and styles from self, images from self/data/GitHub avatars, and `connect-src 'self'`.

- [ ] **Step 6: Run server and browser scaffold checks**

Run: `pnpm --dir web typecheck && pnpm --dir web test && pnpm --dir web build && pnpm vitest run test/web-static.integration.test.ts test/admin-http.integration.test.ts && pnpm build`

Expected: PASS; `/admin` remains available and `/api`, `/auth`, `/mcp`, `/health`, and `/ready` are not swallowed by the SPA fallback.

- [ ] **Step 7: Commit the web boundary**

```bash
git add web package.json pnpm-lock.yaml pnpm-workspace.yaml src/http.ts src/server.ts tsconfig.json Dockerfile test/web-static.integration.test.ts test/admin-http.integration.test.ts
git commit -m "feat: scaffold AgentMesh web product"
```

### Task 2: Create the design system, shared API contract, and session bootstrap

**Files:**
- Create: `shared/control-api.ts`
- Create: `web/src/lib/cn.ts`
- Create: `web/src/components/ui/button.tsx`
- Create: `web/src/components/ui/card.tsx`
- Create: `web/src/components/ui/input.tsx`
- Create: `web/src/components/ui/label.tsx`
- Create: `web/src/components/ui/badge.tsx`
- Create: `web/src/components/ui/dialog.tsx`
- Create: `web/src/components/ui/dropdown-menu.tsx`
- Create: `web/src/components/ui/tabs.tsx`
- Create: `web/src/components/ui/alert.tsx`
- Create: `web/src/components/theme-provider.tsx`
- Create: `web/src/api/client.ts`
- Create: `web/src/api/schemas.ts`
- Create: `web/src/auth/session-store.tsx`
- Create: `web/src/auth/auth-gate.tsx`
- Create: `web/src/auth/session-store.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/app/providers.tsx`
- Modify: `src/control/contracts.ts`
- Modify: `src/control/routes.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: backend `GET /api/v1/session`, CSRF token, safe error envelope, and response shapes.
- Produces: shared Zod API schemas, `ApiClient`, `SessionProvider`, `useSession()`, `AuthGate`, semantic UI tokens, and reusable primitives.

- [ ] **Step 1: Write failing API-client and session bootstrap tests**

```tsx
it("keeps CSRF in memory and sends it only on same-origin mutations", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ user, csrf_token: "csrf", operator: false }))
    .mockResolvedValueOnce(Response.json({ items: [] }));
  const client = new ApiClient(fetchMock);
  await client.loadSession();
  await client.mutate("/api/v1/projects", { name: "alpha", description: null }, "00000000-0000-4000-8000-000000000001");
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    credentials: "same-origin",
    headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
  });
  expect(localStorage.getItem("csrf")).toBeNull();
});
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `pnpm --dir web vitest run src/auth/session-store.test.tsx`

Expected: FAIL because the API client and session store do not exist.

- [ ] **Step 3: Move public response schemas into one shared contract**

```ts
// shared/control-api.ts
export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), request_id: z.string().uuid() }),
}).strict();

export const sessionResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    github_login: z.string(),
    display_name: z.string(),
    avatar_url: z.string().url().nullable(),
  }).strict(),
  csrf_token: z.string().min(32),
  operator: z.boolean(),
}).strict();
```

Export project, connection, overview, agent, message, event, and operator schemas from the same file. Backend routes serialize through these schemas; the browser parses every successful response before use.

- [ ] **Step 4: Add the selected shadcn/ui source and semantic Tailwind theme**

Configure `web/components.json` with aliases rooted at `web/src`, then add the exact button, card, input, label, badge, dialog, dropdown-menu, tabs, and alert source files already listed under **Files**. Keep primitives under `web/src/components/ui` and customize through semantic classes only. Define canvas, panel, border, text, muted, accent, success, warning, and danger tokens for both themes in `styles.css`; add visible focus and `prefers-reduced-motion` rules.

- [ ] **Step 5: Implement the same-origin typed API client and session provider**

```ts
export class ApiClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async loadSession(): Promise<SessionResponse>;
  async query<T>(path: string, schema: z.ZodType<T>): Promise<T>;
  async mutate<T>(path: string, body: unknown, idempotencyKey?: string, method?: "POST" | "DELETE"): Promise<T>;
  clearSession(): void;
}
```

The client keeps CSRF in a private field only, uses same-origin relative paths, parses the standard error envelope, and never includes response bodies in thrown messages. `SessionProvider` exposes `loading`, `anonymous`, or `authenticated` state plus `refresh()` and `logout()`.

- [ ] **Step 6: Run design-system and backend contract tests**

Run: `pnpm --dir web test && pnpm --dir web typecheck && pnpm vitest run test/control-projects.integration.test.ts test/control-connections.integration.test.ts`

Expected: PASS with browser and server consuming the same response schemas.

- [ ] **Step 7: Commit shared contracts and session shell**

```bash
git add shared web/src src/control tsconfig.json
git commit -m "feat: add AgentMesh web design system"
```

### Task 3: Build GitHub sign-in and first-project onboarding

**Files:**
- Create: `web/src/auth/sign-in-page.tsx`
- Create: `web/src/auth/auth-error.tsx`
- Create: `web/src/projects/create-project-form.tsx`
- Create: `web/src/projects/empty-projects.tsx`
- Create: `web/src/projects/onboarding.test.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/auth/auth-gate.tsx`

**Interfaces:**
- Consumes: `SessionProvider`, project create API, error envelope, and full-page `/auth/github/start` redirect.
- Produces: public sign-in, authentication-error retry, protected `/app`, empty state, and project creation flow.

- [ ] **Step 1: Write failing sign-in and onboarding tests**

```tsx
it("sends an anonymous visitor to GitHub and creates the first project explicitly", async () => {
  render(<TestApp initialEntries={["/"]} session="anonymous" />);
  expect(screen.getByRole("link", { name: /continue with github/i })).toHaveAttribute("href", "/auth/github/start");

  render(<TestApp initialEntries={["/app"]} session="authenticated" projects={[]} />);
  await user.click(screen.getByRole("button", { name: /create project/i }));
  await user.type(screen.getByLabelText(/project name/i), "AgentMesh");
  await user.click(screen.getByRole("button", { name: /^create$/i }));
  expect(api.createProject).toHaveBeenCalledWith({ name: "AgentMesh", description: null }, expect.any(String));
});
```

- [ ] **Step 2: Run the onboarding test and verify it fails**

Run: `pnpm --dir web vitest run src/projects/onboarding.test.tsx`

Expected: FAIL because sign-in and onboarding screens are absent.

- [ ] **Step 3: Implement the focused public sign-in screen**

Use one product statement, a GitHub-branded action, short privacy copy stating that repository access is not requested, theme control, and safe retry text for `?auth_error=github`. Do not display raw query values.

- [ ] **Step 4: Implement authenticated empty state and create form**

The form validates trimmed name `1..100` and description `0..500`, generates a UUID idempotency key once per submit attempt, disables duplicate submission, surfaces stable API messages, and routes to `/app/projects/:id/connections/new` after success. It never auto-creates a project on login.

- [ ] **Step 5: Run component tests and production build**

Run: `pnpm --dir web test && pnpm --dir web typecheck && pnpm --dir web build`

Expected: PASS with anonymous, auth-error, loading, empty, invalid-form, and successful-create states covered.

- [ ] **Step 6: Commit sign-in and onboarding**

```bash
git add web/src/auth web/src/projects web/src/app/router.tsx
git commit -m "feat: add GitHub sign-in onboarding"
```

### Task 4: Build the project shell, list, and operational overview

**Files:**
- Create: `web/src/projects/project-list.tsx`
- Create: `web/src/projects/project-layout.tsx`
- Create: `web/src/projects/project-overview.tsx`
- Create: `web/src/projects/project-switcher.tsx`
- Create: `web/src/projects/presence-summary.tsx`
- Create: `web/src/projects/project-overview.test.tsx`
- Create: `web/src/components/app-shell.tsx`
- Modify: `web/src/app/router.tsx`

**Interfaces:**
- Consumes: project list/detail/overview schemas and authenticated user snapshot.
- Produces: responsive owner shell, active count, project switcher, status summary, and project navigation.

- [ ] **Step 1: Write a failing responsive overview test**

```tsx
it("shows the five-project limit and operational summary", async () => {
  render(<ProjectOverviewFixture activeCount={3} limit={5} online={2} idle={1} offline={0} />);
  expect(await screen.findByText("3 of 5 active projects")).toBeVisible();
  expect(screen.getByText("2 online")).toBeVisible();
  expect(screen.getByRole("navigation", { name: /project/i })).toBeVisible();
});
```

- [ ] **Step 2: Run the overview test and verify it fails**

Run: `pnpm --dir web vitest run src/projects/project-overview.test.tsx`

Expected: FAIL because the project shell is absent.

- [ ] **Step 3: Implement responsive owner navigation**

Desktop uses a compact sidebar; mobile uses an accessible sheet/dialog. Routes are Overview, Agents, Messages, Activity, Connections, and Settings. The account dropdown contains GitHub identity, theme choice, and logout. Project switcher separates active and archived projects.

- [ ] **Step 4: Implement project cards and overview metrics**

Project cards show name, status, last activity, agent counts, connection count, and a clear open action. Overview shows online/idle/offline totals, total/unacknowledged messages, failures in 24 hours, recent safe activity, and connection health without exposing secrets.

- [ ] **Step 5: Run focused accessibility and state tests**

Run: `pnpm --dir web vitest run src/projects/project-overview.test.tsx && pnpm --dir web typecheck`

Expected: PASS for loading skeleton, empty activity, archived badge, keyboard navigation, and mobile menu semantics.

- [ ] **Step 6: Commit the project shell**

```bash
git add web/src/projects web/src/components/app-shell.tsx web/src/app/router.tsx
git commit -m "feat: add project dashboard shell"
```

### Task 5: Build named connection creation, one-time display, and revocation

**Files:**
- Create: `web/src/connections/connection-list.tsx`
- Create: `web/src/connections/create-connection.tsx`
- Create: `web/src/connections/connection-secret-dialog.tsx`
- Create: `web/src/connections/revoke-connection-dialog.tsx`
- Create: `web/src/connections/connections.test.tsx`
- Modify: `web/src/app/router.tsx`

**Interfaces:**
- Consumes: connection list/issue/revoke API and project ID.
- Produces: named connection cards, one-time secret state, copy action, retry-loss recovery, and independent revocation.

- [ ] **Step 1: Write failing one-time secret and revoke tests**

```tsx
it("clears the secret when its dialog closes and never persists it", async () => {
  api.issueConnection.mockResolvedValue({ connection, secret: "am_proj_secret", secret_recoverable: true });
  const { unmount } = render(<CreateConnection projectId={projectId} />);
  await user.type(screen.getByLabelText(/connection name/i), "Second PC");
  await user.click(screen.getByRole("button", { name: /generate token/i }));
  expect(await screen.findByText("am_proj_secret")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /done/i }));
  expect(screen.queryByText("am_proj_secret")).toBeNull();
  unmount();
  expect(localStorage.length).toBe(0);
});
```

- [ ] **Step 2: Run the connection test and verify it fails**

Run: `pnpm --dir web vitest run src/connections/connections.test.tsx`

Expected: FAIL because connection components are absent.

- [ ] **Step 3: Implement creation and one-time secret handling**

The form accepts a trimmed `1..80` label and one UUID idempotency key per submit. The response secret lives in local component state only. The modal states that the token cannot be recovered, offers copy, shows environment-backed Codex configuration without embedding the token in a committed filename, and clears state on close and unmount.

- [ ] **Step 4: Implement lost-response and revoke behavior**

When `secret_recoverable` is false, show the created connection metadata and direct the owner to revoke and recreate it; never attempt a secret fetch. Revoke requires connection label confirmation and refreshes only that connection list. Cards show label, created/expiry/last-used times, status, and associated agent count.

- [ ] **Step 5: Run connection and production-build tests**

Run: `pnpm --dir web vitest run src/connections/connections.test.tsx && pnpm --dir web build`

Expected: PASS, including clipboard unavailable, API retry, already revoked, lost first response, and second connection unaffected states.

- [ ] **Step 6: Commit connection management**

```bash
git add web/src/connections web/src/app/router.tsx
git commit -m "feat: add named connection management"
```

### Task 6: Build agents, messages, activity, polling, and pagination

**Files:**
- Create: `web/src/activity/use-visible-polling.ts`
- Create: `web/src/activity/agents-page.tsx`
- Create: `web/src/activity/messages-page.tsx`
- Create: `web/src/activity/message-detail.tsx`
- Create: `web/src/activity/events-page.tsx`
- Create: `web/src/activity/activity.test.tsx`
- Modify: `web/src/app/router.tsx`

**Interfaces:**
- Consumes: scoped owner read endpoints, opaque cursors, message detail, and presence statuses.
- Produces: searchable project activity, safe text rendering, bounded history, and visible-page polling.

- [ ] **Step 1: Write failing safe-rendering and visibility polling tests**

```tsx
it("renders an adversarial message as text and pauses polling while hidden", async () => {
  render(<MessagesPageFixture text={'<img src=x onerror="alert(1)">'} />);
  expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
  setDocumentVisibility("hidden");
  await advancePollingClock(30_000);
  expect(api.listMessages).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the activity test and verify it fails**

Run: `pnpm --dir web vitest run src/activity/activity.test.tsx`

Expected: FAIL because activity pages and polling hook are absent.

- [ ] **Step 3: Implement agents and presence**

Show name, client, capabilities, connection label, last seen, and online/idle/offline badge. Filters remain in the URL as non-secret query parameters. Empty and stale states explain whether an agent has not connected or is offline.

- [ ] **Step 4: Implement message list/detail and event timeline**

Message list shows bounded preview, sender, recipient, time, and ACK state. Detail renders the full owner-authorized text in a wrapping `<pre>` or text container. Event rows show safe typed metadata and request ID; raw JSON is never inserted as HTML.

- [ ] **Step 5: Implement visible polling and cursor history**

Poll current overview/activity every five seconds only when `document.visibilityState === "visible"`, stop on unmount, back off after failures, and show a reconnect banner without clearing last good data. History uses opaque server cursors and a deliberate `Load more` action.

- [ ] **Step 6: Run activity, XSS, and polling tests**

Run: `pnpm --dir web vitest run src/activity/activity.test.tsx && pnpm --dir web typecheck`

Expected: PASS for adversarial text, cursor paging, ACK state, filter changes, visibility pause, backoff, and unmount cleanup.

- [ ] **Step 7: Commit observability pages**

```bash
git add web/src/activity web/src/app/router.tsx
git commit -m "feat: add agent activity views"
```

### Task 7: Add project settings, lifecycle confirmations, theme, and responsive accessibility

**Files:**
- Create: `web/src/settings/project-settings.tsx`
- Create: `web/src/settings/archive-project-dialog.tsx`
- Create: `web/src/settings/delete-project-dialog.tsx`
- Create: `web/src/settings/settings.test.tsx`
- Create: `web/src/components/error-boundary.tsx`
- Modify: `web/src/components/theme-provider.tsx`
- Modify: `web/src/components/app-shell.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: archive/restore/delete APIs and `401 recent_auth_required` response.
- Produces: lifecycle controls, exact-name deletion, GitHub reauthentication redirect, durable theme preference, error boundary, and responsive/a11y release checks.

- [ ] **Step 1: Write failing archive, delete, and theme tests**

```tsx
it("requires the exact project name and reauthenticates stale sessions", async () => {
  api.deleteProject.mockRejectedValue(new ApiError("recent_auth_required", 401));
  render(<DeleteProjectDialog project={{ id: projectId, name: "alpha" }} />);
  await user.type(screen.getByLabelText(/type alpha/i), "alpha");
  await user.click(screen.getByRole("button", { name: /delete permanently/i }));
  expect(window.location.assign).toHaveBeenCalledWith("/auth/github/start?return_to=%2Fapp%2Fprojects%2Fproject-id%2Fsettings");
});
```

- [ ] **Step 2: Run settings tests and verify they fail**

Run: `pnpm --dir web vitest run src/settings/settings.test.tsx`

Expected: FAIL because settings components are absent.

- [ ] **Step 3: Implement archive, restore, and permanent deletion**

Archive explains that MCP access stops and the slot is freed. Restore handles limit conflict. Delete requires exact case-sensitive project name, a danger confirmation, and recent GitHub auth; after success remove cached project data and route to `/app`.

- [ ] **Step 4: Finish theme and accessibility behavior**

Persist only `agentmesh-theme` with values `system`, `light`, or `dark`. Apply theme before the React paint through an external static bootstrap script allowed by CSP. Verify focus return after dialogs, escape close, keyboard menu navigation, landmark labels, minimum touch targets, forced reduced motion, and horizontal overflow at 320 CSS pixels.

- [ ] **Step 5: Run component, type, build, and automated accessibility assertions**

Run: `pnpm --dir web test && pnpm --dir web typecheck && pnpm --dir web build`

Expected: PASS with no console errors, no raw HTML rendering, and no stored credential-like values.

- [ ] **Step 6: Commit settings and accessibility**

```bash
git add web/src/settings web/src/components web/src/styles.css
git commit -m "feat: add project settings and themes"
```

### Task 8: Build the metadata-only operator experience and retire the legacy visual surface

**Files:**
- Create: `web/src/ops/ops-layout.tsx`
- Create: `web/src/ops/users-page.tsx`
- Create: `web/src/ops/projects-page.tsx`
- Create: `web/src/ops/operator-actions.tsx`
- Create: `web/src/ops/ops.test.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `src/admin/routes.ts`
- Modify: `test/admin-http.integration.test.ts`

**Interfaces:**
- Consumes: session operator boolean and `/api/v1/ops/*` metadata APIs.
- Produces: operator-only navigation, block/unblock and archive actions, aggregate load, and legacy dashboard deprecation behavior.

- [ ] **Step 1: Write failing operator authorization and privacy tests**

```tsx
it("hides operations from owners and never renders message content", async () => {
  const ownerView = render(<TestApp session={{ ...session, operator: false }} initialEntries={["/ops"]} />);
  expect(await ownerView.findByText(/not found/i)).toBeVisible();
  ownerView.unmount();

  render(<TestApp session={{ ...session, operator: true }} initialEntries={["/ops/projects"]} />);
  expect(await screen.findByText("alpha")).toBeVisible();
  expect(screen.queryByText("private message body")).toBeNull();
});
```

- [ ] **Step 2: Run operator tests and verify they fail**

Run: `pnpm --dir web vitest run src/ops/ops.test.tsx`

Expected: FAIL because operator routes and pages are absent.

- [ ] **Step 3: Implement operator user and project metadata views**

Users show GitHub login snapshot, created/last-login times, active project count, and blocked status. Projects show owner, lifecycle, agent/message aggregate counts, and safe request correlations. No operator request calls owner message-detail routes.

- [ ] **Step 4: Implement audited block/unblock and project archive actions**

Actions use explicit dialogs, CSRF, and refreshed metadata. Block explains that sessions and owned MCP access stop without deleting data. Unblock does not silently unarchive projects or recreate sessions.

- [ ] **Step 5: Deprecate the old visual dashboard only after parity**

Keep emergency `/api/admin/*` endpoints and admin-token auth. Change `/admin` to a protected compatibility page linking operators to `/ops` only after `/ops` tests cover projects, agents, activity outcomes, connection status, and safe aggregate counts. Do not remove the observer workflow.

- [ ] **Step 6: Run operator and legacy regression tests**

Run: `pnpm --dir web vitest run src/ops/ops.test.tsx && pnpm vitest run test/operator-http.integration.test.ts test/admin-http.integration.test.ts test/observer.integration.test.ts`

Expected: PASS with no message body in `/ops` and legacy emergency API still authenticated.

- [ ] **Step 7: Commit the operator product**

```bash
git add web/src/ops web/src/app/router.tsx src/admin/routes.ts test/admin-http.integration.test.ts
git commit -m "feat: add hosted operator console"
```

### Task 9: Add browser acceptance, responsive screenshots, and the web release gate

**Files:**
- Create: `web/playwright.config.ts`
- Create: `web/e2e/auth-onboarding.spec.ts`
- Create: `web/e2e/two-connections.spec.ts`
- Create: `web/e2e/project-lifecycle.spec.ts`
- Create: `web/e2e/operator.spec.ts`
- Create: `test/web-csp.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `Dockerfile`
- Modify: `scripts/compose-smoke.ts`

**Interfaces:**
- Consumes: completed web application and backend fake-OAuth test seam.
- Produces: deterministic end-to-end suite, responsive evidence, CSP regression, and one web release command.

- [ ] **Step 1: Add a failing end-to-end onboarding specification**

```ts
test("sign in, create project, issue two tokens, and revoke one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /continue with github/i }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.getByRole("button", { name: /create project/i }).click();
  await page.getByLabel(/project name/i).fill("AgentMesh E2E");
  await page.getByRole("button", { name: /^create$/i }).click();
  await page.getByLabel(/connection name/i).fill("Main Mac");
  await page.getByRole("button", { name: /generate token/i }).click();
  await expect(page.getByText(/^am_proj_/)).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright and verify the first spec fails**

Run: `pnpm --dir web exec playwright install chromium && pnpm --dir web test:e2e`

Expected: FAIL until the deterministic fake OAuth test server and web server command are wired.

- [ ] **Step 3: Wire deterministic browser test mode without production bypasses**

Start a test-only injected `GitHubOAuthClient` in the Playwright web-server process. It must still exercise OAuth state/cookie/callback, identity upsert, database session, CSRF, and owner APIs. Production configuration must have no route or environment value that bypasses GitHub identity.

- [ ] **Step 4: Cover all approved browser flows and responsive sizes**

Test desktop 1440x900, tablet 768x1024, and mobile 390x844 for sign-in, empty onboarding, project limit, token one-time display, agents/messages/activity, archive/restore/delete, operator authorization, theme persistence, keyboard focus, and adversarial text. Save screenshots only after verifying they contain no token modal or secret value.

- [ ] **Step 5: Verify production CSP and immutable asset caching**

`test/web-csp.integration.test.ts` must prove HTML uses the approved CSP, HTML is not cached, hashed assets are immutable, unknown API paths remain JSON 404, source maps are not served publicly, and OAuth/session cookies never appear in bodies.

- [ ] **Step 6: Run the complete web release gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm --dir web test:e2e && pnpm smoke:compose`

Expected: PASS with both themes, all three viewports, legacy MCP contracts, and no screenshot or trace containing a token.

- [ ] **Step 7: Commit web acceptance and documentation**

```bash
git add web/e2e web/playwright.config.ts test/web-csp.integration.test.ts package.json README.md Dockerfile scripts/compose-smoke.ts
git commit -m "test: complete web product acceptance"
```

## Web Completion Evidence

Before production deployment, record:

```text
web component tests: pass
backend regression tests: pass
Playwright desktop/tablet/mobile: pass
light/dark/system themes: pass
keyboard and reduced-motion checks: pass
CSP and cache checks: pass
tokens found in browser storage/traces/screenshots: 0
operator message bodies returned: 0
production build: pass
```
