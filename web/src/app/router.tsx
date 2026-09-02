import { lazy, Suspense, type ReactElement } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";

import { AuthGate } from "@/auth/auth-gate";
import { LandingPage } from "@/auth/landing-page";
import { SessionProvider } from "@/auth/session-store";
import { Skeleton } from "@/components/ui/skeleton";

const AgentsPage = lazy(() => import("@/activity/agents-page").then((module) => ({ default: module.AgentsPage })));
const EventsPage = lazy(() => import("@/activity/events-page").then((module) => ({ default: module.EventsPage })));
const MessagesPage = lazy(() => import("@/activity/messages-page").then((module) => ({ default: module.MessagesPage })));
const ConnectionsPage = lazy(() => import("@/connections/connections-page").then((module) => ({ default: module.ConnectionsPage })));
const GuidePage = lazy(() => import("@/guide/guide-page").then((module) => ({ default: module.GuidePage })));
const ProjectOverviewPage = lazy(() => import("@/projects/project-overview-page").then((module) => ({ default: module.ProjectOverviewPage })));
const TeamPulsePage = lazy(() => import("@/pulse/team-pulse-page").then((module) => ({ default: module.TeamPulsePage })));
const ProjectsPage = lazy(() => import("@/projects/projects-page").then((module) => ({ default: module.ProjectsPage })));
const ProjectSettings = lazy(() => import("@/settings/project-settings").then((module) => ({ default: module.ProjectSettings })));
const OperatorGate = lazy(() => import("@/ops/operator-gate").then((module) => ({ default: module.OperatorGate })));
const OperatorShell = lazy(() => import("@/ops/operator-shell").then((module) => ({ default: module.OperatorShell })));
const OperatorUsersPage = lazy(() => import("@/ops/operator-users-page").then((module) => ({ default: module.OperatorUsersPage })));
const OperatorUserPage = lazy(() => import("@/ops/operator-user-page").then((module) => ({ default: module.OperatorUserPage })));
const OperatorProjectsPage = lazy(() => import("@/ops/operator-projects-page").then((module) => ({ default: module.OperatorProjectsPage })));
const OperatorProjectPage = lazy(() => import("@/ops/operator-project-page").then((module) => ({ default: module.OperatorProjectPage })));
const OperatorNotFoundPage = lazy(() => import("@/ops/operator-ui").then((module) => ({ default: module.OperatorNotFoundPage })));

function lazyPage(page: ReactElement): ReactElement {
  return <Suspense fallback={<section className="state-page" aria-label="Loading page"><Skeleton className="h-10 w-60" /><Skeleton className="h-64 w-full" /></section>}>{page}</Suspense>;
}

function AuthenticatedProduct() {
  return (
    <SessionProvider>
      <AuthGate />
    </SessionProvider>
  );
}

function AuthenticatedOperator() {
  return (
    <SessionProvider>
      {lazyPage(<OperatorGate />)}
    </SessionProvider>
  );
}

export const appRoutes: RouteObject[] = [
  { path: "/", element: <LandingPage /> },
  { path: "/guide", element: lazyPage(<GuidePage />) },
  {
    path: "/app",
    element: <AuthenticatedProduct />,
    children: [
      { index: true, element: lazyPage(<ProjectsPage />) },
      { path: "projects/:projectId", element: lazyPage(<ProjectOverviewPage />) },
      { path: "projects/:projectId/pulse", element: lazyPage(<TeamPulsePage />) },
      { path: "projects/:projectId/agents", element: lazyPage(<AgentsPage />) },
      { path: "projects/:projectId/messages", element: lazyPage(<MessagesPage />) },
      { path: "projects/:projectId/activity", element: lazyPage(<EventsPage />) },
      { path: "projects/:projectId/connections", element: lazyPage(<ConnectionsPage />) },
      { path: "projects/:projectId/settings", element: lazyPage(<ProjectSettings />) },
    ],
  },
  {
    path: "/ops",
    element: <AuthenticatedOperator />,
    children: [{
      element: lazyPage(<OperatorShell />),
      children: [
        { index: true, element: <Navigate to="users" replace /> },
        { path: "users", element: lazyPage(<OperatorUsersPage />) },
        { path: "users/:userId", element: lazyPage(<OperatorUserPage />) },
        { path: "projects", element: lazyPage(<OperatorProjectsPage />) },
        { path: "projects/:projectId", element: lazyPage(<OperatorProjectPage />) },
        { path: "*", element: lazyPage(<OperatorNotFoundPage />) },
      ],
    }],
  },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
