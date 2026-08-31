import type { ReactElement, ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { vi, type Mock } from "vitest";

import { appRoutes } from "../app/router";
import { Providers } from "../app/providers";

export interface SessionResponse {
  user: {
    id: string;
    github_id: string;
    login: string;
    display_name: string;
    avatar_url: string | null;
  };
  operator: boolean;
  authenticated_at: string;
  csrf_token: string;
}

export interface MockedApiClient {
  loadSession: Mock;
  query: Mock;
  mutate: Mock;
  clearSession: Mock;
  reset: () => void;
}

export interface TestAppProps {
  initialEntries?: string[];
  children?: ReactNode;
  session?: SessionResponse | "anonymous";
}

export const session: SessionResponse = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    github_id: "101",
    login: "agentmesh-owner",
    display_name: "AgentMesh Owner",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  operator: false,
  authenticated_at: "2026-08-31T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

export const api: MockedApiClient = {
  loadSession: vi.fn(),
  query: vi.fn(),
  mutate: vi.fn(),
  clearSession: vi.fn(),
  reset() {
    this.loadSession.mockReset();
    this.query.mockReset();
    this.mutate.mockReset();
    this.clearSession.mockReset();
  },
};

export function TestApp({ initialEntries = ["/"], children }: TestAppProps): ReactElement {
  const routes = children === undefined
    ? appRoutes
    : [{ path: "*", element: <>{children}</> }];
  const router = createMemoryRouter(routes, { initialEntries });

  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
