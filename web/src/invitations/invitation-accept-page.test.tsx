import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TestApp } from "@/test/render";

const projectId = "00000000-0000-4000-8000-000000000010";
const session = {
  user: {
    id: "00000000-0000-4000-8000-000000000002",
    github_id: "202",
    login: "octo-viewer",
    display_name: "Octo Viewer",
    avatar_url: null,
  },
  operator: false,
  authenticated_at: "2026-09-02T10:00:00.000Z",
  csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
};

function pathOf(input: RequestInfo | URL): string {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "http://localhost");
  return url.pathname + url.search;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

describe("viewer invitation acceptance", () => {
  it("returns an anonymous recipient to the fixed accept route after GitHub sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      error: { code: "AUTH_REQUIRED", message: "Authentication is required", request_id: "invite-auth-test" },
    }, 401)));

    render(<TestApp initialEntries={["/app/invitations/accept"]} />);

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/auth/github/start?return_to=%2Fapp%2Finvitations%2Faccept",
    );
  });

  it("redeems once on authenticated mount and replaces the route with the shared project", async () => {
    let redeemCalls = 0;
    const project = {
      id: projectId,
      name: "Shared AgentMesh",
      description: "Viewer workspace",
      can_edit: false,
      status: "active",
      archived_at: null,
      created_at: "2026-09-02T10:00:00.000Z",
      updated_at: "2026-09-02T10:00:00.000Z",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === "/api/v1/project-invitations/redeem" && init?.method === "POST") {
        redeemCalls += 1;
        return json({ project_id: projectId });
      }
      if (path === `/api/v1/projects/${projectId}/overview`) return json({ overview: { project, agents: { online: 0, idle: 0, offline: 0, total: 0 }, messages: { total: 0, unacknowledged: 0 }, failures_last_24h: 0 } });
      if (path === `/api/v1/projects/${projectId}/agents?limit=50`) return json({ items: [], next_cursor: null });
      if (path === `/api/v1/projects/${projectId}/events?limit=20`) return json({ items: [], next_cursor: null, has_more: false });
      if (path === `/api/v1/projects/${projectId}/connections?limit=50`) return json({ connections: [] });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/app/invitations/accept"]} />);

    expect(await screen.findAllByRole("button", { name: "Current project: Shared AgentMesh" })).not.toHaveLength(0);
    expect(redeemCalls).toBe(1);
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it.each([
    ["INVITATION_UNAVAILABLE", "This invitation is unavailable"],
    ["ALREADY_MEMBER", "You already have access"],
  ])("shows a safe recovery for %s", async (code, heading) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      if (path === "/api/v1/session") return json(session);
      if (path === "/api/v1/project-invitations/redeem" && init?.method === "POST") {
        return json({ error: { code, message: "Invitation cannot be redeemed", request_id: "invite-redeem-test" } }, 409);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<TestApp initialEntries={["/app/invitations/accept"]} />);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open projects" })).toHaveAttribute("href", "/app");
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining("token"), expect.anything());
  });
});
