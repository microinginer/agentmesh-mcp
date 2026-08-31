import { lazy, Suspense, type ReactElement } from "react";
import { createBrowserRouter, type RouteObject } from "react-router-dom";

import { AuthGate } from "@/auth/auth-gate";
import { LandingPage } from "@/auth/landing-page";
import { SessionProvider } from "@/auth/session-store";
import { Skeleton } from "@/components/ui/skeleton";

const AgentsPage = lazy(() => import("@/activity/agents-page").then((module) => ({ default: module.AgentsPage })));
const EventsPage = lazy(() => import("@/activity/events-page").then((module) => ({ default: module.EventsPage })));
const MessagesPage = lazy(() => import("@/activity/messages-page").then((module) => ({ default: module.MessagesPage })));
const ConnectionsPage = lazy(() => import("@/connections/connections-page").then((module) => ({ default: module.ConnectionsPage })));
const ProjectOverviewPage = lazy(() => import("@/projects/project-overview-page").then((module) => ({ default: module.ProjectOverviewPage })));
const ProjectsPage = lazy(() => import("@/projects/projects-page").then((module) => ({ default: module.ProjectsPage })));
const ProjectSettings = lazy(() => import("@/settings/project-settings").then((module) => ({ default: module.ProjectSettings })));

function lazyPage(page: ReactElement): ReactElement {
  return <Suspense fallback={<main className="state-page" aria-label="Loading page"><Skeleton className="h-10 w-60" /><Skeleton className="h-64 w-full" /></main>}>{page}</Suspense>;
}

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
      { index: true, element: lazyPage(<ProjectsPage />) },
      { path: "projects/:projectId", element: lazyPage(<ProjectOverviewPage />) },
      { path: "projects/:projectId/agents", element: lazyPage(<AgentsPage />) },
      { path: "projects/:projectId/messages", element: lazyPage(<MessagesPage />) },
      { path: "projects/:projectId/activity", element: lazyPage(<EventsPage />) },
      { path: "projects/:projectId/connections", element: lazyPage(<ConnectionsPage />) },
      { path: "projects/:projectId/settings", element: lazyPage(<ProjectSettings />) },
    ],
  },
  { path: "/ops/*", element: <main aria-label="AgentMesh operations" /> },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
