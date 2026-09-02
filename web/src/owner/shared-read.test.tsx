import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestApp } from "@/test/render";

const projectId = "00000000-0000-4000-8000-000000000010";
const connectionId = "00000000-0000-4000-8000-000000000020";
const agentId = "00000000-0000-4000-8000-000000000030";

const viewerProject = {
  id: projectId,
  name: "Shared AgentMesh",
  description: "A project shared through membership",
  status: "active",
  archived_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
  can_edit: false,
};

const connection = {
  id: connectionId,
  label: "Owner Mac",
  status: "active",
  expires_at: null,
  last_used_at: "2026-09-02T00:30:00.000Z",
  revoked_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
};

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    const url = new URL(input.url);
    return url.pathname + url.search;
  }
  const url = new URL(String(input), "http://localhost");
  return url.pathname + url.search;
}

function json(value: unknown): Response {
  return Response.json(value);
}

function viewerFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = pathOf(input);
  if (init?.method !== undefined && init.method !== "GET") {
    throw new Error(`Viewer attempted mutation: ${init.method} ${path}`);
  }
  if (path === "/api/v1/session") {
    return Promise.resolve(json({
      user: {
        id: "00000000-0000-4000-8000-000000000002",
        github_id: "202",
        login: "agentmesh-viewer",
        display_name: "AgentMesh Viewer",
        avatar_url: null,
      },
      operator: false,
      authenticated_at: "2026-09-02T01:00:00.000Z",
      csrf_token: "agentmesh-test-csrf-token-32-bytes-long",
    }));
  }
  if (path === `/api/v1/projects/${projectId}`) return Promise.resolve(json({ project: viewerProject }));
  if (path === `/api/v1/projects/${projectId}/overview`) {
    return Promise.resolve(json({
      overview: {
        project: viewerProject,
        agents: { online: 1, idle: 0, offline: 0, total: 1 },
        messages: { total: 1, unacknowledged: 1 },
        failures_last_24h: 0,
      },
    }));
  }
  if (path === `/api/v1/projects/${projectId}/agents?limit=50`) {
    return Promise.resolve(json({
      items: [{
        id: agentId,
        name: "Owner Agent",
        client: "codex",
        capabilities: ["messages"],
        created_at: "2026-09-01T10:00:00.000Z",
        status: "online",
        last_seen_at: "2026-09-02T00:59:00.000Z",
        connection: { id: connectionId, label: "Owner Mac", status: "active", expires_at: null, revoked_at: null },
      }],
      next_cursor: null,
    }));
  }
  if (path === `/api/v1/projects/${projectId}/messages?limit=50`) {
    return Promise.resolve(json({
      items: [{
        sequence: 1,
        id: "00000000-0000-4000-8000-000000000040",
        sender: { id: agentId, name: "Owner Agent" },
        recipient: { id: "00000000-0000-4000-8000-000000000031", name: "Review Agent" },
        preview: "Shared read is visible",
        created_at: "2026-09-02T00:58:00.000Z",
        acknowledged_at: null,
      }],
      next_cursor: null,
      has_more: false,
    }));
  }
  if (path === `/api/v1/projects/${projectId}/events?limit=20`) {
    return Promise.resolve(json({ items: [], next_cursor: null, has_more: false }));
  }
  if (path === `/api/v1/projects/${projectId}/connections?limit=50`) {
    return Promise.resolve(json({ connections: [connection] }));
  }
  throw new Error(`Unexpected request: ${path}`);
}

describe("membership viewer shared read", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn(viewerFetcher));
  });

  it("opens the shared overview while keeping project mutations unavailable", async () => {
    render(<TestApp initialEntries={[`/app/projects/${projectId}`]} />);

    expect((await screen.findAllByText("Shared AgentMesh")).length).toBeGreaterThan(0);
    expect(screen.getByText("1 online")).toBeInTheDocument();
    expect(screen.getByText("You can view this shared project, but only its owner can make changes.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New connection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("renders member-visible agents and messages", async () => {
    const agentsPage = render(<TestApp initialEntries={[`/app/projects/${projectId}/agents`]} />);
    expect(await screen.findByText("Owner Agent")).toBeInTheDocument();
    agentsPage.unmount();

    render(<TestApp initialEntries={[`/app/projects/${projectId}/messages`]} />);
    expect(await screen.findByText("Shared read is visible")).toBeInTheDocument();
  });

  it("shows connection metadata without token or revoke actions", async () => {
    render(<TestApp initialEntries={[`/app/projects/${projectId}/connections`]} />);

    expect(await screen.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
    const row = screen.getByRole("listitem", { name: "Owner Mac connection" });
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New connection" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Revoke Owner Mac" })).not.toBeInTheDocument();
  });

  it("replaces lifecycle settings with a useful read-only state", async () => {
    render(<TestApp initialEntries={[`/app/projects/${projectId}/settings`]} />);

    expect(await screen.findByRole("heading", { name: "Read-only project" })).toBeInTheDocument();
    expect(screen.getByText("You can view Shared AgentMesh, but only its owner can change project settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });
});
