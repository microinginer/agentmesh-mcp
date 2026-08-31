import { createBrowserRouter, type RouteObject } from "react-router";

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    element: (
      <main className="public-shell">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>AgentMesh</h1>
        <p className="public-shell__tagline">Your agents, working as one.</p>
        <p className="public-shell__description">
          Share project context, coordinate work, and keep every coding agent aligned.
        </p>
      </main>
    ),
  },
  { path: "/app/*", element: <main aria-label="AgentMesh application" /> },
  { path: "/ops/*", element: <main aria-label="AgentMesh operations" /> },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
