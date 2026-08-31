import type { ReactElement, ReactNode } from "react";
import { RouterProvider } from "react-router/dom";
import { createMemoryRouter } from "react-router";
import { vi, type Mock } from "vitest";

import { appRoutes } from "../app/router";
import { Providers } from "../app/providers";

export interface SessionResponse {
  user: {
    id: string;
    github_login: string;
    display_name: string;
    avatar_url: string | null;
  };
  csrf_token: string;
  operator: boolean;
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
    github_login: "agentmesh-owner",
    display_name: "AgentMesh Owner",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
  operator: false,
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
