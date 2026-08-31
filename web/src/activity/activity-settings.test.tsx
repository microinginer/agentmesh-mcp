import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "@/test/render";
import { advancePollingClock, setDocumentVisibility } from "@/test/visibility";

import { PollingProbe } from "./polling-probe.test-helper";

const projectId = "00000000-0000-4000-8000-000000000010";
const messageId = "00000000-0000-4000-8000-000000000020";
const adversarialText = '<img src=x onerror="alert(1)">';

const session = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    github_id: "101",
    login: "agentmesh-owner",
    display_name: "AgentMesh Owner",
    avatar_url: null,
  },
  operator: false,
  authenticated_at: "2026-08-31T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

const activeProject = {
  id: projectId,
  name: "AgentMesh",
  description: "Shared workspace",
  status: "active",
  archived_at: null,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T10:00:00.000Z",
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

describe("AgentMesh activity and project lifecycle", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders adversarial message content as text and opens safe message detail", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === `/api/v1/projects/${projectId}`) return json({ project: activeProject });
      if (path === `/api/v1/projects/${projectId}/messages?limit=50`) {
        return json({
          items: [{
            sequence: 1,
            id: messageId,
            sender: { id: "00000000-0000-4000-8000-000000000030", name: "Main Mac" },
            recipient: { id: "00000000-0000-4000-8000-000000000031", name: "Second PC" },
            preview: adversarialText,
            created_at: "2026-08-31T10:01:00.000Z",
            acknowledged_at: null,
          }],
          next_cursor: null,
          has_more: false,
        });
      }
      if (path === `/api/v1/projects/${projectId}/messages/${messageId}`) {
        return json({
          message: {
            sequence: 1,
            id: messageId,
            sender: { id: "00000000-0000-4000-8000-000000000030", name: "Main Mac" },
            recipient: { id: "00000000-0000-4000-8000-000000000031", name: "Second PC" },
            text: adversarialText,
            created_at: "2026-08-31T10:01:00.000Z",
            acknowledged_at: null,
          },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/messages`]} />);

    expect(await screen.findByRole("heading", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByText(adversarialText)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View message from Main Mac" }));
    const detail = await screen.findByRole("dialog", { name: "Message detail" });
    expect(within(detail).getByText(adversarialText)).toBeInTheDocument();
    expect(detail.querySelector("img")).toBeNull();
  });

  it("pauses polling while the page is hidden and resumes from one bounded timer", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    render(<PollingProbe poll={poll} interval={5_000} />);

    await act(() => advancePollingClock(5_000));
    expect(poll).toHaveBeenCalledTimes(1);

    setDocumentVisibility("hidden");
    await act(() => advancePollingClock(20_000));
    expect(poll).toHaveBeenCalledTimes(1);

    setDocumentVisibility("visible");
    await act(() => advancePollingClock(5_000));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("archives, restores, and redirects stale permanent deletion through GitHub reauthentication", async () => {
    const user = userEvent.setup();
    let project = { ...activeProject, archived_at: null as string | null };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === `/api/v1/projects/${projectId}` && init?.method !== "DELETE") return json({ project });
      if (path === `/api/v1/projects/${projectId}/archive` && init?.method === "POST") {
        project = { ...project, status: "archived", archived_at: "2026-08-31T11:00:00.000Z" };
        return json({ project });
      }
      if (path === `/api/v1/projects/${projectId}/restore` && init?.method === "POST") {
        project = { ...project, status: "active", archived_at: null };
        return json({ project });
      }
      if (path === `/api/v1/projects/${projectId}` && init?.method === "DELETE") {
        return json({
          error: {
            code: "RECENT_AUTH_REQUIRED",
            message: "Recent GitHub authentication is required",
            request_id: "00000000-0000-4000-8000-000000000099",
          },
        }, 403);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/settings`]} />);

    await user.click(await screen.findByRole("button", { name: "Archive project" }));
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(await screen.findByText("This project is archived." )).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore project" }));
    expect(await screen.findByRole("button", { name: "Archive project" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    const deleteDialog = screen.getByRole("dialog", { name: "Delete AgentMesh permanently" });
    await user.type(within(deleteDialog).getByLabelText("Type AgentMesh to confirm"), "AgentMesh");
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete project permanently" }));

    expect(window.location.assign).toHaveBeenCalledWith(
      `/auth/github/start?return_to=${encodeURIComponent(`/app/projects/${projectId}/settings`)}`,
    );
  });
});
