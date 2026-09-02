import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "@/test/render";

const projectId = "00000000-0000-4000-8000-000000000010";
const viewerId = "00000000-0000-4000-8000-000000000002";
const invitationId = "00000000-0000-4000-8000-000000000020";

const session = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    github_id: "101",
    login: "agentmesh-owner",
    display_name: "AgentMesh Owner",
    avatar_url: null,
  },
  operator: false,
  authenticated_at: "2026-09-02T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

const project = {
  id: projectId,
  name: "AgentMesh",
  description: "Shared workspace",
  can_edit: true,
  status: "active",
  archived_at: null,
  created_at: "2026-09-02T10:00:00.000Z",
  updated_at: "2026-09-02T10:00:00.000Z",
};

const owner = {
  user_id: session.user.id,
  role: "owner",
  github_login: session.user.login,
  display_name: session.user.display_name,
  avatar_url: null,
  joined_at: "2026-09-02T10:00:00.000Z",
};

function pathOf(input: RequestInfo | URL): string {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "http://localhost");
  return url.pathname + url.search;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

describe("project members settings", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("creates a single-use viewer link and offers an explicit copy action", async () => {
    const user = userEvent.setup();
    const invitationUrl = "https://agentmesh.dev/invite/abcdefghijklmnopqrstuvwxyzABCDEFG123456";
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/members`) return json({ members: [owner], invitations: [] });
      if (path === `/api/v1/projects/${projectId}/invitations` && init?.method === "POST") {
        return json({
          invitation: {
            id: invitationId,
            role: "viewer",
            url: invitationUrl,
            created_at: "2026-09-02T10:05:00.000Z",
            expires_at: "2026-09-09T10:05:00.000Z",
          },
        }, 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/settings`]} />);

    expect(await screen.findByRole("heading", { name: "Members" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create viewer link" }));
    const link = await screen.findByRole("textbox", { name: "Viewer invitation link" });
    expect(link).toHaveValue(invitationUrl);
    expect(link).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(invitationUrl);
  });

  it("shows GitHub members and lets the owner revoke invites or remove viewers", async () => {
    const user = userEvent.setup();
    let viewerPresent = true;
    let invitePresent = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === `/api/v1/projects/${projectId}`) return json({ project });
      if (path === `/api/v1/projects/${projectId}/members`) {
        return json({
          members: [owner, ...(viewerPresent ? [{
            user_id: viewerId,
            role: "viewer",
            github_login: "octo-viewer",
            display_name: "Octo Viewer",
            avatar_url: null,
            joined_at: "2026-09-02T10:10:00.000Z",
          }] : [])],
          invitations: invitePresent ? [{
            id: invitationId,
            role: "viewer",
            created_at: "2026-09-02T10:05:00.000Z",
            expires_at: "2026-09-09T10:05:00.000Z",
          }] : [],
        });
      }
      if (path === `/api/v1/projects/${projectId}/invitations/${invitationId}` && init?.method === "DELETE") {
        invitePresent = false;
        return new Response(null, { status: 204 });
      }
      if (path === `/api/v1/projects/${projectId}/members/${viewerId}` && init?.method === "DELETE") {
        viewerPresent = false;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={[`/app/projects/${projectId}/settings`]} />);

    expect(await screen.findByText("@octo-viewer")).toBeInTheDocument();
    expect(screen.getByText("Pending viewer link")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke viewer link" }));
    expect(await screen.findByText("No pending invitation links.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Octo Viewer" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Octo Viewer?" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByText("Only you currently have access.")).toBeInTheDocument();
  });
});
