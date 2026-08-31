import { createBrowserRouter, type RouteObject } from "react-router-dom";

import { AuthGate } from "@/auth/auth-gate";
import { LandingPage } from "@/auth/landing-page";
import { SessionProvider } from "@/auth/session-store";
import { ConnectionsPage } from "@/connections/connections-page";
import { ProjectOverviewPage } from "@/projects/project-overview-page";
import { ProjectsPage } from "@/projects/projects-page";

function AuthenticatedProduct() {
  return (
    <SessionProvider>
      <AuthGate />
    </SessionProvider>
  );
}

export const appRoutes: RouteObject[] = [
  { path: "/", element: <LandingPage /> },
  {
    path: "/app",
    element: <AuthenticatedProduct />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectOverviewPage /> },
      { path: "projects/:projectId/connections", element: <ConnectionsPage /> },
    ],
  },
  { path: "/ops/*", element: <main aria-label="AgentMesh operations" /> },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
