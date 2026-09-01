import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { appRoutes } from "@/app/router";
import { Providers } from "@/app/providers";
import { TestApp } from "@/test/render";

const userId = "00000000-0000-4000-8000-000000000010";
const secondUserId = "00000000-0000-4000-8000-000000000011";
const projectId = "00000000-0000-4000-8000-000000000020";
const secondProjectId = "00000000-0000-4000-8000-000000000021";
const secret = "am_proj_never-render-this-secret";

const operatorSession = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    github_id: "9001",
    login: "operator",
    display_name: "AgentMesh Operator",
    avatar_url: null,
  },
  operator: true,
  authenticated_at: "2026-08-31T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

const operatorUser = {
  id: userId,
  github_user_id: "9100",
  github_login: "target-user",
  display_name: "Target User",
  avatar_url: null,
  blocked_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
  project_count: 2,
  active_project_count: 1,
};

const secondUser = {
  ...operatorUser,
  id: secondUserId,
  github_user_id: "9200",
  github_login: "second-user",
  display_name: "Second User",
};

const operatorProject = {
  id: projectId,
  name: "Safe metadata project",
  status: "active",
  archived_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
  owner: {
    id: userId,
    github_user_id: "9100",
    github_login: "target-user",
    display_name: "Target User",
  },
  counts: { agents: 3, messages: 8, connections: 2 },
};

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    const url = new URL(input.url);
    return url.pathname + url.search;
  }
  const url = new URL(String(input), "http://localhost");
  return url.pathname + url.search;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function apiError(message: string, status = 503) {
  return json({
    error: {
      code: "CONTROL_UNAVAILABLE",
      message,
      request_id: "operator-ui-request",
    },
  }, status);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("AgentMesh operator UI", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("provides operator navigation, paginates users, and opens safe user metadata", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === "/api/v1/ops/users?limit=25") {
        return json({ items: [operatorUser], next_cursor: "users page 2" });
      }
      if (path === "/api/v1/ops/users?limit=25&cursor=users%20page%202") {
        return json({ items: [secondUser], next_cursor: null });
      }
      if (path === `/api/v1/ops/users/${userId}`) return json({ user: operatorUser });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/ops/users"]} />);

    expect(await screen.findByRole("heading", { name: "Users" })).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Operator navigation" });
    expect(within(navigation).getByRole("link", { name: "Users" })).toHaveAttribute("href", "/ops/users");
    expect(within(navigation).getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/ops/projects");
    expect(screen.getByText("Target User")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more users" }));
    expect(await screen.findByText("Second User")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "View Target User" }));
    expect(await screen.findByRole("heading", { name: "Target User" })).toBeInTheDocument();
    expect(screen.getByText("@target-user")).toBeInTheDocument();
    expect(screen.getByText("1 active of 2 total")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(secret);
  });

  it("blocks and unblocks a user only after accessible confirmation", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === `/api/v1/ops/users/${userId}` && init?.method !== "POST") return json({ user: operatorUser });
      if (path === `/api/v1/ops/users/${userId}/block` && init?.method === "POST") {
        return json({ user: { ...operatorUser, blocked_at: "2026-09-01T10:00:00.000Z", project_count: undefined, active_project_count: undefined } });
      }
      if (path === `/api/v1/ops/users/${userId}/unblock` && init?.method === "POST") {
        return json({ user: { ...operatorUser, project_count: undefined, active_project_count: undefined } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/ops/users/${userId}`]} />);
    await user.click(await screen.findByRole("button", { name: "Block user" }));
    const blockDialog = await screen.findByRole("alertdialog", { name: "Block Target User?" });
    expect(within(blockDialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await user.click(within(blockDialog).getByRole("button", { name: "Confirm block" }));
    expect(await screen.findByText("Blocked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unblock user" }));
    const unblockDialog = await screen.findByRole("alertdialog", { name: "Unblock Target User?" });
    await user.click(within(unblockDialog).getByRole("button", { name: "Confirm unblock" }));
    expect(await screen.findByText("Active")).toBeInTheDocument();

    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/ops/users/${userId}/block`,
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/ops/users/${userId}/unblock`,
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("does not offer self-blocking to the current operator", async () => {
    const currentOperator = {
      ...operatorUser,
      id: operatorSession.user.id,
      github_user_id: operatorSession.user.github_id,
      github_login: operatorSession.user.login,
      display_name: operatorSession.user.display_name,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === `/api/v1/ops/users/${currentOperator.id}`) return json({ user: currentOperator });
      throw new Error(`Unexpected request: ${path}`);
    }));

    render(<TestApp initialEntries={[`/ops/users/${currentOperator.id}`]} />);

    expect(await screen.findByRole("heading", { name: "AgentMesh Operator" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block user" })).not.toBeInTheDocument();
    expect(screen.getByText("The current operator account cannot be blocked from this console.")).toBeInTheDocument();
  });

  it("ignores out-of-order detail and mutation responses after route changes", async () => {
    const user = userEvent.setup();
    const staleDetail = deferred<Response>();
    const staleMutation = deferred<Response>();
    let firstUserLoads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === `/api/v1/ops/users/${userId}` && init?.method !== "POST") {
        firstUserLoads += 1;
        return firstUserLoads === 1 ? staleDetail.promise : json({ user: operatorUser });
      }
      if (path === `/api/v1/ops/users/${secondUserId}` && init?.method !== "POST") {
        return json({ user: secondUser });
      }
      if (path === `/api/v1/ops/users/${userId}/block` && init?.method === "POST") {
        return staleMutation.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const router = createMemoryRouter(appRoutes, { initialEntries: [`/ops/users/${userId}`] });
    render(<Providers><RouterProvider router={router} /></Providers>);

    await waitFor(() => expect(firstUserLoads).toBe(1));
    await router.navigate(`/ops/users/${secondUserId}`);
    expect(await screen.findByRole("heading", { name: "Second User" })).toBeInTheDocument();
    await act(async () => {
      staleDetail.resolve(json({ user: operatorUser }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Second User" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Target User" })).not.toBeInTheDocument();

    await router.navigate(`/ops/users/${userId}`);
    expect(await screen.findByRole("heading", { name: "Target User" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Block user" }));
    await user.click(await screen.findByRole("button", { name: "Confirm block" }));
    await router.navigate(`/ops/users/${secondUserId}`);
    expect(await screen.findByRole("heading", { name: "Second User" })).toBeInTheDocument();
    await router.navigate(`/ops/users/${userId}`);
    expect(await screen.findByRole("heading", { name: "Target User" })).toBeInTheDocument();
    await act(async () => {
      staleMutation.resolve(json({
        user: {
          ...operatorUser,
          blocked_at: "2026-09-01T10:00:00.000Z",
          project_count: undefined,
          active_project_count: undefined,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Target User" })).toBeInTheDocument();
    expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block user" })).toBeInTheDocument();
  });

  it("shows project metadata and archives only after confirmation", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === `/api/v1/ops/projects/${projectId}` && init?.method !== "POST") {
        return json({ project: operatorProject });
      }
      if (path === `/api/v1/ops/projects/${projectId}/archive` && init?.method === "POST") {
        return json({
          project: {
            id: projectId,
            status: "archived",
            archived_at: "2026-09-01T10:00:00.000Z",
            updated_at: "2026-09-01T10:00:00.000Z",
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/ops/projects/${projectId}`]} />);

    expect(await screen.findByRole("heading", { name: "Safe metadata project" })).toBeInTheDocument();
    expect(screen.getByText("8 messages")).toBeInTheDocument();
    expect(screen.getByText("2 connections")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(secret);

    await user.click(screen.getByRole("button", { name: "Archive project" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive Safe metadata project?" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm archive" }));

    expect(await screen.findByText("Archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive project" })).not.toBeInTheDocument();
    const updated = screen.getByText("Updated").nextElementSibling;
    const archivedAt = screen.getByText("Archived at").nextElementSibling;
    expect(updated).toHaveTextContent("Sep 1, 2026");
    expect(archivedAt).toHaveTextContent(updated?.textContent ?? "");
  });

  it("ignores an old project archive response after an A-B-A route cycle", async () => {
    const user = userEvent.setup();
    const staleArchive = deferred<Response>();
    const secondProject = { ...operatorProject, id: secondProjectId, name: "Second metadata project" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === `/api/v1/ops/projects/${projectId}` && init?.method !== "POST") {
        return json({ project: operatorProject });
      }
      if (path === `/api/v1/ops/projects/${secondProjectId}` && init?.method !== "POST") {
        return json({ project: secondProject });
      }
      if (path === `/api/v1/ops/projects/${projectId}/archive` && init?.method === "POST") {
        return staleArchive.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const router = createMemoryRouter(appRoutes, { initialEntries: [`/ops/projects/${projectId}`] });
    render(<Providers><RouterProvider router={router} /></Providers>);

    await user.click(await screen.findByRole("button", { name: "Archive project" }));
    await user.click(await screen.findByRole("button", { name: "Confirm archive" }));
    await router.navigate(`/ops/projects/${secondProjectId}`);
    expect(await screen.findByRole("heading", { name: "Second metadata project" })).toBeInTheDocument();
    await router.navigate(`/ops/projects/${projectId}`);
    expect(await screen.findByRole("heading", { name: "Safe metadata project" })).toBeInTheDocument();

    await act(async () => {
      staleArchive.resolve(json({
        project: {
          id: projectId,
          status: "archived",
          archived_at: "2026-09-01T10:00:00.000Z",
          updated_at: "2026-09-01T10:00:00.000Z",
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Safe metadata project" })).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive project" })).toBeInTheDocument();
  });

  it("paginates projects without exposing project content", async () => {
    const user = userEvent.setup();
    const secondProject = {
      ...operatorProject,
      id: secondProjectId,
      name: "Second metadata project",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === "/api/v1/ops/projects?limit=25") {
        return json({ items: [operatorProject], next_cursor: "projects page 2" });
      }
      if (path === "/api/v1/ops/projects?limit=25&cursor=projects%20page%202") {
        return json({ items: [secondProject], next_cursor: null });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/ops/projects"]} />);

    expect(await screen.findByText("Safe metadata project")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more projects" }));
    expect(await screen.findByText("Second metadata project")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("message body");
  });

  it("renders generic errors without server secrets and retries into an empty state", async () => {
    const user = userEvent.setup();
    let listAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(operatorSession);
      if (path === "/api/v1/ops/users?limit=25") {
        listAttempts += 1;
        return listAttempts === 1
          ? apiError(`upstream included ${secret}`)
          : json({ items: [], next_cursor: null });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/ops/users"]} />);

    expect(await screen.findByRole("heading", { name: "Users are temporarily unavailable" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(secret);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No users found" })).toBeInTheDocument();
    await waitFor(() => expect(listAttempts).toBe(2));
  });
});
